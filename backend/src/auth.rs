use std::time::{SystemTime, UNIX_EPOCH};

use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use axum::{
    extract::State,
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::IntoResponse,
    Json,
};
use rand::RngCore;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{open_conn, ratelimit, AppState};

/// Session lifetime: 30 days.
const SESSION_TTL_SECS: i64 = 60 * 60 * 24 * 30;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthUser {
    pub id: String,
    pub username: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub email: String,
    /// Optional avatar as a data URL (client stores it inline for simplicity).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub avatar: String,
}

/// Internal result type from the blocking login task.
struct LoginOutcome {
    token: String,
    user: AuthUser,
    new_device: bool,
}

/// Cookie name used when BABYLOG_COOKIE_MODE is enabled.
pub const SESSION_COOKIE: &str = "babylog_session";

#[derive(Debug, Deserialize)]
pub struct RegisterPayload {
    username: String,
    password: String,
}

#[derive(Debug, Deserialize)]
pub struct LoginPayload {
    #[serde(default)]
    login: String,
    #[serde(default)]
    username: String,
    password: String,
}

pub fn ensure_auth_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL UNIQUE,
          email TEXT NOT NULL DEFAULT '',
          password_hash TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          avatar TEXT NOT NULL DEFAULT ''
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique
          ON users(lower(email))
          WHERE email <> '';

        CREATE TABLE IF NOT EXISTS sessions (
          token TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          last_ip TEXT NOT NULL DEFAULT '',
          last_ua TEXT NOT NULL DEFAULT '',
          FOREIGN KEY(user_id) REFERENCES users(id)
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

        CREATE TABLE IF NOT EXISTS audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL DEFAULT '',
          username TEXT NOT NULL DEFAULT '',
          kind TEXT NOT NULL,
          at INTEGER NOT NULL,
          ip TEXT NOT NULL DEFAULT '',
          ua TEXT NOT NULL DEFAULT '',
          detail TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, at DESC);
        CREATE INDEX IF NOT EXISTS idx_audit_kind ON audit_log(kind, at DESC);
        ",
    )?;
    Ok(())
}

/// Append an entry to the `audit_log` table. Never panics on failure; audit
/// logging is best-effort and must not break business flows.
pub fn write_audit(
    db_path: &std::path::Path,
    user_id: &str,
    username: &str,
    kind: &str,
    ip: &str,
    ua: &str,
    detail: &str,
) {
    let db_path = db_path.to_path_buf();
    let user_id = user_id.to_string();
    let username = username.to_string();
    let kind = kind.to_string();
    let ip = ip.to_string();
    let ua = ua.to_string();
    let detail = detail.to_string();
    // Fire-and-forget so handlers aren't blocked on disk writes.
    tokio::spawn(async move {
        let _ = tokio::task::spawn_blocking(move || {
            if let Ok(conn) = open_conn(&db_path) {
                let _ = conn.execute(
                    "INSERT INTO audit_log (user_id, username, kind, at, ip, ua, detail) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![user_id, username, kind, now_secs(), ip, ua, detail],
                );
            }
        })
        .await;
    });
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn normalize_username(s: &str) -> String {
    s.trim().to_lowercase()
}

fn normalize_email(s: &str) -> String {
    s.trim().to_lowercase()
}

fn is_valid_email(email: &str) -> bool {
    if email.is_empty() || email.len() > 254 || email.contains(' ') {
        return false;
    }
    let Some((local, domain)) = email.split_once('@') else {
        return false;
    };
    !local.is_empty() && domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.')
}

fn validate_credentials(username: &str, password: &str) -> Result<(), &'static str> {
    if username.is_empty() || username.len() > 48 {
        return Err("username length must be 1..=48");
    }
    if !username
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
    {
        return Err("username may only contain letters, digits, _ - .");
    }
    if password.len() < 6 || password.len() > 128 {
        return Err("password length must be 6..=128");
    }
    Ok(())
}

fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    // Hex encode (64 chars) — simple, URL safe, no extra dep.
    let mut out = String::with_capacity(64);
    for b in bytes {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

fn validate_password_len(password: &str) -> Result<(), &'static str> {
    if password.len() < 6 || password.len() > 128 {
        return Err("password length must be 6..=128");
    }
    Ok(())
}

