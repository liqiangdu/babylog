use std::{collections::BTreeMap, io::ErrorKind, net::SocketAddr, path::PathBuf, sync::Arc};

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, put},
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::{fs, sync::RwLock};
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
struct Persisted {
    #[serde(default)]
    profile: Profile,
    #[serde(default)]
    entries: Vec<Entry>,
    #[serde(default)]
    vaccines: Vec<VaccineItem>,
    #[serde(default)]
    vaccine_settings: VaccineSettings,
    #[serde(default)]
    custom_vaccine_templates: BTreeMap<String, CustomTemplate>,
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
    store_path: PathBuf,
    data: Arc<RwLock<Persisted>>,
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
        Err(err) if err.kind() == ErrorKind::AddrInUse => {
            tracing::error!(
                "cannot start babylog-api: {} is already in use. Stop the existing process or run only one backend instance.",
                addr
            );
            return;
        }
        Err(err) => {
            tracing::error!("failed to bind {}: {}", addr, err);
            return;
        }
    };
    info!("babylog-api listening on http://{}", addr);
    axum::serve(listener, app).await.unwrap();
}

async fn bootstrap_state() -> AppState {
    let store_path = PathBuf::from("data/store.json");
    if let Some(parent) = store_path.parent() {
        let _ = fs::create_dir_all(parent).await;
    }
    let data = load_persisted(&store_path).await.unwrap_or_default();
    AppState {
        store_path,
        data: Arc::new(RwLock::new(data)),
    }
}

async fn load_persisted(path: &PathBuf) -> Option<Persisted> {
    let bytes = fs::read(path).await.ok()?;
    serde_json::from_slice(&bytes).ok()
}

async fn save_persisted(state: &AppState) -> Result<(), String> {
    let snapshot = { state.data.read().await.clone() };
    let encoded = serde_json::to_vec_pretty(&snapshot).map_err(|e| e.to_string())?;
    fs::write(&state.store_path, encoded)
        .await
        .map_err(|e| e.to_string())
}

async fn health() -> impl IntoResponse {
    (StatusCode::OK, Json(serde_json::json!({ "ok": true })))
}

async fn get_profile(State(state): State<AppState>) -> impl IntoResponse {
    let data = state.data.read().await;
    Json(data.profile.clone())
}

async fn put_profile(
    State(state): State<AppState>,
    Json(payload): Json<Profile>,
) -> impl IntoResponse {
    {
        let mut data = state.data.write().await;
        data.profile = payload;
    }
    match save_persisted(&state).await {
        Ok(_) => (StatusCode::OK, Json(serde_json::json!({ "saved": true }))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        )
            .into_response(),
    }
}

async fn list_entries(
    State(state): State<AppState>,
    Query(query): Query<EntryQuery>,
) -> impl IntoResponse {
    let data = state.data.read().await;
    let mut items = data.entries.clone();
    items.sort_by(|a, b| b.at.cmp(&a.at));

    if let Some(category) = &query.category {
        items.retain(|e| &e.category_id == category);
    }
    if let Some(day) = &query.day {
        items.retain(|e| e.at.date_naive().to_string() == *day);
    }

    let offset = query.offset.unwrap_or(0);
    let limit = query.limit.unwrap_or(20);
    let total = items.len();
    let page: Vec<Entry> = items.into_iter().skip(offset).take(limit).collect();

    Json(serde_json::json!({
        "total": total,
        "offset": offset,
        "limit": limit,
        "items": page
    }))
}

async fn create_entry(
    State(state): State<AppState>,
    Json(payload): Json<CreateEntry>,
) -> impl IntoResponse {
    let entry = Entry {
        id: Uuid::new_v4(),
        category_id: payload.category_id,
        at: payload.at,
        fields: payload.fields.unwrap_or_default(),
        note: payload.note.unwrap_or_default(),
    };

    {
        let mut data = state.data.write().await;
        data.entries.push(entry.clone());
    }

    match save_persisted(&state).await {
        Ok(_) => (StatusCode::CREATED, Json(entry)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        )
            .into_response(),
    }
}

async fn delete_entry(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> impl IntoResponse {
    {
        let mut data = state.data.write().await;
        data.entries.retain(|e| e.id != id);
    }
    match save_persisted(&state).await {
        Ok(_) => (StatusCode::OK, Json(serde_json::json!({ "deleted": true }))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        )
            .into_response(),
    }
}

async fn update_entry(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(payload): Json<UpdateEntry>,
) -> impl IntoResponse {
    let mut found = false;
    {
        let mut data = state.data.write().await;
        for item in &mut data.entries {
            if item.id == id {
                item.category_id = payload.category_id.clone();
                item.at = payload.at;
                item.fields = payload.fields.clone().unwrap_or_default();
                item.note = payload.note.clone().unwrap_or_default();
                found = true;
                break;
            }
        }
    }

    if !found {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "entry not found" })),
        )
            .into_response();
    }

    match save_persisted(&state).await {
        Ok(_) => (StatusCode::OK, Json(serde_json::json!({ "updated": true }))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        )
            .into_response(),
    }
}

async fn get_stats(
    State(state): State<AppState>,
    Query(query): Query<StatsQuery>,
) -> impl IntoResponse {
    let data = state.data.read().await;
    let mut items = data.entries.clone();

    if let Some(start) = &query.start {
        items.retain(|e| e.at.date_naive().to_string() >= *start);
    }
    if let Some(end) = &query.end {
        items.retain(|e| e.at.date_naive().to_string() <= *end);
    }

    let mut by_category: BTreeMap<String, usize> = BTreeMap::new();
    for e in &items {
        *by_category.entry(e.category_id.clone()).or_insert(0) += 1;
    }

    Json(StatsResponse {
        total_entries: items.len(),
        by_category,
    })
}

async fn get_vaccines(State(state): State<AppState>) -> impl IntoResponse {
    let data = state.data.read().await;
    Json(data.vaccines.clone())
}

async fn put_vaccines(
    State(state): State<AppState>,
    Json(payload): Json<Vec<VaccineItem>>,
) -> impl IntoResponse {
    {
        let mut data = state.data.write().await;
        data.vaccines = payload;
    }
    match save_persisted(&state).await {
        Ok(_) => (StatusCode::OK, Json(serde_json::json!({ "saved": true }))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        )
            .into_response(),
    }
}

async fn get_vaccine_settings(State(state): State<AppState>) -> impl IntoResponse {
    let data = state.data.read().await;
    Json(data.vaccine_settings.clone())
}

async fn put_vaccine_settings(
    State(state): State<AppState>,
    Json(payload): Json<VaccineSettings>,
) -> impl IntoResponse {
    {
        let mut data = state.data.write().await;
        data.vaccine_settings = payload;
    }
    match save_persisted(&state).await {
        Ok(_) => (StatusCode::OK, Json(serde_json::json!({ "saved": true }))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        )
            .into_response(),
    }
}

async fn get_vaccine_templates(State(state): State<AppState>) -> impl IntoResponse {
    let data = state.data.read().await;
    Json(data.custom_vaccine_templates.clone())
}

async fn put_vaccine_templates(
    State(state): State<AppState>,
    Json(payload): Json<BTreeMap<String, CustomTemplate>>,
) -> impl IntoResponse {
    {
        let mut data = state.data.write().await;
        data.custom_vaccine_templates = payload;
    }
    match save_persisted(&state).await {
        Ok(_) => (StatusCode::OK, Json(serde_json::json!({ "saved": true }))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        )
            .into_response(),
    }
}
