use std::{
    hash::{DefaultHasher, Hash, Hasher},
    sync::Arc,
    time::Duration,
};

use axum::{
    Json, Router,
    extract::{Query, State},
    http::{StatusCode, header},
    response::IntoResponse,
    routing::get,
};
use chrono::{NaiveDate, Utc};
use moka::future::Cache;
use serde::{Deserialize, Serialize};
use tower_http::{cors::CorsLayer, services::ServeDir, trace::TraceLayer};
use tracing_subscriber::EnvFilter;

use crate::sun::{SunTimes, calc_sun_times};

pub mod sun;

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

type CacheKey = (i64, i64, String);

pub fn create_cache() -> Cache<CacheKey, SunTimes> {
    Cache::builder()
        .time_to_live(Duration::from_secs(86_400))
        .max_capacity(10_000)
        .build()
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
struct ErrorBody {
    status: &'static str,
    error: String,
}

enum ApiError {
    InvalidCoordinates(String),
    InvalidDate(String),
    MissingParameter(&'static str),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let (status, message) = match self {
            ApiError::InvalidCoordinates(msg) => (StatusCode::BAD_REQUEST, msg),
            ApiError::InvalidDate(msg) => (StatusCode::BAD_REQUEST, msg),
            ApiError::MissingParameter(name) => (
                StatusCode::BAD_REQUEST,
                format!("missing required query parameter: {name}"),
            ),
        };

        (
            status,
            Json(ErrorBody {
                status: "ERROR",
                error: message,
            }),
        )
            .into_response()
    }
}

// ---------------------------------------------------------------------------
// Request / Response types
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct Params {
    lat: Option<f64>,
    lng: Option<f64>,
    date: Option<String>, // default today
}

#[derive(Serialize)]
struct ApiResponse {
    results: SunTimes,
    status: &'static str,
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

fn validate_lat(lat: f64) -> Result<f64, ApiError> {
    if !(-90.0..=90.0).contains(&lat) {
        Err(ApiError::InvalidCoordinates(format!(
            "latitude must be between -90 and 90, got {lat}"
        )))
    } else {
        Ok(lat)
    }
}

fn validate_lng(lng: f64) -> Result<f64, ApiError> {
    if !(-180.0..=180.0).contains(&lng) {
        Err(ApiError::InvalidCoordinates(format!(
            "longitude must be between -180 and 180, got {lng}"
        )))
    } else {
        Ok(lng)
    }
}

fn parse_date(date_str: Option<&str>) -> Result<NaiveDate, ApiError> {
    match date_str {
        None | Some("today") => Ok(Utc::now().date_naive()),
        Some(s) => NaiveDate::parse_from_str(s, "%Y-%m-%d").map_err(|_| {
            ApiError::InvalidDate(format!(
                "invalid date format '{s}', expected YYYY-MM-DD or 'today'"
            ))
        }),
    }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

#[axum::debug_handler]
async fn sun_handler(
    State(cache): State<Arc<Cache<CacheKey, SunTimes>>>,
    Query(params): Query<Params>,
) -> Result<impl IntoResponse, ApiError> {
    let lat = validate_lat(params.lat.ok_or(ApiError::MissingParameter("lat"))?)?;
    let lng = validate_lng(params.lng.ok_or(ApiError::MissingParameter("lng"))?)?;
    let date = parse_date(params.date.as_deref())?;
    let date_str = date.format("%Y-%m-%d").to_string();

    // Round to 5 decimal places (~1 m precision) for cache dedup
    let lat_scaled = (lat * 100_000.0).round() as i64;
    let lng_scaled = (lng * 100_000.0).round() as i64;

    let key = (lat_scaled, lng_scaled, date_str);

    let times = cache
        .get_with(key.clone(), async {
            calc_sun_times(date, lat, lng)
        })
        .await;

    // Build a deterministic ETag from the cache key
    let mut hasher = DefaultHasher::new();
    key.hash(&mut hasher);
    let etag = format!("\"{}\"", hasher.finish());

    let mut headers = header::HeaderMap::new();
    headers.insert(
        header::CACHE_CONTROL,
        "public, max-age=86400".parse().unwrap(),
    );
    headers.insert(header::ETAG, etag.parse().unwrap());

    Ok((
        headers,
        Json(ApiResponse {
            results: times,
            status: "OK",
        }),
    ))
}

async fn health_handler() -> StatusCode {
    StatusCode::OK
}

// ---------------------------------------------------------------------------
// Application entry point
// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let cache = Arc::new(create_cache());

    let app = Router::new()
        .route("/json", get(sun_handler))
        .route("/health", get(health_handler))
        .fallback_service(ServeDir::new("static"))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(cache);

    let bind_addr = std::env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:3000".into());
    let listener = tokio::net::TcpListener::bind(&bind_addr)
        .await
        .expect("failed to bind listener");
    tracing::info!("Listening on {}", listener.local_addr().unwrap());

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .unwrap();
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => tracing::info!("Ctrl+C received, starting graceful shutdown"),
        _ = terminate => tracing::info!("SIGTERM received, starting graceful shutdown"),
    }
}
