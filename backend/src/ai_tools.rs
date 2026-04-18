//! OpenAI-style tool definitions and validated execution against the local DB.

use std::collections::BTreeMap;
use std::path::PathBuf;

use chrono::{DateTime, NaiveDate, Utc};
use rusqlite::params;
use serde_json::{json, Value};

use crate::open_conn;

const ALLOWED_CATEGORIES: &[&str] = &[
    "feeding", "sleep", "diaper", "temperature", "bath", "medicine", "supplement", "tummy_time",
    "growth", "spitup", "cry", "outdoor", "pump", "solid", "custom",
];

/// JSON array for the `tools` field of `/v1/chat/completions`.
pub fn openai_tools_definition() -> Vec<Value> {
    vec![
        json!({
            "type": "function",
            "function": {
                "name": "list_entries",
                "description": "List log entries for the authenticated user in a calendar-day range (inclusive). Use for factual questions about past records.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "start_day": { "type": "string", "description": "Start date YYYY-MM-DD (inclusive)" },
                        "end_day": { "type": "string", "description": "End date YYYY-MM-DD (inclusive)" },
                        "category": { "type": "string", "description": "Optional category id filter (e.g. feeding, sleep)" },
                        "limit": { "type": "integer", "description": "Max rows, default 30, max 60" },
                        "offset": { "type": "integer", "description": "Pagination offset, default 0" }
                    },
                    "required": ["start_day", "end_day"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "get_stats",
                "description": "Aggregate entry counts by category for a day range (optional; omit for all time).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "start_day": { "type": "string", "description": "Optional start YYYY-MM-DD" },
                        "end_day": { "type": "string", "description": "Optional end YYYY-MM-DD" }
                    },
                    "required": []
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "summarize_range",
                "description": "Per-day entry counts plus category totals for a date range (compact summary).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "start_day": { "type": "string" },
                        "end_day": { "type": "string" }
                    },
                    "required": ["start_day", "end_day"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "list_vaccines",
                "description": "Return the user's vaccine schedule rows from the database.",
                "parameters": { "type": "object", "properties": {}, "required": [] }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "explain_vaccine_row",
                "description": "Return one vaccine row by id for precise citation.",
                "parameters": {
                    "type": "object",
                    "properties": { "vaccine_id": { "type": "string" } },
                    "required": ["vaccine_id"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "create_draft_entry",
                "description": "Validate a proposed log entry and return a draft for parent confirmation (does not write to DB). Use category_id from: feeding, sleep, diaper, temperature, bath, medicine, supplement, tummy_time, growth, spitup, cry, outdoor, pump, solid, custom.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "category_id": { "type": "string" },
                        "at": { "type": "string", "description": "ISO-8601 timestamp (RFC3339)" },
                        "fields": { "type": "object", "additionalProperties": true },
                        "note": { "type": "string" }
                    },
                    "required": ["category_id", "at", "fields"]
                }
            }
        }),
    ]
}

fn parse_day(s: &str) -> Result<NaiveDate, String> {
    NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d").map_err(|_| format!("invalid date (expected YYYY-MM-DD): {}", s))
}

fn category_allowed(id: &str) -> bool {
    ALLOWED_CATEGORIES.iter().any(|c| *c == id)
}

/// Run a single tool; returns JSON string suitable for a `tool` message `content`.
pub fn run_tool(db_path: &PathBuf, user_id: &str, name: &str, arguments: &str) -> Result<String, String> {
    let args: Value = serde_json::from_str(arguments).map_err(|e| format!("invalid tool arguments JSON: {}", e))?;
    match name {
        "list_entries" => tool_list_entries(db_path, user_id, &args),
        "get_stats" => tool_get_stats(db_path, user_id, &args),
        "summarize_range" => tool_summarize_range(db_path, user_id, &args),
        "list_vaccines" => tool_list_vaccines(db_path, user_id),
        "explain_vaccine_row" => tool_explain_vaccine_row(db_path, user_id, &args),
        "create_draft_entry" => tool_create_draft_entry(&args),
        _ => Err(format!("unknown tool: {}", name)),
    }
}

