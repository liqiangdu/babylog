use std::{collections::BTreeMap, env, net::SocketAddr, path::PathBuf, time::Duration};

mod chat;

use axum::{
    extract::{DefaultBodyLimit, Multipart, Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post, put},
    Json, Router,
};
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tokio::fs;
use tower_http::{cors::CorsLayer, services::ServeDir, trace::TraceLayer};
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
    #[serde(default)]
    photos: Vec<String>,
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
pub(crate) struct AppState {
    db_path: PathBuf,
    objects_dir: PathBuf,
    /// Public origin for absolute media URLs (e.g. https://api.example.com or http://127.0.0.1:8787).
    public_base: String,
    http_client: reqwest::Client,
    deepseek_api_key: String,
    deepseek_base_url: String,
    deepseek_model: String,
}

#[derive(Debug, Serialize)]
struct UploadResponse {
    urls: Vec<String>,
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
    #[serde(default)]
    photos: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct UpdateEntry {
    category_id: String,
    at: DateTime<Utc>,
    fields: Option<BTreeMap<String, serde_json::Value>>,
    note: Option<String>,
    #[serde(default)]
    photos: Option<Vec<String>>,
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
    let objects_dir = state.objects_dir.clone();
    let app = Router::new()
        .route("/health", get(health))
        .route("/api/profile", get(get_profile).put(put_profile))
        .route("/api/entries", get(list_entries).post(create_entry))
        .route("/api/entries/:id", put(update_entry).delete(delete_entry))
        .route("/api/uploads", post(upload_images))
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
        .route("/api/chat/stream", post(chat::chat_stream))
        .with_state(state)
        .nest_service("/media", ServeDir::new(objects_dir))
        .layer(DefaultBodyLimit::max(48 * 1024 * 1024))
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
    let objects_dir = PathBuf::from("data/objects");
    if let Some(parent) = db_path.parent() {
        let _ = fs::create_dir_all(parent).await;
    }
    let _ = fs::create_dir_all(&objects_dir).await;
    if let Err(e) = ensure_schema(&db_path) {
        tracing::error!("failed to initialize sqlite schema: {}", e);
        std::process::exit(1);
    }
    let public_base = env::var("BABYLOG_PUBLIC_BASE")
        .unwrap_or_else(|_| "http://127.0.0.1:8787".to_string())
        .trim_end_matches('/')
        .to_string();
    let http_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .connect_timeout(Duration::from_secs(15))
        .build()
        .expect("reqwest client");
    let deepseek_api_key = env::var("DEEPSEEK_API_KEY").unwrap_or_default();
    let deepseek_base_url = env::var("DEEPSEEK_BASE_URL")
        .unwrap_or_else(|_| "https://api.deepseek.com".to_string())
        .trim_end_matches('/')
        .to_string();
    let deepseek_model = env::var("DEEPSEEK_MODEL").unwrap_or_else(|_| "deepseek-chat".to_string());
    AppState {
        db_path,
        objects_dir,
        public_base,
        http_client,
        deepseek_api_key,
        deepseek_base_url,
        deepseek_model,
    }
}

const MAX_UPLOAD_BYTES: usize = 8 * 1024 * 1024;

fn sniff_image_ext(data: &[u8]) -> Option<&'static str> {
    if data.len() < 12 {
        return None;
    }
    if data.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("jpg");
    }
    if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("png");
    }
    if data.len() >= 6 && (&data[..6] == b"GIF87a" || &data[..6] == b"GIF89a") {
        return Some("gif");
    }
    if data.starts_with(b"RIFF") && data.len() >= 12 && &data[8..12] == b"WEBP" {
        return Some("webp");
    }
    None
}

