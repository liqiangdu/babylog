use std::collections::BTreeMap;
use std::convert::Infallible;
use std::path::PathBuf;
use std::time::Duration;

use axum::{
    extract::State,
    http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    Json,
};
use futures_util::StreamExt;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio_stream::wrappers::UnboundedReceiverStream;

use crate::{auth, ai_tools, open_conn, ratelimit, AppState};

#[derive(Default, Clone)]
struct ToolCallAcc {
    id: String,
    name: String,
    arguments: String,
}

fn merge_tool_call_deltas(acc: &mut BTreeMap<u32, ToolCallAcc>, deltas: &[Value]) {
    for d in deltas {
        let idx = d.get("index").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
        let part = acc.entry(idx).or_default();
        if let Some(id) = d.get("id").and_then(|x| x.as_str()) {
            part.id.push_str(id);
        }
        if let Some(fnobj) = d.get("function") {
            if let Some(name) = fnobj.get("name").and_then(|x| x.as_str()) {
                part.name.push_str(name);
            }
            if let Some(args) = fnobj.get("arguments").and_then(|x| x.as_str()) {
                part.arguments.push_str(args);
            }
        }
    }
}

/// Consumes one DeepSeek/OpenAI-style **streaming** completion (`stream: true`).
/// Forwards `delta.content` to the client as `{ "c": "..." }` SSE events.
/// Returns `(finish_reason, assistant_message_with_tool_calls)` when the model ends with `tool_calls`.
async fn forward_deepseek_stream(
    upstream: reqwest::Response,
    tx: &tokio::sync::mpsc::UnboundedSender<Result<Event, Infallible>>,
) -> Result<(String, Option<Value>, bool), String> {
    let mut buf: Vec<u8> = Vec::new();
    let mut tool_parts: BTreeMap<u32, ToolCallAcc> = BTreeMap::new();
    let mut last_finish = String::new();
    let mut sent_any_content = false;
    let mut stream = upstream.bytes_stream();

    while let Some(next) = stream.next().await {
        let chunk = next.map_err(|e| format!("DeepSeek stream read failed: {}", e))?;
        buf.extend_from_slice(&chunk);
        while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
            let line_bytes: Vec<u8> = buf.drain(..=pos).collect();
            let mut line_bytes = line_bytes;
            if line_bytes.last() == Some(&b'\n') {
                line_bytes.pop();
            }
            if line_bytes.last() == Some(&b'\r') {
                line_bytes.pop();
            }
            let line = String::from_utf8_lossy(&line_bytes);
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if !trimmed.starts_with("data:") {
                continue;
            }
            let rest = trimmed[trimmed.find(':').map(|i| i + 1).unwrap_or(0)..].trim();
            if rest == "[DONE]" {
                if last_finish == "tool_calls" && tool_parts.is_empty() {
                    return Err("tool_calls finish without tool deltas".to_string());
                }
                return Ok(stream_outcome(last_finish, tool_parts, sent_any_content));
            }
            let v: Value = match serde_json::from_str(rest) {
                Ok(x) => x,
                Err(_) => continue,
            };
            if let Some(err) = v.get("error") {
                let msg = err
                    .get("message")
                    .and_then(|x| x.as_str())
                    .or_else(|| err.as_str())
                    .unwrap_or("upstream error");
                return Err(msg.to_string());
            }
            let Some(choice) = v.get("choices").and_then(|c| c.as_array()).and_then(|a| a.first()) else {
                continue;
            };
            if let Some(fr) = choice.get("finish_reason").and_then(|x| x.as_str()) {
                if !fr.is_empty() {
                    last_finish = fr.to_string();
                }
            }
            let delta = choice.get("delta").cloned().unwrap_or(json!({}));
            if let Some(content) = delta.get("content").and_then(|x| x.as_str()) {
                if !content.is_empty() {
                    sent_any_content = true;
                    let _ = tx.send(Ok(Event::default().data(json!({ "c": content }).to_string())));
                    tokio::task::yield_now().await;
                }
            }
            if let Some(arr) = delta.get("tool_calls").and_then(|x| x.as_array()) {
                merge_tool_call_deltas(&mut tool_parts, arr);
            }
        }
    }

    if last_finish == "tool_calls" && tool_parts.is_empty() {
        return Err("tool_calls finish without tool deltas".to_string());
    }
    Ok(stream_outcome(last_finish, tool_parts, sent_any_content))
}

