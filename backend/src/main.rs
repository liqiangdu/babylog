use std::{collections::BTreeMap, env, net::SocketAddr, path::PathBuf, sync::Arc, time::Duration};

mod auth;
mod chat;
mod ratelimit;

use axum::{
    extract::{DefaultBodyLimit, Multipart, Path, Query, State},
    http::{HeaderValue, Method, Request, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tokio::fs;
use tower_http::{
    cors::{AllowOrigin, CorsLayer},
    services::ServeDir,
    trace::TraceLayer,
};
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
    /// Rate limiter for login/register attempts (shared across handlers).
    pub(crate) auth_limiter: Arc<ratelimit::RateLimiter>,
    /// Whether to trust X-Forwarded-For / X-Real-IP when computing client IP.
    pub(crate) trust_proxy: bool,
    /// Secret pepper prepended (via HMAC) to passwords before argon2 hashing.
    pub(crate) password_pepper: String,
    /// If true, login/register also set an HttpOnly session cookie.
    pub(crate) cookie_mode: bool,
    /// Secure attribute for cookies (set when serving over HTTPS).
    pub(crate) cookie_secure: bool,
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
    let cors = build_cors_layer();
    spawn_background_tasks(state.clone());

    // Per-path body limits: JSON endpoints are small, only /api/uploads needs
    // the generous 48MB allowance.
    let uploads_router = Router::new()
        .route("/api/uploads", post(upload_images))
        .layer(DefaultBodyLimit::max(48 * 1024 * 1024));

    let api_router = Router::new()
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
        .route("/api/auth/register", post(auth::register))
        .route("/api/auth/login", post(auth::login))
        .route("/api/auth/me", get(auth::me))
        .route("/api/auth/logout", post(auth::logout))
        .route("/api/auth/avatar", put(auth::update_avatar))
        .route("/api/audit", get(auth::list_audit))
        .route("/api/chat/stream", post(chat::chat_stream))
        .layer(DefaultBodyLimit::max(1024 * 1024));

    let app = Router::new()
        .route("/health", get(health))
        .merge(uploads_router)
        .merge(api_router)
        .with_state(state)
        .nest_service("/media", ServeDir::new(objects_dir))
        .layer(middleware::from_fn(security_headers))
        .layer(cors)
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

/// Build the CORS layer from `BABYLOG_ALLOWED_ORIGINS` (comma-separated).
/// Default allow-list covers local dev origins; set the env var to lock it
/// down in production. Set `BABYLOG_CORS_PERMISSIVE=1` to override and allow *
/// (not recommended once you enable auth in production).
fn build_cors_layer() -> CorsLayer {
    let methods = [
        Method::GET,
        Method::POST,
        Method::PUT,
        Method::DELETE,
        Method::OPTIONS,
    ];
    let headers = [
        axum::http::header::AUTHORIZATION,
        axum::http::header::CONTENT_TYPE,
        axum::http::HeaderName::from_static("x-csrf-token"),
    ];

    if env::var("BABYLOG_CORS_PERMISSIVE").ok().as_deref() == Some("1") {
        return CorsLayer::permissive();
    }

    let raw = env::var("BABYLOG_ALLOWED_ORIGINS").unwrap_or_else(|_| {
        "http://localhost:3000,http://localhost:5173,http://localhost:8080,\
         http://127.0.0.1:3000,http://127.0.0.1:5173,http://127.0.0.1:8080,\
         http://localhost:8787,http://127.0.0.1:8787"
            .to_string()
    });
    let origins: Vec<HeaderValue> = raw
        .split(',')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .filter_map(|s| HeaderValue::from_str(s).ok())
        .collect();

    CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_methods(methods)
        .allow_headers(headers)
        .allow_credentials(true)
}

/// Attach defensive response headers to every request. HSTS is opt-in (only
/// sensible when you terminate TLS in front of the app); the rest are safe to
/// send everywhere.
async fn security_headers(req: Request<axum::body::Body>, next: Next) -> Response {
    let mut resp = next.run(req).await;
    let headers = resp.headers_mut();
    headers.insert(
        axum::http::header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        axum::http::header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        axum::http::HeaderName::from_static("permissions-policy"),
        HeaderValue::from_static("geolocation=(), microphone=(), camera=()"),
    );
    headers.insert(
        axum::http::header::X_FRAME_OPTIONS,
        HeaderValue::from_static("DENY"),
    );
    if env::var("BABYLOG_HSTS").ok().as_deref() == Some("1") {
        headers.insert(
            axum::http::HeaderName::from_static("strict-transport-security"),
            HeaderValue::from_static("max-age=31536000; includeSubDomains"),
        );
    }
    resp
}

fn spawn_background_tasks(state: AppState) {
    // GC rate-limit buckets every minute.
    let limiter = state.auth_limiter.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(60));
        loop {
            tick.tick().await;
            limiter.gc();
        }
    });
    // Sweep expired sessions every hour.
    let db_path = state.db_path.clone();
    tokio::spawn(async move {
        // Run once shortly after startup, then hourly.
        tokio::time::sleep(Duration::from_secs(5)).await;
        loop {
            let p = db_path.clone();
            let _ = tokio::task::spawn_blocking(move || -> Result<(), String> {
                let conn = open_conn(&p).map_err(|e| e.to_string())?;
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);
                let removed = conn
                    .execute("DELETE FROM sessions WHERE expires_at <= ?1", params![now])
                    .map_err(|e| e.to_string())?;
                if removed > 0 {
                    tracing::info!("expired sessions removed: {}", removed);
                }
                Ok(())
            })
            .await;
            tokio::time::sleep(Duration::from_secs(3600)).await;
        }
    });
}

