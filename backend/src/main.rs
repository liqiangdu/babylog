use std::{collections::BTreeMap, net::SocketAddr, path::PathBuf};

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, put},
    Json, Router,
};
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tokio::fs;
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use tracing::info;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct Profile {
    name: String,
    birth_date: String,
    gender: String,
    blood: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Entry {
    id: Uuid,
    category_id: String,
    at: DateTime<Utc>,
    fields: BTreeMap<String, serde_json::Value>,
    note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct VaccineItem {
    id: String,
    name: String,
    dose: String,
    due_date: String,
    status: String,
    done_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct VaccineSettings {
    region: String,
    reminder_days: i64,
    notifications_enabled: bool,
    notified_map: BTreeMap<String, bool>,
}

impl Default for VaccineSettings {
    fn default() -> Self {
        Self {
            region: "cn".to_string(),
            reminder_days: 3,
            notifications_enabled: false,
            notified_map: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct VaccineTemplateItem {
    name: String,
    dose: String,
    day: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct CustomTemplate {
    label: String,
    items: Vec<VaccineTemplateItem>,
}

#[derive(Clone)]
struct AppState {
    db_path: PathBuf,
}

#[derive(Debug, Deserialize)]
struct EntryQuery {
    category: Option<String>,
    day: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct CreateEntry {
    category_id: String,
    at: DateTime<Utc>,
    fields: Option<BTreeMap<String, serde_json::Value>>,
    note: Option<String>,
}

#[derive(Debug, Deserialize)]
struct UpdateEntry {
    category_id: String,
    at: DateTime<Utc>,
    fields: Option<BTreeMap<String, serde_json::Value>>,
    note: Option<String>,
}

#[derive(Debug, Deserialize)]
struct StatsQuery {
    start: Option<String>,
    end: Option<String>,
}

#[derive(Debug, Serialize)]
struct StatsResponse {
    total_entries: usize,
    by_category: BTreeMap<String, usize>,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter("info")
        .with_target(false)
        .compact()
        .init();

    let state = bootstrap_state().await;
    let app = Router::new()
        .route("/health", get(health))
        .route("/api/profile", get(get_profile).put(put_profile))
        .route("/api/entries", get(list_entries).post(create_entry))
        .route("/api/entries/:id", put(update_entry).delete(delete_entry))
        .route("/api/vaccines", get(get_vaccines).put(put_vaccines))
        .route(
            "/api/vaccine-settings",
            get(get_vaccine_settings).put(put_vaccine_settings),
        )
        .route(
            "/api/vaccine-templates",
            get(get_vaccine_templates).put(put_vaccine_templates),
        )
        .route("/api/stats", get(get_stats))
        .with_state(state)
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http());

    let addr = SocketAddr::from(([127, 0, 0, 1], 8787));
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(listener) => listener,
        Err(err) => {
            tracing::error!("failed to bind {}: {}", addr, err);
            return;
        }
    };
    info!("babylog-api listening on http://{}", addr);
    axum::serve(listener, app).await.unwrap();
}

async fn bootstrap_state() -> AppState {
    let db_path = PathBuf::from("data/babylog.db");
    if let Some(parent) = db_path.parent() {
        let _ = fs::create_dir_all(parent).await;
    }
    if let Err(e) = ensure_schema(&db_path) {
        tracing::error!("failed to initialize sqlite schema: {}", e);
        std::process::exit(1);
    }
    AppState { db_path }
}

fn open_conn(db_path: &PathBuf) -> rusqlite::Result<Connection> {
    let conn = Connection::open(db_path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    Ok(conn)
}

fn ensure_schema(db_path: &PathBuf) -> rusqlite::Result<()> {
    let conn = open_conn(db_path)?;
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS profile (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          name TEXT NOT NULL DEFAULT '',
          birth_date TEXT NOT NULL DEFAULT '',
          gender TEXT NOT NULL DEFAULT '',
          blood TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS entries (
          id TEXT PRIMARY KEY,
          category_id TEXT NOT NULL,
          at TEXT NOT NULL,
          day TEXT NOT NULL,
          fields_json TEXT NOT NULL DEFAULT '{}',
          note TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_entries_at ON entries(at DESC);
        CREATE INDEX IF NOT EXISTS idx_entries_day ON entries(day);
        CREATE INDEX IF NOT EXISTS idx_entries_category ON entries(category_id);
        CREATE INDEX IF NOT EXISTS idx_entries_category_day ON entries(category_id, day);

        CREATE TABLE IF NOT EXISTS vaccines (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          dose TEXT NOT NULL,
          due_date TEXT NOT NULL,
          status TEXT NOT NULL,
          done_at TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_vaccines_due_date ON vaccines(due_date);
        CREATE INDEX IF NOT EXISTS idx_vaccines_status ON vaccines(status);

        CREATE TABLE IF NOT EXISTS vaccine_settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          region TEXT NOT NULL DEFAULT 'cn',
          reminder_days INTEGER NOT NULL DEFAULT 3,
          notifications_enabled INTEGER NOT NULL DEFAULT 0,
          notified_map_json TEXT NOT NULL DEFAULT '{}'
        );

        CREATE TABLE IF NOT EXISTS vaccine_templates (
          template_id TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          items_json TEXT NOT NULL
        );
        ",
    )?;
    Ok(())
}

async fn health() -> impl IntoResponse {
    (StatusCode::OK, Json(serde_json::json!({ "ok": true })))
}

async fn get_profile(State(state): State<AppState>) -> impl IntoResponse {
    let result = tokio::task::spawn_blocking(move || -> Result<Profile, String> {
        let conn = open_conn(&state.db_path).map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT name, birth_date, gender, blood FROM profile WHERE id = 1")
            .map_err(|e| e.to_string())?;
        let row = stmt.query_row([], |row| {
            Ok(Profile {
                name: row.get(0)?,
                birth_date: row.get(1)?,
                gender: row.get(2)?,
                blood: row.get(3)?,
            })
        });
        match row {
            Ok(v) => Ok(v),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(Profile::default()),
            Err(e) => Err(e.to_string()),
        }
    })
    .await;

    match result {
        Ok(Ok(profile)) => Json(profile).into_response(),
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "failed to load profile" })),
        )
            .into_response(),
    }
}

async fn put_profile(State(state): State<AppState>, Json(payload): Json<Profile>) -> impl IntoResponse {
    let result = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let conn = open_conn(&state.db_path).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO profile (id, name, birth_date, gender, blood)
             VALUES (1, ?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name,
               birth_date = excluded.birth_date,
               gender = excluded.gender,
               blood = excluded.blood",
            params![payload.name, payload.birth_date, payload.gender, payload.blood],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await;

    match result {
        Ok(Ok(())) => (StatusCode::OK, Json(serde_json::json!({ "saved": true }))).into_response(),
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "failed to save profile" })),
        )
            .into_response(),
    }
}

async fn list_entries(State(state): State<AppState>, Query(query): Query<EntryQuery>) -> impl IntoResponse {
    let result = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let conn = open_conn(&state.db_path).map_err(|e| e.to_string())?;
        let offset = query.offset.unwrap_or(0);
        let limit = query.limit.unwrap_or(20);
        let category = query.category.unwrap_or_default();
        let day = query.day.unwrap_or_default();

        let mut where_parts: Vec<&str> = Vec::new();
        if !category.is_empty() {
            where_parts.push("category_id = ?1");
        }
        if !day.is_empty() {
            where_parts.push(if category.is_empty() { "day = ?1" } else { "day = ?2" });
        }
        let where_sql = if where_parts.is_empty() {
            "".to_string()
        } else {
            format!("WHERE {}", where_parts.join(" AND "))
        };

        let total_sql = format!("SELECT COUNT(*) FROM entries {}", where_sql);
        let total: i64 = match (category.is_empty(), day.is_empty()) {
            (true, true) => conn.query_row(&total_sql, [], |r| r.get(0)),
            (false, true) => conn.query_row(&total_sql, params![category], |r| r.get(0)),
            (true, false) => conn.query_row(&total_sql, params![day], |r| r.get(0)),
            (false, false) => conn.query_row(&total_sql, params![category, day], |r| r.get(0)),
        }
        .map_err(|e| e.to_string())?;

        let list_sql = format!(
            "SELECT id, category_id, at, fields_json, note FROM entries {} ORDER BY at DESC LIMIT ?{} OFFSET ?{}",
            where_sql,
            if where_parts.is_empty() { 1 } else { where_parts.len() + 1 },
            if where_parts.is_empty() { 2 } else { where_parts.len() + 2 }
        );
        let mut stmt = conn.prepare(&list_sql).map_err(|e| e.to_string())?;

        let map_row = |row: &rusqlite::Row<'_>| -> rusqlite::Result<Entry> {
            let id_str: String = row.get(0)?;
            let at_str: String = row.get(2)?;
            let fields_str: String = row.get(3)?;
            let at = DateTime::parse_from_rfc3339(&at_str)
                .map_err(|_| rusqlite::Error::InvalidQuery)?
                .with_timezone(&Utc);
            let fields = serde_json::from_str::<BTreeMap<String, serde_json::Value>>(&fields_str)
                .unwrap_or_default();
            Ok(Entry {
                id: Uuid::parse_str(&id_str).map_err(|_| rusqlite::Error::InvalidQuery)?,
                category_id: row.get(1)?,
                at,
                fields,
                note: row.get(4)?,
            })
        };

        let rows = match (category.is_empty(), day.is_empty()) {
            (true, true) => stmt.query_map(params![limit as i64, offset as i64], map_row),
            (false, true) => stmt.query_map(params![category, limit as i64, offset as i64], map_row),
            (true, false) => stmt.query_map(params![day, limit as i64, offset as i64], map_row),
            (false, false) => {
                stmt.query_map(params![category, day, limit as i64, offset as i64], map_row)
            }
        }
        .map_err(|e| e.to_string())?;

        let mut items = Vec::new();
        for row in rows {
            items.push(row.map_err(|e| e.to_string())?);
        }
        Ok(serde_json::json!({
            "total": total as usize,
            "offset": offset,
            "limit": limit,
            "items": items
        }))
    })
    .await;

    match result {
        Ok(Ok(v)) => Json(v).into_response(),
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "failed to query entries" })),
        )
            .into_response(),
    }
}