fn stream_outcome(
    last_finish: String,
    tool_parts: BTreeMap<u32, ToolCallAcc>,
    sent_any_content: bool,
) -> (String, Option<Value>, bool) {
    if last_finish == "tool_calls" {
        let mut calls: Vec<Value> = Vec::new();
        for (_idx, acc) in tool_parts {
            calls.push(json!({
                "id": acc.id,
                "type": "function",
                "function": { "name": acc.name, "arguments": acc.arguments }
            }));
        }
        let message = json!({
            "role": "assistant",
            "content": Value::Null,
            "tool_calls": calls
        });
        return (last_finish, Some(message), sent_any_content);
    }
    (last_finish, None, sent_any_content)
}

#[derive(Debug, Deserialize)]
pub struct ChatStreamRequest {
    /// User-defined system instruction (merged with baby context on server).
    pub instruction: String,
    /// Serialized baby profile + recent entries from the client.
    pub baby_context: String,
    /// Recent conversation turns (user / assistant only).
    pub messages: Vec<ChatTurn>,
    /// When false, the model cannot invoke server-side tools (DB reads / drafts).
    #[serde(default)]
    pub allow_server_tools: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ChatTurn {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone)]
struct ContextPlan {
    include_profile: bool,
    include_vaccines: bool,
    include_entries: bool,
    prefer_stats: bool,
    entry_window_days: usize,
    max_entries: usize,
    category_hints: Vec<String>,
}

#[derive(Default)]
struct ContextBuildMeta {
    profile_used: bool,
    vaccine_rows: usize,
    entry_rows: usize,
    used_stats: bool,
}

const ALLOWED_CATEGORIES: &[&str] = &[
    "feeding",
    "sleep",
    "diaper",
    "temperature",
    "bath",
    "medicine",
    "supplement",
    "tummy_time",
    "growth",
    "spitup",
    "cry",
    "outdoor",
    "pump",
    "solid",
    "custom",
];

impl Default for ContextPlan {
    fn default() -> Self {
        Self {
            include_profile: true,
            include_vaccines: true,
            include_entries: true,
            prefer_stats: false,
            entry_window_days: 14,
            max_entries: 80,
            category_hints: Vec::new(),
        }
    }
}

const MAX_INSTRUCTION_LEN: usize = 16_000;
const MAX_CONTEXT_LEN: usize = 200_000;
const MAX_MESSAGES: usize = 40;
const MAX_TURN_LEN: usize = 24_000;
const MAX_TOOL_ROUNDS: u32 = 10;
const CONTEXT_MAX_WINDOW_DAYS: usize = 60;
const CONTEXT_MAX_ENTRIES: usize = 180;

fn sanitize_context_plan(mut plan: ContextPlan) -> ContextPlan {
    if plan.entry_window_days == 0 {
        plan.entry_window_days = 7;
    }
    plan.entry_window_days = plan.entry_window_days.min(CONTEXT_MAX_WINDOW_DAYS);
    if plan.max_entries == 0 {
        plan.max_entries = 40;
    }
    plan.max_entries = plan.max_entries.min(CONTEXT_MAX_ENTRIES);
    plan.category_hints = plan
        .category_hints
        .into_iter()
        .map(|x| x.trim().to_string())
        .filter(|x| ALLOWED_CATEGORIES.contains(&x.as_str()))
        .take(4)
        .collect();
    if plan.prefer_stats {
        plan.max_entries = plan.max_entries.min(30);
    }
    plan
}