fn tool_list_entries(db_path: &PathBuf, user_id: &str, args: &Value) -> Result<String, String> {
    let start_s = args.get("start_day").and_then(|x| x.as_str()).ok_or_else(|| "start_day required".to_string())?;
    let end_s = args.get("end_day").and_then(|x| x.as_str()).ok_or_else(|| "end_day required".to_string())?;
    let _ = parse_day(start_s)?;
    let _ = parse_day(end_s)?;
    if start_s > end_s {
        return Err("start_day must be <= end_day".to_string());
    }
    let limit = args
        .get("limit")
        .and_then(|x| x.as_u64())
        .unwrap_or(30)
        .clamp(1, 60) as usize;
    let offset = args.get("offset").and_then(|x| x.as_u64()).unwrap_or(0) as usize;
    let category = args.get("category").and_then(|x| x.as_str()).unwrap_or("").trim();
    if !category.is_empty() && !category_allowed(category) {
        return Err(format!("unsupported category_id: {}", category));
    }

    let conn = open_conn(db_path).map_err(|e| e.to_string())?;
    let mut clauses = vec!["user_id = ?1".to_string(), "day >= ?2".to_string(), "day <= ?3".to_string()];
    let mut bind: Vec<rusqlite::types::Value> = vec![
        user_id.to_string().into(),
        start_s.to_string().into(),
        end_s.to_string().into(),
    ];
    if !category.is_empty() {
        bind.push(category.to_string().into());
        clauses.push(format!("category_id = ?{}", bind.len()));
    }
    let where_sql = clauses.join(" AND ");
    let total_sql = format!("SELECT COUNT(*) FROM entries WHERE {}", where_sql);
    let total: i64 = conn
        .query_row(&total_sql, rusqlite::params_from_iter(bind.iter()), |r| r.get(0))
        .map_err(|e| e.to_string())?;

    let mut bind2 = bind.clone();
    bind2.push((limit as i64).into());
    let lim_i = bind2.len();
    bind2.push((offset as i64).into());
    let off_i = bind2.len();
    let sql = format!(
        "SELECT id, category_id, at, fields_json, note, photos_json FROM entries WHERE {} ORDER BY at DESC LIMIT ?{} OFFSET ?{}",
        where_sql, lim_i, off_i
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mut rows = stmt.query(rusqlite::params_from_iter(bind2.iter())).map_err(|e| e.to_string())?;
    let mut items = Vec::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let id: String = row.get(0).map_err(|e| e.to_string())?;
        let category_id: String = row.get(1).map_err(|e| e.to_string())?;
        let at: String = row.get(2).map_err(|e| e.to_string())?;
        let fields_json: String = row.get(3).map_err(|e| e.to_string())?;
        let note: String = row.get(4).map_err(|e| e.to_string())?;
        let photos_json: String = row.get(5).map_err(|e| e.to_string())?;
        let fields: Value = serde_json::from_str(&fields_json).unwrap_or(json!({}));
        let photos: Value = serde_json::from_str(&photos_json).unwrap_or(json!([]));
        items.push(json!({
            "id": id,
            "category_id": category_id,
            "at": at,
            "fields": fields,
            "note": note,
            "photos": photos
        }));
    }
    Ok(json!({
        "total": total,
        "offset": offset,
        "limit": limit,
        "items": items
    })
    .to_string())
}

fn tool_get_stats(db_path: &PathBuf, user_id: &str, args: &Value) -> Result<String, String> {
    let start = args.get("start_day").and_then(|x| x.as_str()).unwrap_or("").trim();
    let end = args.get("end_day").and_then(|x| x.as_str()).unwrap_or("").trim();
    if !start.is_empty() {
        let _ = parse_day(start)?;
    }
    if !end.is_empty() {
        let _ = parse_day(end)?;
    }
    if !start.is_empty() && !end.is_empty() && start > end {
        return Err("start_day must be <= end_day".to_string());
    }

    let conn = open_conn(db_path).map_err(|e| e.to_string())?;
    let mut clauses = vec!["user_id = ?1".to_string()];
    let mut bind: Vec<rusqlite::types::Value> = vec![user_id.to_string().into()];
    if !start.is_empty() {
        bind.push(start.to_string().into());
        clauses.push(format!("day >= ?{}", bind.len()));
    }
    if !end.is_empty() {
        bind.push(end.to_string().into());
        clauses.push(format!("day <= ?{}", bind.len()));
    }
    let where_sql = clauses.join(" AND ");
    let sql = format!(
        "SELECT category_id, COUNT(*) as c FROM entries WHERE {} GROUP BY category_id",
        where_sql
    );
    let mut by_category = BTreeMap::new();
    let mut total_entries = 0usize;
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mut rows = stmt.query(rusqlite::params_from_iter(bind.iter())).map_err(|e| e.to_string())?;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let category: String = row.get(0).map_err(|e| e.to_string())?;
        let count: i64 = row.get(1).map_err(|e| e.to_string())?;
        by_category.insert(category, count as usize);
        total_entries += count as usize;
    }
    Ok(json!({
        "total_entries": total_entries,
        "by_category": by_category
    })
    .to_string())
}