async fn create_entry(State(state): State<AppState>, Json(payload): Json<CreateEntry>) -> impl IntoResponse {
    let entry = Entry {
        id: Uuid::new_v4(),
        category_id: payload.category_id,
        at: payload.at,
        fields: payload.fields.unwrap_or_default(),
        note: payload.note.unwrap_or_default(),
    };
    let entry_clone = entry.clone();

    let result = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let conn = open_conn(&state.db_path).map_err(|e| e.to_string())?;
        let day = entry_clone.at.date_naive().to_string();
        let fields_json = serde_json::to_string(&entry_clone.fields).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO entries (id, category_id, at, day, fields_json, note) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                entry_clone.id.to_string(),
                entry_clone.category_id,
                entry_clone.at.to_rfc3339(),
                day,
                fields_json,
                entry_clone.note
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await;

    match result {
        Ok(Ok(())) => (StatusCode::CREATED, Json(entry)).into_response(),
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "failed to create entry" })),
        )
            .into_response(),
    }
}

async fn update_entry(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(payload): Json<UpdateEntry>,
) -> impl IntoResponse {
    let result = tokio::task::spawn_blocking(move || -> Result<usize, String> {
        let conn = open_conn(&state.db_path).map_err(|e| e.to_string())?;
        let fields_json = serde_json::to_string(&payload.fields.unwrap_or_default()).map_err(|e| e.to_string())?;
        let day = payload.at.date_naive().to_string();
        let updated = conn
            .execute(
                "UPDATE entries SET category_id = ?1, at = ?2, day = ?3, fields_json = ?4, note = ?5 WHERE id = ?6",
                params![
                    payload.category_id,
                    payload.at.to_rfc3339(),
                    day,
                    fields_json,
                    payload.note.unwrap_or_default(),
                    id.to_string()
                ],
            )
            .map_err(|e| e.to_string())?;
        Ok(updated)
    })
    .await;

    match result {
        Ok(Ok(0)) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "entry not found" })),
        )
            .into_response(),
        Ok(Ok(_)) => (StatusCode::OK, Json(serde_json::json!({ "updated": true }))).into_response(),
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "failed to update entry" })),
        )
            .into_response(),
    }
}