fn summarize_fields(fields: &Value) -> String {
    let Some(obj) = fields.as_object() else {
        return String::new();
    };
    let mut parts = Vec::new();
    for (k, v) in obj.iter().take(4) {
        let val = if let Some(s) = v.as_str() {
            s.to_string()
        } else if let Some(n) = v.as_f64() {
            format!("{}", n)
        } else if let Some(b) = v.as_bool() {
            if b { "是".to_string() } else { "否".to_string() }
        } else {
            continue;
        };
        parts.push(format!("{}={}", k, val));
    }
    parts.join(", ")
}

fn extract_json_object(s: &str) -> Option<Value> {
    if let Ok(v) = serde_json::from_str::<Value>(s) {
        return Some(v);
    }
    let start = s.find('{')?;
    let end = s.rfind('}')?;
    if end <= start {
        return None;
    }
    serde_json::from_str::<Value>(&s[start..=end]).ok()
}

async fn plan_context_for_question(state: &AppState, question: &str) -> Option<ContextPlan> {
    let q = question.trim();
    if q.is_empty() {
        return None;
    }
    let planner_instruction = "你是上下文规划器。根据用户问题返回严格 JSON，不要返回解释文本。\
JSON schema: {\"include_profile\":bool,\"include_vaccines\":bool,\"include_entries\":bool,\"prefer_stats\":bool,\
\"entry_window_days\":number,\"max_entries\":number,\"category_hints\":string[]}。\
category_hints 仅可使用 feeding,sleep,diaper,temperature,bath,medicine,supplement,tummy_time,growth,spitup,cry,outdoor,pump,solid,custom。\
如果问题偏事实追问（某天/昨晚/最近一次）则 include_entries=true 且窗口更短。\
如果问题偏总体趋势（规律、整体）可 prefer_stats=true。";
    let body = json!({
        "model": state.deepseek_model,
        "stream": false,
        "max_tokens": 220,
        "temperature": 0.1,
        "messages": [
            { "role": "system", "content": planner_instruction },
            { "role": "user", "content": q }
        ]
    });
    let url = format!("{}/v1/chat/completions", state.deepseek_base_url.trim_end_matches('/'));
    let res = state
        .http_client
        .post(url)
        .header(
            "Authorization",
            format!("Bearer {}", state.deepseek_api_key.trim()),
        )
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .ok()?;
    if !res.status().is_success() {
        return None;
    }
    let j: Value = res.json().await.ok()?;
    let content = j
        .get("choices")
        .and_then(|x| x.as_array())
        .and_then(|arr| arr.first())
        .and_then(|x| x.get("message"))
        .and_then(|x| x.get("content"))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let v = extract_json_object(&content)?;
    let mut plan = ContextPlan::default();
    if let Some(x) = v.get("include_profile").and_then(|x| x.as_bool()) {
        plan.include_profile = x;
    }
    if let Some(x) = v.get("include_vaccines").and_then(|x| x.as_bool()) {
        plan.include_vaccines = x;
    }
    if let Some(x) = v.get("include_entries").and_then(|x| x.as_bool()) {
        plan.include_entries = x;
    }
    if let Some(x) = v.get("prefer_stats").and_then(|x| x.as_bool()) {
        plan.prefer_stats = x;
    }
    if let Some(x) = v.get("entry_window_days").and_then(|x| x.as_u64()) {
        plan.entry_window_days = x as usize;
    }
    if let Some(x) = v.get("max_entries").and_then(|x| x.as_u64()) {
        plan.max_entries = x as usize;
    }
    if let Some(arr) = v.get("category_hints").and_then(|x| x.as_array()) {
        plan.category_hints = arr
            .iter()
            .filter_map(|x| x.as_str().map(|s| s.to_string()))
            .collect();
    }
    Some(sanitize_context_plan(plan))
}

