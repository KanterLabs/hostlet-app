use axum::{
    Json, Router,
    extract::{Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::Response,
    routing::{delete, get, post},
};
use serde::Serialize;
use sqlx::PgPool;
use tokio::net::TcpListener;

use crate::{
    auth,
    config::{FoundationConfig, FoundationPrerequisites},
    db,
    error::ApiError,
};

#[derive(Clone)]
pub struct FoundationState {
    pub pool: PgPool,
    prerequisites: FoundationReadiness,
}

#[derive(Clone)]
struct FoundationReadiness {
    worker_auth_configured: bool,
    secret_key_configured: bool,
    recovery_key_configured: bool,
}

pub struct FoundationServeError {
    code: &'static str,
}

impl std::fmt::Debug for FoundationServeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("FoundationServeError")
            .field("code", &self.code)
            .finish()
    }
}

impl std::fmt::Display for FoundationServeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "foundation service failed: {}", self.code)
    }
}

impl std::error::Error for FoundationServeError {}

#[derive(Serialize)]
struct ReadinessResponse {
    status: &'static str,
    scope: &'static str,
    customer_admission: bool,
    workload_execution: bool,
    dependencies: ReadinessDependencies,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
}

#[derive(Serialize)]
struct ReadinessDependencies {
    postgres: &'static str,
    schema: &'static str,
    secret_keyring: &'static str,
    worker_auth: &'static str,
}

pub fn router(state: FoundationState) -> Router {
    let resource_routes = Router::new()
        .route("/v1/accounts", post(auth::create_account))
        .route(
            "/v1/accounts/{account_id}",
            get(auth::get_account).patch(auth::update_account),
        )
        .route("/v1/sessions", post(auth::create_session))
        .route("/v1/sessions/current", delete(auth::revoke_session))
        .route("/v1/me", get(auth::me))
        .route("/v1/audit", get(auth::audit))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_ready));
    Router::new()
        .route("/healthz", get(crate::healthz))
        .route("/readyz", get(readiness))
        .route("/v1/version", get(crate::version))
        .merge(resource_routes)
        .with_state(state)
}

pub async fn serve(config: FoundationConfig) -> Result<(), FoundationServeError> {
    let (api_bind, worker_bind, database_url, prerequisites) = config.into_runtime_parts();
    let pool = db::lazy_pool(&database_url)
        .map_err(|_| FoundationServeError::new("database_configuration_invalid"))?;
    let state = FoundationState::new(pool, prerequisites);
    let api_listener = TcpListener::bind(api_bind)
        .await
        .map_err(|_| FoundationServeError::new("api_bind_failed"))?;
    let worker_listener = TcpListener::bind(worker_bind)
        .await
        .map_err(|_| FoundationServeError::new("worker_bind_failed"))?;
    let api_server =
        axum::serve(api_listener, router(state)).with_graceful_shutdown(crate::shutdown_signal());
    let worker_server = axum::serve(worker_listener, Router::new())
        .with_graceful_shutdown(crate::shutdown_signal());
    tokio::try_join!(async { api_server.await }, async { worker_server.await })
        .map(|_| ())
        .map_err(|_| FoundationServeError::new("server_failed"))
}

impl FoundationState {
    fn new(pool: PgPool, prerequisites: FoundationPrerequisites) -> Self {
        Self {
            pool,
            prerequisites: FoundationReadiness {
                worker_auth_configured: prerequisites.worker_auth_configured,
                secret_key_configured: prerequisites.secret_key_configured,
                recovery_key_configured: prerequisites.recovery_key_configured,
            },
        }
    }

    pub async fn ensure_ready(&self) -> Result<(), ApiError> {
        match db::check_schema(&self.pool).await {
            Ok(()) => {}
            Err(db::SchemaProblem::DatabaseUnavailable) => {
                return Err(ApiError::database_unavailable());
            }
            Err(_) => return Err(ApiError::foundation_unavailable()),
        }
        if !self.prerequisites.worker_auth_configured
            || !self.prerequisites.secret_key_configured
            || !self.prerequisites.recovery_key_configured
        {
            return Err(ApiError::foundation_unavailable());
        }
        Ok(())
    }
}

impl FoundationServeError {
    fn new(code: &'static str) -> Self {
        Self { code }
    }
}

async fn readiness(
    axum::extract::State(state): axum::extract::State<FoundationState>,
) -> (StatusCode, Json<ReadinessResponse>) {
    let schema = db::check_schema(&state.pool).await;
    let keys_ready =
        state.prerequisites.secret_key_configured && state.prerequisites.recovery_key_configured;
    let worker_ready = state.prerequisites.worker_auth_configured;
    let reason = match schema {
        Err(problem) => Some(problem.readiness_reason()),
        Ok(()) if !keys_ready => Some("key_material_unavailable"),
        Ok(()) if !worker_ready => Some("worker_auth_unavailable"),
        Ok(()) => None,
    };
    let ready = reason.is_none();
    (
        if ready {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        Json(ReadinessResponse {
            status: if ready { "ready" } else { "not_ready" },
            scope: "control_foundation",
            customer_admission: false,
            workload_execution: false,
            dependencies: ReadinessDependencies {
                postgres: if matches!(schema, Err(db::SchemaProblem::DatabaseUnavailable)) {
                    "unavailable"
                } else {
                    "ready"
                },
                schema: if schema.is_ok() {
                    "ready"
                } else {
                    "unavailable"
                },
                secret_keyring: if keys_ready { "ready" } else { "unavailable" },
                worker_auth: if worker_ready { "ready" } else { "unavailable" },
            },
            reason,
        }),
    )
}

async fn require_ready(
    State(state): State<FoundationState>,
    request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    state.ensure_ready().await?;
    let mut response = next.run(request).await;
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    Ok(response)
}