async fn delete_entry(State(state): State<AppState>, Path(id): Path<Uuid>) -> impl IntoResponse {
    let result = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let conn = open_conn(&state.db_path).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM entries WHERE id = ?1", params![id.to_string()])
            .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await;
    match result {
        Ok(Ok(())) => (StatusCode::OK, Json(serde_json::json!({ "deleted": true }))).into_response(),
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "failed to delete entry" })),
        )
            .into_response(),
    }
}

async fn get_stats(State(state): State<AppState>, Query(query): Query<StatsQuery>) -> impl IntoResponse {
    let result = tokio::task::spawn_blocking(move || -> Result<StatsResponse, String> {
        let conn = open_conn(&state.db_path).map_err(|e| e.to_string())?;
        let start = query.start.unwrap_or_default();
        let end = query.end.unwrap_or_default();
        let mut where_parts: Vec<&str> = Vec::new();
        if !start.is_empty() {
            where_parts.push("day >= ?1");
        }
        if !end.is_empty() {
            where_parts.push(if start.is_empty() { "day <= ?1" } else { "day <= ?2" });
        }
        let where_sql = if where_parts.is_empty() {
            "".to_string()
        } else {
            format!("WHERE {}", where_parts.join(" AND "))
        };
        let sql = format!(
            "SELECT category_id, COUNT(*) as c FROM entries {} GROUP BY category_id",
            where_sql
        );
        let mut by_category = BTreeMap::new();
        let mut total_entries = 0usize;
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        match (start.is_empty(), end.is_empty()) {
            (true, true) => {
                let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
                while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                    let category: String = row.get(0).map_err(|e| e.to_string())?;
                    let count: i64 = row.get(1).map_err(|e| e.to_string())?;
                    by_category.insert(category, count as usize);
                    total_entries += count as usize;
                }
            }
            (false, true) => {
                let mut rows = stmt.query(params![start]).map_err(|e| e.to_string())?;
                while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                    let category: String = row.get(0).map_err(|e| e.to_string())?;
                    let count: i64 = row.get(1).map_err(|e| e.to_string())?;
                    by_category.insert(category, count as usize);
                    total_entries += count as usize;
                }
            }
            (true, false) => {
                let mut rows = stmt.query(params![end]).map_err(|e| e.to_string())?;
                while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                    let category: String = row.get(0).map_err(|e| e.to_string())?;
                    let count: i64 = row.get(1).map_err(|e| e.to_string())?;
                    by_category.insert(category, count as usize);
                    total_entries += count as usize;
                }
            }
            (false, false) => {
                let mut rows = stmt.query(params![start, end]).map_err(|e| e.to_string())?;
                while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                    let category: String = row.get(0).map_err(|e| e.to_string())?;
                    let count: i64 = row.get(1).map_err(|e| e.to_string())?;
                    by_category.insert(category, count as usize);
                    total_entries += count as usize;
                }
            }
        }
        Ok(StatsResponse {
            total_entries,
            by_category,
        })
    })
    .await;

    match result {
        Ok(Ok(v)) => Json(v).into_response(),
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "failed to query stats" })),
        )
            .into_response(),
    }
}

