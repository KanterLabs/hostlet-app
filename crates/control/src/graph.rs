use std::borrow::Cow;

use axum::{
    Json, Router,
    extract::{Path, Query, State, rejection::QueryRejection},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use hostlet_contracts::project::{
    AccountId, ArtifactReference, ConfigurationRevision, ConfigurationRevisionId, DeploymentId,
    DeploymentLifecycle, DeploymentRecord, ProjectId, ProjectMode, ProjectRecord,
    ReleaseReferences, RepositoryId, RepositoryRecord, ServiceId, ServiceKind, ServiceRecord,
    SlotRelationship, SlotState, StandardProjectSpec,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use crate::{
    auth::Authenticated,
    error::{ApiError, SafeJson},
    foundation::FoundationState,
    intent::{self, Replay},
};

type ProjectRow = (Uuid, String, String, i16, String, Uuid, i64);
type ConfigurationRow = (Uuid, i64, Value);
type RepositoryRow = (Uuid, Value);
type ServiceRow = (Uuid, Value);
type DeploymentRow = (
    Uuid,
    Uuid,
    String,
    String,
    Option<String>,
    Option<String>,
    Value,
);
type ArtifactRow = (String, Uuid, String);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProjectListQuery {
    after: Option<Uuid>,
}

#[derive(Serialize, sqlx::FromRow)]
struct ProjectSummary {
    id: Uuid,
    name: String,
    mode: String,
    revision: i64,
    current_configuration_revision_id: Option<Uuid>,
}

#[derive(Serialize)]
struct ProjectListResponse {
    projects: Vec<ProjectSummary>,
    next_cursor: Option<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectGraphResponse {
    project: ProjectRecord,
    configuration: ConfigurationRevision,
    repositories: Vec<RepositoryRecord>,
    services: Vec<ServiceRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConfigurationGraphResponse {
    configuration: ConfigurationRevision,
    repositories: Vec<RepositoryRecord>,
    services: Vec<ServiceRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServicesResponse {
    services: Vec<ServiceRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LifecycleIntentResponse {
    id: Uuid,
    project_id: ProjectId,
    kind: String,
    target_deployment_id: Option<DeploymentId>,
    state: String,
    project_revision: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateProjectRequest {
    name: String,
    configuration: StandardProjectSpec,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateProjectRequest {
    name: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateConfigurationRequest {
    configuration: StandardProjectSpec,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateDeploymentIntentRequest {
    configuration_revision_id: String,
    source_commit: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateRollbackIntentRequest {
    target_deployment_id: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateRemovalIntentRequest {}

#[derive(Serialize)]
struct GraphErrorEnvelope {
    error: GraphErrorBody,
}

#[derive(Serialize)]
struct GraphErrorBody {
    code: &'static str,
    message: Cow<'static, str>,
    request_id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<GraphErrorDetails>,
}

#[derive(Serialize)]
struct GraphErrorDetails {
    issues: Vec<GraphIssue>,
}

#[derive(Serialize)]
struct GraphIssue {
    code: String,
    path: String,
    message: String,
}

enum GraphError {
    Api(ApiError),
    Detailed {
        status: StatusCode,
        code: &'static str,
        message: &'static str,
        issues: Vec<GraphIssue>,
    },
}

impl From<ApiError> for GraphError {
    fn from(value: ApiError) -> Self {
        Self::Api(value)
    }
}

impl From<sqlx::Error> for GraphError {
    fn from(_: sqlx::Error) -> Self {
        Self::Api(ApiError::database_unavailable())
    }
}

impl IntoResponse for GraphError {
    fn into_response(self) -> Response {
        match self {
            Self::Api(error) => error.into_response(),
            Self::Detailed {
                status,
                code,
                message,
                issues,
            } => (
                status,
                Json(GraphErrorEnvelope {
                    error: GraphErrorBody {
                        code,
                        message: Cow::Borrowed(message),
                        request_id: Uuid::new_v4(),
                        details: Some(GraphErrorDetails { issues }),
                    },
                }),
            )
                .into_response(),
        }
    }
}

pub fn routes() -> Router<FoundationState> {
    Router::new()
        .route("/v1/projects", post(create_project).get(list_projects))
        .route(
            "/v1/projects/{project_id}",
            get(get_project).patch(update_project),
        )
        .route(
            "/v1/projects/{project_id}/configuration-revisions",
            post(create_configuration),
        )
        .route(
            "/v1/projects/{project_id}/configuration-revisions/{configuration_id}",
            get(get_configuration),
        )
        .route("/v1/projects/{project_id}/services", get(get_services))
        .route(
            "/v1/projects/{project_id}/services/{service_id}",
            get(get_service),
        )
        .route(
            "/v1/projects/{project_id}/deployment-intents",
            post(create_deployment_intent),
        )
        .route(
            "/v1/projects/{project_id}/deployments/{deployment_id}",
            get(get_deployment),
        )
        .route(
            "/v1/projects/{project_id}/rollback-intents",
            post(create_rollback_intent),
        )
        .route(
            "/v1/projects/{project_id}/removal-intents",
            post(create_removal_intent),
        )
}

fn validate_name(name: &str) -> Result<(), GraphError> {
    if name.trim().is_empty()
        || name.len() > 120
        || name.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err(validation_error(
            "invalid_project_configuration",
            vec![GraphIssue {
                code: "invalid_name".into(),
                path: "name".into(),
                message: "project name must contain 1 to 120 non-control bytes".into(),
            }],
        ));
    }
    Ok(())
}

fn validate_spec(spec: &StandardProjectSpec) -> Result<(), GraphError> {
    let issues = spec
        .validate()
        .into_iter()
        .map(|issue| GraphIssue {
            code: serde_json::to_value(issue.code)
                .ok()
                .and_then(|value| value.as_str().map(str::to_owned))
                .unwrap_or_else(|| "invalid_configuration".into()),
            path: issue.path,
            message: issue.message,
        })
        .collect::<Vec<_>>();
    if issues.is_empty() {
        Ok(())
    } else {
        Err(validation_error("invalid_project_configuration", issues))
    }
}

fn validation_error(code: &'static str, issues: Vec<GraphIssue>) -> GraphError {
    GraphError::Detailed {
        status: StatusCode::UNPROCESSABLE_ENTITY,
        code,
        message: "the request failed contract validation",
        issues,
    }
}

fn changed_payload() -> GraphError {
    ApiError::conflict(
        "idempotency_payload_changed",
        "the idempotency key was already used with a different request",
    )
    .into()
}

fn lifecycle_pending() -> GraphError {
    ApiError::conflict(
        "lifecycle_intent_pending",
        "the project already has a pending lifecycle intent",
    )
    .into()
}

async fn has_pending_lifecycle_intent(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    project_id: Uuid,
) -> Result<bool, GraphError> {
    Ok(sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM project_lifecycle_intents \
         WHERE account_id = $1 AND project_id = $2 AND state = 'requested')",
    )
    .bind(account_id)
    .bind(project_id)
    .fetch_one(&mut **transaction)
    .await?)
}

fn as_u64(value: i64) -> Result<u64, GraphError> {
    u64::try_from(value).map_err(|_| ApiError::internal().into())
}

fn service_kind(kind: ServiceKind) -> Result<&'static str, GraphError> {
    match kind {
        ServiceKind::StaticFrontend => Ok("static_frontend"),
        ServiceKind::Application => Ok("application"),
        ServiceKind::Postgres => Ok("postgres"),
        _ => Err(ApiError::internal().into()),
    }
}

fn project_mode(value: &str) -> Result<ProjectMode, GraphError> {
    match value {
        "draft" => Ok(ProjectMode::Draft),
        "compatibility_check" => Ok(ProjectMode::CompatibilityCheck),
        "deployment_intent" => Ok(ProjectMode::DeploymentIntent),
        "showcase_only" => Ok(ProjectMode::ShowcaseOnly),
        "portfolio_only" => Ok(ProjectMode::PortfolioOnly),
        "external_case_study" => Ok(ProjectMode::ExternalCaseStudy),
        _ => Err(ApiError::internal().into()),
    }
}

fn slot_state(value: &str) -> Result<SlotState, GraphError> {
    match value {
        "no_slot" => Ok(SlotState::NoSlot),
        "admission_required" => Ok(SlotState::AdmissionRequired),
        "reserved" => Ok(SlotState::Reserved),
        "resources_retained" => Ok(SlotState::ResourcesRetained),
        "release_pending" => Ok(SlotState::ReleasePending),
        "released" => Ok(SlotState::Released),
        _ => Err(ApiError::internal().into()),
    }
}

fn deployment_lifecycle(value: &str) -> Result<DeploymentLifecycle, GraphError> {
    match value {
        "intent" => Ok(DeploymentLifecycle::Intent),
        "admission_required" => Ok(DeploymentLifecycle::AdmissionRequired),
        "queued" => Ok(DeploymentLifecycle::Queued),
        "healthy" => Ok(DeploymentLifecycle::Healthy),
        "failed_no_resources" => Ok(DeploymentLifecycle::FailedNoResources),
        "failed_resources_retained" => Ok(DeploymentLifecycle::FailedResourcesRetained),
        "rollback_requested" => Ok(DeploymentLifecycle::RollbackRequested),
        "removed" => Ok(DeploymentLifecycle::Removed),
        _ => Err(ApiError::internal().into()),
    }
}

async fn load_configuration(
    executor: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    project_id: Uuid,
    configuration_id: Uuid,
) -> Result<ConfigurationGraphResponse, GraphError> {
    let (id, revision, spec): ConfigurationRow = sqlx::query_as(
        "SELECT id, revision_number, spec FROM configuration_revisions \
         WHERE account_id = $1 AND project_id = $2 AND id = $3",
    )
    .bind(account_id)
    .bind(project_id)
    .bind(configuration_id)
    .fetch_optional(&mut **executor)
    .await?
    .ok_or_else(ApiError::not_found)?;
    let spec: StandardProjectSpec =
        serde_json::from_value(spec).map_err(|_| ApiError::internal())?;

    let repository_rows: Vec<RepositoryRow> = sqlx::query_as(
        "SELECT repository_id, configuration FROM repository_configurations \
         WHERE account_id = $1 AND project_id = $2 AND configuration_revision_id = $3 \
         ORDER BY repository_id",
    )
    .bind(account_id)
    .bind(project_id)
    .bind(configuration_id)
    .fetch_all(&mut **executor)
    .await?;
    let repositories = repository_rows
        .into_iter()
        .map(|(repository_id, configuration)| {
            Ok(RepositoryRecord {
                id: RepositoryId(repository_id.to_string()),
                project_id: ProjectId(project_id.to_string()),
                configuration: serde_json::from_value(configuration)
                    .map_err(|_| ApiError::internal())?,
                revision: as_u64(revision)?,
            })
        })
        .collect::<Result<Vec<_>, GraphError>>()?;

    let service_rows: Vec<ServiceRow> = sqlx::query_as(
        "SELECT service_id, specification FROM service_configurations \
         WHERE account_id = $1 AND project_id = $2 AND configuration_revision_id = $3 \
         ORDER BY kind, name, service_id",
    )
    .bind(account_id)
    .bind(project_id)
    .bind(configuration_id)
    .fetch_all(&mut **executor)
    .await?;
    let services = service_rows
        .into_iter()
        .map(|(service_id, specification)| {
            Ok(ServiceRecord {
                id: ServiceId(service_id.to_string()),
                project_id: ProjectId(project_id.to_string()),
                configuration: serde_json::from_value(specification)
                    .map_err(|_| ApiError::internal())?,
                revision: as_u64(revision)?,
            })
        })
        .collect::<Result<Vec<_>, GraphError>>()?;

    Ok(ConfigurationGraphResponse {
        configuration: ConfigurationRevision {
            id: ConfigurationRevisionId(id.to_string()),
            project_id: ProjectId(project_id.to_string()),
            revision: as_u64(revision)?,
            spec,
            public_environment_names: Vec::new(),
            secret_version_refs: Vec::new(),
        },
        repositories,
        services,
    })
}

async fn load_project_graph(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    project_id: Uuid,
) -> Result<ProjectGraphResponse, GraphError> {
    let (id, name, mode, hosted_slots, state, configuration_id, revision): ProjectRow =
        sqlx::query_as(
            "SELECT id, name, mode, hosted_slots, slot_state, \
                    current_configuration_revision_id, revision \
             FROM projects WHERE account_id = $1 AND id = $2",
        )
        .bind(account_id)
        .bind(project_id)
        .fetch_optional(&mut **transaction)
        .await?
        .ok_or_else(ApiError::not_found)?;
    let graph = load_configuration(transaction, account_id, project_id, configuration_id).await?;
    Ok(ProjectGraphResponse {
        project: ProjectRecord {
            id: ProjectId(id.to_string()),
            owner_account_id: AccountId(account_id.to_string()),
            name,
            mode: project_mode(&mode)?,
            slot: SlotRelationship {
                hosted_slots: u8::try_from(hosted_slots).map_err(|_| ApiError::internal())?,
                state: slot_state(&state)?,
            },
            revision: as_u64(revision)?,
        },
        configuration: graph.configuration,
        repositories: graph.repositories,
        services: graph.services,
    })
}

async fn persist_configuration(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    project_id: Uuid,
    revision: i64,
    spec: &StandardProjectSpec,
) -> Result<Uuid, GraphError> {
    let configuration_id = Uuid::new_v4();
    let spec_json = serde_json::to_value(spec).map_err(|_| ApiError::internal())?;
    sqlx::query(
        "INSERT INTO configuration_revisions \
         (id, account_id, project_id, revision_number, spec) VALUES ($1,$2,$3,$4,$5)",
    )
    .bind(configuration_id)
    .bind(account_id)
    .bind(project_id)
    .bind(revision)
    .bind(spec_json)
    .execute(&mut **transaction)
    .await?;

    let repository_id: Uuid =
        sqlx::query_scalar("SELECT id FROM repositories WHERE account_id = $1 AND project_id = $2")
            .bind(account_id)
            .bind(project_id)
            .fetch_optional(&mut **transaction)
            .await?
            .unwrap_or_else(Uuid::new_v4);
    sqlx::query(
        "INSERT INTO repositories (id, account_id, project_id) VALUES ($1,$2,$3) \
         ON CONFLICT (project_id) DO NOTHING",
    )
    .bind(repository_id)
    .bind(account_id)
    .bind(project_id)
    .execute(&mut **transaction)
    .await?;
    let repository_id: Uuid =
        sqlx::query_scalar("SELECT id FROM repositories WHERE account_id = $1 AND project_id = $2")
            .bind(account_id)
            .bind(project_id)
            .fetch_one(&mut **transaction)
            .await?;
    let repository = spec.repositories.first().ok_or_else(ApiError::internal)?;
    sqlx::query(
        "INSERT INTO repository_configurations \
         (account_id, project_id, configuration_revision_id, repository_id, configuration) \
         VALUES ($1,$2,$3,$4,$5)",
    )
    .bind(account_id)
    .bind(project_id)
    .bind(configuration_id)
    .bind(repository_id)
    .bind(serde_json::to_value(repository).map_err(|_| ApiError::internal())?)
    .execute(&mut **transaction)
    .await?;

    for service in &spec.services {
        let kind = service_kind(service.kind)?;
        let service_id: Uuid = sqlx::query_scalar(
            "SELECT id FROM services \
             WHERE account_id = $1 AND project_id = $2 AND kind = $3",
        )
        .bind(account_id)
        .bind(project_id)
        .bind(kind)
        .fetch_optional(&mut **transaction)
        .await?
        .unwrap_or_else(Uuid::new_v4);
        sqlx::query(
            "INSERT INTO services (id, account_id, project_id, kind) VALUES ($1,$2,$3,$4) \
             ON CONFLICT (project_id, kind) DO NOTHING",
        )
        .bind(service_id)
        .bind(account_id)
        .bind(project_id)
        .bind(kind)
        .execute(&mut **transaction)
        .await?;
        let service_id: Uuid = sqlx::query_scalar(
            "SELECT id FROM services WHERE account_id = $1 AND project_id = $2 AND kind = $3",
        )
        .bind(account_id)
        .bind(project_id)
        .bind(kind)
        .fetch_one(&mut **transaction)
        .await?;
        sqlx::query(
            "INSERT INTO service_configurations \
             (account_id, project_id, configuration_revision_id, service_id, name, kind, specification) \
             VALUES ($1,$2,$3,$4,$5,$6,$7)",
        )
        .bind(account_id)
        .bind(project_id)
        .bind(configuration_id)
        .bind(service_id)
        .bind(&service.name)
        .bind(kind)
        .bind(serde_json::to_value(service).map_err(|_| ApiError::internal())?)
        .execute(&mut **transaction)
        .await?;
    }
    Ok(configuration_id)
}

async fn get_project(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    Path(project_id): Path<String>,
) -> Result<Json<ProjectGraphResponse>, GraphError> {
    let account_id = authenticated.account_id()?;
    let project_id = intent::path_uuid(&project_id)?;
    let mut transaction = state.pool.begin().await?;
    let response = load_project_graph(&mut transaction, account_id, project_id).await?;
    transaction.commit().await?;
    Ok(Json(response))
}

async fn get_configuration(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    Path((project_id, configuration_id)): Path<(String, String)>,
) -> Result<Json<ConfigurationGraphResponse>, GraphError> {
    let account_id = authenticated.account_id()?;
    let project_id = intent::path_uuid(&project_id)?;
    let configuration_id = intent::path_uuid(&configuration_id)?;
    let mut transaction = state.pool.begin().await?;
    let response =
        load_configuration(&mut transaction, account_id, project_id, configuration_id).await?;
    transaction.commit().await?;
    Ok(Json(response))
}

async fn get_services(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    Path(project_id): Path<String>,
) -> Result<Json<ServicesResponse>, GraphError> {
    let account_id = authenticated.account_id()?;
    let project_id = intent::path_uuid(&project_id)?;
    let mut transaction = state.pool.begin().await?;
    let graph = load_project_graph(&mut transaction, account_id, project_id).await?;
    transaction.commit().await?;
    Ok(Json(ServicesResponse {
        services: graph.services,
    }))
}

async fn get_service(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    Path((project_id, service_id)): Path<(String, String)>,
) -> Result<Json<ServiceRecord>, GraphError> {
    let service_id = intent::path_uuid(&service_id)?;
    let account_id = authenticated.account_id()?;
    let project_id = intent::path_uuid(&project_id)?;
    let mut transaction = state.pool.begin().await?;
    let graph = load_project_graph(&mut transaction, account_id, project_id).await?;
    let service = graph
        .services
        .into_iter()
        .find(|service| service.id.0 == service_id.to_string())
        .ok_or_else(ApiError::not_found)?;
    transaction.commit().await?;
    Ok(Json(service))
}

// The private picker survives reloads without storing a second project model
// in the browser. UUID keyset pagination bounds each response to fifty summaries.
async fn list_projects(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    query: Result<Query<ProjectListQuery>, QueryRejection>,
) -> Result<Response, GraphError> {
    let Query(query) = query.map_err(|_| {
        ApiError::bad_request("invalid_project_cursor", "use a valid project cursor")
    })?;
    let mut projects: Vec<ProjectSummary> = sqlx::query_as(
        "SELECT id,name,mode,revision,current_configuration_revision_id FROM projects \
         WHERE account_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 51",
    )
    .bind(authenticated.account_id()?)
    .bind(query.after)
    .fetch_all(&state.pool)
    .await?;
    let next_cursor = if projects.len() > 50 {
        projects.truncate(50);
        projects.last().map(|project| project.id)
    } else {
        None
    };
    Ok((
        [(header::CACHE_CONTROL, "private, no-store")],
        Json(ProjectListResponse {
            projects,
            next_cursor,
        }),
    )
        .into_response())
}

async fn create_project(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    headers: HeaderMap,
    SafeJson(request): SafeJson<CreateProjectRequest>,
) -> Result<(StatusCode, Json<ProjectGraphResponse>), GraphError> {
    validate_name(&request.name)?;
    validate_spec(&request.configuration)?;
    let account_id = authenticated.account_id()?;
    let key = intent::idempotency_key(&headers)?;
    let hash = intent::request_hash(&request)?;
    let operation = "project.create";
    let mut transaction = state.pool.begin().await?;
    intent::acquire_operation_lock(&mut transaction, account_id, operation, key).await?;
    match intent::replay(&mut transaction, account_id, operation, key, &hash).await? {
        Replay::Match(response) => {
            transaction.commit().await?;
            return Ok((StatusCode::CREATED, Json(response)));
        }
        Replay::Changed => {
            intent::audit(
                &mut transaction,
                account_id,
                authenticated.session_id(),
                "project.create",
                "project",
                None,
                "idempotency_conflict",
            )
            .await?;
            transaction.commit().await?;
            return Err(changed_payload());
        }
        Replay::Miss => {}
    }
    let project_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO projects (id, account_id, name, mode, hosted_slots, slot_state) \
         VALUES ($1,$2,$3,'draft',0,'no_slot')",
    )
    .bind(project_id)
    .bind(account_id)
    .bind(request.name.trim())
    .execute(&mut *transaction)
    .await?;
    let configuration_id = persist_configuration(
        &mut transaction,
        account_id,
        project_id,
        1,
        &request.configuration,
    )
    .await?;
    sqlx::query(
        "UPDATE projects SET current_configuration_revision_id = $1, updated_at = transaction_timestamp() \
         WHERE account_id = $2 AND id = $3",
    )
    .bind(configuration_id)
    .bind(account_id)
    .bind(project_id)
    .execute(&mut *transaction)
    .await?;
    let response = load_project_graph(&mut transaction, account_id, project_id).await?;
    intent::audit(
        &mut transaction,
        account_id,
        authenticated.session_id(),
        "project.create",
        "project",
        Some(project_id),
        "succeeded",
    )
    .await?;
    intent::store_replay(
        &mut transaction,
        account_id,
        operation,
        key,
        &hash,
        201,
        &response,
    )
    .await?;
    transaction.commit().await?;
    Ok((StatusCode::CREATED, Json(response)))
}

async fn update_project(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    SafeJson(request): SafeJson<UpdateProjectRequest>,
) -> Result<Json<ProjectGraphResponse>, GraphError> {
    validate_name(&request.name)?;
    let project_id = intent::path_uuid(&project_id)?;
    let account_id = authenticated.account_id()?;
    let key = intent::idempotency_key(&headers)?;
    let expected_revision = intent::if_match_revision(&headers)?;
    let hash = intent::request_hash(&request)?;
    let operation = format!("project.update/{project_id}");
    let mut transaction = state.pool.begin().await?;
    intent::acquire_operation_lock(&mut transaction, account_id, &operation, key).await?;
    match intent::replay(&mut transaction, account_id, &operation, key, &hash).await? {
        Replay::Match(response) => {
            transaction.commit().await?;
            return Ok(Json(response));
        }
        Replay::Changed => {
            intent::audit(
                &mut transaction,
                account_id,
                authenticated.session_id(),
                "project.update",
                "project",
                Some(project_id),
                "idempotency_conflict",
            )
            .await?;
            transaction.commit().await?;
            return Err(changed_payload());
        }
        Replay::Miss => {}
    }
    let revision: Option<i64> = sqlx::query_scalar(
        "SELECT revision FROM projects WHERE account_id = $1 AND id = $2 FOR UPDATE",
    )
    .bind(account_id)
    .bind(project_id)
    .fetch_optional(&mut *transaction)
    .await?;
    let revision = revision.ok_or_else(ApiError::not_found)?;
    if revision != expected_revision {
        intent::audit(
            &mut transaction,
            account_id,
            authenticated.session_id(),
            "project.update",
            "project",
            Some(project_id),
            "stale_revision",
        )
        .await?;
        transaction.commit().await?;
        return Err(ApiError::stale_revision().into());
    }
    sqlx::query(
        "UPDATE projects SET name = $1, revision = revision + 1, \
         updated_at = transaction_timestamp() WHERE account_id = $2 AND id = $3",
    )
    .bind(request.name.trim())
    .bind(account_id)
    .bind(project_id)
    .execute(&mut *transaction)
    .await?;
    let response = load_project_graph(&mut transaction, account_id, project_id).await?;
    intent::audit(
        &mut transaction,
        account_id,
        authenticated.session_id(),
        "project.update",
        "project",
        Some(project_id),
        "succeeded",
    )
    .await?;
    intent::store_replay(
        &mut transaction,
        account_id,
        &operation,
        key,
        &hash,
        200,
        &response,
    )
    .await?;
    transaction.commit().await?;
    Ok(Json(response))
}

async fn create_configuration(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    SafeJson(request): SafeJson<CreateConfigurationRequest>,
) -> Result<(StatusCode, Json<ProjectGraphResponse>), GraphError> {
    validate_spec(&request.configuration)?;
    let project_id = intent::path_uuid(&project_id)?;
    let account_id = authenticated.account_id()?;
    let key = intent::idempotency_key(&headers)?;
    let expected_revision = intent::if_match_revision(&headers)?;
    let hash = intent::request_hash(&request)?;
    let operation = format!("project.configuration.create/{project_id}");
    let mut transaction = state.pool.begin().await?;
    intent::acquire_operation_lock(&mut transaction, account_id, &operation, key).await?;
    match intent::replay(&mut transaction, account_id, &operation, key, &hash).await? {
        Replay::Match(response) => {
            transaction.commit().await?;
            return Ok((StatusCode::CREATED, Json(response)));
        }
        Replay::Changed => {
            intent::audit(
                &mut transaction,
                account_id,
                authenticated.session_id(),
                "project.configuration.create",
                "project",
                Some(project_id),
                "idempotency_conflict",
            )
            .await?;
            transaction.commit().await?;
            return Err(changed_payload());
        }
        Replay::Miss => {}
    }
    let row: Option<(i64,)> = sqlx::query_as(
        "SELECT revision FROM projects WHERE account_id = $1 AND id = $2 FOR UPDATE",
    )
    .bind(account_id)
    .bind(project_id)
    .fetch_optional(&mut *transaction)
    .await?;
    let revision = row.ok_or_else(ApiError::not_found)?.0;
    if revision != expected_revision {
        intent::audit(
            &mut transaction,
            account_id,
            authenticated.session_id(),
            "project.configuration.create",
            "project",
            Some(project_id),
            "stale_revision",
        )
        .await?;
        transaction.commit().await?;
        return Err(ApiError::stale_revision().into());
    }
    let next_configuration_revision: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(revision_number), 0) + 1 FROM configuration_revisions \
         WHERE account_id = $1 AND project_id = $2",
    )
    .bind(account_id)
    .bind(project_id)
    .fetch_one(&mut *transaction)
    .await?;
    let configuration_id = persist_configuration(
        &mut transaction,
        account_id,
        project_id,
        next_configuration_revision,
        &request.configuration,
    )
    .await?;
    sqlx::query(
        "UPDATE projects SET current_configuration_revision_id = $1, revision = revision + 1, \
         updated_at = transaction_timestamp() WHERE account_id = $2 AND id = $3",
    )
    .bind(configuration_id)
    .bind(account_id)
    .bind(project_id)
    .execute(&mut *transaction)
    .await?;
    let response = load_project_graph(&mut transaction, account_id, project_id).await?;
    intent::audit(
        &mut transaction,
        account_id,
        authenticated.session_id(),
        "project.configuration.create",
        "configuration_revision",
        Some(configuration_id),
        "succeeded",
    )
    .await?;
    intent::store_replay(
        &mut transaction,
        account_id,
        &operation,
        key,
        &hash,
        201,
        &response,
    )
    .await?;
    transaction.commit().await?;
    Ok((StatusCode::CREATED, Json(response)))
}

async fn load_deployment(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    project_id: Uuid,
    deployment_id: Uuid,
) -> Result<DeploymentRecord, GraphError> {
    let (
        id,
        configuration_id,
        source_commit,
        lifecycle,
        health_result_ref,
        database_revision,
        secret_refs,
    ): DeploymentRow = sqlx::query_as(
        "SELECT id, configuration_revision_id, source_commit, lifecycle, health_result_ref, \
                    database_migration_revision, secret_version_refs \
             FROM deployments WHERE account_id = $1 AND project_id = $2 AND id = $3",
    )
    .bind(account_id)
    .bind(project_id)
    .bind(deployment_id)
    .fetch_optional(&mut **transaction)
    .await?
    .ok_or_else(ApiError::not_found)?;
    let artifact_rows: Vec<ArtifactRow> = sqlx::query_as(
        "SELECT kind, service_id, digest FROM deployment_artifact_refs \
         WHERE account_id = $1 AND project_id = $2 AND deployment_id = $3 ORDER BY kind",
    )
    .bind(account_id)
    .bind(project_id)
    .bind(deployment_id)
    .fetch_all(&mut **transaction)
    .await?;
    let mut static_artifact = None;
    let mut application_artifact = None;
    for (kind, service_id, digest) in artifact_rows {
        let artifact = ArtifactReference {
            service_id: ServiceId(service_id.to_string()),
            digest,
        };
        match kind.as_str() {
            "static" => static_artifact = Some(artifact),
            "application" => application_artifact = Some(artifact),
            _ => return Err(ApiError::internal().into()),
        }
    }
    Ok(DeploymentRecord {
        id: DeploymentId(id.to_string()),
        project_id: ProjectId(project_id.to_string()),
        configuration_revision_id: ConfigurationRevisionId(configuration_id.to_string()),
        source_commit,
        lifecycle: deployment_lifecycle(&lifecycle)?,
        release: ReleaseReferences {
            static_artifact,
            application_artifact,
            health_result_ref,
            database_migration_revision: database_revision,
            secret_version_refs: serde_json::from_value(secret_refs)
                .map_err(|_| ApiError::internal())?,
        },
    })
}

async fn get_deployment(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    Path((project_id, deployment_id)): Path<(String, String)>,
) -> Result<Json<DeploymentRecord>, GraphError> {
    let account_id = authenticated.account_id()?;
    let project_id = intent::path_uuid(&project_id)?;
    let deployment_id = intent::path_uuid(&deployment_id)?;
    let mut transaction = state.pool.begin().await?;
    let response = load_deployment(&mut transaction, account_id, project_id, deployment_id).await?;
    transaction.commit().await?;
    Ok(Json(response))
}

fn valid_source_commit(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

async fn create_deployment_intent(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    SafeJson(request): SafeJson<CreateDeploymentIntentRequest>,
) -> Result<(StatusCode, Json<DeploymentRecord>), GraphError> {
    let project_id = intent::path_uuid(&project_id)?;
    let configuration_id = intent::path_uuid(&request.configuration_revision_id)?;
    if !valid_source_commit(&request.source_commit) {
        return Err(validation_error(
            "invalid_project_configuration",
            vec![GraphIssue {
                code: "invalid_source_commit".into(),
                path: "source_commit".into(),
                message: "source_commit must be 40 or 64 lowercase hexadecimal characters".into(),
            }],
        ));
    }
    let account_id = authenticated.account_id()?;
    let key = intent::idempotency_key(&headers)?;
    let expected_revision = intent::if_match_revision(&headers)?;
    let hash = intent::request_hash(&request)?;
    let operation = format!("project.deployment_intent.create/{project_id}");
    let mut transaction = state.pool.begin().await?;
    intent::acquire_operation_lock(&mut transaction, account_id, &operation, key).await?;
    match intent::replay(&mut transaction, account_id, &operation, key, &hash).await? {
        Replay::Match(response) => {
            transaction.commit().await?;
            return Ok((StatusCode::CREATED, Json(response)));
        }
        Replay::Changed => {
            intent::audit(
                &mut transaction,
                account_id,
                authenticated.session_id(),
                "project.deployment_intent.create",
                "project",
                Some(project_id),
                "idempotency_conflict",
            )
            .await?;
            transaction.commit().await?;
            return Err(changed_payload());
        }
        Replay::Miss => {}
    }
    let row: Option<(i64, i16, String)> = sqlx::query_as(
        "SELECT revision, hosted_slots, slot_state FROM projects \
         WHERE account_id = $1 AND id = $2 FOR UPDATE",
    )
    .bind(account_id)
    .bind(project_id)
    .fetch_optional(&mut *transaction)
    .await?;
    let (revision, hosted_slots, slot_state) = row.ok_or_else(ApiError::not_found)?;
    if revision != expected_revision {
        intent::audit(
            &mut transaction,
            account_id,
            authenticated.session_id(),
            "project.deployment_intent.create",
            "project",
            Some(project_id),
            "stale_revision",
        )
        .await?;
        transaction.commit().await?;
        return Err(ApiError::stale_revision().into());
    }
    if slot_state == "release_pending"
        || has_pending_lifecycle_intent(&mut transaction, account_id, project_id).await?
    {
        intent::audit(
            &mut transaction,
            account_id,
            authenticated.session_id(),
            "project.deployment_intent.create",
            "project",
            Some(project_id),
            "lifecycle_intent_pending",
        )
        .await?;
        transaction.commit().await?;
        return Err(lifecycle_pending());
    }
    let deployment_pending: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM deployments \
         WHERE account_id = $1 AND project_id = $2 AND lifecycle = 'admission_required')",
    )
    .bind(account_id)
    .bind(project_id)
    .fetch_one(&mut *transaction)
    .await?;
    if deployment_pending {
        intent::audit(
            &mut transaction,
            account_id,
            authenticated.session_id(),
            "project.deployment_intent.create",
            "project",
            Some(project_id),
            "deployment_intent_pending",
        )
        .await?;
        transaction.commit().await?;
        return Err(ApiError::conflict(
            "deployment_intent_pending",
            "the project already has a deployment awaiting admission",
        )
        .into());
    }
    let owned_configuration: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM configuration_revisions \
         WHERE account_id = $1 AND project_id = $2 AND id = $3)",
    )
    .bind(account_id)
    .bind(project_id)
    .bind(configuration_id)
    .fetch_one(&mut *transaction)
    .await?;
    if !owned_configuration {
        intent::audit(
            &mut transaction,
            account_id,
            authenticated.session_id(),
            "project.deployment_intent.create",
            "configuration_revision",
            Some(configuration_id),
            "denied",
        )
        .await?;
        transaction.commit().await?;
        return Err(ApiError::not_found().into());
    }
    let deployment_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO deployments \
         (id, account_id, project_id, configuration_revision_id, source_commit, lifecycle) \
         VALUES ($1,$2,$3,$4,$5,'admission_required')",
    )
    .bind(deployment_id)
    .bind(account_id)
    .bind(project_id)
    .bind(configuration_id)
    .bind(&request.source_commit)
    .execute(&mut *transaction)
    .await?;
    sqlx::query(
        "INSERT INTO hosting_state_events \
         (id, account_id, project_id, deployment_id, state, source, reason) \
         VALUES ($1,$2,$3,$4,'admission_required','owner_intent','deployment intent requires capacity admission')",
    )
    .bind(Uuid::new_v4())
    .bind(account_id)
    .bind(project_id)
    .bind(deployment_id)
    .execute(&mut *transaction)
    .await?;
    let (next_hosted_slots, next_slot_state) =
        if matches!(slot_state.as_str(), "no_slot" | "released") {
            (0_i16, "admission_required")
        } else {
            (hosted_slots, slot_state.as_str())
        };
    sqlx::query(
        "UPDATE projects SET mode = 'deployment_intent', hosted_slots = $1, \
         slot_state = $2, revision = revision + 1, updated_at = transaction_timestamp() \
         WHERE account_id = $3 AND id = $4",
    )
    .bind(next_hosted_slots)
    .bind(next_slot_state)
    .bind(account_id)
    .bind(project_id)
    .execute(&mut *transaction)
    .await?;
    let response = load_deployment(&mut transaction, account_id, project_id, deployment_id).await?;
    intent::audit(
        &mut transaction,
        account_id,
        authenticated.session_id(),
        "project.deployment_intent.create",
        "deployment",
        Some(deployment_id),
        "succeeded",
    )
    .await?;
    intent::store_replay(
        &mut transaction,
        account_id,
        &operation,
        key,
        &hash,
        201,
        &response,
    )
    .await?;
    transaction.commit().await?;
    Ok((StatusCode::CREATED, Json(response)))
}

async fn create_rollback_intent(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    SafeJson(request): SafeJson<CreateRollbackIntentRequest>,
) -> Result<(StatusCode, Json<LifecycleIntentResponse>), GraphError> {
    let account_id = authenticated.account_id()?;
    let project_id = intent::path_uuid(&project_id)?;
    let target_id = intent::path_uuid(&request.target_deployment_id)?;
    let key = intent::idempotency_key(&headers)?;
    let expected_revision = intent::if_match_revision(&headers)?;
    let hash = intent::request_hash(&request)?;
    let operation = format!("project.rollback_intent.create/{project_id}");
    let mut transaction = state.pool.begin().await?;
    intent::acquire_operation_lock(&mut transaction, account_id, &operation, key).await?;
    match intent::replay(&mut transaction, account_id, &operation, key, &hash).await? {
        Replay::Match(response) => {
            transaction.commit().await?;
            return Ok((StatusCode::CREATED, Json(response)));
        }
        Replay::Changed => {
            intent::audit(
                &mut transaction,
                account_id,
                authenticated.session_id(),
                "project.rollback_intent.create",
                "project",
                Some(project_id),
                "idempotency_conflict",
            )
            .await?;
            transaction.commit().await?;
            return Err(changed_payload());
        }
        Replay::Miss => {}
    }
    let row: Option<(i64, String)> = sqlx::query_as(
        "SELECT revision, slot_state FROM projects \
         WHERE account_id = $1 AND id = $2 FOR UPDATE",
    )
    .bind(account_id)
    .bind(project_id)
    .fetch_optional(&mut *transaction)
    .await?;
    let (revision, slot_state) = row.ok_or_else(ApiError::not_found)?;
    if revision != expected_revision {
        intent::audit(
            &mut transaction,
            account_id,
            authenticated.session_id(),
            "project.rollback_intent.create",
            "project",
            Some(project_id),
            "stale_revision",
        )
        .await?;
        transaction.commit().await?;
        return Err(ApiError::stale_revision().into());
    }
    if slot_state == "release_pending"
        || has_pending_lifecycle_intent(&mut transaction, account_id, project_id).await?
    {
        intent::audit(
            &mut transaction,
            account_id,
            authenticated.session_id(),
            "project.rollback_intent.create",
            "project",
            Some(project_id),
            "lifecycle_intent_pending",
        )
        .await?;
        transaction.commit().await?;
        return Err(lifecycle_pending());
    }
    let lifecycle: Option<String> = sqlx::query_scalar(
        "SELECT lifecycle FROM deployments \
         WHERE account_id = $1 AND project_id = $2 AND id = $3",
    )
    .bind(account_id)
    .bind(project_id)
    .bind(target_id)
    .fetch_optional(&mut *transaction)
    .await?;
    let Some(lifecycle) = lifecycle else {
        intent::audit(
            &mut transaction,
            account_id,
            authenticated.session_id(),
            "project.rollback_intent.create",
            "deployment",
            Some(target_id),
            "denied",
        )
        .await?;
        transaction.commit().await?;
        return Err(ApiError::not_found().into());
    };
    if lifecycle != "healthy" {
        intent::audit(
            &mut transaction,
            account_id,
            authenticated.session_id(),
            "project.rollback_intent.create",
            "deployment",
            Some(target_id),
            "ineligible",
        )
        .await?;
        transaction.commit().await?;
        return Err(ApiError::conflict(
            "rollback_target_ineligible",
            "the target deployment is not eligible for rollback",
        )
        .into());
    }
    let intent_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO project_lifecycle_intents \
         (id, account_id, project_id, kind, target_deployment_id) \
         VALUES ($1,$2,$3,'rollback',$4)",
    )
    .bind(intent_id)
    .bind(account_id)
    .bind(project_id)
    .bind(target_id)
    .execute(&mut *transaction)
    .await?;
    sqlx::query(
        "INSERT INTO hosting_state_events \
         (id, account_id, project_id, deployment_id, state, source, reason) \
         VALUES ($1,$2,$3,$4,'rollback_requested','owner_intent','owner requested rollback to a healthy deployment')",
    )
    .bind(Uuid::new_v4())
    .bind(account_id)
    .bind(project_id)
    .bind(target_id)
    .execute(&mut *transaction)
    .await?;
    let project_revision: i64 = sqlx::query_scalar(
        "UPDATE projects SET revision = revision + 1, updated_at = transaction_timestamp() \
         WHERE account_id = $1 AND id = $2 RETURNING revision",
    )
    .bind(account_id)
    .bind(project_id)
    .fetch_one(&mut *transaction)
    .await?;
    let response = LifecycleIntentResponse {
        id: intent_id,
        project_id: ProjectId(project_id.to_string()),
        kind: "rollback".into(),
        target_deployment_id: Some(DeploymentId(target_id.to_string())),
        state: "requested".into(),
        project_revision: as_u64(project_revision)?,
    };
    intent::audit(
        &mut transaction,
        account_id,
        authenticated.session_id(),
        "project.rollback_intent.create",
        "lifecycle_intent",
        Some(intent_id),
        "succeeded",
    )
    .await?;
    intent::store_replay(
        &mut transaction,
        account_id,
        &operation,
        key,
        &hash,
        201,
        &response,
    )
    .await?;
    transaction.commit().await?;
    Ok((StatusCode::CREATED, Json(response)))
}