/// HMAC-SHA256(pepper, password) → bytes. Used to pre-hash the password before
/// argon2. A leak of the database alone is not enough to crack hashes offline.
/// If the pepper is unset we fall back to the raw password, which keeps the
/// code working in dev setups — log a warning at startup when that happens.
fn pepper_password(pepper: &str, password: &str) -> Vec<u8> {
    if pepper.is_empty() {
        return password.as_bytes().to_vec();
    }
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(pepper.as_bytes())
        .expect("hmac accepts any key length");
    mac.update(password.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

fn hash_password(pepper: &str, password: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut OsRng);
    let peppered = pepper_password(pepper, password);
    Argon2::default()
        .hash_password(&peppered, &salt)
        .map(|h| h.to_string())
        .map_err(|e| e.to_string())
}

fn verify_password(pepper: &str, password: &str, hash: &str) -> bool {
    let parsed = match PasswordHash::new(hash) {
        Ok(v) => v,
        Err(_) => return false,
    };
    let peppered = pepper_password(pepper, password);
    if Argon2::default().verify_password(&peppered, &parsed).is_ok() {
        return true;
    }
    // Backwards compatibility: hashes created before pepper rollout were built
    // from the raw password bytes. Accept them so users don't get locked out.
    if !pepper.is_empty()
        && Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok()
    {
        return true;
    }
    false
}

/// Loose strength check: rejects passwords that score < 3 on the zxcvbn scale
/// (0 = trivial, 4 = very strong). Returns the first feedback warning when it
/// fails so the caller can surface guidance.
fn check_password_strength(username: &str, password: &str) -> Result<(), String> {
    let user_inputs = [username];
    let estimate = zxcvbn::zxcvbn(password, &user_inputs);
    if u8::from(estimate.score()) >= 3 {
        return Ok(());
    }
    let warning = estimate
        .feedback()
        .and_then(|f| f.warning().map(|w| w.to_string()))
        .unwrap_or_else(|| "password is too weak".to_string());
    Err(warning)
}

fn err_json(status: StatusCode, msg: &str) -> axum::response::Response {
    (status, Json(serde_json::json!({ "error": msg }))).into_response()
}

pub async fn register(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<RegisterPayload>,
) -> impl IntoResponse {
    let username = normalize_username(&payload.username);
    if let Err(msg) = validate_credentials(&username, &payload.password) {
        return err_json(StatusCode::BAD_REQUEST, msg);
    }
    if let Err(msg) = check_password_strength(&username, &payload.password) {
        return err_json(StatusCode::BAD_REQUEST, &format!("weak password: {}", msg));
    }
    let password = payload.password.clone();

    let ip = ratelimit::client_ip(&headers, state.trust_proxy, None);
    let ua = user_agent(&headers);
    let bucket_key = format!("register:{}", ip);
    let limiter = state.auth_limiter.clone();
    if let Some(retry_after) = limiter.check(&bucket_key) {
        return too_many_requests(retry_after);
    }

    let db_path = state.db_path.clone();
    let pepper = state.password_pepper.clone();
    let ip_for_session = ip.clone();
    let ua_for_session = ua.clone();
    let username_for_db = username.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<(String, AuthUser), (StatusCode, String)> {
        let conn = open_conn(&db_path)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(1) FROM users WHERE username = ?1",
                params![username_for_db],
                |r| r.get(0),
            )
            .unwrap_or(0);
        if exists > 0 {
            return Err((StatusCode::CONFLICT, "username already taken".to_string()));
        }

        let password_hash = hash_password(&pepper, &password)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
        let user_id = Uuid::new_v4().to_string();
        let now = now_secs();
        conn.execute(
            "INSERT INTO users (id, username, password_hash, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![user_id, username_for_db, password_hash, now],
        )
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

        let token = generate_token();
        let expires_at = now + SESSION_TTL_SECS;
        conn.execute(
            "INSERT INTO sessions (token, user_id, created_at, expires_at, last_ip, last_ua) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![token, user_id, now, expires_at, ip_for_session, ua_for_session],
        )
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

        Ok((
            token,
            AuthUser {
                id: user_id,
                username: username_for_db,
                email: String::new(),
                avatar: String::new(),
            },
        ))
    })
    .await;

    match result {
        Ok(Ok((token, user))) => {
            limiter.reset(&bucket_key);
            write_audit(&state.db_path, &user.id, &user.username, "register", &ip, &ua, "");
            build_auth_success(&state, &token, &user, false).into_response()
        }
        Ok(Err((status, msg))) => {
            limiter.register_failure(&bucket_key);
            write_audit(
                &state.db_path,
                "",
                &username,
                "register_failed",
                &ip,
                &ua,
                &msg,
            );
            // Don't leak whether the username already exists.
            if status == StatusCode::CONFLICT {
                return err_json(StatusCode::BAD_REQUEST, "registration failed");
            }
            err_json(status, &msg)
        }
        Err(_) => {
            limiter.register_failure(&bucket_key);
            err_json(StatusCode::INTERNAL_SERVER_ERROR, "register failed")
        }
    }
}