async fn get_vaccines(State(state): State<AppState>) -> impl IntoResponse {
    let result = tokio::task::spawn_blocking(move || -> Result<Vec<VaccineItem>, String> {
        let conn = open_conn(&state.db_path).map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id, name, dose, due_date, status, done_at FROM vaccines ORDER BY due_date ASC")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(VaccineItem {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    dose: row.get(2)?,
                    due_date: row.get(3)?,
                    status: row.get(4)?,
                    done_at: row.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut items = Vec::new();
        for row in rows {
            items.push(row.map_err(|e| e.to_string())?);
        }
        Ok(items)
    })
    .await;
    match result {
        Ok(Ok(v)) => Json(v).into_response(),
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "failed to load vaccines" })),
        )
            .into_response(),
    }
}

async fn put_vaccines(State(state): State<AppState>, Json(payload): Json<Vec<VaccineItem>>) -> impl IntoResponse {
    let result = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let mut conn = open_conn(&state.db_path).map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM vaccines", []).map_err(|e| e.to_string())?;
        for v in payload {
            tx.execute(
                "INSERT INTO vaccines (id, name, dose, due_date, status, done_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![v.id, v.name, v.dose, v.due_date, v.status, v.done_at],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    })
    .await;
    match result {
        Ok(Ok(())) => (StatusCode::OK, Json(serde_json::json!({ "saved": true }))).into_response(),
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "failed to save vaccines" })),
        )
            .into_response(),
    }
}