async fn create_removal_intent(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    SafeJson(request): SafeJson<CreateRemovalIntentRequest>,
) -> Result<(StatusCode, Json<LifecycleIntentResponse>), GraphError> {
    let account_id = authenticated.account_id()?;
    let project_id = intent::path_uuid(&project_id)?;
    let key = intent::idempotency_key(&headers)?;
    let expected_revision = intent::if_match_revision(&headers)?;
    let hash = intent::request_hash(&request)?;
    let operation = format!("project.removal_intent.create/{project_id}");
    let mut transaction = state.pool.begin().await?;
    intent::acquire_operation_lock(&mut transaction, account_id, &operation, key).await?;
    match intent::replay(&mut transaction, account_id, &operation, key, &hash).await? {
        Replay::Match(response) => {
            transaction.commit().await?;
            return Ok((StatusCode::CREATED, Json(response)));
        }
        Replay::Changed => {
            intent::audit(
                &mut transaction,
                account_id,
                authenticated.session_id(),
                "project.removal_intent.create",
                "project",
                Some(project_id),
                "idempotency_conflict",
            )
            .await?;
            transaction.commit().await?;
            return Err(changed_payload());
        }
        Replay::Miss => {}
    }
    let row: Option<(i64, String)> = sqlx::query_as(
        "SELECT revision, slot_state FROM projects \
         WHERE account_id = $1 AND id = $2 FOR UPDATE",
    )
    .bind(account_id)
    .bind(project_id)
    .fetch_optional(&mut *transaction)
    .await?;
    let (revision, slot_state) = row.ok_or_else(ApiError::not_found)?;
    if revision != expected_revision {
        intent::audit(
            &mut transaction,
            account_id,
            authenticated.session_id(),
            "project.removal_intent.create",
            "project",
            Some(project_id),
            "stale_revision",
        )
        .await?;
        transaction.commit().await?;
        return Err(ApiError::stale_revision().into());
    }
    if slot_state == "release_pending"
        || has_pending_lifecycle_intent(&mut transaction, account_id, project_id).await?
    {
        intent::audit(
            &mut transaction,
            account_id,
            authenticated.session_id(),
            "project.removal_intent.create",
            "project",
            Some(project_id),
            "lifecycle_intent_pending",
        )
        .await?;
        transaction.commit().await?;
        return Err(lifecycle_pending());
    }
    if matches!(slot_state.as_str(), "no_slot" | "released") {
        intent::audit(
            &mut transaction,
            account_id,
            authenticated.session_id(),
            "project.removal_intent.create",
            "project",
            Some(project_id),
            "ineligible",
        )
        .await?;
        transaction.commit().await?;
        return Err(ApiError::conflict(
            "removal_not_required",
            "the project has no hosted resources requiring removal",
        )
        .into());
    }
    let intent_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO project_lifecycle_intents (id, account_id, project_id, kind) \
         VALUES ($1,$2,$3,'removal')",
    )
    .bind(intent_id)
    .bind(account_id)
    .bind(project_id)
    .execute(&mut *transaction)
    .await?;
    sqlx::query(
        "INSERT INTO hosting_state_events \
         (id, account_id, project_id, state, source, reason) \
         VALUES ($1,$2,$3,'removal_pending','owner_intent','owner requested resource removal')",
    )
    .bind(Uuid::new_v4())
    .bind(account_id)
    .bind(project_id)
    .execute(&mut *transaction)
    .await?;
    let project_revision: i64 = sqlx::query_scalar(
        "UPDATE projects SET slot_state = 'release_pending', revision = revision + 1, \
         updated_at = transaction_timestamp() WHERE account_id = $1 AND id = $2 RETURNING revision",
    )
    .bind(account_id)
    .bind(project_id)
    .fetch_one(&mut *transaction)
    .await?;
    let response = LifecycleIntentResponse {
        id: intent_id,
        project_id: ProjectId(project_id.to_string()),
        kind: "removal".into(),
        target_deployment_id: None,
        state: "requested".into(),
        project_revision: as_u64(project_revision)?,
    };
    intent::audit(
        &mut transaction,
        account_id,
        authenticated.session_id(),
        "project.removal_intent.create",
        "lifecycle_intent",
        Some(intent_id),
        "succeeded",
    )
    .await?;
    intent::store_replay(
        &mut transaction,
        account_id,
        &operation,
        key,
        &hash,
        201,
        &response,
    )
    .await?;
    transaction.commit().await?;
    Ok((StatusCode::CREATED, Json(response)))
}