/// Build the success response for /auth/login and /auth/register. When cookie
/// mode is on it sets HttpOnly session cookie + a companion CSRF cookie.
fn build_auth_success(
    state: &AppState,
    token: &str,
    user: &AuthUser,
    new_device: bool,
) -> axum::response::Response {
    let mut body = serde_json::json!({
        "token": token,
        "user": user,
        "new_device": new_device,
    });
    let mut csrf_value = None;
    if state.cookie_mode {
        let csrf = generate_csrf_value();
        body["csrf_token"] = serde_json::Value::String(csrf.clone());
        csrf_value = Some(csrf);
    }
    let mut resp = (StatusCode::OK, Json(body)).into_response();
    if state.cookie_mode {
        let set_cookie = build_session_cookie(state, token);
        if let Ok(v) = HeaderValue::from_str(&set_cookie) {
            resp.headers_mut().append(header::SET_COOKIE, v);
        }
        if let Some(csrf) = csrf_value {
            let csrf_cookie = build_csrf_cookie(state, &csrf);
            if let Ok(v) = HeaderValue::from_str(&csrf_cookie) {
                resp.headers_mut().append(header::SET_COOKIE, v);
            }
        }
    }
    resp
}

pub async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<LoginPayload>,
) -> impl IntoResponse {
    let login_input = payload.login.trim().to_string();
    let login = if login_input.is_empty() {
        normalize_username(&payload.username)
    } else {
        normalize_username(&login_input)
    };
    if login.is_empty() || payload.password.is_empty() {
        return err_json(StatusCode::BAD_REQUEST, "missing login or password");
    }
    let password = payload.password.clone();

    let ip = ratelimit::client_ip(&headers, state.trust_proxy, None);
    let ua = user_agent(&headers);
    // Couple IP + username so a single attacker can't exhaust a victim's bucket
    // while also being unable to tumble across many usernames from one IP.
    let ip_key = format!("login-ip:{}", ip);
    let user_key = format!("login-user:{}", login);
    let limiter = state.auth_limiter.clone();
    if let Some(retry_after) = limiter.check(&ip_key).or_else(|| limiter.check(&user_key)) {
        return too_many_requests(retry_after);
    }

    let db_path = state.db_path.clone();
    let pepper = state.password_pepper.clone();
    let ip_for_session = ip.clone();
    let ua_for_session = ua.clone();
    let login_for_db = login.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<LoginOutcome, (StatusCode, String)> {
        let conn = open_conn(&db_path)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        let row = conn.query_row(
            "SELECT id, username, email, password_hash, avatar FROM users
             WHERE username = ?1 OR (email <> '' AND lower(email) = ?2)
             LIMIT 1",
            params![login_for_db, login_for_db],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                ))
            },
        );
        let (user_id, username, email, password_hash, avatar) = match row {
            Ok(v) => v,
            Err(rusqlite::Error::QueryReturnedNoRows) => {
                return Err((StatusCode::UNAUTHORIZED, "invalid credentials".to_string()));
            }
            Err(e) => return Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
        };
        if !verify_password(&pepper, &password, &password_hash) {
            return Err((StatusCode::UNAUTHORIZED, "invalid credentials".to_string()));
        }

        // Compare against recent session fingerprints for this user; if we've
        // never seen the IP/UA before, flag it so the UI can warn.
        let prior_ip: Option<String> = conn
            .query_row(
                "SELECT last_ip FROM sessions WHERE user_id = ?1 AND last_ip = ?2 LIMIT 1",
                params![user_id, ip_for_session],
                |r| r.get(0),
            )
            .ok();
        let prior_ua: Option<String> = conn
            .query_row(
                "SELECT last_ua FROM sessions WHERE user_id = ?1 AND last_ua = ?2 LIMIT 1",
                params![user_id, ua_for_session],
                |r| r.get(0),
            )
            .ok();
        let has_history: i64 = conn
            .query_row(
                "SELECT COUNT(1) FROM sessions WHERE user_id = ?1",
                params![user_id],
                |r| r.get(0),
            )
            .unwrap_or(0);
        // First login ever: not a new device, just the first.
        let new_device = has_history > 0 && (prior_ip.is_none() || prior_ua.is_none());

        let token = generate_token();
        let now = now_secs();
        let expires_at = now + SESSION_TTL_SECS;
        conn.execute(
            "INSERT INTO sessions (token, user_id, created_at, expires_at, last_ip, last_ua) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![token, user_id, now, expires_at, ip_for_session, ua_for_session],
        )
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

        Ok(LoginOutcome {
            token,
            user: AuthUser {
                id: user_id,
                username,
                email,
                avatar,
            },
            new_device,
        })
    })
    .await;

    match result {
        Ok(Ok(outcome)) => {
            limiter.reset(&ip_key);
            limiter.reset(&user_key);
            let detail = if outcome.new_device { "new_device" } else { "" };
            write_audit(
                &state.db_path,
                &outcome.user.id,
                &outcome.user.username,
                "login",
                &ip,
                &ua,
                detail,
            );
            build_auth_success(&state, &outcome.token, &outcome.user, outcome.new_device)
                .into_response()
        }
        Ok(Err((status, msg))) => {
            limiter.register_failure(&ip_key);
            limiter.register_failure(&user_key);
            write_audit(&state.db_path, "", &login, "login_failed", &ip, &ua, &msg);
            // Always return the same message for unauthorized outcomes.
            if status == StatusCode::UNAUTHORIZED {
                return err_json(StatusCode::UNAUTHORIZED, "invalid credentials");
            }
            err_json(status, &msg)
        }
        Err(_) => {
            limiter.register_failure(&ip_key);
            err_json(StatusCode::INTERNAL_SERVER_ERROR, "login failed")
        }
    }
}