fn build_scoped_context(
    db_path: &PathBuf,
    user_id: &str,
    plan: &ContextPlan,
) -> Result<(String, ContextBuildMeta), String> {
    let conn = open_conn(db_path).map_err(|e| e.to_string())?;
    let mut lines: Vec<String> = Vec::new();
    let mut meta = ContextBuildMeta::default();

    if plan.include_profile {
        let row = conn.query_row(
            "SELECT name, birth_date, gender, blood FROM user_profile WHERE user_id = ?1",
            params![user_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            },
        );
        if let Ok((name, birth, gender, blood)) = row {
            lines.push("## 宝宝档案".to_string());
            lines.push(format!("昵称: {}", if name.is_empty() { "未填写" } else { &name }));
            lines.push(format!("出生日期: {}", if birth.is_empty() { "未填写" } else { &birth }));
            lines.push(format!("性别: {}", if gender.is_empty() { "未填写" } else { &gender }));
            lines.push(format!("血型: {}", if blood.is_empty() { "未填写" } else { &blood }));
            lines.push(String::new());
            meta.profile_used = true;
        }
    }

    if plan.include_vaccines {
        let mut stmt = conn
            .prepare(
                "SELECT name, dose, due_date, status, done_at FROM vaccines WHERE user_id = ?1 ORDER BY due_date ASC LIMIT 30",
            )
            .map_err(|e| e.to_string())?;
        let mut rows = stmt.query(params![user_id]).map_err(|e| e.to_string())?;
        let mut vaccine_lines = Vec::new();
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let name: String = row.get(0).map_err(|e| e.to_string())?;
            let dose: String = row.get(1).map_err(|e| e.to_string())?;
            let due_date: String = row.get(2).map_err(|e| e.to_string())?;
            let status: String = row.get(3).map_err(|e| e.to_string())?;
            let done_at: String = row.get(4).map_err(|e| e.to_string())?;
            vaccine_lines.push(format!(
                "{} · {} · 计划 {} · 状态 {}{}",
                name,
                dose,
                due_date,
                status,
                if done_at.is_empty() {
                    String::new()
                } else {
                    format!(" · 完成 {}", done_at)
                }
            ));
        }
        if !vaccine_lines.is_empty() {
            meta.vaccine_rows = vaccine_lines.len();
            lines.push("## 疫苗计划（摘要）".to_string());
            lines.extend(vaccine_lines);
            lines.push(String::new());
        }
    }

    if plan.include_entries {
        let cutoff_day = chrono::Utc::now()
            .date_naive()
            .checked_sub_days(chrono::Days::new(plan.entry_window_days as u64))
            .map(|d| d.to_string())
            .unwrap_or_else(|| "1970-01-01".to_string());
        if plan.prefer_stats {
            let mut stmt = conn
                .prepare(
                    "SELECT category_id, COUNT(*) as c FROM entries WHERE user_id = ?1 AND day >= ?2 GROUP BY category_id ORDER BY c DESC",
                )
                .map_err(|e| e.to_string())?;
            let mut rows = stmt.query(params![user_id, cutoff_day]).map_err(|e| e.to_string())?;
            lines.push("## 照护记录（统计摘要）".to_string());
            while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                let category: String = row.get(0).map_err(|e| e.to_string())?;
                let count: i64 = row.get(1).map_err(|e| e.to_string())?;
                lines.push(format!("{}: {}", category, count));
            }
            lines.push(String::new());
            meta.used_stats = true;
        }

        let mut sql =
            "SELECT at, category_id, fields_json, note FROM entries WHERE user_id = ?1 AND day >= ?2".to_string();
        if !plan.category_hints.is_empty() {
            let placeholders = (0..plan.category_hints.len())
                .map(|i| format!("?{}", i + 3))
                .collect::<Vec<_>>()
                .join(",");
            sql.push_str(&format!(" AND category_id IN ({})", placeholders));
        }
        sql.push_str(" ORDER BY at DESC LIMIT ?");
        let mut bind: Vec<rusqlite::types::Value> = vec![user_id.to_string().into(), cutoff_day.into()];
        for c in &plan.category_hints {
            bind.push(c.to_string().into());
        }
        bind.push((plan.max_entries as i64).into());
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut rows = stmt
            .query(rusqlite::params_from_iter(bind.iter()))
            .map_err(|e| e.to_string())?;
        let mut entry_lines = Vec::new();
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let at: String = row.get(0).map_err(|e| e.to_string())?;
            let category: String = row.get(1).map_err(|e| e.to_string())?;
            let fields_json: String = row.get(2).map_err(|e| e.to_string())?;
            let note: String = row.get(3).map_err(|e| e.to_string())?;
            let fields: Value = serde_json::from_str(&fields_json).unwrap_or(json!({}));
            let detail = summarize_fields(&fields);
            let mut line = format!("{} | {}", at, category);
            if !detail.is_empty() {
                line.push_str(&format!(" | {}", detail));
            }
            if !note.is_empty() {
                line.push_str(&format!(" | {}", note));
            }
            entry_lines.push(line);
        }
        if !entry_lines.is_empty() {
            meta.entry_rows = entry_lines.len();
            lines.push("## 照护记录（时间倒序）".to_string());
            lines.extend(entry_lines);
            lines.push(String::new());
        }
    }

    if lines.is_empty() {
        return Ok((String::new(), meta));
    }
    Ok((lines.join("\n"), meta))
}

