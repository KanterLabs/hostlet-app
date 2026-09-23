use std::{borrow::Cow, collections::HashSet};

use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use hostlet_contracts::{
    portfolio::{
        DemoReadiness, FieldViolation, PortfolioDraft, ProjectReferenceKind, ReadinessRecheckReason,
    },
    project::AccountId,
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

const CREATE_OPERATION: &str = "portfolio.draft_revision.create";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PortfolioDraftRevisionResponse {
    id: Uuid,
    owner_account_id: AccountId,
    revision: u64,
    draft: PortfolioDraft,
    created_at: DateTime<Utc>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CreatePortfolioDraftRequest {
    draft: PortfolioDraft,
}

#[derive(Serialize)]
struct PortfolioErrorEnvelope {
    error: PortfolioErrorBody,
}

#[derive(Serialize)]
struct PortfolioErrorBody {
    code: &'static str,
    message: Cow<'static, str>,
    request_id: Uuid,
    details: PortfolioErrorDetails,
}

#[derive(Serialize)]
struct PortfolioErrorDetails {
    issues: Vec<FieldViolation>,
}

enum PortfolioError {
    Api(ApiError),
    Validation(Vec<FieldViolation>),
}

impl From<ApiError> for PortfolioError {
    fn from(value: ApiError) -> Self {
        Self::Api(value)
    }
}

impl From<sqlx::Error> for PortfolioError {
    fn from(_: sqlx::Error) -> Self {
        Self::Api(ApiError::database_unavailable())
    }
}

impl IntoResponse for PortfolioError {
    fn into_response(self) -> Response {
        match self {
            Self::Api(error) => error.into_response(),
            Self::Validation(issues) => (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(PortfolioErrorEnvelope {
                    error: PortfolioErrorBody {
                        code: "invalid_portfolio_draft",
                        message: Cow::Borrowed("the portfolio draft failed contract validation"),
                        request_id: Uuid::new_v4(),
                        details: PortfolioErrorDetails { issues },
                    },
                }),
            )
                .into_response(),
        }
    }
}

pub fn routes() -> Router<FoundationState> {
    Router::new()
        .route("/v1/portfolio/draft-revisions", post(create_draft_revision))
        .route(
            "/v1/portfolio/draft-revisions/{revision_id}",
            get(get_draft_revision),
        )
}

fn changed_payload() -> PortfolioError {
    ApiError::conflict(
        "idempotency_payload_changed",
        "the idempotency key was already used with a different request",
    )
    .into()
}

fn as_u64(value: i64) -> Result<u64, PortfolioError> {
    u64::try_from(value).map_err(|_| ApiError::internal().into())
}

pub(crate) fn m1_validation_issues(draft: &PortfolioDraft) -> Vec<FieldViolation> {
    input_validation_issues(draft, false)
}

pub(crate) fn private_preview_validation_issues(draft: &PortfolioDraft) -> Vec<FieldViolation> {
    input_validation_issues(draft, true)
}

fn input_validation_issues(draft: &PortfolioDraft, private_preview: bool) -> Vec<FieldViolation> {
    let validation = if private_preview {
        draft.validate_private_input()
    } else {
        draft.validate()
    };
    let mut issues = validation
        .err()
        .map_or_else(Vec::new, |error| error.violations);

    for (index, project) in draft.projects.iter().enumerate() {
        let path = format!("projects[{index}]");
        if let ProjectReferenceKind::HostedProject { project_id } = &project.kind
            && Uuid::parse_str(project_id).is_err()
        {
            issues.push(FieldViolation {
                path: format!("{path}.kind.project_id"),
                code: "invalid_hosted_project_id".into(),
                message: "a hosted project reference must contain a UUID".into(),
            });
        }

        if project.authorized_deployment_facts_id.is_some() {
            issues.push(FieldViolation {
                path: format!("{path}.authorized_deployment_facts_id"),
                code: "unauthorized_deployment_facts".into(),
                message: if private_preview {
                    "private previews cannot supply authorized deployment facts"
                } else {
                    "authorized deployment facts are unavailable in M1"
                }
                .into(),
            });
        }

        let readiness_is_m1_safe = matches!(
            &project.demo_readiness,
            DemoReadiness::NeedsRecheck {
                previous_attestation: None,
                reason: ReadinessRecheckReason::NeverChecked,
            }
        );
        if !readiness_is_m1_safe {
            issues.push(FieldViolation {
                path: format!("{path}.demo_readiness"),
                code: "readiness_unverified".into(),
                message: if private_preview {
                    "private previews require never-checked demo readiness"
                } else {
                    "M1 drafts require never-checked demo readiness"
                }
                .into(),
            });
        }
    }

    issues
}

fn hosted_project_ids(draft: &PortfolioDraft) -> Result<Vec<Uuid>, PortfolioError> {
    let mut ids = HashSet::new();
    for project in &draft.projects {
        if let ProjectReferenceKind::HostedProject { project_id } = &project.kind {
            ids.insert(Uuid::parse_str(project_id).map_err(|_| ApiError::internal())?);
        }
    }
    Ok(ids.into_iter().collect())
}

async fn audit_and_commit(
    mut transaction: Transaction<'_, Postgres>,
    account_id: Uuid,
    session_id: Uuid,
    target_id: Option<Uuid>,
    outcome: &str,
) -> Result<(), PortfolioError> {
    intent::audit(
        &mut transaction,
        account_id,
        session_id,
        CREATE_OPERATION,
        "portfolio_draft_revision",
        target_id,
        outcome,
    )
    .await?;
    transaction.commit().await?;
    Ok(())
}

async fn create_draft_revision(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    headers: HeaderMap,
    SafeJson(request): SafeJson<CreatePortfolioDraftRequest>,
) -> Result<(StatusCode, Json<PortfolioDraftRevisionResponse>), PortfolioError> {
    let account_id = authenticated.account_id()?;
    let key = intent::idempotency_key(&headers)?;
    let request_hash = intent::request_hash(&request)?;
    let mut transaction = state.pool.begin().await?;

    intent::acquire_operation_lock(&mut transaction, account_id, CREATE_OPERATION, key).await?;
    let replay: Replay<PortfolioDraftRevisionResponse> = intent::replay(
        &mut transaction,
        account_id,
        CREATE_OPERATION,
        key,
        &request_hash,
    )
    .await?;
    match replay {
        Replay::Match(response) => {
            transaction.commit().await?;
            return Ok((StatusCode::CREATED, Json(response)));
        }
        Replay::Changed => {
            audit_and_commit(
                transaction,
                account_id,
                authenticated.session_id(),
                None,
                "idempotency_conflict",
            )
            .await?;
            return Err(changed_payload());
        }
        Replay::Miss => {}
    }

    let issues = m1_validation_issues(&request.draft);
    if !issues.is_empty() {
        audit_and_commit(
            transaction,
            account_id,
            authenticated.session_id(),
            None,
            "rejected",
        )
        .await?;
        return Err(PortfolioError::Validation(issues));
    }

    sqlx::query_scalar::<_, Uuid>("SELECT id FROM accounts WHERE id = $1 FOR UPDATE")
        .bind(account_id)
        .fetch_one(&mut *transaction)
        .await?;

    let hosted_project_ids = hosted_project_ids(&request.draft)?;
    if !hosted_project_ids.is_empty() {
        let owned_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM projects WHERE account_id = $1 AND id = ANY($2)",
        )
        .bind(account_id)
        .bind(&hosted_project_ids)
        .fetch_one(&mut *transaction)
        .await?;
        if usize::try_from(owned_count).ok() != Some(hosted_project_ids.len()) {
            audit_and_commit(
                transaction,
                account_id,
                authenticated.session_id(),
                None,
                "denied",
            )
            .await?;
            return Err(ApiError::not_found().into());
        }
    }

    let revision: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(revision_number), 0) + 1 \
         FROM portfolio_draft_revisions WHERE account_id = $1",
    )
    .bind(account_id)
    .fetch_one(&mut *transaction)
    .await?;
    let revision_id = Uuid::new_v4();
    let draft_json = serde_json::to_value(&request.draft).map_err(|_| ApiError::internal())?;
    let created_at: DateTime<Utc> = sqlx::query_scalar(
        "INSERT INTO portfolio_draft_revisions \
         (id, account_id, revision_number, draft) VALUES ($1,$2,$3,$4) \
         RETURNING created_at",
    )
    .bind(revision_id)
    .bind(account_id)
    .bind(revision)
    .bind(draft_json)
    .fetch_one(&mut *transaction)
    .await?;

    for reference in &request.draft.projects {
        let (hosted_project_id, external_reference_id) = match &reference.kind {
            ProjectReferenceKind::HostedProject { project_id } => (
                Some(Uuid::parse_str(project_id).map_err(|_| ApiError::internal())?),
                None,
            ),
            ProjectReferenceKind::ExternalCaseStudy {
                external_reference_id,
            } => (None, Some(external_reference_id.as_str())),
        };
        sqlx::query(
            "INSERT INTO portfolio_project_references \
             (portfolio_revision_id, account_id, project_reference_id, \
              hosted_project_id, external_reference_id) \
             VALUES ($1,$2,$3,$4,$5)",
        )
        .bind(revision_id)
        .bind(account_id)
        .bind(&reference.project_reference_id)
        .bind(hosted_project_id)
        .bind(external_reference_id)
        .execute(&mut *transaction)
        .await?;
    }

    let response = PortfolioDraftRevisionResponse {
        id: revision_id,
        owner_account_id: AccountId(account_id.to_string()),
        revision: as_u64(revision)?,
        draft: request.draft,
        created_at,
    };
    intent::audit(
        &mut transaction,
        account_id,
        authenticated.session_id(),
        CREATE_OPERATION,
        "portfolio_draft_revision",
        Some(revision_id),
        "succeeded",
    )
    .await?;
    intent::store_replay(
        &mut transaction,
        account_id,
        CREATE_OPERATION,
        key,
        &request_hash,
        201,
        &response,
    )
    .await?;
    transaction.commit().await?;

    Ok((StatusCode::CREATED, Json(response)))
}

