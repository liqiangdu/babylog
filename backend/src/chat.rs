use std::convert::Infallible;
use std::time::Duration;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse,
    },
    Json,
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio_stream::wrappers::UnboundedReceiverStream;

use crate::{auth, AppState};

#[derive(Debug, Deserialize)]
pub struct ChatStreamRequest {
    /// User-defined system instruction (merged with baby context on server).
    pub instruction: String,
    /// Serialized baby profile + recent entries from the client.
    pub baby_context: String,
    /// Recent conversation turns (user / assistant only).
    pub messages: Vec<ChatTurn>,
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

pub async fn chat_stream(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<ChatStreamRequest>,
) -> impl IntoResponse {
    if let Err(e) = auth::authenticate_unsafe(&state, &headers).await {
        return auth::auth_err_response(e);
    }
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

    let system_prompt = build_system_prompt(&req.instruction, &req.baby_context);
    let mut openai_messages: Vec<serde_json::Value> = vec![json!({
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
    let body = json!({
        "model": state.deepseek_model,
        "messages": openai_messages,
        "stream": true
    });

    let upstream = match state
        .http_client
        .post(&url)
        .header("Authorization", format!("Bearer {}", state.deepseek_api_key.trim()))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": format!("failed to reach DeepSeek: {}", e) })),
            )
                .into_response();
        }
    };

    if !upstream.status().is_success() {
        let status = upstream.status();
        let text = upstream.text().await.unwrap_or_default();
        return (
            StatusCode::BAD_GATEWAY,
            Json(json!({
                "error": format!("DeepSeek returned HTTP {}: {}", status.as_u16(), text)
            })),
        )
            .into_response();
    }

    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Result<Event, Infallible>>();
    let mut byte_stream = upstream.bytes_stream();

    tokio::spawn(async move {
        let mut buf: Vec<u8> = Vec::new();
        while let Some(item) = byte_stream.next().await {
            let chunk = match item {
                Ok(c) => c,
                Err(e) => {
                    let _ = tx.send(Ok(Event::default().data(
                        json!({ "error": format!("stream read error: {}", e) }).to_string(),
                    )));
                    break;
                }
            };
            buf.extend_from_slice(&chunk);
            drain_sse_blocks(&mut buf, &tx);
        }
        flush_sse_tail(&mut buf, &tx);
        let _ = tx.send(Ok(Event::default().data("[DONE]")));
    });

    Sse::new(UnboundedReceiverStream::new(rx))
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
        .into_response()
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
    let base = instruction.trim();
    let ctx = baby_context.trim();
    if base.is_empty() && ctx.is_empty() {
        return "你是婴幼儿照护记录助手。请基于用户提供的宝宝数据摘要与对话内容作答。".to_string();
    }
    if base.is_empty() {
        return format!(
            "你是婴幼儿照护记录助手。请基于以下宝宝数据摘要与对话内容作答。\n\n## 宝宝数据摘要\n{}",
            ctx
        );
    }
    if ctx.is_empty() {
        return base.to_string();
    }
    format!(
        "{}\n\n## 宝宝数据摘要（请优先依据这些事实回答；不确定时请说明）\n{}",
        base, ctx
    )
}

fn drain_sse_blocks(buf: &mut Vec<u8>, tx: &tokio::sync::mpsc::UnboundedSender<Result<Event, Infallible>>) {
    loop {
        let Some((event_end, consume_end)) = find_sse_frame(buf) else {
            break;
        };
        let frame: Vec<u8> = buf.drain(..consume_end).collect();
        process_sse_block(&frame[..event_end], tx);
    }
}

fn flush_sse_tail(buf: &mut Vec<u8>, tx: &tokio::sync::mpsc::UnboundedSender<Result<Event, Infallible>>) {
    if buf.is_empty() {
        return;
    }
    let block = std::mem::take(buf);
    if !block.is_empty() {
        process_sse_block(&block, tx);
    }
}

/// Returns `(event_end, consume_end)` where `buf[..event_end]` is the frame payload
/// (without the blank line delimiter) and `buf[..consume_end]` should be drained
/// (payload + delimiter).
fn find_sse_frame(buf: &[u8]) -> Option<(usize, usize)> {
    if let Some(i) = buf.windows(2).position(|w| w == b"\n\n") {
        return Some((i, i + 2));
    }
    if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
        return Some((i, i + 4));
    }
    None
}

fn process_sse_block(block: &[u8], tx: &tokio::sync::mpsc::UnboundedSender<Result<Event, Infallible>>) {
    let text = String::from_utf8_lossy(block);
    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(data) = line.strip_prefix("data:") {
            let data = data.trim();
            if data == "[DONE]" {
                continue;
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(data) else {
                continue;
            };
            if let Some(err) = v.get("error").and_then(|x| x.as_str()) {
                let _ = tx.send(Ok(Event::default().data(json!({ "error": err }).to_string())));
                continue;
            }
            let piece = v
                .pointer("/choices/0/delta/content")
                .and_then(|x| x.as_str())
                .unwrap_or("");
            if piece.is_empty() {
                continue;
            }
            let _ = tx.send(Ok(
                Event::default().data(json!({ "c": piece }).to_string()),
            ));
        }
    }
}