async fn upload_images(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> impl IntoResponse {
    let mut urls = Vec::new();
    let mut saw_file_field = false;
    loop {
        let field = match multipart.next_field().await {
            Ok(Some(f)) => f,
            Ok(None) => break,
            Err(e) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({ "error": e.to_string() })),
                )
                    .into_response();
            }
        };
        let name = field.name().unwrap_or("");
        if name != "file" && name != "files" {
            continue;
        }
        saw_file_field = true;
        let data = match field.bytes().await {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!("multipart field read error: {}", e);
                continue;
            }
        };
        if data.is_empty() {
            continue;
        }
        if data.len() > MAX_UPLOAD_BYTES {
            tracing::warn!("skip upload: file too large ({} bytes)", data.len());
            continue;
        }
        let Some(ext) = sniff_image_ext(&data) else {
            tracing::warn!("skip upload: unsupported image signature");
            continue;
        };
        let id = Uuid::new_v4();
        let fname = format!("{}.{}", id, ext);
        let path = state.objects_dir.join(&fname);
        if let Err(e) = fs::write(&path, &data).await {
            tracing::error!("failed to write upload {}: {}", fname, e);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "failed to persist file" })),
            )
                .into_response();
        }
        urls.push(format!("{}/media/{}", state.public_base, fname));
    }

    if urls.is_empty() {
        let msg = if saw_file_field {
            "no valid image files stored (check type jpeg/png/gif/webp and max 8MB each)"
        } else {
            "no files received (use multipart form field name \"file\")"
        };
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": msg })),
        )
            .into_response();
    }

    (StatusCode::OK, Json(UploadResponse { urls })).into_response()
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
    migrate_entries_photos_column(&conn)?;
    Ok(())
}

fn migrate_entries_photos_column(conn: &Connection) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare("PRAGMA table_info(entries)")?;
    let cols: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<_, _>>()?;
    if cols.iter().any(|c| c == "photos_json") {
        return Ok(());
    }
    conn.execute(
        "ALTER TABLE entries ADD COLUMN photos_json TEXT NOT NULL DEFAULT '[]'",
        [],
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
            "SELECT id, category_id, at, fields_json, note, photos_json FROM entries {} ORDER BY at DESC LIMIT ?{} OFFSET ?{}",
            where_sql,
            if where_parts.is_empty() { 1 } else { where_parts.len() + 1 },
            if where_parts.is_empty() { 2 } else { where_parts.len() + 2 }
        );
        let mut stmt = conn.prepare(&list_sql).map_err(|e| e.to_string())?;

        let map_row = |row: &rusqlite::Row<'_>| -> rusqlite::Result<Entry> {
            let id_str: String = row.get(0)?;
            let at_str: String = row.get(2)?;
            let fields_str: String = row.get(3)?;
            let photos_str: String = row.get(5)?;
            let at = DateTime::parse_from_rfc3339(&at_str)
                .map_err(|_| rusqlite::Error::InvalidQuery)?
                .with_timezone(&Utc);
            let fields = serde_json::from_str::<BTreeMap<String, serde_json::Value>>(&fields_str)
                .unwrap_or_default();
            let photos = serde_json::from_str::<Vec<String>>(&photos_str).unwrap_or_default();
            Ok(Entry {
                id: Uuid::parse_str(&id_str).map_err(|_| rusqlite::Error::InvalidQuery)?,
                category_id: row.get(1)?,
                at,
                fields,
                note: row.get(4)?,
                photos,
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
        category_id: payload.category_id.clone(),
        at: payload.at,
        fields: payload.fields.clone().unwrap_or_default(),
        note: payload.note.clone().unwrap_or_default(),
        photos: payload.photos.clone().unwrap_or_default(),
    };
    let entry_clone = entry.clone();

    let result = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let conn = open_conn(&state.db_path).map_err(|e| e.to_string())?;
        let day = entry_clone.at.date_naive().to_string();
        let fields_json = serde_json::to_string(&entry_clone.fields).map_err(|e| e.to_string())?;
        let photos_json = serde_json::to_string(&entry_clone.photos).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO entries (id, category_id, at, day, fields_json, note, photos_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                entry_clone.id.to_string(),
                entry_clone.category_id,
                entry_clone.at.to_rfc3339(),
                day,
                fields_json,
                entry_clone.note,
                photos_json
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
        let photos_json =
            serde_json::to_string(&payload.photos.unwrap_or_default()).map_err(|e| e.to_string())?;
        let day = payload.at.date_naive().to_string();
        let updated = conn
            .execute(
                "UPDATE entries SET category_id = ?1, at = ?2, day = ?3, fields_json = ?4, note = ?5, photos_json = ?6 WHERE id = ?7",
                params![
                    payload.category_id,
                    payload.at.to_rfc3339(),
                    day,
                    fields_json,
                    payload.note.unwrap_or_default(),
                    photos_json,
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