fn too_many_requests(retry_after: u64) -> axum::response::Response {
    use axum::http::header::RETRY_AFTER;
    let mut resp = (
        StatusCode::TOO_MANY_REQUESTS,
        Json(serde_json::json!({ "error": "too many attempts, please try again later" })),
    )
        .into_response();
    if let Ok(v) = HeaderValue::from_str(&retry_after.to_string()) {
        resp.headers_mut().insert(RETRY_AFTER, v);
    }
    resp
}

/// Truncated User-Agent (at most 256 bytes) for audit / fingerprinting.
pub fn user_agent(headers: &HeaderMap) -> String {
    headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.chars().take(256).collect())
        .unwrap_or_default()
}

/// Build a `Set-Cookie` header value for a session token.
pub fn build_session_cookie(state: &AppState, token: &str) -> String {
    let base = format!(
        "{}={}; Path=/; Max-Age={}; HttpOnly; SameSite=Lax",
        SESSION_COOKIE, token, SESSION_TTL_SECS
    );
    if state.cookie_secure {
        format!("{}; Secure", base)
    } else {
        base
    }
}

/// Build a `Set-Cookie` header that clears the session cookie.
pub fn clear_session_cookie(state: &AppState) -> String {
    let base = format!(
        "{}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax",
        SESSION_COOKIE
    );
    if state.cookie_secure {
        format!("{}; Secure", base)
    } else {
        base
    }
}

/// Name of the (non-HttpOnly) CSRF cookie. The client must echo its value back
/// in the `X-CSRF-Token` header on unsafe requests.
pub const CSRF_COOKIE: &str = "babylog_csrf";