async fn get_draft_revision(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    Path(revision_id): Path<String>,
) -> Result<Json<PortfolioDraftRevisionResponse>, PortfolioError> {
    let revision_id = intent::path_uuid(&revision_id)?;
    let account_id = authenticated.account_id()?;
    let mut transaction = state.pool.begin().await?;
    let row: Option<(Uuid, i64, Value, DateTime<Utc>)> = sqlx::query_as(
        "SELECT id, revision_number, draft, created_at \
         FROM portfolio_draft_revisions WHERE account_id = $1 AND id = $2",
    )
    .bind(account_id)
    .bind(revision_id)
    .fetch_optional(&mut *transaction)
    .await?;

    let Some((id, revision, draft, created_at)) = row else {
        intent::audit(
            &mut transaction,
            account_id,
            authenticated.session_id(),
            "portfolio.draft_revision.read",
            "portfolio_draft_revision",
            Some(revision_id),
            "denied",
        )
        .await?;
        transaction.commit().await?;
        return Err(ApiError::not_found().into());
    };
    let draft = serde_json::from_value(draft).map_err(|_| ApiError::internal())?;
    let response = PortfolioDraftRevisionResponse {
        id,
        owner_account_id: AccountId(account_id.to_string()),
        revision: as_u64(revision)?,
        draft,
        created_at,
    };
    transaction.commit().await?;
    Ok(Json(response))
}
