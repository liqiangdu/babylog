//! Persisted AI Q&A project (sessions + settings) per authenticated user.

use axum::{
    extract::State,
    http::HeaderMap,
    response::IntoResponse,
    Json,
};
use rusqlite::params;
use serde_json::{json, Value};

use crate::{auth, open_conn, AppState};

const MAX_PROJECT_JSON_BYTES: usize = 8 * 1024 * 1024;
const MAX_INSTRUCTION_LEN: usize = 16_000;
const MAX_SESSIONS: usize = 200;
const MAX_MESSAGES_PER_SESSION: usize = 500;
const MAX_MESSAGE_CONTENT_LEN: usize = 256_000;
const MAX_TITLE_LEN: usize = 200;

fn validate_ai_project(v: &Value) -> Result<(), String> {
    let obj = v
        .as_object()
        .ok_or_else(|| "project must be a JSON object".to_string())?;

    let instruction = obj
        .get("instruction")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "instruction must be a string".to_string())?;
    if instruction.len() > MAX_INSTRUCTION_LEN {
        return Err(format!(
            "instruction too long (max {} chars)",
            MAX_INSTRUCTION_LEN
        ));
    }

    let active = obj
        .get("activeSessionId")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "activeSessionId must be a string".to_string())?;
    if active.len() > 200 {
        return Err("activeSessionId too long".to_string());
    }

    let policy = obj
        .get("contextPolicy")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "contextPolicy must be a string".to_string())?;
    let policies = ["full_recent", "stats_only", "recent_7d", "timeline_filter"];
    if !policies.contains(&policy) {
        return Err("invalid contextPolicy".to_string());
    }

    if let Some(c) = obj.get("aiContextConsent") {
        if !c.is_object() && !c.is_null() {
            return Err("aiContextConsent must be an object".to_string());
        }
    }

    if let Some(b) = obj.get("syncSessionsDisclaimerAck") {
        if !b.is_boolean() {
            return Err("syncSessionsDisclaimerAck must be a boolean".to_string());
        }
    }

    let sessions = obj
        .get("sessions")
        .and_then(|x| x.as_array())
        .ok_or_else(|| "sessions must be an array".to_string())?;
    if sessions.len() > MAX_SESSIONS {
        return Err(format!("too many sessions (max {})", MAX_SESSIONS));
    }

    for s in sessions {
        let so = s
            .as_object()
            .ok_or_else(|| "each session must be an object".to_string())?;
        let title = so
            .get("title")
            .and_then(|x| x.as_str())
            .unwrap_or("");
        if title.len() > MAX_TITLE_LEN {
            return Err("session title too long".to_string());
        }
        let id = so
            .get("id")
            .and_then(|x| x.as_str())
            .ok_or_else(|| "session id must be a string".to_string())?;
        if id.is_empty() || id.len() > 200 {
            return Err("invalid session id".to_string());
        }
        let messages = so
            .get("messages")
            .and_then(|x| x.as_array())
            .ok_or_else(|| "messages must be an array".to_string())?;
        if messages.len() > MAX_MESSAGES_PER_SESSION {
            return Err(format!(
                "too many messages in session {} (max {})",
                id, MAX_MESSAGES_PER_SESSION
            ));
        }
        for m in messages {
            let mo = m
                .as_object()
                .ok_or_else(|| "each message must be an object".to_string())?;
            let role = mo
                .get("role")
                .and_then(|x| x.as_str())
                .ok_or_else(|| "message role must be a string".to_string())?;
            if role != "user" && role != "assistant" {
                return Err("message role must be user or assistant".to_string());
            }
            let content = mo
                .get("content")
                .and_then(|x| x.as_str())
                .ok_or_else(|| "message content must be a string".to_string())?;
            if content.len() > MAX_MESSAGE_CONTENT_LEN {
                return Err("message content too long".to_string());
            }
            if let Some(ts) = mo.get("ts").and_then(|x| x.as_str()) {
                if ts.len() > 80 {
                    return Err("message ts too long".to_string());
                }
            }
        }
    }

    Ok(())
}

pub async fn get_ai_project(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let user_id = match auth::authenticate_headers(&state, &headers).await {
        Ok(v) => v,
        Err(e) => return auth::auth_err_response(e),
    };
    let db_path = state.db_path.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<(Option<Value>, Option<i64>), String> {
        let conn = open_conn(&db_path).map_err(|e| e.to_string())?;
        let row: Result<(String, i64), rusqlite::Error> = conn.query_row(
            "SELECT payload_json, updated_at FROM user_ai_project WHERE user_id = ?1",
            params![user_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        );
        match row {
            Ok((json_s, updated_at)) => {
                let v: Value = serde_json::from_str(&json_s).map_err(|e| e.to_string())?;
                Ok((Some(v), Some(updated_at)))
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok((None, None)),
            Err(e) => Err(e.to_string()),
        }
    })
    .await;

    match result {
        Ok(Ok((Some(project), Some(updated_at)))) => {
            Json(json!({ "project": project, "updated_at": updated_at })).into_response()
        }
        Ok(Ok((None, None))) => Json(json!({ "project": null, "updated_at": null })).into_response(),
        _ => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "failed to load ai project" })),
        )
            .into_response(),
    }
}

pub async fn put_ai_project(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> impl IntoResponse {
    let user_id = match auth::authenticate_unsafe(&state, &headers).await {
        Ok(v) => v,
        Err(e) => return auth::auth_err_response(e),
    };

    if let Err(msg) = validate_ai_project(&payload) {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(json!({ "error": msg })),
        )
            .into_response();
    }

    let json_str = match serde_json::to_string(&payload) {
        Ok(s) => s,
        Err(e) => {
            return (
                axum::http::StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("serialize: {}", e) })),
            )
                .into_response();
        }
    };
    if json_str.len() > MAX_PROJECT_JSON_BYTES {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(json!({ "error": "project JSON too large" })),
        )
            .into_response();
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let db_path = state.db_path.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<i64, String> {
        let conn = open_conn(&db_path).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO user_ai_project (user_id, payload_json, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(user_id) DO UPDATE SET
               payload_json = excluded.payload_json,
               updated_at = excluded.updated_at",
            params![user_id, json_str, now],
        )
        .map_err(|e| e.to_string())?;
        Ok(now)
    })
    .await;

    match result {
        Ok(Ok(updated_at)) => {
            Json(json!({ "saved": true, "updated_at": updated_at })).into_response()
        }
        _ => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "failed to save ai project" })),
        )
            .into_response(),
    }
}