async fn bootstrap_state() -> AppState {
    let db_path = PathBuf::from("data/babylog.db");
    let objects_dir = PathBuf::from("data/objects");
    if let Some(parent) = db_path.parent() {
        let _ = fs::create_dir_all(parent).await;
    }
    let _ = fs::create_dir_all(&objects_dir).await;
    if let Err(e) = ensure_schema(&db_path, &objects_dir) {
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
    let trust_proxy = env::var("BABYLOG_TRUST_PROXY").ok().as_deref() == Some("1");
    let password_pepper = env::var("BABYLOG_PEPPER").unwrap_or_default();
    if password_pepper.is_empty() {
        tracing::warn!(
            "BABYLOG_PEPPER is unset; password hashes are stored without an extra HMAC layer. \
             Set BABYLOG_PEPPER to a long random string before running in production."
        );
    }
    let cookie_mode = env::var("BABYLOG_COOKIE_MODE")
        .ok()
        .as_deref()
        .map(|v| v != "0")
        .unwrap_or(true);
    let cookie_secure = env::var("BABYLOG_COOKIE_SECURE").ok().as_deref() == Some("1");
    // 20 failures per 10 min triggers lockout; 10 failures => locked for 15 min.
    let auth_limiter = Arc::new(ratelimit::RateLimiter::new(
        Duration::from_secs(600),
        20,
        10,
        Duration::from_secs(900),
    ));
    AppState {
        db_path,
        objects_dir,
        public_base,
        http_client,
        deepseek_api_key,
        deepseek_base_url,
        deepseek_model,
        auth_limiter,
        trust_proxy,
        password_pepper,
        cookie_mode,
        cookie_secure,
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
    headers: axum::http::HeaderMap,
    mut multipart: Multipart,
) -> impl IntoResponse {
    let user_id = match auth::authenticate_unsafe(&state, &headers).await {
        Ok(v) => v,
        Err(e) => return auth::auth_err_response(e),
    };
    let ip = ratelimit::client_ip(&headers, state.trust_proxy, None);
    let ua = auth::user_agent(&headers);
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
        tracing::info!(
            target: "uploads",
            user = %user_id,
            file = %fname,
            bytes = data.len(),
            "stored uploaded image"
        );
        auth::write_audit(
            &state.db_path,
            &user_id,
            "",
            "upload",
            &ip,
            &ua,
            &format!("{} ({} bytes)", fname, data.len()),
        );
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

pub(crate) fn open_conn(db_path: &PathBuf) -> rusqlite::Result<Connection> {
    let conn = Connection::open(db_path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    Ok(conn)
}

fn ensure_schema(db_path: &PathBuf, objects_dir: &std::path::Path) -> rusqlite::Result<()> {
    let conn = open_conn(db_path)?;
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS entries (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          category_id TEXT NOT NULL,
          at TEXT NOT NULL,
          day TEXT NOT NULL,
          fields_json TEXT NOT NULL DEFAULT '{}',
          note TEXT NOT NULL DEFAULT '',
          photos_json TEXT NOT NULL DEFAULT '[]'
        );
        CREATE INDEX IF NOT EXISTS idx_entries_user_at ON entries(user_id, at DESC);
        CREATE INDEX IF NOT EXISTS idx_entries_user_day ON entries(user_id, day);
        CREATE INDEX IF NOT EXISTS idx_entries_user_category ON entries(user_id, category_id);
        CREATE INDEX IF NOT EXISTS idx_entries_user_category_day ON entries(user_id, category_id, day);

        CREATE TABLE IF NOT EXISTS vaccines (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          name TEXT NOT NULL,
          dose TEXT NOT NULL,
          due_date TEXT NOT NULL,
          status TEXT NOT NULL,
          done_at TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_vaccines_user_due ON vaccines(user_id, due_date);

        CREATE TABLE IF NOT EXISTS user_profile (
          user_id TEXT PRIMARY KEY,
          name TEXT NOT NULL DEFAULT '',
          birth_date TEXT NOT NULL DEFAULT '',
          gender TEXT NOT NULL DEFAULT '',
          blood TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS user_vaccine_settings (
          user_id TEXT PRIMARY KEY,
          region TEXT NOT NULL DEFAULT 'cn',
          reminder_days INTEGER NOT NULL DEFAULT 3,
          notifications_enabled INTEGER NOT NULL DEFAULT 0,
          notified_map_json TEXT NOT NULL DEFAULT '{}'
        );

        CREATE TABLE IF NOT EXISTS user_vaccine_templates (
          user_id TEXT NOT NULL,
          template_id TEXT NOT NULL,
          label TEXT NOT NULL,
          items_json TEXT NOT NULL,
          PRIMARY KEY (user_id, template_id)
        );
        ",
    )?;
    // Upgrade path for DBs that predate the per-user refactor.
    add_column_if_missing(&conn, "entries", "user_id", "TEXT NOT NULL DEFAULT ''")?;
    add_column_if_missing(&conn, "vaccines", "user_id", "TEXT NOT NULL DEFAULT ''")?;
    migrate_entries_photos_column(&conn)?;
    auth::ensure_auth_schema(&conn)?;
    purge_legacy_data(&conn, objects_dir)?;
    Ok(())
}

/// One-time cleanup of data that predates the multi-user schema.
///
/// Earlier versions of Babylog stored a single family's records in un-scoped
/// tables (`profile`, `vaccine_settings`, `vaccine_templates`) and in
/// `entries` / `vaccines` rows without a `user_id`. When multi-user support
/// landed we temporarily parked all of that under a synthetic `__legacy__`
/// owner so no data was silently dropped on upgrade. Nobody can log in as
/// that owner, so the rows are just dead weight.
///
/// This routine runs on every startup, finds anything still attributed to
/// `__legacy__` (plus the old single-row tables), deletes it, drops the
/// tables, and unlinks any photo objects the deleted entries referenced.
/// It's idempotent: on a clean DB all counts are zero and it does nothing.
fn purge_legacy_data(
    conn: &Connection,
    objects_dir: &std::path::Path,
) -> rusqlite::Result<()> {
    let legacy = "__legacy__";

    let mut photo_files: Vec<String> = Vec::new();
    {
        let mut stmt = conn.prepare("SELECT photos_json FROM entries WHERE user_id = ?1")?;
        let rows = stmt.query_map(params![legacy], |r| r.get::<_, String>(0))?;
        for row in rows {
            let raw = row.unwrap_or_default();
            if let Ok(serde_json::Value::Array(arr)) =
                serde_json::from_str::<serde_json::Value>(&raw)
            {
                for v in arr {
                    if let Some(s) = v.as_str() {
                        if let Some(name) = s.rsplit('/').next() {
                            if !name.is_empty() {
                                photo_files.push(name.to_string());
                            }
                        }
                    }
                }
            }
        }
    }

    let old_tables = ["profile", "vaccine_settings", "vaccine_templates"];
    let mut present_old: Vec<&str> = Vec::new();
    for t in &old_tables {
        if table_exists(conn, t)? {
            present_old.push(*t);
        }
    }

    let tx = conn.unchecked_transaction()?;
    let del_entries = tx.execute("DELETE FROM entries WHERE user_id = ?1", params![legacy])?;
    let del_vaccines = tx.execute("DELETE FROM vaccines WHERE user_id = ?1", params![legacy])?;
    let del_profile = tx.execute(
        "DELETE FROM user_profile WHERE user_id = ?1",
        params![legacy],
    )?;
    let del_vset = tx.execute(
        "DELETE FROM user_vaccine_settings WHERE user_id = ?1",
        params![legacy],
    )?;
    let del_vtpl = tx.execute(
        "DELETE FROM user_vaccine_templates WHERE user_id = ?1",
        params![legacy],
    )?;
    for t in &present_old {
        tx.execute(&format!("DROP TABLE IF EXISTS {}", t), [])?;
    }
    tx.commit()?;
    let dropped = present_old;

    let touched = del_entries + del_vaccines + del_profile + del_vset + del_vtpl;
    if touched == 0 && dropped.is_empty() {
        return Ok(());
    }

    let mut removed_files = 0usize;
    let mut missing_files = 0usize;
    for name in &photo_files {
        let path = objects_dir.join(name);
        match std::fs::remove_file(&path) {
            Ok(()) => removed_files += 1,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => missing_files += 1,
            Err(e) => {
                tracing::warn!("failed to delete legacy object {}: {}", path.display(), e);
            }
        }
    }

    tracing::info!(
        "legacy data purged: entries={} vaccines={} profile={} vaccine_settings={} \
         vaccine_templates={} dropped_tables={:?} photos_removed={} photos_missing={}",
        del_entries,
        del_vaccines,
        del_profile,
        del_vset,
        del_vtpl,
        dropped,
        removed_files,
        missing_files,
    );

    Ok(())
}

fn add_column_if_missing(
    conn: &Connection,
    table: &str,
    column: &str,
    decl: &str,
) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", table))?;
    let cols: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<_, _>>()?;
    if cols.iter().any(|c| c == column) {
        return Ok(());
    }
    conn.execute(
        &format!("ALTER TABLE {} ADD COLUMN {} {}", table, column, decl),
        [],
    )?;
    Ok(())
}

fn table_exists(conn: &Connection, name: &str) -> rusqlite::Result<bool> {
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = ?1",
            params![name],
            |r| r.get(0),
        )
        .unwrap_or(0);
    Ok(count > 0)
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

async fn get_profile(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
) -> impl IntoResponse {
    let user_id = match auth::authenticate_headers(&state, &headers).await {
        Ok(v) => v,
        Err(e) => return auth::auth_err_response(e),
    };
    let result = tokio::task::spawn_blocking(move || -> Result<Profile, String> {
        let conn = open_conn(&state.db_path).map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT name, birth_date, gender, blood FROM user_profile WHERE user_id = ?1")
            .map_err(|e| e.to_string())?;
        let row = stmt.query_row(params![user_id], |row| {
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

async fn put_profile(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(payload): Json<Profile>,
) -> impl IntoResponse {
    let user_id = match auth::authenticate_unsafe(&state, &headers).await {
        Ok(v) => v,
        Err(e) => return auth::auth_err_response(e),
    };
    let ip = ratelimit::client_ip(&headers, state.trust_proxy, None);
    let ua = auth::user_agent(&headers);
    let audit_user = user_id.clone();
    let db_for_audit = state.db_path.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let conn = open_conn(&state.db_path).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO user_profile (user_id, name, birth_date, gender, blood)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(user_id) DO UPDATE SET
               name = excluded.name,
               birth_date = excluded.birth_date,
               gender = excluded.gender,
               blood = excluded.blood",
            params![user_id, payload.name, payload.birth_date, payload.gender, payload.blood],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await;

    match result {
        Ok(Ok(())) => {
            auth::write_audit(&db_for_audit, &audit_user, "", "profile_update", &ip, &ua, "");
            (StatusCode::OK, Json(serde_json::json!({ "saved": true }))).into_response()
        }
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "failed to save profile" })),
        )
            .into_response(),
    }
}

async fn list_entries(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Query(query): Query<EntryQuery>,
) -> impl IntoResponse {
    let user_id = match auth::authenticate_headers(&state, &headers).await {
        Ok(v) => v,
        Err(e) => return auth::auth_err_response(e),
    };
    let result = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let conn = open_conn(&state.db_path).map_err(|e| e.to_string())?;
        let offset = query.offset.unwrap_or(0);
        let limit = query.limit.unwrap_or(20);
        let category = query.category.unwrap_or_default();
        let day = query.day.unwrap_or_default();

        let mut clauses: Vec<String> = vec!["user_id = ?1".to_string()];
        let mut bind: Vec<rusqlite::types::Value> = vec![user_id.clone().into()];
        if !category.is_empty() {
            bind.push(category.clone().into());
            clauses.push(format!("category_id = ?{}", bind.len()));
        }
        if !day.is_empty() {
            bind.push(day.clone().into());
            clauses.push(format!("day = ?{}", bind.len()));
        }
        let where_sql = format!("WHERE {}", clauses.join(" AND "));

        let total_sql = format!("SELECT COUNT(*) FROM entries {}", where_sql);
        let total: i64 = conn
            .query_row(
                &total_sql,
                rusqlite::params_from_iter(bind.iter()),
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;

        bind.push((limit as i64).into());
        let limit_idx = bind.len();
        bind.push((offset as i64).into());
        let offset_idx = bind.len();
        let list_sql = format!(
            "SELECT id, category_id, at, fields_json, note, photos_json FROM entries {} \
             ORDER BY at DESC LIMIT ?{} OFFSET ?{}",
            where_sql, limit_idx, offset_idx
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

        let rows = stmt
            .query_map(rusqlite::params_from_iter(bind.iter()), map_row)
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

async fn create_entry(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(payload): Json<CreateEntry>,
) -> impl IntoResponse {
    let user_id = match auth::authenticate_unsafe(&state, &headers).await {
        Ok(v) => v,
        Err(e) => return auth::auth_err_response(e),
    };
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
            "INSERT INTO entries (id, user_id, category_id, at, day, fields_json, note, photos_json) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                entry_clone.id.to_string(),
                user_id,
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
    headers: axum::http::HeaderMap,
    Path(id): Path<Uuid>,
    Json(payload): Json<UpdateEntry>,
) -> impl IntoResponse {
    let user_id = match auth::authenticate_unsafe(&state, &headers).await {
        Ok(v) => v,
        Err(e) => return auth::auth_err_response(e),
    };
    let result = tokio::task::spawn_blocking(move || -> Result<usize, String> {
        let conn = open_conn(&state.db_path).map_err(|e| e.to_string())?;
        let fields_json = serde_json::to_string(&payload.fields.unwrap_or_default()).map_err(|e| e.to_string())?;
        let photos_json =
            serde_json::to_string(&payload.photos.unwrap_or_default()).map_err(|e| e.to_string())?;
        let day = payload.at.date_naive().to_string();
        let updated = conn
            .execute(
                "UPDATE entries SET category_id = ?1, at = ?2, day = ?3, fields_json = ?4, note = ?5, photos_json = ?6 \
                 WHERE id = ?7 AND user_id = ?8",
                params![
                    payload.category_id,
                    payload.at.to_rfc3339(),
                    day,
                    fields_json,
                    payload.note.unwrap_or_default(),
                    photos_json,
                    id.to_string(),
                    user_id
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

async fn delete_entry(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<Uuid>,
) -> impl IntoResponse {
    let user_id = match auth::authenticate_unsafe(&state, &headers).await {
        Ok(v) => v,
        Err(e) => return auth::auth_err_response(e),
    };
    let ip = ratelimit::client_ip(&headers, state.trust_proxy, None);
    let ua = auth::user_agent(&headers);
    let audit_user = user_id.clone();
    let db_for_audit = state.db_path.clone();
    let entry_id = id.to_string();
    let result = tokio::task::spawn_blocking(move || -> Result<usize, String> {
        let conn = open_conn(&state.db_path).map_err(|e| e.to_string())?;
        let n = conn
            .execute(
                "DELETE FROM entries WHERE id = ?1 AND user_id = ?2",
                params![id.to_string(), user_id],
            )
            .map_err(|e| e.to_string())?;
        Ok(n)
    })
    .await;
    match result {
        Ok(Ok(0)) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "entry not found" })),
        )
            .into_response(),
        Ok(Ok(_)) => {
            auth::write_audit(
                &db_for_audit,
                &audit_user,
                "",
                "entry_delete",
                &ip,
                &ua,
                &entry_id,
            );
            (StatusCode::OK, Json(serde_json::json!({ "deleted": true }))).into_response()
        }
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "failed to delete entry" })),
        )
            .into_response(),
    }
}

async fn get_stats(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Query(query): Query<StatsQuery>,
) -> impl IntoResponse {
    let user_id = match auth::authenticate_headers(&state, &headers).await {
        Ok(v) => v,
        Err(e) => return auth::auth_err_response(e),
    };
    let result = tokio::task::spawn_blocking(move || -> Result<StatsResponse, String> {
        let conn = open_conn(&state.db_path).map_err(|e| e.to_string())?;
        let start = query.start.unwrap_or_default();
        let end = query.end.unwrap_or_default();

        let mut clauses: Vec<String> = vec!["user_id = ?1".to_string()];
        let mut bind: Vec<rusqlite::types::Value> = vec![user_id.clone().into()];
        if !start.is_empty() {
            bind.push(start.into());
            clauses.push(format!("day >= ?{}", bind.len()));
        }
        if !end.is_empty() {
            bind.push(end.into());
            clauses.push(format!("day <= ?{}", bind.len()));
        }
        let where_sql = format!("WHERE {}", clauses.join(" AND "));
        let sql = format!(
            "SELECT category_id, COUNT(*) as c FROM entries {} GROUP BY category_id",
            where_sql
        );

        let mut by_category = BTreeMap::new();
        let mut total_entries = 0usize;
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut rows = stmt
            .query(rusqlite::params_from_iter(bind.iter()))
            .map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let category: String = row.get(0).map_err(|e| e.to_string())?;
            let count: i64 = row.get(1).map_err(|e| e.to_string())?;
            by_category.insert(category, count as usize);
            total_entries += count as usize;
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

async fn get_vaccines(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
) -> impl IntoResponse {
    let user_id = match auth::authenticate_headers(&state, &headers).await {
        Ok(v) => v,
        Err(e) => return auth::auth_err_response(e),
    };
    let result = tokio::task::spawn_blocking(move || -> Result<Vec<VaccineItem>, String> {
        let conn = open_conn(&state.db_path).map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, name, dose, due_date, status, done_at FROM vaccines \
                 WHERE user_id = ?1 ORDER BY due_date ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![user_id], |row| {
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

async fn put_vaccines(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(payload): Json<Vec<VaccineItem>>,
) -> impl IntoResponse {
    let user_id = match auth::authenticate_unsafe(&state, &headers).await {
        Ok(v) => v,
        Err(e) => return auth::auth_err_response(e),
    };
    let result = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let mut conn = open_conn(&state.db_path).map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM vaccines WHERE user_id = ?1", params![user_id])
            .map_err(|e| e.to_string())?;
        for v in payload {
            tx.execute(
                "INSERT INTO vaccines (id, user_id, name, dose, due_date, status, done_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![v.id, user_id, v.name, v.dose, v.due_date, v.status, v.done_at],
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

async fn get_vaccine_settings(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
) -> impl IntoResponse {
    let user_id = match auth::authenticate_headers(&state, &headers).await {
        Ok(v) => v,
        Err(e) => return auth::auth_err_response(e),
    };
    let result = tokio::task::spawn_blocking(move || -> Result<VaccineSettings, String> {
        let conn = open_conn(&state.db_path).map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT region, reminder_days, notifications_enabled, notified_map_json
                 FROM user_vaccine_settings WHERE user_id = ?1",
            )
            .map_err(|e| e.to_string())?;
        let row = stmt.query_row(params![user_id], |row| {
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
    headers: axum::http::HeaderMap,
    Json(payload): Json<VaccineSettings>,
) -> impl IntoResponse {
    let user_id = match auth::authenticate_unsafe(&state, &headers).await {
        Ok(v) => v,
        Err(e) => return auth::auth_err_response(e),
    };
    let result = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let conn = open_conn(&state.db_path).map_err(|e| e.to_string())?;
        let notified_map_json = serde_json::to_string(&payload.notified_map).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO user_vaccine_settings (user_id, region, reminder_days, notifications_enabled, notified_map_json)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(user_id) DO UPDATE SET
               region = excluded.region,
               reminder_days = excluded.reminder_days,
               notifications_enabled = excluded.notifications_enabled,
               notified_map_json = excluded.notified_map_json",
            params![
                user_id,
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

async fn get_vaccine_templates(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
) -> impl IntoResponse {
    let user_id = match auth::authenticate_headers(&state, &headers).await {
        Ok(v) => v,
        Err(e) => return auth::auth_err_response(e),
    };
    let result = tokio::task::spawn_blocking(move || -> Result<BTreeMap<String, CustomTemplate>, String> {
        let conn = open_conn(&state.db_path).map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT template_id, label, items_json FROM user_vaccine_templates WHERE user_id = ?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![user_id], |row| {
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
    headers: axum::http::HeaderMap,
    Json(payload): Json<BTreeMap<String, CustomTemplate>>,
) -> impl IntoResponse {
    let user_id = match auth::authenticate_unsafe(&state, &headers).await {
        Ok(v) => v,
        Err(e) => return auth::auth_err_response(e),
    };
    let result = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let mut conn = open_conn(&state.db_path).map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM user_vaccine_templates WHERE user_id = ?1",
            params![user_id],
        )
        .map_err(|e| e.to_string())?;
        for (template_id, tpl) in payload {
            let items_json = serde_json::to_string(&tpl.items).map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT INTO user_vaccine_templates (user_id, template_id, label, items_json) VALUES (?1, ?2, ?3, ?4)",
                params![user_id, template_id, tpl.label, items_json],
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
