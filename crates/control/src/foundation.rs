use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
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
    graph,
};

#[derive(Clone)]
pub struct FoundationState {
    pub pool: PgPool,
    pub worker_token_hash: Option<[u8; 32]>,
    pub secret_key: Option<Arc<crate::crypto::SecretKey>>,
    pub recovery_key: Option<Arc<crate::recovery::RecoveryKey>>,
    pub worker_lease_seconds: i64,
    pub(crate) github: Option<Arc<crate::github_provider::GitHubProvider>>,
    pub(crate) m3: Option<Arc<crate::m3::M3Config>>,
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
        .merge(graph::routes())
        .merge(crate::portfolio_drafts::routes())
        .merge(crate::portfolio_approval::routes())
        .merge(crate::releases::routes())
        .merge(crate::portfolio_publish::routes())
        .merge(crate::runtime_policy::routes())
        .merge(crate::tenant_databases::routes())
        .merge(crate::build_jobs::routes())
        .merge(crate::portfolio_preview::routes())
        .merge(crate::secrets::routes())
        .merge(crate::jobs::routes())
        .merge(crate::github::routes())
        .merge(crate::github_webhooks::routes())
        .merge(crate::admission::routes())
        .merge(crate::compatibility::routes())
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
    let mut state = FoundationState::new(pool, prerequisites);
    state.github = crate::github_provider::GitHubProvider::from_env()
        .map_err(|_| FoundationServeError::new("github_configuration_invalid"))?
        .map(Arc::new);
    state.m3 = crate::m3::M3Config::from_env()
        .map_err(FoundationServeError::new)?
        .map(Arc::new);
    if let (Some(m3), Some(foundation_token)) = (&state.m3, &state.worker_token_hash)
        && m3.uses_foundation_token(foundation_token)
    {
        return Err(FoundationServeError::new("m3_worker_tokens_must_differ"));
    }
    let api_listener = TcpListener::bind(api_bind)
        .await
        .map_err(|_| FoundationServeError::new("api_bind_failed"))?;
    let worker_listener = TcpListener::bind(worker_bind)
        .await
        .map_err(|_| FoundationServeError::new("worker_bind_failed"))?;
    let worker_router = crate::jobs::internal_routes()
        .merge(crate::admission::internal_routes())
        .merge(crate::m3::internal_routes())
        .merge(crate::releases::internal_routes())
        .merge(crate::portfolio_publish::internal_routes())
        .merge(crate::runtime_policy::internal_routes())
        .merge(crate::tenant_databases::internal_routes())
        .merge(crate::build_jobs::internal_routes())
        .merge(crate::portfolio_approval::internal_routes())
        .route_layer(middleware::from_fn_with_state(state.clone(), require_ready))
        .with_state(state.clone());
    let api_server = axum::serve(api_listener, router(state.clone()))
        .with_graceful_shutdown(crate::shutdown_signal());
    let worker_server = axum::serve(worker_listener, worker_router)
        .with_graceful_shutdown(crate::shutdown_signal());
    let reaper = tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(1));
        loop {
            interval.tick().await;
            if state.ensure_ready().await.is_ok() {
                // Safe errors are observable through job state/readiness; no raw
                // SQL error chains or job credentials enter process logs.
                let _ = crate::jobs::reap_expired(&state.pool).await;
                let _ = crate::admission::reconcile(&state.pool).await;
                if state.m3.is_some() {
                    let _ = crate::build_jobs::reap_expired(&state.pool).await;
                    let _ = crate::portfolio_publish::reconcile_pending(&state).await;
                }
            }
        }
    });
    let result = tokio::try_join!(async { api_server.await }, async { worker_server.await })
        .map(|_| ())
        .map_err(|_| FoundationServeError::new("server_failed"));
    reaper.abort();
    result
}

impl FoundationState {
    fn new(pool: PgPool, prerequisites: FoundationPrerequisites) -> Self {
        Self {
            pool,
            worker_token_hash: prerequisites.worker_token_hash,
            secret_key: prerequisites.secret_key,
            recovery_key: prerequisites.recovery_key,
            worker_lease_seconds: prerequisites.worker_lease_seconds,
            github: None,
            m3: None,
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
        if self.worker_token_hash.is_none() {
            return Err(ApiError::foundation_unavailable());
        }
        self.check_keyrings().await
    }

    async fn check_keyrings(&self) -> Result<(), ApiError> {
        let secret_key = self
            .secret_key
            .as_deref()
            .ok_or_else(ApiError::foundation_unavailable)?;
        let recovery_key = self
            .recovery_key
            .as_deref()
            .ok_or_else(ApiError::foundation_unavailable)?;
        crate::secrets::check_keyring(&self.pool, secret_key).await?;
        crate::github::check_keyring(&self.pool, secret_key).await?;
        let tenant_keys_match: bool = sqlx::query_scalar(
            "SELECT NOT EXISTS (SELECT 1 FROM tenant_database_credentials WHERE key_version <> $1)",
        )
        .bind(secret_key.key_version())
        .fetch_one(&self.pool)
        .await?;
        if !tenant_keys_match {
            return Err(ApiError::foundation_unavailable());
        }
        crate::recovery::check_keyring(&self.pool, recovery_key)
            .await
            .map_err(|error| {
                if error.code() == "backup_key_receipt_check_failed" {
                    ApiError::database_unavailable()
                } else {
                    ApiError::foundation_unavailable()
                }
            })
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
    let keys = if schema.is_ok() {
        state.check_keyrings().await
    } else {
        Err(ApiError::foundation_unavailable())
    };
    let keys_ready = keys.is_ok();
    let database_unavailable = matches!(schema, Err(db::SchemaProblem::DatabaseUnavailable))
        || keys
            .as_ref()
            .is_err_and(|error| error.is_database_unavailable());
    let worker_ready = state.worker_token_hash.is_some();
    let reason = match schema {
        Err(problem) => Some(problem.readiness_reason()),
        Ok(()) if database_unavailable => Some("database_unavailable"),
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
            scope: if state.m3.is_some() {
                "owned_fixture_m3"
            } else {
                "control_foundation"
            },
            customer_admission: false,
            workload_execution: ready && state.m3.is_some(),
            dependencies: ReadinessDependencies {
                postgres: if database_unavailable {
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
) -> Response {
    let mut response = match state.ensure_ready().await {
        Ok(()) => next.run(request).await,
        Err(error) => error.into_response(),
    };
    let private_no_transform =
        axum::http::HeaderValue::from_static("private, no-store, no-transform");
    if response.headers().get(axum::http::header::CACHE_CONTROL) != Some(&private_no_transform) {
        response.headers_mut().insert(
            axum::http::header::CACHE_CONTROL,
            axum::http::HeaderValue::from_static("private, no-store"),
        );
    }
    response
}
