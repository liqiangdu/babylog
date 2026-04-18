use std::collections::BTreeMap;
use std::convert::Infallible;
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
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio_stream::wrappers::UnboundedReceiverStream;

use crate::{auth, ai_tools, ratelimit, AppState};

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

const MAX_INSTRUCTION_LEN: usize = 16_000;
const MAX_CONTEXT_LEN: usize = 200_000;
const MAX_MESSAGES: usize = 40;
const MAX_TURN_LEN: usize = 24_000;
const MAX_TOOL_ROUNDS: u32 = 10;

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
    let system_prompt = build_system_prompt(&req.instruction, &req.baby_context);
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
    let last_user_text = req
        .messages
        .last()
        .filter(|m| m.role == "user")
        .map(|m| m.content.clone())
        .unwrap_or_default();
    let instruction_for_audit = req.instruction.clone();

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
            "sha256_instruction_last_user={} tool_rounds={}",
            digest, tool_rounds_executed
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