fn tool_summarize_range(db_path: &PathBuf, user_id: &str, args: &Value) -> Result<String, String> {
    let start_s = args.get("start_day").and_then(|x| x.as_str()).ok_or_else(|| "start_day required".to_string())?;
    let end_s = args.get("end_day").and_then(|x| x.as_str()).ok_or_else(|| "end_day required".to_string())?;
    let _ = parse_day(start_s)?;
    let _ = parse_day(end_s)?;
    if start_s > end_s {
        return Err("start_day must be <= end_day".to_string());
    }
    let stats = tool_get_stats(
        db_path,
        user_id,
        &json!({ "start_day": start_s, "end_day": end_s }),
    )?;
    let conn = open_conn(db_path).map_err(|e| e.to_string())?;
    let sql = "SELECT day, COUNT(*) FROM entries WHERE user_id = ?1 AND day >= ?2 AND day <= ?3 GROUP BY day ORDER BY day ASC";
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let mut rows = stmt.query(params![user_id, start_s, end_s]).map_err(|e| e.to_string())?;
    let mut per_day = Vec::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let day: String = row.get(0).map_err(|e| e.to_string())?;
        let c: i64 = row.get(1).map_err(|e| e.to_string())?;
        per_day.push(json!({ "day": day, "count": c }));
    }
    Ok(json!({
        "stats": serde_json::from_str::<Value>(&stats).unwrap_or(json!({})),
        "per_day": per_day
    })
    .to_string())
}

fn tool_list_vaccines(db_path: &PathBuf, user_id: &str) -> Result<String, String> {
    let conn = open_conn(db_path).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, name, dose, due_date, status, done_at FROM vaccines WHERE user_id = ?1 ORDER BY due_date ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![user_id], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "name": row.get::<_, String>(1)?,
                "dose": row.get::<_, String>(2)?,
                "due_date": row.get::<_, String>(3)?,
                "status": row.get::<_, String>(4)?,
                "done_at": row.get::<_, String>(5)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    let mut items = Vec::new();
    for r in rows {
        items.push(r.map_err(|e| e.to_string())?);
    }
    Ok(json!({ "items": items }).to_string())
}

fn tool_explain_vaccine_row(db_path: &PathBuf, user_id: &str, args: &Value) -> Result<String, String> {
    let vid = args.get("vaccine_id").and_then(|x| x.as_str()).ok_or_else(|| "vaccine_id required".to_string())?;
    if vid.len() > 128 {
        return Err("vaccine_id too long".to_string());
    }
    let conn = open_conn(db_path).map_err(|e| e.to_string())?;
    let row = conn.query_row(
        "SELECT id, name, dose, due_date, status, done_at FROM vaccines WHERE user_id = ?1 AND id = ?2",
        params![user_id, vid],
        |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "name": row.get::<_, String>(1)?,
                "dose": row.get::<_, String>(2)?,
                "due_date": row.get::<_, String>(3)?,
                "status": row.get::<_, String>(4)?,
                "done_at": row.get::<_, String>(5)?,
            }))
        },
    );
    match row {
        Ok(v) => Ok(json!({ "found": true, "vaccine": v }).to_string()),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(json!({ "found": false }).to_string()),
        Err(e) => Err(e.to_string()),
    }
}

fn sanitize_fields(obj: &Value) -> Result<BTreeMap<String, Value>, String> {
    let m = obj.as_object().ok_or_else(|| "fields must be an object".to_string())?;
    if m.len() > 32 {
        return Err("too many field keys".to_string());
    }
    let mut out = BTreeMap::new();
    for (k, v) in m {
        if k.len() > 64 || !k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return Err(format!("invalid field key: {}", k));
        }
        match v {
            Value::String(s) => {
                if s.len() > 4000 {
                    return Err(format!("field {} too long", k));
                }
                out.insert(k.clone(), Value::String(s.clone()));
            }
            Value::Number(n) => {
                out.insert(k.clone(), Value::Number(n.clone()));
            }
            Value::Bool(b) => {
                out.insert(k.clone(), Value::Bool(*b));
            }
            Value::Null => {}
            _ => return Err(format!("field {} has unsupported type", k)),
        }
    }
    Ok(out)
}

fn tool_create_draft_entry(args: &Value) -> Result<String, String> {
    let category_id = args
        .get("category_id")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "category_id required".to_string())?
        .trim();
    if !category_allowed(category_id) {
        return Err(format!("invalid category_id: {}", category_id));
    }
    let at_s = args.get("at").and_then(|x| x.as_str()).ok_or_else(|| "at required".to_string())?;
    let at: DateTime<Utc> = DateTime::parse_from_rfc3339(at_s.trim())
        .map(|d| d.with_timezone(&Utc))
        .map_err(|_| format!("invalid at (RFC3339): {}", at_s))?;
    let fields = args.get("fields").ok_or_else(|| "fields required".to_string())?;
    let map = sanitize_fields(fields)?;
    let note = args
        .get("note")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim();
    if note.len() > 4000 {
        return Err("note too long".to_string());
    }
    let draft_token = uuid::Uuid::new_v4().to_string();
    Ok(json!({
        "ok": true,
        "draft_token": draft_token,
        "draft": {
            "category_id": category_id,
            "at": at.to_rfc3339(),
            "fields": map,
            "note": note,
            "photos": []
        }
    })
    .to_string())
}