async fn get_vaccine_settings(State(state): State<AppState>) -> impl IntoResponse {
    let result = tokio::task::spawn_blocking(move || -> Result<VaccineSettings, String> {
        let conn = open_conn(&state.db_path).map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT region, reminder_days, notifications_enabled, notified_map_json
                 FROM vaccine_settings WHERE id = 1",
            )
            .map_err(|e| e.to_string())?;
        let row = stmt.query_row([], |row| {
            let notified_map_json: String = row.get(3)?;
            Ok(VaccineSettings {
                region: row.get(0)?,
                reminder_days: row.get(1)?,
                notifications_enabled: row.get::<_, i64>(2)? == 1,
                notified_map: serde_json::from_str(&notified_map_json).unwrap_or_default(),
            })
        });
        match row {
            Ok(v) => Ok(v),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(VaccineSettings::default()),
            Err(e) => Err(e.to_string()),
        }
    })
    .await;
    match result {
        Ok(Ok(v)) => Json(v).into_response(),
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "failed to load vaccine settings" })),
        )
            .into_response(),
    }
}

async fn put_vaccine_settings(
    State(state): State<AppState>,
    Json(payload): Json<VaccineSettings>,
) -> impl IntoResponse {
    let result = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let conn = open_conn(&state.db_path).map_err(|e| e.to_string())?;
        let notified_map_json = serde_json::to_string(&payload.notified_map).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO vaccine_settings (id, region, reminder_days, notifications_enabled, notified_map_json)
             VALUES (1, ?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET
               region = excluded.region,
               reminder_days = excluded.reminder_days,
               notifications_enabled = excluded.notifications_enabled,
               notified_map_json = excluded.notified_map_json",
            params![
                payload.region,
                payload.reminder_days,
                if payload.notifications_enabled { 1 } else { 0 },
                notified_map_json
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await;
    match result {
        Ok(Ok(())) => (StatusCode::OK, Json(serde_json::json!({ "saved": true }))).into_response(),
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "failed to save vaccine settings" })),
        )
            .into_response(),
    }
}

async fn get_vaccine_templates(State(state): State<AppState>) -> impl IntoResponse {
    let result = tokio::task::spawn_blocking(move || -> Result<BTreeMap<String, CustomTemplate>, String> {
        let conn = open_conn(&state.db_path).map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT template_id, label, items_json FROM vaccine_templates")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                let template_id: String = row.get(0)?;
                let label: String = row.get(1)?;
                let items_json: String = row.get(2)?;
                let items = serde_json::from_str::<Vec<VaccineTemplateItem>>(&items_json).unwrap_or_default();
                Ok((template_id, CustomTemplate { label, items }))
            })
            .map_err(|e| e.to_string())?;
        let mut out = BTreeMap::new();
        for row in rows {
            let (k, v) = row.map_err(|e| e.to_string())?;
            out.insert(k, v);
        }
        Ok(out)
    })
    .await;
    match result {
        Ok(Ok(v)) => Json(v).into_response(),
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "failed to load vaccine templates" })),
        )
            .into_response(),
    }
}

async fn put_vaccine_templates(
    State(state): State<AppState>,
    Json(payload): Json<BTreeMap<String, CustomTemplate>>,
) -> impl IntoResponse {
    let result = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let mut conn = open_conn(&state.db_path).map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM vaccine_templates", []).map_err(|e| e.to_string())?;
        for (template_id, tpl) in payload {
            let items_json = serde_json::to_string(&tpl.items).map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT INTO vaccine_templates (template_id, label, items_json) VALUES (?1, ?2, ?3)",
                params![template_id, tpl.label, items_json],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    })
    .await;
    match result {
        Ok(Ok(())) => (StatusCode::OK, Json(serde_json::json!({ "saved": true }))).into_response(),
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "failed to save vaccine templates" })),
        )
            .into_response(),
    }
}