pub async fn chat_stream(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<ChatStreamRequest>,
) -> Response {
    let user_id = match auth::authenticate_unsafe(&state, &headers).await {
        Ok(v) => v,
        Err(e) => return auth::auth_err_response(e),
    };
    if state.deepseek_api_key.trim().is_empty() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "error": "DeepSeek API key is not configured. Set DEEPSEEK_API_KEY for the babylog-api process."
            })),
        )
            .into_response();
    }

    if let Err(msg) = validate_request(&req) {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response();
    }

    let ip = ratelimit::client_ip(&headers, state.trust_proxy, None);
    let chat_key = format!("{}|{}", user_id, ip);
    if let Some(retry_after_sec) = state.chat_limiter.try_consume(&chat_key) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({
                "error": "AI 问答请求过于频繁，请稍后重试",
                "retry_after_sec": retry_after_sec
            })),
        )
            .into_response();
    }

    let allow_tools = req.allow_server_tools.unwrap_or(true);
    let ua = auth::user_agent(&headers);
    let last_user_text = req
        .messages
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .map(|m| m.content.clone())
        .unwrap_or_default();
    let planner_plan = plan_context_for_question(&state, &last_user_text)
        .await
        .unwrap_or_default();
    let planner_plan = sanitize_context_plan(planner_plan);
    let db_for_context = state.db_path.clone();
    let user_for_context = user_id.clone();
    let planner_plan_for_context = planner_plan.clone();
    let context_result = tokio::task::spawn_blocking(move || {
        build_scoped_context(&db_for_context, &user_for_context, &planner_plan_for_context)
    })
    .await
    .ok()
    .and_then(Result::ok);
    let (effective_context, planner_context_meta, context_source) = match context_result {
        Some((ctx, meta)) if !ctx.trim().is_empty() => (ctx, meta, "planner"),
        _ => (req.baby_context.clone(), ContextBuildMeta::default(), "fallback_client"),
    };
    let planner_summary = format!(
        "context_source={} plan[p={},v={},e={},stats={},days={},max={},cats={}] used[p={},vacc_rows={},entry_rows={},stats={}]",
        context_source,
        planner_plan.include_profile,
        planner_plan.include_vaccines,
        planner_plan.include_entries,
        planner_plan.prefer_stats,
        planner_plan.entry_window_days,
        planner_plan.max_entries,
        planner_plan.category_hints.join("|"),
        planner_context_meta.profile_used,
        planner_context_meta.vaccine_rows,
        planner_context_meta.entry_rows,
        planner_context_meta.used_stats,
    );
    let system_prompt = build_system_prompt(&req.instruction, &effective_context);
    let mut openai_messages: Vec<Value> = vec![json!({
        "role": "system",
        "content": system_prompt
    })];
    for m in &req.messages {
        let role = if m.role == "assistant" { "assistant" } else { "user" };
        openai_messages.push(json!({ "role": role, "content": m.content }));
    }

    let url = format!(
        "{}/v1/chat/completions",
        state.deepseek_base_url.trim_end_matches('/')
    );

    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Result<Event, Infallible>>();
    let state_clone = state.clone();
    let db_path = state.db_path.clone();
    let audit_user = user_id.clone();
    let audit_db = state.db_path.clone();
    let instruction_for_audit = req.instruction.clone();
    let planner_summary_for_audit = planner_summary.clone();

    tokio::spawn(async move {
        let tools_def = if allow_tools {
            ai_tools::openai_tools_definition()
        } else {
            Vec::new()
        };
        let mut tool_rounds_executed = 0u32;

        loop {
            let mut body = json!({
                "model": state_clone.deepseek_model,
                "messages": openai_messages,
                "stream": true
            });
            if !tools_def.is_empty() {
                body["tools"] = json!(tools_def);
                body["tool_choice"] = json!("auto");
            }

            let upstream = match state_clone
                .http_client
                .post(&url)
                .header(
                    "Authorization",
                    format!("Bearer {}", state_clone.deepseek_api_key.trim()),
                )
                .header("Content-Type", "application/json")
                .json(&body)
                .send()
                .await
            {
                Ok(r) => r,
                Err(e) => {
                    let _ = tx.send(Ok(Event::default().data(
                        json!({ "error": format!("failed to reach DeepSeek: {}", e) }).to_string(),
                    )));
                    break;
                }
            };

            if !upstream.status().is_success() {
                let status = upstream.status();
                let text = upstream.text().await.unwrap_or_default();
                let _ = tx.send(Ok(Event::default().data(
                    json!({ "error": format!("DeepSeek returned HTTP {}: {}", status.as_u16(), text) }).to_string(),
                )));
                break;
            }

            match forward_deepseek_stream(upstream, &tx).await {
                Ok((finish, tool_message, sent_any)) => {
                    if let Some(message) = tool_message {
                        tool_rounds_executed += 1;
                        if tool_rounds_executed > MAX_TOOL_ROUNDS {
                            let _ = tx.send(Ok(Event::default().data(
                                json!({ "error": "工具调用次数超过上限，请简化问题后重试" }).to_string(),
                            )));
                            break;
                        }
                        let tool_calls = message
                            .get("tool_calls")
                            .and_then(|x| x.as_array())
                            .cloned()
                            .unwrap_or_default();
                        openai_messages.push(message);

                        for tc in &tool_calls {
                            let id = tc.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
                            let name = tc
                                .get("function")
                                .and_then(|f| f.get("name"))
                                .and_then(|x| x.as_str())
                                .unwrap_or("")
                                .to_string();
                            let args = tc
                                .get("function")
                                .and_then(|f| f.get("arguments"))
                                .and_then(|x| x.as_str())
                                .unwrap_or("{}")
                                .to_string();

                            let result = ai_tools::run_tool(&db_path, &user_id, &name, &args).unwrap_or_else(|e| {
                                json!({ "error": e }).to_string()
                            });

                            if name == "create_draft_entry" {
                                if let Ok(val) = serde_json::from_str::<Value>(&result) {
                                    if val.get("ok").and_then(|x| x.as_bool()) == Some(true) {
                                        if let Some(d) = val.get("draft") {
                                            let payload = json!({
                                                "draft": d,
                                                "draft_token": val.get("draft_token")
                                            });
                                            let _ = tx.send(Ok(Event::default().data(payload.to_string())));
                                        }
                                    }
                                }
                            }

                            openai_messages.push(json!({
                                "role": "tool",
                                "tool_call_id": id,
                                "content": result
                            }));
                        }
                        continue;
                    }

                    let fin = finish.as_str();
                    if !sent_any && fin == "length" {
                        let _ = tx.send(Ok(Event::default().data(
                            json!({ "c": "（回答被长度限制截断，请缩短问题或重试。）" }).to_string(),
                        )));
                    } else if !sent_any && (fin == "stop" || fin.is_empty()) {
                        let _ = tx.send(Ok(Event::default().data(
                            json!({ "c": "（模型未返回文本内容。）" }).to_string(),
                        )));
                    }
                    break;
                }
                Err(e) => {
                    let _ = tx.send(Ok(Event::default().data(json!({ "error": e }).to_string())));
                    break;
                }
            }
        }

        let mut hasher = Sha256::new();
        hasher.update(instruction_for_audit.as_bytes());
        hasher.update(b"|");
        hasher.update(last_user_text.as_bytes());
        let digest = format!("{:x}", hasher.finalize());
        let detail = format!(
            "sha256_instruction_last_user={} tool_rounds={} {}",
            digest, tool_rounds_executed, planner_summary_for_audit
        );
        auth::write_audit(&audit_db, &audit_user, "", "ai_chat", &ip, &ua, &detail);

        let _ = tx.send(Ok(Event::default().data("[DONE]")));
    });

    let mut res = Sse::new(UnboundedReceiverStream::new(rx))
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
        .into_response();
    res.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-cache, no-transform"),
    );
    res.headers_mut().insert(
        HeaderName::from_static("x-accel-buffering"),
        HeaderValue::from_static("no"),
    );
    res
}

