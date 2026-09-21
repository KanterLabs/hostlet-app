//! Minimal Hostlet control API scaffold.

mod auth;
pub mod config;
pub mod db;
mod error;
mod foundation;
mod graph;
mod intent;
mod portfolio_drafts;

use std::{fmt, net::SocketAddr, str::FromStr};

use axum::{Router, http::StatusCode, response::Json, routing::get};
use hostlet_contracts::{PROTOCOL_VERSION, VersionResponse};
use serde::Serialize;
use tokio::net::TcpListener;

pub const SERVICE_NAME: &str = "hostlet-control";
pub const DEFAULT_BIND: &str = "127.0.0.1:8080";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub bind_addr: SocketAddr,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigError {
    input: String,
}

impl ConfigError {
    fn invalid_bind(input: impl Into<String>) -> Self {
        Self {
            input: input.into(),
        }
    }
}

impl fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "HOSTLET_API_BIND must be a valid socket address, got {:?}",
            self.input
        )
    }
}

impl std::error::Error for ConfigError {}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        let value = std::env::var("HOSTLET_API_BIND").unwrap_or_else(|_| DEFAULT_BIND.to_owned());
        Self::from_bind(&value)
    }

    pub fn from_bind(value: &str) -> Result<Self, ConfigError> {
        let bind_addr =
            SocketAddr::from_str(value).map_err(|_| ConfigError::invalid_bind(value))?;
        Ok(Self { bind_addr })
    }
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: &'static str,
}

#[derive(Debug, Serialize)]
struct ReadinessResponse {
    status: &'static str,
    reason: &'static str,
}

pub fn router() -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .route("/v1/version", get(version))
}

pub(crate) async fn healthz() -> Json<HealthResponse> {
    Json(HealthResponse { status: "ok" })
}

async fn readyz() -> (StatusCode, Json<ReadinessResponse>) {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(ReadinessResponse {
            status: "not_ready",
            reason: "product dependencies are not wired",
        }),
    )
}

pub(crate) async fn version() -> Json<VersionResponse> {
    Json(VersionResponse::new(
        SERVICE_NAME,
        env!("CARGO_PKG_VERSION"),
        PROTOCOL_VERSION,
    ))
}

/// Bind and serve the API until SIGTERM or Ctrl-C is received.
pub async fn serve(config: Config) -> Result<(), std::io::Error> {
    let listener = TcpListener::bind(config.bind_addr).await?;
    axum::serve(listener, router())
        .with_graceful_shutdown(shutdown_signal())
        .await
}

pub async fn serve_process(config: config::ProcessConfig) -> Result<(), ProcessServeError> {
    match config {
        config::ProcessConfig::Scaffold(config) => {
            serve(config).await.map_err(ProcessServeError::Scaffold)
        }
        config::ProcessConfig::Foundation(config) => foundation::serve(config)
            .await
            .map_err(ProcessServeError::Foundation),
    }
}

pub async fn migrate(config: config::ProcessConfig) -> Result<(), MigrationCliError> {
    let config::ProcessConfig::Foundation(config) = config else {
        return Err(MigrationCliError::DatabaseUrlRequired);
    };
    let (_, _, database_url, _) = config.into_runtime_parts();
    db::run_migrations(&database_url)
        .await
        .map_err(MigrationCliError::Command)
}

pub enum ProcessServeError {
    Scaffold(std::io::Error),
    Foundation(foundation::FoundationServeError),
}

impl fmt::Debug for ProcessServeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Scaffold(_) => formatter.write_str("ProcessServeError::Scaffold"),
            Self::Foundation(error) => formatter.debug_tuple("Foundation").field(error).finish(),
        }
    }
}

impl fmt::Display for ProcessServeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Scaffold(_) => formatter.write_str("scaffold server failed"),
            Self::Foundation(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for ProcessServeError {}

pub enum MigrationCliError {
    DatabaseUrlRequired,
    Command(db::MigrationCommandError),
}

impl fmt::Debug for MigrationCliError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DatabaseUrlRequired => formatter.write_str("DatabaseUrlRequired"),
            Self::Command(error) => formatter.debug_tuple("Command").field(error).finish(),
        }
    }
}

impl fmt::Display for MigrationCliError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DatabaseUrlRequired => {
                formatter.write_str("DATABASE_URL is required for migrate")
            }
            Self::Command(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for MigrationCliError {}

pub(crate) async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(error) = tokio::signal::ctrl_c().await {
            eprintln!("failed to install Ctrl-C handler: {error}");
        }
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(signal_error) => eprintln!("failed to install SIGTERM handler: {signal_error}"),
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}

#[cfg(test)]
mod tests {
    use axum::{body::Body, body::to_bytes, http::Request};
    use serde_json::Value;
    use tower::ServiceExt;

    use hostlet_contracts::API_PREFIX;

    use super::*;

    async fn get(path: &str) -> axum::http::Response<Body> {
        router()
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap()
    }

    async fn json(response: axum::http::Response<Body>) -> Value {
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    #[tokio::test]
    async fn health_is_live_and_version_is_json() {
        let health = get("/healthz").await;
        assert_eq!(health.status(), StatusCode::OK);
        assert_eq!(json(health).await["status"], "ok");

        let version = get("/v1/version").await;
        assert_eq!(version.status(), StatusCode::OK);
        let body = json(version).await;
        assert_eq!(body["service"], SERVICE_NAME);
        assert_eq!(body["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(body["protocol_version"], PROTOCOL_VERSION);
        assert_eq!(API_PREFIX, "/v1");

        let fixture: Value =
            serde_json::from_str(include_str!("../../../contracts/v1/version.json")).unwrap();
        assert_eq!(body, fixture);
    }

    #[tokio::test]
    async fn readiness_is_explicitly_unavailable() {
        let response = get("/readyz").await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = json(response).await;
        assert_eq!(body["status"], "not_ready");
        assert_eq!(body["reason"], "product dependencies are not wired");
    }

    #[test]
    fn config_uses_typed_socket_addresses() {
        assert_eq!(
            Config::from_bind("127.0.0.1:9090")
                .unwrap()
                .bind_addr
                .port(),
            9090
        );
        assert!(Config::from_bind("not-an-address").is_err());
    }
}
