use std::{
    borrow::Cow,
    collections::{HashMap, HashSet},
};

use axum::{
    Json, Router,
    extract::{RawQuery, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use hostlet_contracts::{
    portfolio::{FieldViolation, PortfolioDraft, ProjectReferenceKind},
    project::AccountId,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use crate::{
    auth::Authenticated,
    error::{ApiError, SafeJson},
    foundation::FoundationState,
    intent::{self, Replay},
    portfolio_drafts::private_preview_validation_issues,
};

const CREATE_OPERATION: &str = "portfolio.preview_revision.create";
const ANSWER_VERSION: &str = "hostlet.configuration-answer/v1";
const MAX_ANSWER_ID_BYTES: usize = 256;
const MAX_PUBLIC_VALUE_BYTES: usize = 2_048;
const MAX_ANSWERS_BYTES: usize = 65_536;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PortfolioPreviewRevisionResponse {
    id: Uuid,
    owner_account_id: AccountId,
    revision: u64,
    draft: PortfolioDraft,
    preview: PreviewContext,
    preview_context_revision: Option<u64>,
    created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CreatePreviewRevisionRequest {
    draft: PortfolioDraft,
    preview: PreviewContext,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PreviewContext {
    layout: String,
    typography: String,
    accent: String,
    #[serde(default)]
    project_contexts: Vec<ProjectPreviewContext>,
}

impl Default for PreviewContext {
    fn default() -> Self {
        Self {
            layout: "layout_1".to_owned(),
            typography: "system_sans".to_owned(),
            accent: "coral".to_owned(),
            project_contexts: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProjectPreviewContext {
    project_reference_id: String,
    project_id: Uuid,
    configuration_revision_id: Uuid,
    source_revision_id: Uuid,
    compatibility_report_id: Uuid,
    #[serde(default = "default_placeholder")]
    placeholder: String,
    #[serde(default)]
    configuration_answers: Vec<Value>,
}

fn default_placeholder() -> String {
    "gradient_1".to_owned()
}

#[derive(Debug, Deserialize)]
#[serde(tag = "classification", rename_all = "snake_case", deny_unknown_fields)]
enum ConfigurationAnswer {
    ConfigurationChoice {
        answer_version: String,
        question_id: String,
        selected_option: String,
    },
    PublicBuildValue {
        answer_version: String,
        question_id: String,
        value: String,
    },
    SecretRequired {
        answer_version: String,
        question_id: String,
    },
    Unresolved {
        answer_version: String,
        question_id: String,
    },
}

impl ConfigurationAnswer {
    fn common(&self) -> (&str, &str) {
        match self {
            Self::ConfigurationChoice {
                answer_version,
                question_id,
                ..
            }
            | Self::PublicBuildValue {
                answer_version,
                question_id,
                ..
            }
            | Self::SecretRequired {
                answer_version,
                question_id,
            }
            | Self::Unresolved {
                answer_version,
                question_id,
            } => (answer_version, question_id),
        }
    }
}

#[derive(Debug, Deserialize)]
struct ReportQuestion {
    id: String,
    classification: String,
    #[serde(default)]
    allowed_options: Vec<String>,
}

#[derive(sqlx::FromRow)]
struct ReportRow {
    report: Value,
    report_digest: String,
}

#[derive(Serialize)]
struct PreviewErrorEnvelope {
    error: PreviewErrorBody,
}

#[derive(Serialize)]
struct PreviewErrorBody {
    code: &'static str,
    message: Cow<'static, str>,
    request_id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<PreviewErrorDetails>,
}

#[derive(Serialize)]
struct PreviewErrorDetails {
    issues: Vec<FieldViolation>,
}

enum PreviewError {
    Api(ApiError),
    Draft(Vec<FieldViolation>),
    Context,
    Answer,
}

impl From<ApiError> for PreviewError {
    fn from(value: ApiError) -> Self {
        Self::Api(value)
    }
}

impl From<sqlx::Error> for PreviewError {
    fn from(_: sqlx::Error) -> Self {
        Self::Api(ApiError::database_unavailable())
    }
}

impl IntoResponse for PreviewError {
    fn into_response(self) -> Response {
        match self {
            Self::Api(error) => error.into_response(),
            Self::Draft(issues) => preview_error_response(
                "invalid_portfolio_draft",
                "the portfolio draft failed contract validation",
                Some(PreviewErrorDetails { issues }),
            ),
            Self::Context => preview_error_response(
                "invalid_preview_context",
                "the preview context is invalid",
                None,
            ),
            Self::Answer => preview_error_response(
                "invalid_configuration_answer",
                "a configuration answer is invalid",
                None,
            ),
        }
    }
}

fn preview_error_response(
    code: &'static str,
    message: &'static str,
    details: Option<PreviewErrorDetails>,
) -> Response {
    (
        StatusCode::UNPROCESSABLE_ENTITY,
        Json(PreviewErrorEnvelope {
            error: PreviewErrorBody {
                code,
                message: Cow::Borrowed(message),
                request_id: Uuid::new_v4(),
                details,
            },
        }),
    )
        .into_response()
}

pub(crate) fn routes() -> Router<FoundationState> {
    Router::new()
        .route(
            "/v1/portfolio/draft-revisions/latest",
            get(get_latest_revision),
        )
        .route(
            "/v1/portfolio/preview-revisions",
            post(create_preview_revision),
        )
        .route_layer(middleware::map_response(private_no_store))
}

async fn private_no_store(mut response: Response) -> Response {
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    response
}

fn preview_if_match(headers: &HeaderMap) -> Result<i64, ApiError> {
    let mut values = headers.get_all(header::IF_MATCH).iter();
    let value = values
        .next()
        .ok_or_else(ApiError::precondition_required)?
        .to_str()
        .map_err(|_| malformed_if_match())?;
    if values.next().is_some() {
        return Err(malformed_if_match());
    }
    let unquoted = value
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .ok_or_else(malformed_if_match)?;
    if unquoted.is_empty() || !unquoted.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(malformed_if_match());
    }
    unquoted
        .parse::<i64>()
        .ok()
        .filter(|revision| *revision >= 0)
        .ok_or_else(malformed_if_match)
}

fn malformed_if_match() -> ApiError {
    ApiError::bad_request(
        "malformed_if_match",
        "If-Match must contain one quoted non-negative revision",
    )
}

fn changed_payload() -> ApiError {
    ApiError::conflict(
        "idempotency_payload_changed",
        "the idempotency key was already used with a different request",
    )
}

fn etag_response(status: StatusCode, response: PortfolioPreviewRevisionResponse) -> Response {
    let etag = format!("\"{}\"", response.revision);
    let mut result = (status, Json(response)).into_response();
    if let Ok(value) = HeaderValue::from_str(&etag) {
        result.headers_mut().insert(header::ETAG, value);
    }
    result
}

async fn get_latest_revision(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    RawQuery(query): RawQuery,
) -> Result<Response, PreviewError> {
    if query.is_some() {
        return Err(ApiError::bad_request(
            "invalid_preview_query",
            "the latest preview endpoint does not accept query parameters",
        )
        .into());
    }
    let account_id = authenticated.account_id()?;
    let mut transaction = state.pool.begin().await?;
    let latest: Option<(Uuid, i64, Value, DateTime<Utc>)> = sqlx::query_as(
        "SELECT id, revision_number, draft, created_at \
         FROM portfolio_draft_revisions WHERE account_id = $1 \
         ORDER BY revision_number DESC LIMIT 1",
    )
    .bind(account_id)
    .fetch_optional(&mut *transaction)
    .await?;
    let Some((id, revision, draft_value, created_at)) = latest else {
        return Err(ApiError::not_found().into());
    };
    let draft: PortfolioDraft =
        serde_json::from_value(draft_value).map_err(|_| ApiError::internal())?;

    let context_row: Option<(Uuid, i64, String, String, String)> = sqlx::query_as(
        "SELECT c.portfolio_revision_id, d.revision_number, c.layout, c.typography, c.accent \
         FROM portfolio_preview_contexts c \
         JOIN portfolio_draft_revisions d \
           ON d.account_id = c.account_id AND d.id = c.portfolio_revision_id \
         WHERE c.account_id = $1 AND d.revision_number <= $2 \
         ORDER BY d.revision_number DESC LIMIT 1",
    )
    .bind(account_id)
    .bind(revision)
    .fetch_optional(&mut *transaction)
    .await?;

    let (preview, preview_context_revision) = if let Some((
        context_revision_id,
        context_revision,
        layout,
        typography,
        accent,
    )) = context_row
    {
        let rows: Vec<(String, Uuid, Uuid, Uuid, Uuid, String, Value)> = sqlx::query_as(
            "SELECT project_reference_id, project_id, configuration_revision_id, \
                    source_revision_id, compatibility_report_id, placeholder, configuration_answers \
             FROM portfolio_preview_project_contexts \
             WHERE account_id = $1 AND portfolio_revision_id = $2 \
             ORDER BY project_reference_id",
        )
        .bind(account_id)
        .bind(context_revision_id)
        .fetch_all(&mut *transaction)
        .await?;
        let current_hosted: HashMap<&str, Uuid> = draft
            .projects
            .iter()
            .filter_map(|project| match &project.kind {
                ProjectReferenceKind::HostedProject { project_id } => Uuid::parse_str(project_id)
                    .ok()
                    .map(|id| (project.project_reference_id.as_str(), id)),
                ProjectReferenceKind::ExternalCaseStudy { .. } => None,
            })
            .collect();
        let project_contexts = rows
            .into_iter()
            .filter(|(reference_id, project_id, ..)| {
                current_hosted.get(reference_id.as_str()) == Some(project_id)
            })
            .map(
                |(
                    project_reference_id,
                    project_id,
                    configuration_revision_id,
                    source_revision_id,
                    compatibility_report_id,
                    placeholder,
                    configuration_answers,
                )| {
                    let configuration_answers = configuration_answers
                        .as_array()
                        .cloned()
                        .ok_or_else(ApiError::internal)?;
                    Ok(ProjectPreviewContext {
                        project_reference_id,
                        project_id,
                        configuration_revision_id,
                        source_revision_id,
                        compatibility_report_id,
                        placeholder,
                        configuration_answers,
                    })
                },
            )
            .collect::<Result<Vec<_>, ApiError>>()?;
        (
            PreviewContext {
                layout,
                typography,
                accent,
                project_contexts,
            },
            Some(as_u64(context_revision)?),
        )
    } else {
        (PreviewContext::default(), None)
    };
    transaction.commit().await?;
    Ok(etag_response(
        StatusCode::OK,
        PortfolioPreviewRevisionResponse {
            id,
            owner_account_id: AccountId(account_id.to_string()),
            revision: as_u64(revision)?,
            draft,
            preview,
            preview_context_revision,
            created_at,
        },
    ))
}

async fn create_preview_revision(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    headers: HeaderMap,
    SafeJson(request): SafeJson<CreatePreviewRevisionRequest>,
) -> Result<Response, PreviewError> {
    let account_id = authenticated.account_id()?;
    let expected_revision = preview_if_match(&headers)?;
    let key = intent::idempotency_key(&headers)?;
    let request_hash = intent::request_hash(&request)?;
    let mut transaction = state.pool.begin().await?;

    intent::acquire_operation_lock(&mut transaction, account_id, CREATE_OPERATION, key).await?;
    let replay: Replay<PortfolioPreviewRevisionResponse> = intent::replay(
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
            return Ok(etag_response(StatusCode::CREATED, response));
        }
        Replay::Changed => return Err(changed_payload().into()),
        Replay::Miss => {}
    }

    sqlx::query_scalar::<_, Uuid>("SELECT id FROM accounts WHERE id = $1 FOR UPDATE")
        .bind(account_id)
        .fetch_one(&mut *transaction)
        .await?;
    let current_revision: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(revision_number), 0) \
         FROM portfolio_draft_revisions WHERE account_id = $1",
    )
    .bind(account_id)
    .fetch_one(&mut *transaction)
    .await?;
    if current_revision != expected_revision {
        return Err(ApiError::stale_revision().into());
    }

    let draft_issues = private_preview_validation_issues(&request.draft);
    if !draft_issues.is_empty() {
        return Err(PreviewError::Draft(draft_issues));
    }
    validate_preview_shape(&request.draft, &request.preview)?;
    validate_owned_projects(&mut transaction, account_id, &request.draft).await?;
    validate_reports_and_answers(&mut transaction, account_id, &request.preview).await?;

    let revision = current_revision
        .checked_add(1)
        .ok_or_else(ApiError::internal)?;
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
    insert_project_references(&mut transaction, account_id, revision_id, &request.draft).await?;
    sqlx::query(
        "INSERT INTO portfolio_preview_contexts \
         (account_id, portfolio_revision_id, layout, typography, accent) \
         VALUES ($1,$2,$3,$4,$5)",
    )
    .bind(account_id)
    .bind(revision_id)
    .bind(&request.preview.layout)
    .bind(&request.preview.typography)
    .bind(&request.preview.accent)
    .execute(&mut *transaction)
    .await?;
    for context in &request.preview.project_contexts {
        let answers = Value::Array(context.configuration_answers.clone());
        sqlx::query(
            "INSERT INTO portfolio_preview_project_contexts \
             (account_id, portfolio_revision_id, project_reference_id, project_id, \
              configuration_revision_id, source_revision_id, compatibility_report_id, \
              placeholder, configuration_answers) \
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        )
        .bind(account_id)
        .bind(revision_id)
        .bind(&context.project_reference_id)
        .bind(context.project_id)
        .bind(context.configuration_revision_id)
        .bind(context.source_revision_id)
        .bind(context.compatibility_report_id)
        .bind(&context.placeholder)
        .bind(answers)
        .execute(&mut *transaction)
        .await?;
    }

    let response = PortfolioPreviewRevisionResponse {
        id: revision_id,
        owner_account_id: AccountId(account_id.to_string()),
        revision: as_u64(revision)?,
        draft: request.draft,
        preview: request.preview,
        preview_context_revision: Some(as_u64(revision)?),
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
    Ok(etag_response(StatusCode::CREATED, response))
}

fn validate_preview_shape(
    draft: &PortfolioDraft,
    preview: &PreviewContext,
) -> Result<(), PreviewError> {
    if preview.layout != "layout_1"
        || !matches!(
            preview.typography.as_str(),
            "system_sans" | "editorial_serif"
        )
        || !matches!(preview.accent.as_str(), "coral" | "indigo" | "forest")
    {
        return Err(PreviewError::Context);
    }
    let hosted: HashMap<&str, Uuid> = draft
        .projects
        .iter()
        .filter_map(|project| match &project.kind {
            ProjectReferenceKind::HostedProject { project_id } => Uuid::parse_str(project_id)
                .ok()
                .map(|id| (project.project_reference_id.as_str(), id)),
            ProjectReferenceKind::ExternalCaseStudy { .. } => None,
        })
        .collect();
    let mut references = HashSet::new();
    for context in &preview.project_contexts {
        if context.project_reference_id.is_empty()
            || context.project_reference_id.len() > 128
            || !references.insert(context.project_reference_id.as_str())
            || hosted.get(context.project_reference_id.as_str()) != Some(&context.project_id)
            || !matches!(
                context.placeholder.as_str(),
                "gradient_1" | "grid_1" | "terminal_1"
            )
        {
            return Err(PreviewError::Context);
        }
        let encoded =
            serde_json::to_vec(&context.configuration_answers).map_err(|_| ApiError::internal())?;
        if encoded.len() > MAX_ANSWERS_BYTES {
            return Err(PreviewError::Answer);
        }
    }
    Ok(())
}

async fn validate_owned_projects(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    draft: &PortfolioDraft,
) -> Result<(), PreviewError> {
    let project_ids: HashSet<Uuid> = draft
        .projects
        .iter()
        .filter_map(|project| match &project.kind {
            ProjectReferenceKind::HostedProject { project_id } => Uuid::parse_str(project_id).ok(),
            ProjectReferenceKind::ExternalCaseStudy { .. } => None,
        })
        .collect();
    if project_ids.is_empty() {
        return Ok(());
    }
    let ids: Vec<_> = project_ids.into_iter().collect();
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM projects WHERE account_id = $1 AND id = ANY($2)")
            .bind(account_id)
            .bind(&ids)
            .fetch_one(&mut **transaction)
            .await?;
    if usize::try_from(count).ok() != Some(ids.len()) {
        return Err(ApiError::not_found().into());
    }
    Ok(())
}

async fn validate_reports_and_answers(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    preview: &PreviewContext,
) -> Result<(), PreviewError> {
    for context in &preview.project_contexts {
        let row: Option<(Uuid, Uuid, Uuid, Value, String)> = sqlx::query_as(
            "SELECT project_id, configuration_revision_id, source_revision_id, \
                    report, report_digest \
             FROM compatibility_reports WHERE account_id = $1 AND id = $2",
        )
        .bind(account_id)
        .bind(context.compatibility_report_id)
        .fetch_optional(&mut **transaction)
        .await?;
        let Some((
            project_id,
            configuration_revision_id,
            source_revision_id,
            report,
            report_digest,
        )) = row
        else {
            return Err(ApiError::not_found().into());
        };
        if project_id != context.project_id
            || configuration_revision_id != context.configuration_revision_id
            || source_revision_id != context.source_revision_id
        {
            return Err(PreviewError::Context);
        }
        let row = ReportRow {
            report,
            report_digest,
        };
        verify_report_digest(&row)?;
        validate_answers(&row.report, &context.configuration_answers)?;
    }
    Ok(())
}

fn verify_report_digest(row: &ReportRow) -> Result<(), PreviewError> {
    let bytes = serde_json::to_vec(&row.report).map_err(|_| ApiError::internal())?;
    let digest = format!("sha256:{:x}", Sha256::digest(bytes));
    if digest != row.report_digest {
        return Err(ApiError::internal().into());
    }
    Ok(())
}

fn validate_answers(report: &Value, answers: &[Value]) -> Result<(), PreviewError> {
    let questions_value = report
        .get("configuration_questions")
        .cloned()
        .ok_or_else(|| PreviewError::Api(ApiError::internal()))?;
    let questions: Vec<ReportQuestion> =
        serde_json::from_value(questions_value).map_err(|_| ApiError::internal())?;
    let questions: HashMap<_, _> = questions
        .into_iter()
        .map(|question| (question.id.clone(), question))
        .collect();
    let mut answered = HashSet::new();
    for value in answers {
        let answer: ConfigurationAnswer =
            serde_json::from_value(value.clone()).map_err(|_| PreviewError::Answer)?;
        let (version, question_id) = answer.common();
        if version != ANSWER_VERSION
            || question_id.is_empty()
            || question_id.len() > MAX_ANSWER_ID_BYTES
            || question_id.bytes().any(|byte| byte.is_ascii_control())
            || !answered.insert(question_id.to_owned())
        {
            return Err(PreviewError::Answer);
        }
        let question = questions.get(question_id).ok_or(PreviewError::Answer)?;
        let valid = match &answer {
            ConfigurationAnswer::ConfigurationChoice {
                selected_option, ..
            } => {
                question.classification == "configuration_choice"
                    && question
                        .allowed_options
                        .iter()
                        .any(|option| option == selected_option)
            }
            ConfigurationAnswer::PublicBuildValue { value, .. } => {
                question.classification == "public_build_value"
                    && !value.is_empty()
                    && value.len() <= MAX_PUBLIC_VALUE_BYTES
                    && !value.bytes().any(|byte| byte.is_ascii_control())
            }
            ConfigurationAnswer::SecretRequired { .. } => {
                question.classification == "secret_required"
            }
            ConfigurationAnswer::Unresolved { .. } => true,
        };
        if !valid {
            return Err(PreviewError::Answer);
        }
    }
    Ok(())
}

async fn insert_project_references(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    revision_id: Uuid,
    draft: &PortfolioDraft,
) -> Result<(), PreviewError> {
    for reference in &draft.projects {
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
              hosted_project_id, external_reference_id) VALUES ($1,$2,$3,$4,$5)",
        )
        .bind(revision_id)
        .bind(account_id)
        .bind(&reference.project_reference_id)
        .bind(hosted_project_id)
        .bind(external_reference_id)
        .execute(&mut **transaction)
        .await?;
    }
    Ok(())
}

fn as_u64(value: i64) -> Result<u64, PreviewError> {
    u64::try_from(value).map_err(|_| ApiError::internal().into())
}