fn validate_request(req: &ChatStreamRequest) -> Result<(), String> {
    if req.instruction.len() > MAX_INSTRUCTION_LEN {
        return Err(format!("instruction too long (max {} chars)", MAX_INSTRUCTION_LEN));
    }
    if req.baby_context.len() > MAX_CONTEXT_LEN {
        return Err(format!("baby_context too long (max {} chars)", MAX_CONTEXT_LEN));
    }
    if req.messages.is_empty() {
        return Err("messages must not be empty".to_string());
    }
    if req.messages.len() > MAX_MESSAGES {
        return Err(format!("too many messages (max {})", MAX_MESSAGES));
    }
    for (i, m) in req.messages.iter().enumerate() {
        if m.role != "user" && m.role != "assistant" {
            return Err(format!("messages[{}].role must be user or assistant", i));
        }
        if m.content.is_empty() {
            return Err(format!("messages[{}].content is empty", i));
        }
        if m.content.len() > MAX_TURN_LEN {
            return Err(format!("messages[{}].content too long", i));
        }
    }
    Ok(())
}

fn build_system_prompt(instruction: &str, baby_context: &str) -> String {
    let tools_hint = "\n\n你可以调用提供的工具从服务器读取该账号下的真实记录与疫苗数据；不要编造工具结果。若用户想记账，先用 create_draft_entry 生成草稿，并提醒家长在应用中确认写入。";
    let base = instruction.trim();
    let ctx = baby_context.trim();
    let merged = if base.is_empty() && ctx.is_empty() {
        format!(
            "你是婴幼儿照护记录助手。请基于用户提供的宝宝数据摘要与对话内容作答。{}",
            tools_hint
        )
    } else if base.is_empty() {
        format!(
            "你是婴幼儿照护记录助手。请基于以下宝宝数据摘要与对话内容作答。\n\n## 宝宝数据摘要\n{}{}",
            ctx, tools_hint
        )
    } else if ctx.is_empty() {
        format!("{}{}", base, tools_hint)
    } else {
        format!(
            "{}\n\n## 宝宝数据摘要（请优先依据这些事实回答；不确定时请说明）\n{}{}",
            base, ctx, tools_hint
        )
    };
    merged
}