/// Generate a 24-byte random value (hex encoded) suitable for a CSRF token.
pub fn generate_csrf_value() -> String {
    let mut bytes = [0u8; 24];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut bytes);
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

pub fn build_csrf_cookie(state: &AppState, value: &str) -> String {
    let base = format!(
        "{}={}; Path=/; Max-Age={}; SameSite=Lax",
        CSRF_COOKIE, value, SESSION_TTL_SECS
    );
    if state.cookie_secure {
        format!("{}; Secure", base)
    } else {
        base
    }
}

pub fn clear_csrf_cookie(state: &AppState) -> String {
    let base = format!("{}=; Path=/; Max-Age=0; SameSite=Lax", CSRF_COOKIE);
    if state.cookie_secure {
        format!("{}; Secure", base)
    } else {
        base
    }
}

fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
    for part in raw.split(';') {
        let p = part.trim();
        if let Some(rest) = p.strip_prefix(&format!("{}=", name)) {
            let trimmed = rest.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

/// CSRF enforcement for cookie-authenticated unsafe requests. Returns Ok(()) if
/// the request presents a `Bearer` token (bearer auth is not vulnerable to
/// browser-implicit CSRF) or if the CSRF cookie and `X-CSRF-Token` header
/// match. Safe methods (GET/HEAD/OPTIONS) bypass this check at the caller.
pub fn enforce_csrf(headers: &HeaderMap) -> Result<(), (StatusCode, String)> {
    if bearer_token(headers).is_some() {
        return Ok(());
    }
    let Some(cookie) = cookie_value(headers, CSRF_COOKIE) else {
        return Err((StatusCode::FORBIDDEN, "missing CSRF cookie".to_string()));
    };
    let header_val = headers
        .get("x-csrf-token")
        .and_then(|h| h.to_str().ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    if header_val.is_empty() || !constant_time_eq(cookie.as_bytes(), header_val.as_bytes()) {
        return Err((StatusCode::FORBIDDEN, "CSRF token mismatch".to_string()));
    }
    Ok(())
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Try reading a session token from the `babylog_session` cookie.
pub fn cookie_token(headers: &HeaderMap) -> Option<String> {
    cookie_value(headers, SESSION_COOKIE)
}

/// Extract the bearer token from an Authorization header.
pub fn bearer_token(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let rest = value.strip_prefix("Bearer ").or_else(|| value.strip_prefix("bearer "))?;
    let trimmed = rest.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Look up the user id for a given bearer token (synchronous; callers should
/// wrap in spawn_blocking when already inside a blocking section, or use
/// `authenticate_headers` from async contexts).
pub fn user_id_for_token(conn: &Connection, token: &str) -> Option<String> {
    let now = now_secs();
    conn.query_row(
        "SELECT user_id FROM sessions WHERE token = ?1 AND expires_at > ?2",
        params![token, now],
        |r| r.get::<_, String>(0),
    )
    .ok()
}

/// Validates the Authorization header (or session cookie) against the sessions
/// table. Returns the user id on success, or an (401/500, error) tuple.
/// For cookie-based auth, callers should additionally enforce CSRF via
/// `enforce_csrf` before allowing state-changing methods.
pub async fn authenticate_headers(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<String, (StatusCode, String)> {
    let Some(token) = bearer_token(headers).or_else(|| cookie_token(headers)) else {
        return Err((StatusCode::UNAUTHORIZED, "missing bearer token".to_string()));
    };
    let db_path = state.db_path.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<Option<String>, String> {
        let conn = open_conn(&db_path).map_err(|e| e.to_string())?;
        Ok(user_id_for_token(&conn, &token))
    })
    .await;
    match result {
        Ok(Ok(Some(uid))) => Ok(uid),
        Ok(Ok(None)) => Err((
            StatusCode::UNAUTHORIZED,
            "invalid or expired token".to_string(),
        )),
        Ok(Err(e)) => Err((StatusCode::INTERNAL_SERVER_ERROR, e)),
        Err(_) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            "session lookup failed".to_string(),
        )),
    }
}

/// Helper to turn an auth error into a standard JSON response.
pub fn auth_err_response((status, msg): (StatusCode, String)) -> axum::response::Response {
    err_json(status, &msg)
}

/// Like `authenticate_headers` but additionally enforces CSRF for cookie-based
/// auth on state-changing requests. Use this for POST/PUT/DELETE handlers;
/// GET handlers should keep calling `authenticate_headers`.
pub async fn authenticate_unsafe(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<String, (StatusCode, String)> {
    let uid = authenticate_headers(state, headers).await?;
    // Only cookie-authenticated requests need CSRF; bearer auth is not subject
    // to browser-implicit cross-site submission.
    if bearer_token(headers).is_none() && cookie_token(headers).is_some() {
        enforce_csrf(headers)?;
    }
    Ok(uid)
}

#[derive(Debug, Deserialize)]
pub struct AvatarPayload {
    /// Data URL (data:image/...;base64,...) or empty string to clear.
    pub avatar: String,
}

/// Maximum stored avatar size. Data URLs carry ~4/3 overhead; 256 KB is plenty
/// for a profile picture and keeps sqlite rows small.
const MAX_AVATAR_BYTES: usize = 256 * 1024;

fn is_valid_avatar_data_url(s: &str) -> bool {
    if s.is_empty() {
        return true;
    }
    // Accept only data:image/{jpeg,png,webp,gif};base64,... and bounded length.
    if s.len() > MAX_AVATAR_BYTES {
        return false;
    }
    let lowered = s.to_ascii_lowercase();
    let Some(rest) = lowered.strip_prefix("data:image/") else {
        return false;
    };
    let Some((mime, payload)) = rest.split_once(";base64,") else {
        return false;
    };
    matches!(mime, "jpeg" | "png" | "webp" | "gif") && !payload.is_empty()
}

pub async fn update_avatar(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<AvatarPayload>,
) -> impl IntoResponse {
    let user_id = match authenticate_unsafe(&state, &headers).await {
        Ok(v) => v,
        Err(e) => return auth_err_response(e),
    };
    if !is_valid_avatar_data_url(&payload.avatar) {
        return err_json(
            StatusCode::BAD_REQUEST,
            "invalid avatar (must be a data:image/{jpeg,png,webp,gif} data URL ≤ 256 KB)",
        );
    }
    let avatar = payload.avatar.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let conn = open_conn(&state.db_path).map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE users SET avatar = ?1 WHERE id = ?2",
            params![avatar, user_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await;
    match result {
        Ok(Ok(())) => (
            StatusCode::OK,
            Json(serde_json::json!({ "saved": true, "avatar": payload.avatar })),
        )
            .into_response(),
        _ => err_json(StatusCode::INTERNAL_SERVER_ERROR, "failed to save avatar"),
    }
}

#[derive(Debug, Serialize)]
struct AuditEntry {
    id: i64,
    kind: String,
    at: i64,
    ip: String,
    ua: String,
    detail: String,
}

pub async fn list_audit(State(state): State<AppState>, headers: HeaderMap) -> impl IntoResponse {
    let user_id = match authenticate_headers(&state, &headers).await {
        Ok(v) => v,
        Err(e) => return auth_err_response(e),
    };

    let result = tokio::task::spawn_blocking(move || -> Result<Vec<AuditEntry>, String> {
        let conn = open_conn(&state.db_path).map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, kind, at, ip, ua, detail FROM audit_log \
                 WHERE user_id = ?1 ORDER BY at DESC LIMIT 100",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![user_id], |row| {
                Ok(AuditEntry {
                    id: row.get(0)?,
                    kind: row.get(1)?,
                    at: row.get(2)?,
                    ip: row.get(3)?,
                    ua: row.get(4)?,
                    detail: row.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut items = Vec::new();
        for r in rows {
            items.push(r.map_err(|e| e.to_string())?);
        }
        Ok(items)
    })
    .await;

    match result {
        Ok(Ok(v)) => Json(serde_json::json!({ "items": v })).into_response(),
        _ => err_json(StatusCode::INTERNAL_SERVER_ERROR, "failed to load audit log"),
    }
}

pub async fn me(State(state): State<AppState>, headers: HeaderMap) -> impl IntoResponse {
    let user_id = match authenticate_headers(&state, &headers).await {
        Ok(v) => v,
        Err(e) => return auth_err_response(e),
    };

    let result = tokio::task::spawn_blocking(move || -> Result<AuthUser, (StatusCode, String)> {
        let conn = open_conn(&state.db_path)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        let row = conn.query_row(
            "SELECT id, username, email, avatar FROM users WHERE id = ?1",
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
        match row {
            Ok((id, username, email, avatar)) => Ok(AuthUser {
                id,
                username,
                email,
                avatar,
            }),
            Err(rusqlite::Error::QueryReturnedNoRows) => {
                Err((StatusCode::UNAUTHORIZED, "invalid or expired token".to_string()))
            }
            Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
        }
    })
    .await;

    match result {
        Ok(Ok(user)) => (StatusCode::OK, Json(serde_json::json!({ "user": user }))).into_response(),
        Ok(Err((status, msg))) => err_json(status, &msg),
        Err(_) => err_json(StatusCode::INTERNAL_SERVER_ERROR, "session lookup failed"),
    }
}

#[derive(Debug, Deserialize)]
pub struct UpdateEmailPayload {
    email: String,
}

pub async fn update_email(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<UpdateEmailPayload>,
) -> impl IntoResponse {
    let user_id = match authenticate_unsafe(&state, &headers).await {
        Ok(v) => v,
        Err(e) => return auth_err_response(e),
    };
    let email = normalize_email(&payload.email);
    if !is_valid_email(&email) {
        return err_json(StatusCode::BAD_REQUEST, "invalid email");
    }
    let ip = ratelimit::client_ip(&headers, state.trust_proxy, None);
    let ua = user_agent(&headers);
    let db_path = state.db_path.clone();
    let user_id_for_db = user_id.clone();
    let email_for_db = email.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<String, (StatusCode, String)> {
        let conn = open_conn(&db_path)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        let username: String = conn
            .query_row(
                "SELECT username FROM users WHERE id = ?1",
                params![user_id_for_db],
                |r| r.get(0),
            )
            .map_err(|_| (StatusCode::UNAUTHORIZED, "invalid or expired token".to_string()))?;
        let updated = conn
            .execute(
                "UPDATE users SET email = ?1 WHERE id = ?2",
                params![email_for_db, user_id_for_db],
            )
            .map_err(|e| {
                if let rusqlite::Error::SqliteFailure(err, _) = &e {
                    if err.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE
                        || err.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_PRIMARYKEY
                    {
                        return (StatusCode::BAD_REQUEST, "email update failed".to_string());
                    }
                }
                (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
            })?;
        if updated == 0 {
            return Err((StatusCode::UNAUTHORIZED, "invalid or expired token".to_string()));
        }
        Ok(username)
    })
    .await;
    match result {
        Ok(Ok(username)) => {
            write_audit(
                &state.db_path,
                &user_id,
                &username,
                "email_update",
                &ip,
                &ua,
                "",
            );
            (
                StatusCode::OK,
                Json(serde_json::json!({ "saved": true, "email": email })),
            )
                .into_response()
        }
        Ok(Err((status, msg))) => {
            write_audit(
                &state.db_path,
                &user_id,
                "",
                "email_update_failed",
                &ip,
                &ua,
                &msg,
            );
            err_json(status, &msg)
        }
        Err(_) => err_json(StatusCode::INTERNAL_SERVER_ERROR, "email update failed"),
    }
}

#[derive(Debug, Deserialize)]
pub struct UpdatePasswordPayload {
    current_password: String,
    new_password: String,
}

pub async fn update_password(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<UpdatePasswordPayload>,
) -> impl IntoResponse {
    let user_id = match authenticate_unsafe(&state, &headers).await {
        Ok(v) => v,
        Err(e) => return auth_err_response(e),
    };
    if payload.current_password.is_empty() || payload.new_password.is_empty() {
        return err_json(StatusCode::BAD_REQUEST, "missing password");
    }
    if let Err(msg) = validate_password_len(&payload.new_password) {
        return err_json(StatusCode::BAD_REQUEST, msg);
    }
    let ip = ratelimit::client_ip(&headers, state.trust_proxy, None);
    let ua = user_agent(&headers);
    let current_token = bearer_token(&headers).or_else(|| cookie_token(&headers));
    let db_path = state.db_path.clone();
    let pepper = state.password_pepper.clone();
    let current_password = payload.current_password.clone();
    let new_password = payload.new_password.clone();
    let user_id_for_db = user_id.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<String, (StatusCode, String)> {
        let conn = open_conn(&db_path)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        let (username, password_hash): (String, String) = conn
            .query_row(
                "SELECT username, password_hash FROM users WHERE id = ?1",
                params![user_id_for_db],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|_| (StatusCode::UNAUTHORIZED, "invalid or expired token".to_string()))?;
        if !verify_password(&pepper, &current_password, &password_hash) {
            return Err((StatusCode::UNAUTHORIZED, "current password is incorrect".to_string()));
        }
        if let Err(msg) = check_password_strength(&username, &new_password) {
            return Err((StatusCode::BAD_REQUEST, format!("weak password: {}", msg)));
        }
        let new_hash = hash_password(&pepper, &new_password)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
        conn.execute(
            "UPDATE users SET password_hash = ?1 WHERE id = ?2",
            params![new_hash, user_id_for_db],
        )
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        if let Some(token) = current_token {
            let _ = conn.execute(
                "DELETE FROM sessions WHERE user_id = ?1 AND token <> ?2",
                params![user_id_for_db, token],
            );
        } else {
            let _ = conn.execute("DELETE FROM sessions WHERE user_id = ?1", params![user_id_for_db]);
        }
        Ok(username)
    })
    .await;
    match result {
        Ok(Ok(username)) => {
            write_audit(
                &state.db_path,
                &user_id,
                &username,
                "password_update",
                &ip,
                &ua,
                "",
            );
            (StatusCode::OK, Json(serde_json::json!({ "saved": true }))).into_response()
        }
        Ok(Err((status, msg))) => {
            write_audit(
                &state.db_path,
                &user_id,
                "",
                "password_update_failed",
                &ip,
                &ua,
                &msg,
            );
            err_json(status, &msg)
        }
        Err(_) => err_json(StatusCode::INTERNAL_SERVER_ERROR, "password update failed"),
    }
}

pub async fn logout(State(state): State<AppState>, headers: HeaderMap) -> impl IntoResponse {
    let Some(token) = bearer_token(&headers).or_else(|| cookie_token(&headers)) else {
        return err_json(StatusCode::UNAUTHORIZED, "missing bearer token");
    };
    // CSRF: only enforce for cookie-mode unsafe requests; bearer auth is immune.
    if cookie_token(&headers).is_some() && bearer_token(&headers).is_none() {
        if let Err((status, msg)) = enforce_csrf(&headers) {
            return err_json(status, &msg);
        }
    }

    let db_path = state.db_path.clone();
    let token_for_db = token.clone();
    let outcome = tokio::task::spawn_blocking(move || -> Option<(String, String)> {
        let conn = open_conn(&db_path).ok()?;
        let uid: Option<String> = conn
            .query_row(
                "SELECT user_id FROM sessions WHERE token = ?1",
                params![token_for_db],
                |r| r.get::<_, String>(0),
            )
            .ok();
        let _ = conn.execute(
            "DELETE FROM sessions WHERE token = ?1",
            params![token_for_db],
        );
        let uid = uid?;
        let username: String = conn
            .query_row("SELECT username FROM users WHERE id = ?1", params![uid], |r| {
                r.get::<_, String>(0)
            })
            .unwrap_or_default();
        Some((uid, username))
    })
    .await
    .ok()
    .flatten();

    let ip = ratelimit::client_ip(&headers, state.trust_proxy, None);
    let ua = user_agent(&headers);
    if let Some((uid, uname)) = &outcome {
        write_audit(&state.db_path, uid, uname, "logout", &ip, &ua, "");
    }

    let mut resp = (StatusCode::OK, Json(serde_json::json!({ "ok": true }))).into_response();
    if state.cookie_mode {
        if let Ok(v) = HeaderValue::from_str(&clear_session_cookie(&state)) {
            resp.headers_mut().append(header::SET_COOKIE, v);
        }
        if let Ok(v) = HeaderValue::from_str(&clear_csrf_cookie(&state)) {
            resp.headers_mut().append(header::SET_COOKIE, v);
        }
    }
    resp
}
