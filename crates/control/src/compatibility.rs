use std::collections::{BTreeMap, BTreeSet, HashSet};

use axum::{
    Json, Router,
    extract::{Path, RawQuery, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware,
    response::Response,
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use hostlet_contracts::project::{
    FrameworkPattern, PackageManager, RepositoryLayout, ServiceKind, StandardProjectSpec,
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
    github,
    intent::{self, Replay},
};

const ANALYZER_REVISION: &str = "hostlet.compatibility/v1+hostlet.compatibility-bounds/v1";
const REPORT_CONTRACT: &str = "hostlet.compatibility-report/v1";
const LIMITS_REVISION: &str = "hostlet.compatibility-bounds/v1";
const CREATE_OPERATION: &str = "compatibility.report.create";
const MAX_REASONS: usize = 64;
const MAX_QUESTIONS: usize = 32;
const MAX_ENVIRONMENT_NAMES: usize = 128;
const MAX_REPORT_BYTES: usize = 128 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct AnalyzeRequest {
    source_revision_id: String,
    configuration_revision_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CompatibilityReportResponse {
    id: Uuid,
    project_id: Uuid,
    configuration_revision_id: Uuid,
    source_revision_id: Uuid,
    analyzer_revision: String,
    status: CompatibilityStatus,
    headline: String,
    advisory: String,
    deployment_verified: bool,
    facts: CompatibilitySafeFacts,
    created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum CompatibilityStatus {
    Candidate,
    ConfigurationNeeded,
    DatabaseNeeded,
    SecretsNeeded,
    ShowcaseOnly,
}

impl CompatibilityStatus {
    const fn database_value(self) -> &'static str {
        match self {
            Self::Candidate => "candidate",
            Self::ConfigurationNeeded => "configuration_needed",
            Self::DatabaseNeeded => "database_needed",
            Self::SecretsNeeded => "secrets_needed",
            Self::ShowcaseOnly => "showcase_only",
        }
    }

    fn parse(value: &str) -> Result<Self, ApiError> {
        match value {
            "candidate" => Ok(Self::Candidate),
            "configuration_needed" => Ok(Self::ConfigurationNeeded),
            "database_needed" => Ok(Self::DatabaseNeeded),
            "secrets_needed" => Ok(Self::SecretsNeeded),
            "showcase_only" => Ok(Self::ShowcaseOnly),
            _ => Err(ApiError::internal()),
        }
    }

    const fn headline(self) -> &'static str {
        match self {
            Self::Candidate => "Looks compatible — deployment not yet verified",
            Self::ConfigurationNeeded => "Configuration needed",
            Self::DatabaseNeeded => "Database needed",
            Self::SecretsNeeded => "Secrets needed",
            Self::ShowcaseOnly => "Showcase-only unsupported",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CompatibilitySafeFacts {
    contract_version: String,
    repository: RepositoryFacts,
    services: Vec<ServiceFacts>,
    environment_requirements: Vec<EnvironmentRequirement>,
    reasons: Vec<CompatibilityReason>,
    configuration_questions: Vec<ConfigurationQuestion>,
    inspection: InspectionFacts,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RepositoryFacts {
    layout: String,
    package_manager: String,
    lockfile_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ServiceFacts {
    kind: String,
    root: Option<String>,
    framework: String,
    node_major: Option<u16>,
    build_command_present: bool,
    start_command_present: bool,
    http_health_path_present: bool,
    durable_data_detected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct EnvironmentRequirement {
    name: String,
    classification: EnvironmentClassification,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
enum EnvironmentClassification {
    PublicBuildValue,
    ServerSecret,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CompatibilityReason {
    code: String,
    message: String,
    source_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ConfigurationQuestion {
    id: String,
    kind: String,
    classification: String,
    target_path: String,
    prompt: String,
    source_path: Option<String>,
    required: bool,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    allowed_options: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct InspectionFacts {
    files_considered: usize,
    files_read: usize,
    bytes_read: usize,
    limits_revision: String,
}

#[derive(sqlx::FromRow)]
struct ReportRow {
    id: Uuid,
    project_id: Uuid,
    configuration_revision_id: Uuid,
    source_revision_id: Uuid,
    analyzer_revision: String,
    status: String,
    advisory: String,
    report: Value,
    created_at: DateTime<Utc>,
}

struct ReportParts {
    id: Uuid,
    project_id: Uuid,
    configuration_revision_id: Uuid,
    source_revision_id: Uuid,
    analyzer_revision: String,
    status: CompatibilityStatus,
    advisory: String,
    facts: CompatibilitySafeFacts,
    created_at: DateTime<Utc>,
}

struct LatestQuery {
    source_revision_id: String,
    configuration_revision_id: String,
}

struct Analysis {
    status: CompatibilityStatus,
    facts: CompatibilitySafeFacts,
}

struct AnalysisBuilder {
    reasons: Vec<CompatibilityReason>,
    reason_codes: HashSet<String>,
    questions: Vec<ConfigurationQuestion>,
    question_ids: HashSet<String>,
    unsupported: bool,
    configuration_needed: bool,
    database_needed: bool,
    secrets_needed: bool,
    report_limit_exceeded: bool,
}

impl AnalysisBuilder {
    fn new() -> Self {
        Self {
            reasons: Vec::new(),
            reason_codes: HashSet::new(),
            questions: Vec::new(),
            question_ids: HashSet::new(),
            unsupported: false,
            configuration_needed: false,
            database_needed: false,
            secrets_needed: false,
            report_limit_exceeded: false,
        }
    }

    fn reason(&mut self, code: &str, message: &str, source_path: Option<&str>) {
        if self.reason_codes.insert(code.to_owned()) {
            if self.reasons.len() >= MAX_REASONS {
                self.report_limit_exceeded = true;
            } else {
                self.reasons.push(CompatibilityReason {
                    code: code.to_owned(),
                    message: message.to_owned(),
                    source_path: source_path.map(str::to_owned),
                });
            }
        }
    }

    fn question(&mut self, question: ConfigurationQuestion) {
        if self.question_ids.insert(question.id.clone()) {
            if self.questions.len() >= MAX_QUESTIONS {
                self.report_limit_exceeded = true;
            } else {
                self.questions.push(question);
            }
        }
    }

    fn status(&self) -> CompatibilityStatus {
        if self.unsupported {
            CompatibilityStatus::ShowcaseOnly
        } else if self.configuration_needed {
            CompatibilityStatus::ConfigurationNeeded
        } else if self.database_needed {
            CompatibilityStatus::DatabaseNeeded
        } else if self.secrets_needed {
            CompatibilityStatus::SecretsNeeded
        } else {
            CompatibilityStatus::Candidate
        }
    }
}

pub(crate) fn routes() -> Router<FoundationState> {
    Router::new()
        .route(
            "/v1/projects/{project_id}/compatibility-reports",
            post(create_report),
        )
        .route(
            "/v1/projects/{project_id}/compatibility-reports/latest",
            get(get_latest_report),
        )
        .route(
            "/v1/projects/{project_id}/compatibility-reports/{report_id}",
            get(get_report),
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

async fn create_report(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    SafeJson(request): SafeJson<AnalyzeRequest>,
) -> Result<(StatusCode, Json<CompatibilityReportResponse>), ApiError> {
    let project_id = intent::path_uuid(&project_id)?;
    let source_revision_id = intent::path_uuid(&request.source_revision_id)?;
    let configuration_revision_id = intent::path_uuid(&request.configuration_revision_id)?;
    let account_id = authenticated.account_id()?;
    let expected_project_revision = intent::if_match_revision(&headers)?;
    let key = intent::idempotency_key(&headers)?;
    let request_hash = intent::request_hash(&request)?;
    let operation = format!("{CREATE_OPERATION}/{project_id}");
    let mut transaction = state.pool.begin().await?;

    intent::acquire_operation_lock(&mut transaction, account_id, &operation, key).await?;
    match intent::replay(&mut transaction, account_id, &operation, key, &request_hash).await? {
        Replay::Match(response) => {
            transaction.commit().await?;
            return Ok((StatusCode::CREATED, Json(response)));
        }
        Replay::Changed => {
            return Err(ApiError::conflict(
                "idempotency_payload_changed",
                "the idempotency key was already used with a different request",
            ));
        }
        Replay::Miss => {}
    }

    let project: Option<(i64, Option<Uuid>)> = sqlx::query_as(
        "SELECT revision, current_configuration_revision_id FROM projects \
         WHERE account_id = $1 AND id = $2",
    )
    .bind(account_id)
    .bind(project_id)
    .fetch_optional(&mut *transaction)
    .await?;
    let Some((project_revision, current_configuration)) = project else {
        return Err(ApiError::not_found());
    };
    if project_revision != expected_project_revision {
        return Err(ApiError::stale_revision());
    }
    if current_configuration != Some(configuration_revision_id) {
        return Err(ApiError::conflict(
            "compatibility_configuration_stale",
            "compatibility analysis requires the current project configuration",
        ));
    }

    let authorized = github::authorized_source_snapshot(
        &state,
        &authenticated,
        &mut transaction,
        project_id,
        source_revision_id,
    )
    .await?;
    if authorized.account_id != account_id
        || authorized.project_id != project_id
        || authorized.configuration_revision_id != configuration_revision_id
        || authorized.project_revision != expected_project_revision
    {
        return Err(ApiError::conflict(
            "compatibility_source_stale",
            "compatibility analysis requires the selected current source and configuration",
        ));
    }

    let spec_json: Value = sqlx::query_scalar(
        "SELECT spec FROM configuration_revisions \
         WHERE account_id = $1 AND project_id = $2 AND id = $3",
    )
    .bind(account_id)
    .bind(project_id)
    .bind(configuration_revision_id)
    .fetch_optional(&mut *transaction)
    .await?
    .ok_or_else(ApiError::not_found)?;
    let spec: StandardProjectSpec =
        serde_json::from_value(spec_json).map_err(|_| ApiError::internal())?;
    if !spec.validate().is_empty() {
        return Err(ApiError::unprocessable(
            "compatibility_configuration_invalid",
            "the selected project configuration is not a valid standard project",
        ));
    }

    let analysis = analyze(&spec, &authorized.snapshot)?;
    let report_value = serde_json::to_value(&analysis.facts).map_err(|_| ApiError::internal())?;
    let report_bytes = serde_json::to_vec(&report_value).map_err(|_| ApiError::internal())?;
    if report_bytes.len() > MAX_REPORT_BYTES {
        return Err(ApiError::unprocessable(
            "compatibility_report_limit",
            "the compatibility report exceeded its safe size limit",
        ));
    }
    let report_digest = format!("sha256:{:x}", Sha256::digest(&report_bytes));
    let report_id = Uuid::new_v4();
    let inserted: Option<DateTime<Utc>> = sqlx::query_scalar(
        "INSERT INTO compatibility_reports \
         (id, account_id, project_id, configuration_revision_id, source_revision_id, \
          analyzer_revision, status, advisory, report, report_digest) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,'deployment_not_verified',$8,$9) \
         ON CONFLICT (account_id, project_id, configuration_revision_id, source_revision_id, analyzer_revision) \
         DO NOTHING RETURNING created_at",
    )
    .bind(report_id)
    .bind(account_id)
    .bind(project_id)
    .bind(configuration_revision_id)
    .bind(source_revision_id)
    .bind(ANALYZER_REVISION)
    .bind(analysis.status.database_value())
    .bind(&report_value)
    .bind(&report_digest)
    .fetch_optional(&mut *transaction)
    .await?;

    let response = if let Some(created_at) = inserted {
        ReportParts {
            id: report_id,
            project_id,
            configuration_revision_id,
            source_revision_id,
            analyzer_revision: ANALYZER_REVISION.to_owned(),
            status: analysis.status,
            advisory: "deployment_not_verified".to_owned(),
            facts: analysis.facts,
            created_at,
        }
        .into_response()
    } else {
        let row = load_exact_report(
            &mut transaction,
            account_id,
            project_id,
            configuration_revision_id,
            source_revision_id,
        )
        .await?
        .ok_or_else(ApiError::internal)?;
        row.into_response()?
    };

    intent::audit(
        &mut transaction,
        account_id,
        authenticated.session_id(),
        CREATE_OPERATION,
        "compatibility_report",
        Some(response.id),
        "succeeded",
    )
    .await?;
    intent::store_replay(
        &mut transaction,
        account_id,
        &operation,
        key,
        &request_hash,
        201,
        &response,
    )
    .await?;
    transaction.commit().await?;
    Ok((StatusCode::CREATED, Json(response)))
}

async fn get_report(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    Path((project_id, report_id)): Path<(String, String)>,
) -> Result<Json<CompatibilityReportResponse>, ApiError> {
    let account_id = authenticated.account_id()?;
    let project_id = intent::path_uuid(&project_id)?;
    let report_id = intent::path_uuid(&report_id)?;
    let row: Option<ReportRow> = sqlx::query_as(
        "SELECT id, project_id, configuration_revision_id, source_revision_id, \
                analyzer_revision, status, advisory, report, created_at \
         FROM compatibility_reports WHERE account_id = $1 AND project_id = $2 AND id = $3",
    )
    .bind(account_id)
    .bind(project_id)
    .bind(report_id)
    .fetch_optional(&state.pool)
    .await?;
    Ok(Json(row.ok_or_else(ApiError::not_found)?.into_response()?))
}

async fn get_latest_report(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    Path(project_id): Path<String>,
    RawQuery(query): RawQuery,
) -> Result<Json<CompatibilityReportResponse>, ApiError> {
    let account_id = authenticated.account_id()?;
    let project_id = intent::path_uuid(&project_id)?;
    let query = parse_latest_query(query.as_deref())?;
    let source_revision_id = intent::path_uuid(&query.source_revision_id)?;
    let configuration_revision_id = intent::path_uuid(&query.configuration_revision_id)?;
    let mut transaction = state.pool.begin().await?;
    let row = load_exact_report(
        &mut transaction,
        account_id,
        project_id,
        configuration_revision_id,
        source_revision_id,
    )
    .await?;
    transaction.commit().await?;
    Ok(Json(row.ok_or_else(ApiError::not_found)?.into_response()?))
}

async fn load_exact_report(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    project_id: Uuid,
    configuration_revision_id: Uuid,
    source_revision_id: Uuid,
) -> Result<Option<ReportRow>, ApiError> {
    sqlx::query_as(
        "SELECT id, project_id, configuration_revision_id, source_revision_id, \
                analyzer_revision, status, advisory, report, created_at \
         FROM compatibility_reports \
         WHERE account_id = $1 AND project_id = $2 AND configuration_revision_id = $3 \
           AND source_revision_id = $4 AND analyzer_revision = $5 \
         ORDER BY created_at DESC, id DESC LIMIT 1",
    )
    .bind(account_id)
    .bind(project_id)
    .bind(configuration_revision_id)
    .bind(source_revision_id)
    .bind(ANALYZER_REVISION)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(ApiError::from)
}

fn parse_latest_query(query: Option<&str>) -> Result<LatestQuery, ApiError> {
    let mut source_revision_id = None;
    let mut configuration_revision_id = None;
    let query = query.ok_or_else(|| {
        ApiError::bad_request(
            "invalid_compatibility_query",
            "source_revision_id and configuration_revision_id are required",
        )
    })?;
    for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
        let target = match key.as_ref() {
            "source_revision_id" => &mut source_revision_id,
            "configuration_revision_id" => &mut configuration_revision_id,
            _ => {
                return Err(ApiError::bad_request(
                    "invalid_compatibility_query",
                    "the compatibility query contains an unknown field",
                ));
            }
        };
        if target.replace(value.into_owned()).is_some() {
            return Err(ApiError::bad_request(
                "invalid_compatibility_query",
                "the compatibility query contains a duplicate field",
            ));
        }
    }
    Ok(LatestQuery {
        source_revision_id: source_revision_id.ok_or_else(|| {
            ApiError::bad_request(
                "invalid_compatibility_query",
                "source_revision_id is required",
            )
        })?,
        configuration_revision_id: configuration_revision_id.ok_or_else(|| {
            ApiError::bad_request(
                "invalid_compatibility_query",
                "configuration_revision_id is required",
            )
        })?,
    })
}

impl ReportRow {
    fn into_response(self) -> Result<CompatibilityReportResponse, ApiError> {
        let status = CompatibilityStatus::parse(&self.status)?;
        let facts = serde_json::from_value(self.report).map_err(|_| ApiError::internal())?;
        Ok(ReportParts {
            id: self.id,
            project_id: self.project_id,
            configuration_revision_id: self.configuration_revision_id,
            source_revision_id: self.source_revision_id,
            analyzer_revision: self.analyzer_revision,
            status,
            advisory: self.advisory,
            facts,
            created_at: self.created_at,
        }
        .into_response())
    }
}

impl ReportParts {
    fn into_response(self) -> CompatibilityReportResponse {
        CompatibilityReportResponse {
            id: self.id,
            project_id: self.project_id,
            configuration_revision_id: self.configuration_revision_id,
            source_revision_id: self.source_revision_id,
            analyzer_revision: self.analyzer_revision,
            status: self.status,
            headline: self.status.headline().to_owned(),
            advisory: self.advisory,
            deployment_verified: false,
            facts: self.facts,
            created_at: self.created_at,
        }
    }
}

fn analyze(
    spec: &StandardProjectSpec,
    snapshot: &crate::github_provider::SourceSnapshot,
) -> Result<Analysis, ApiError> {
    let mut builder = AnalysisBuilder::new();
    let paths: BTreeSet<String> = snapshot.entry_paths.iter().cloned().collect();
    let mut files = BTreeMap::new();
    let mut bytes_read = 0_usize;
    for file in &snapshot.files {
        let text = std::str::from_utf8(&file.content).map_err(|_| malformed_source())?;
        bytes_read = bytes_read
            .checked_add(file.content.len())
            .ok_or_else(malformed_source)?;
        if files.insert(file.path.clone(), text).is_some() {
            return Err(malformed_source());
        }
    }

    inspect_unsupported(&paths, &files, &mut builder);
    let package_documents = parse_json_documents(&files, "package.json")?;
    let hostlet_documents = parse_json_documents(&files, "hostlet.json")?;

    let repository = spec.repositories.first().ok_or_else(malformed_source)?;
    let lockfile_path = repository.lockfile_path.clone();
    let lockfile_present = lockfile_path
        .as_ref()
        .is_some_and(|path| paths.contains(path));
    if !lockfile_present {
        builder.configuration_needed = true;
        builder.reason(
            "lockfile_missing",
            "The selected npm package-lock.json was not found at the configured path.",
            lockfile_path.as_deref(),
        );
        builder.question(question(
            "lockfile-path",
            "lockfile_path",
            "configuration_choice",
            "repositories[0].lockfile_path",
            "Select the repository-relative package-lock.json path.",
            None,
            Vec::new(),
        ));
    }
    if repository.package_manager != PackageManager::Npm
        || (!lockfile_present && has_unsupported_lockfile(&paths))
    {
        builder.unsupported = true;
        builder.reason(
            "unsupported_package_manager",
            "The initial compatibility contract supports locked npm projects only.",
            lockfile_path.as_deref(),
        );
    }

    let mut environment = BTreeMap::new();
    for document in hostlet_documents.values() {
        collect_hostlet_environment(document, &mut environment)?;
    }
    let explicitly_declared_environment: BTreeSet<_> = environment.keys().cloned().collect();
    for text in files.values() {
        collect_environment_references(text, &mut environment);
    }
    for platform_name in ["PORT", "NODE_ENV"] {
        if !explicitly_declared_environment.contains(platform_name) {
            environment.remove(platform_name);
        }
    }
    if environment.len() > MAX_ENVIRONMENT_NAMES {
        return Err(ApiError::unprocessable(
            "compatibility_report_limit",
            "the source declares too many environment variable names",
        ));
    }

    let mut services = Vec::new();
    let has_database_service = spec
        .services
        .iter()
        .any(|service| service.kind == ServiceKind::Postgres);
    let durable_source = detects_durable_data(&package_documents, &hostlet_documents, &files);

    for (index, service) in spec.services.iter().enumerate() {
        let root = service.root.as_deref();
        let package_path = rooted(root, "package.json");
        let package = package_documents.get(&package_path);
        if service.kind != ServiceKind::Postgres && package.is_none() {
            builder.configuration_needed = true;
            builder.reason(
                "service_root_missing",
                "The configured service root does not contain package.json.",
                Some(&package_path),
            );
            builder.question(question(
                &format!("service-{index}-root"),
                "service_root",
                "configuration_choice",
                &format!("services[{index}].root"),
                "Select the repository-relative service root.",
                Some(&package_path),
                Vec::new(),
            ));
        }
        let scripts = package
            .and_then(|value| value.get("scripts"))
            .and_then(Value::as_object);
        match package.and_then(classify_node_engine) {
            Some(NodeEngineEvidence::Unsupported) => {
                builder.unsupported = true;
                builder.reason(
                    "unsupported_node_version",
                    "The source declares a Node major outside the tested Node 22 and 24 lines.",
                    Some(&package_path),
                );
            }
            Some(NodeEngineEvidence::Ambiguous) => {
                builder.configuration_needed = true;
                builder.reason(
                    "node_version_ambiguous",
                    "Confirm Node 24 or the tested Node 22 alternative.",
                    Some(&package_path),
                );
                builder.question(question(
                    &format!("service-{index}-node-major"),
                    "node_major",
                    "configuration_choice",
                    &format!("services[{index}].node.major"),
                    "Select a tested Node major.",
                    Some(&package_path),
                    vec!["24".to_owned(), "22".to_owned()],
                ));
            }
            Some(NodeEngineEvidence::Supported(majors))
                if service
                    .node
                    .as_ref()
                    .is_some_and(|node| !majors.contains(&node.major)) =>
            {
                builder.configuration_needed = true;
                builder.reason(
                    "node_version_mismatch",
                    "The configured Node major is not included by the source engine declaration.",
                    Some(&package_path),
                );
                builder.question(question(
                    &format!("service-{index}-node-major"),
                    "node_major",
                    "configuration_choice",
                    &format!("services[{index}].node.major"),
                    "Select a Node major declared by the source and tested by Hostlet.",
                    Some(&package_path),
                    majors.into_iter().map(|major| major.to_string()).collect(),
                ));
            }
            Some(NodeEngineEvidence::Supported(_)) | None => {}
        }
        let build_present =
            command_present(service.build_command.as_deref(), scripts, root, &paths);
        let start_present =
            command_present(service.start_command.as_deref(), scripts, root, &paths);
        let health_present = detect_health(
            root,
            service.health_check.as_ref().map(|h| h.path.as_str()),
            &paths,
            &hostlet_documents,
        );

        if service.build_command.is_some() && !build_present {
            builder.configuration_needed = true;
            builder.reason(
                "build_command_missing",
                "The configured build command is not declared at the selected service root.",
                Some(&package_path),
            );
        }
        if service.start_command.is_some() && !start_present {
            builder.configuration_needed = true;
            builder.reason(
                "start_command_missing",
                "The configured start command is not declared at the selected service root.",
                Some(&package_path),
            );
        }
        if service.kind == ServiceKind::Application && !health_present {
            builder.configuration_needed = true;
            builder.reason(
                "health_endpoint_missing",
                "Confirm an HTTP health endpoint for the application service.",
                Some(&package_path),
            );
            builder.question(question(
                &format!("service-{index}-health-path"),
                "http_health_path",
                "configuration_choice",
                &format!("services[{index}].health_check.path"),
                "Select the HTTP health-check path.",
                Some(&package_path),
                Vec::new(),
            ));
        }

        match service.framework {
            FrameworkPattern::ViteStatic => {
                if detects_vite(root, package, &paths) {
                    builder.reason(
                        "vite_static_export",
                        "A Vite or static-export frontend matches the initial pattern.",
                        Some(&package_path),
                    );
                } else {
                    builder.configuration_needed = true;
                    builder.reason(
                        "framework_evidence_missing",
                        "Static framework evidence was not found at the selected root.",
                        Some(&package_path),
                    );
                }
            }
            FrameworkPattern::StaticExport => {
                if build_present {
                    builder.reason(
                        "static_export",
                        "A static-export frontend matches the initial pattern.",
                        Some(&package_path),
                    );
                } else {
                    builder.configuration_needed = true;
                    builder.reason(
                        "framework_evidence_missing",
                        "Static-export evidence was not found at the selected root.",
                        Some(&package_path),
                    );
                }
            }
            FrameworkPattern::NodeHttp => {
                builder.reason(
                    "single_node_http_service",
                    "One Node HTTP application service matches the initial pattern.",
                    Some(&package_path),
                );
                if health_present {
                    builder.reason(
                        "health_endpoint_declared",
                        "An HTTP health endpoint is declared for the application service.",
                        Some(&package_path),
                    );
                }
            }
            FrameworkPattern::Nextjs16Standalone => {
                if detects_next16_standalone(root, package, &files) {
                    builder.reason(
                        "nextjs_16_standalone",
                        "Next.js 16 standalone configuration matches the tested pattern.",
                        Some(&package_path),
                    );
                    if repository.layout == RepositoryLayout::Monorepo && root != Some(".") {
                        builder.reason(
                            "monorepo_service_root",
                            "The service uses an explicit monorepo root.",
                            Some(&package_path),
                        );
                    }
                } else {
                    builder.configuration_needed = true;
                    builder.reason(
                        "nextjs_standalone_configuration_missing",
                        "Next.js 16 standalone evidence is missing at the selected root.",
                        Some(&package_path),
                    );
                }
            }
            FrameworkPattern::Postgresql18 => {}
            FrameworkPattern::DockerCompose
            | FrameworkPattern::CustomNextServer
            | FrameworkPattern::Unsupported => {
                builder.unsupported = true;
                builder.reason(
                    "unsupported_framework",
                    "The configured framework is outside the initial compatibility scope.",
                    Some(&package_path),
                );
            }
        }

        services.push(ServiceFacts {
            kind: service_kind(service.kind).to_owned(),
            root: service.root.clone(),
            framework: framework_name(service.framework).to_owned(),
            node_major: service.node.as_ref().map(|node| node.major),
            build_command_present: build_present,
            start_command_present: start_present,
            http_health_path_present: health_present,
            durable_data_detected: service.kind == ServiceKind::Application && durable_source,
        });
    }

    if durable_source {
        builder.reason(
            "postgresql_connection_required",
            "The application declares PostgreSQL-backed durable data.",
            first_evidence_path(&files, "hostlet.json").as_deref(),
        );
        if !has_database_service {
            builder.database_needed = true;
            builder.question(question(
                "project-database",
                "database_service",
                "configuration_choice",
                "services",
                "Add the supported PostgreSQL 18 service or keep this project showcase-only.",
                None,
                vec!["postgresql18".to_owned(), "showcase_only".to_owned()],
            ));
        }
    }

    if has_database_service {
        // Hostlet injects this managed PostgreSQL connection name. It is not an
        // owner-supplied secret and its value must never enter this report.
        environment.remove("DATABASE_URL");
    }

    let environment_requirements: Vec<_> = environment
        .into_iter()
        .map(|(name, classification)| EnvironmentRequirement {
            name,
            classification,
        })
        .collect();
    let secret_names: Vec<_> = environment_requirements
        .iter()
        .filter(|item| item.classification == EnvironmentClassification::ServerSecret)
        .map(|item| item.name.clone())
        .collect();
    let public_names: Vec<_> = environment_requirements
        .iter()
        .filter(|item| item.classification == EnvironmentClassification::PublicBuildValue)
        .map(|item| item.name.clone())
        .collect();
    if !secret_names.is_empty() {
        builder.secrets_needed = true;
        builder.reason(
            "server_secret_names_declared",
            "Server secret names are declared; no secret value was read or inferred.",
            first_evidence_path(&files, "hostlet.json").as_deref(),
        );
        for name in secret_names {
            builder.question(question(
                &format!("secret-{}", safe_identifier(&name)),
                "environment_variable",
                "secret_required",
                &format!("environment.{name}"),
                &format!("Provide the server secret {name} during paid configuration."),
                None,
                Vec::new(),
            ));
        }
    }
    if !public_names.is_empty() {
        builder.reason(
            "public_build_values_separate",
            "Public build-time variable names are separate from server secrets.",
            first_evidence_path(&files, "hostlet.json").as_deref(),
        );
        for name in public_names {
            builder.question(question(
                &format!("public-{}", safe_identifier(&name)),
                "environment_variable",
                "public_build_value",
                &format!("environment.{name}"),
                &format!("Enter the public build-time value for {name}."),
                None,
                Vec::new(),
            ));
        }
    }

    if detects_inert_commands(&package_documents, &hostlet_documents) {
        builder.configuration_needed = true;
        builder.reason(
            "commands_are_inert_metadata",
            "Lifecycle, build, start and migration commands were inspected only as inert metadata.",
            first_evidence_path(&files, "package.json").as_deref(),
        );
    }

    if builder.report_limit_exceeded {
        return Err(ApiError::unprocessable(
            "compatibility_report_limit",
            "the compatibility report exceeded its bounded findings limit",
        ));
    }

    builder
        .reasons
        .sort_by(|left, right| left.code.cmp(&right.code));
    builder
        .questions
        .sort_by(|left, right| left.id.cmp(&right.id));
    let status = builder.status();
    let facts = CompatibilitySafeFacts {
        contract_version: REPORT_CONTRACT.to_owned(),
        repository: RepositoryFacts {
            layout: repository_layout(repository.layout).to_owned(),
            package_manager: package_manager(repository.package_manager).to_owned(),
            lockfile_path,
        },
        services,
        environment_requirements,
        reasons: builder.reasons,
        configuration_questions: builder.questions,
        inspection: InspectionFacts {
            files_considered: snapshot.entry_paths.len(),
            files_read: snapshot.files.len(),
            bytes_read,
            limits_revision: LIMITS_REVISION.to_owned(),
        },
    };
    Ok(Analysis { status, facts })
}

fn inspect_unsupported(
    paths: &BTreeSet<String>,
    files: &BTreeMap<String, &str>,
    builder: &mut AnalysisBuilder,
) {
    if let Some(path) = paths.iter().find(|path| {
        let file = basename(path).to_ascii_lowercase();
        matches!(
            file.as_str(),
            "compose.yaml" | "compose.yml" | "docker-compose.yaml" | "docker-compose.yml"
        )
    }) {
        builder.unsupported = true;
        builder.reason(
            "docker_compose_unsupported",
            "Docker Compose is outside the initial compatibility scope.",
            Some(path),
        );
        builder.reason(
            "multiple_backends_unsupported",
            "Compose or multiple backend services are outside the initial compatibility scope.",
            Some(path),
        );
    }
    if let Some(path) = paths.iter().find(|path| {
        basename(path)
            .to_ascii_lowercase()
            .starts_with("dockerfile")
    }) {
        builder.unsupported = true;
        builder.reason(
            "dockerfile_unsupported",
            "Arbitrary Dockerfiles are outside the initial compatibility scope.",
            Some(path),
        );
    }
    if let Some(path) = paths.iter().find(|path| {
        let folded = path.to_ascii_lowercase();
        folded.starts_with("workers/") || folded.contains("/workers/")
    }) {
        builder.unsupported = true;
        builder.reason(
            "extra_workers_unsupported",
            "Extra worker services are outside the initial compatibility scope.",
            Some(path),
        );
    }
    if let Some((path, _)) = files.iter().find(|(path, text)| {
        (path.to_ascii_lowercase().contains("custom-server")
            || (text.contains("createServer") && text.contains("next(")))
            && is_javascript_path(path)
    }) {
        builder.unsupported = true;
        builder.reason(
            "unsupported_custom_server",
            "Custom application servers are outside the tested Next.js standalone pattern.",
            Some(path),
        );
    }
    let persistent_path = paths.iter().find(|path| {
        let folded = path.to_ascii_lowercase();
        folded.starts_with("uploads/")
            || folded.contains("/uploads/")
            || folded.starts_with("data/")
            || folded.contains("/data/")
    });
    let persistent_body = files.iter().find(|(_, text)| {
        text.contains("persistentPaths")
            || ((text.contains("writeFile") || text.contains("appendFile"))
                && (text.contains("uploads") || text.contains("sqlite")))
    });
    if let Some(path) = persistent_path
        .map(String::as_str)
        .or_else(|| persistent_body.map(|(path, _)| path.as_str()))
    {
        builder.unsupported = true;
        builder.reason(
            "persistent_local_disk_assumption",
            "Persistent application-disk assumptions are outside the initial scope.",
            Some(path),
        );
    }
}

fn parse_json_documents<'a>(
    files: &'a BTreeMap<String, &'a str>,
    name: &str,
) -> Result<BTreeMap<String, Value>, ApiError> {
    let mut result = BTreeMap::new();
    for (path, text) in files {
        if basename(path) == name {
            let value: Value = serde_json::from_str(text).map_err(|_| malformed_source())?;
            if !value.is_object() {
                return Err(malformed_source());
            }
            result.insert(path.clone(), value);
        }
    }
    Ok(result)
}

fn collect_hostlet_environment(
    value: &Value,
    output: &mut BTreeMap<String, EnvironmentClassification>,
) -> Result<(), ApiError> {
    let object = value.as_object().ok_or_else(malformed_source)?;
    for (field, classification) in [
        (
            "publicBuildVariables",
            EnvironmentClassification::PublicBuildValue,
        ),
        ("serverSecrets", EnvironmentClassification::ServerSecret),
    ] {
        if let Some(values) = object.get(field) {
            let values = values.as_array().ok_or_else(malformed_source)?;
            for value in values {
                let name = value.as_str().ok_or_else(malformed_source)?;
                insert_environment_name(output, name, classification)?;
            }
        }
    }
    Ok(())
}

fn collect_environment_references(
    text: &str,
    output: &mut BTreeMap<String, EnvironmentClassification>,
) {
    for prefix in ["process.env.", "import.meta.env."] {
        let mut remainder = text;
        while let Some(index) = remainder.find(prefix) {
            remainder = &remainder[index + prefix.len()..];
            let name: String = remainder
                .chars()
                .take_while(|character| character.is_ascii_alphanumeric() || *character == '_')
                .take(129)
                .collect();
            if valid_environment_name(&name) {
                let classification = if name.starts_with("VITE_")
                    || name.starts_with("NEXT_PUBLIC_")
                    || name.starts_with("PUBLIC_")
                {
                    EnvironmentClassification::PublicBuildValue
                } else {
                    EnvironmentClassification::ServerSecret
                };
                output
                    .entry(name)
                    .and_modify(|existing| {
                        if classification == EnvironmentClassification::ServerSecret {
                            *existing = classification;
                        }
                    })
                    .or_insert(classification);
            }
        }
    }
}

fn insert_environment_name(
    output: &mut BTreeMap<String, EnvironmentClassification>,
    name: &str,
    classification: EnvironmentClassification,
) -> Result<(), ApiError> {
    if !valid_environment_name(name) {
        return Err(malformed_source());
    }
    output
        .entry(name.to_owned())
        .and_modify(|existing| {
            if classification == EnvironmentClassification::ServerSecret {
                *existing = classification;
            }
        })
        .or_insert(classification);
    Ok(())
}

fn valid_environment_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_uppercase() || byte == b'_')
        && name
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
}

fn detects_durable_data(
    packages: &BTreeMap<String, Value>,
    hostlet: &BTreeMap<String, Value>,
    files: &BTreeMap<String, &str>,
) -> bool {
    packages.values().any(|package| {
        has_dependency(package, "pg")
            || has_dependency(package, "postgres")
            || has_dependency(package, "@prisma/client")
    }) || hostlet
        .values()
        .any(|value| value.get("database").and_then(Value::as_str) == Some("postgresql"))
        || files.values().any(|text| text.contains("DATABASE_URL"))
}

fn detects_vite(root: Option<&str>, package: Option<&Value>, paths: &BTreeSet<String>) -> bool {
    package.is_some_and(|value| has_dependency(value, "vite"))
        || paths
            .iter()
            .any(|path| in_root(path, root) && basename(path).starts_with("vite.config."))
}

fn detects_next16_standalone(
    root: Option<&str>,
    package: Option<&Value>,
    files: &BTreeMap<String, &str>,
) -> bool {
    let next16 = package
        .and_then(|value| dependency_version(value, "next"))
        .and_then(simple_package_major)
        == Some(16);
    let standalone = files.iter().any(|(path, text)| {
        in_root(path, root)
            && basename(path).starts_with("next.config.")
            && has_single_literal_property(text, "output", "standalone")
    });
    next16 && standalone
}

fn detect_health(
    root: Option<&str>,
    configured_path: Option<&str>,
    paths: &BTreeSet<String>,
    hostlet: &BTreeMap<String, Value>,
) -> bool {
    let Some(configured) = configured_path else {
        return false;
    };
    if hostlet.iter().any(|(path, value)| {
        in_root(path, root) && value.get("healthPath").and_then(Value::as_str) == Some(configured)
    }) {
        return true;
    }
    let route = configured.trim_matches('/');
    !route.is_empty()
        && paths.iter().any(|path| {
            if !in_root(path, root) {
                return false;
            }
            let relative = strip_root(path, root);
            ["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts"]
                .iter()
                .any(|extension| {
                    relative == format!("app/{route}/route.{extension}")
                        || relative == format!("src/app/{route}/route.{extension}")
                        || relative == format!("pages/{route}.{extension}")
                        || relative == format!("src/pages/{route}.{extension}")
                })
        })
}

fn detects_inert_commands(
    packages: &BTreeMap<String, Value>,
    hostlet: &BTreeMap<String, Value>,
) -> bool {
    packages.values().any(|package| {
        package
            .get("scripts")
            .and_then(Value::as_object)
            .is_some_and(|scripts| {
                scripts.contains_key("preinstall")
                    || scripts.contains_key("postinstall")
                    || scripts.contains_key("migrate")
            })
    }) || hostlet
        .values()
        .any(|value| value.get("migrationCommand").is_some())
}

fn has_unsupported_lockfile(paths: &BTreeSet<String>) -> bool {
    paths.iter().any(|path| {
        let name = basename(path).to_ascii_lowercase();
        matches!(
            name.as_str(),
            "yarn.lock" | "pnpm-lock.yaml" | "bun.lock" | "bun.lockb"
        )
    })
}

fn has_dependency(value: &Value, name: &str) -> bool {
    dependency_version(value, name).is_some()
}

fn dependency_version<'a>(value: &'a Value, name: &str) -> Option<&'a str> {
    ["dependencies", "devDependencies", "peerDependencies"]
        .into_iter()
        .find_map(|field| {
            value
                .get(field)
                .and_then(Value::as_object)
                .and_then(|items| items.get(name))
                .and_then(Value::as_str)
        })
}

fn simple_package_major(requirement: &str) -> Option<u16> {
    let requirement = requirement.trim();
    if requirement.is_empty()
        || requirement
            .bytes()
            .any(|byte| matches!(byte, b'>' | b'<' | b'*' | b' ' | b'\t'))
        || requirement.contains("||")
    {
        return None;
    }
    let version = requirement.trim_start_matches(['^', '~', '=', 'v']);
    let digits: String = version.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    let boundary = version.as_bytes().get(digits.len()).copied();
    if !matches!(boundary, None | Some(b'.') | Some(b'-')) {
        return None;
    }
    digits.parse().ok()
}

fn has_single_literal_property(source: &str, property: &str, expected: &str) -> bool {
    let Some(source) = strip_javascript_comments(source) else {
        return false;
    };
    let Some(source) = static_exported_object(&source) else {
        return false;
    };
    let bytes = source.as_bytes();
    let mut index = 0;
    let mut depth = 0_usize;
    let mut property_count = 0;
    let mut literal_count = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'{' => {
                depth += 1;
                index += 1;
                continue;
            }
            b'}' => {
                depth = depth.saturating_sub(1);
                index += 1;
                continue;
            }
            _ => {}
        }
        let (is_property, end) = if matches!(bytes[index], b'\'' | b'"') {
            let Some((end, content)) = parse_simple_quoted(bytes, index) else {
                return false;
            };
            (content == Some(property.as_bytes()), end)
        } else if bytes[index].is_ascii_alphabetic() || matches!(bytes[index], b'_' | b'$') {
            let end = bytes[index..]
                .iter()
                .position(|byte| !(byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'$')))
                .map_or(bytes.len(), |offset| index + offset);
            (&bytes[index..end] == property.as_bytes(), end)
        } else {
            index += 1;
            continue;
        };
        index = end;
        if !is_property || depth != 1 {
            continue;
        }
        index = skip_ascii_whitespace(bytes, index);
        if bytes.get(index) != Some(&b':') {
            continue;
        }
        property_count += 1;
        index = skip_ascii_whitespace(bytes, index + 1);
        if !matches!(bytes.get(index), Some(b'\'' | b'"')) {
            continue;
        }
        let Some((end, content)) = parse_simple_quoted(bytes, index) else {
            return false;
        };
        if content == Some(expected.as_bytes()) {
            literal_count += 1;
        }
        index = end;
    }
    property_count == 1 && literal_count == 1
}

fn static_exported_object(source: &str) -> Option<&str> {
    let object = if let Some(offset) = source.find("export default") {
        &source[offset + "export default".len()..]
    } else if let Some(offset) = source.find("module.exports") {
        let remainder = &source[offset + "module.exports".len()..];
        let equals = skip_ascii_whitespace(remainder.as_bytes(), 0);
        if remainder.as_bytes().get(equals) != Some(&b'=') {
            return None;
        }
        &remainder[equals + 1..]
    } else {
        return None;
    };
    let start = skip_ascii_whitespace(object.as_bytes(), 0);
    let object = object.get(start..)?;
    if !object.starts_with('{')
        || object.contains("...")
        || object.contains("Object.assign")
        || object.contains("=>")
        || object.contains("function")
        || object.contains('[')
    {
        return None;
    }
    let bytes = object.as_bytes();
    let mut index = 0;
    let mut depth = 0_usize;
    while index < bytes.len() {
        match bytes[index] {
            b'\'' | b'"' => {
                index = parse_simple_quoted(bytes, index)?.0;
                continue;
            }
            b'`' => return None,
            b'{' => depth += 1,
            b'}' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    let trailing = object.get(index + 1..)?.trim();
                    if !trailing.is_empty() && trailing != ";" {
                        return None;
                    }
                    return object.get(..=index);
                }
            }
            _ => {}
        }
        index += 1;
    }
    None
}

fn parse_simple_quoted(bytes: &[u8], start: usize) -> Option<(usize, Option<&[u8]>)> {
    let quote = *bytes.get(start)?;
    let mut index = start + 1;
    let mut simple = true;
    while index < bytes.len() {
        match bytes[index] {
            byte if byte == quote => {
                return Some((index + 1, simple.then_some(&bytes[start + 1..index])));
            }
            b'\\' => {
                simple = false;
                index += 2;
                continue;
            }
            b'\n' | b'\r' => return None,
            _ => index += 1,
        }
    }
    None
}

fn skip_ascii_whitespace(bytes: &[u8], mut index: usize) -> usize {
    while bytes.get(index).is_some_and(u8::is_ascii_whitespace) {
        index += 1;
    }
    index
}

fn strip_javascript_comments(source: &str) -> Option<String> {
    #[derive(Clone, Copy)]
    enum State {
        Code,
        Single,
        Double,
        Template,
        LineComment,
        BlockComment,
    }
    let bytes = source.as_bytes();
    let mut output = String::with_capacity(source.len());
    let mut state = State::Code;
    let mut index = 0;
    let mut escaped = false;
    while index < bytes.len() {
        let byte = bytes[index];
        let next = bytes.get(index + 1).copied();
        match state {
            State::Code if byte == b'/' && next == Some(b'/') => {
                state = State::LineComment;
                output.push(' ');
                index += 2;
                continue;
            }
            State::Code if byte == b'/' && next == Some(b'*') => {
                state = State::BlockComment;
                output.push(' ');
                index += 2;
                continue;
            }
            State::Code => {
                output.push(byte as char);
                state = match byte {
                    b'\'' => State::Single,
                    b'"' => State::Double,
                    b'`' => State::Template,
                    _ => State::Code,
                };
            }
            State::LineComment if byte == b'\n' => {
                output.push('\n');
                state = State::Code;
            }
            State::LineComment => {}
            State::BlockComment if byte == b'*' && next == Some(b'/') => {
                state = State::Code;
                index += 2;
                continue;
            }
            State::BlockComment => {}
            State::Single | State::Double | State::Template => {
                output.push(byte as char);
                if escaped {
                    escaped = false;
                } else if byte == b'\\' {
                    escaped = true;
                } else if matches!(
                    (state, byte),
                    (State::Single, b'\'') | (State::Double, b'"') | (State::Template, b'`')
                ) {
                    state = State::Code;
                }
            }
        }
        index += 1;
    }
    match state {
        State::Code | State::LineComment => Some(output),
        State::Single | State::Double | State::Template | State::BlockComment => None,
    }
}

enum NodeEngineEvidence {
    Supported(BTreeSet<u16>),
    Unsupported,
    Ambiguous,
}

fn classify_node_engine(package: &Value) -> Option<NodeEngineEvidence> {
    let requirement = package
        .get("engines")
        .and_then(Value::as_object)
        .and_then(|engines| engines.get("node"))
        .and_then(Value::as_str)?;
    let mut majors = BTreeSet::new();
    for alternative in requirement.split("||") {
        let trimmed = alternative.trim();
        if trimmed.is_empty()
            || trimmed == "*"
            || trimmed.contains(" - ")
            || trimmed
                .bytes()
                .any(|byte| matches!(byte, b'>' | b'<' | b'*'))
            || trimmed
                .split_ascii_whitespace()
                .filter(|part| !part.is_empty())
                .count()
                > 1
        {
            return Some(NodeEngineEvidence::Ambiguous);
        }
        let Some(start) = trimmed.find(|character: char| character.is_ascii_digit()) else {
            return Some(NodeEngineEvidence::Ambiguous);
        };
        let digits: String = trimmed[start..]
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        let Ok(major) = digits.parse::<u16>() else {
            return Some(NodeEngineEvidence::Ambiguous);
        };
        majors.insert(major);
    }
    if majors.is_empty() {
        Some(NodeEngineEvidence::Ambiguous)
    } else if majors.iter().all(|major| matches!(major, 22 | 24)) {
        Some(NodeEngineEvidence::Supported(majors))
    } else {
        Some(NodeEngineEvidence::Unsupported)
    }
}

fn command_present(
    command: Option<&str>,
    scripts: Option<&serde_json::Map<String, Value>>,
    root: Option<&str>,
    paths: &BTreeSet<String>,
) -> bool {
    let Some(command) = command else {
        return false;
    };
    let words: Vec<_> = command.split_ascii_whitespace().collect();
    if words.len() == 3 && words[0] == "npm" && words[1] == "run" {
        scripts.is_some_and(|scripts| scripts.contains_key(words[2]))
    } else if words.len() == 2 && words[0] == "npm" {
        scripts.is_some_and(|scripts| scripts.contains_key(words[1]))
    } else if words.len() == 2
        && words[0] == "node"
        && !words[1].starts_with('-')
        && !words[1].starts_with('/')
        && !words[1]
            .split('/')
            .any(|part| matches!(part, "" | "." | ".."))
    {
        paths.contains(&rooted(root, words[1]))
    } else {
        false
    }
}

fn question(
    id: &str,
    kind: &str,
    classification: &str,
    target_path: &str,
    prompt: &str,
    source_path: Option<&str>,
    allowed_options: Vec<String>,
) -> ConfigurationQuestion {
    ConfigurationQuestion {
        id: id.to_owned(),
        kind: kind.to_owned(),
        classification: classification.to_owned(),
        target_path: target_path.to_owned(),
        prompt: prompt.to_owned(),
        source_path: source_path.map(str::to_owned),
        required: true,
        allowed_options,
    }
}

fn rooted(root: Option<&str>, file: &str) -> String {
    match root {
        None | Some(".") | Some("") => file.to_owned(),
        Some(root) => format!("{}/{file}", root.trim_end_matches('/')),
    }
}

fn in_root(path: &str, root: Option<&str>) -> bool {
    match root {
        None | Some(".") | Some("") => true,
        Some(root) => path == root || path.starts_with(&format!("{}/", root.trim_end_matches('/'))),
    }
}

fn strip_root<'a>(path: &'a str, root: Option<&str>) -> &'a str {
    match root {
        None | Some(".") | Some("") => path,
        Some(root) => path
            .strip_prefix(root.trim_end_matches('/'))
            .and_then(|relative| relative.strip_prefix('/'))
            .unwrap_or(path),
    }
}

fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn first_evidence_path(files: &BTreeMap<String, &str>, name: &str) -> Option<String> {
    files.keys().find(|path| basename(path) == name).cloned()
}

fn is_javascript_path(path: &str) -> bool {
    path.rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .is_some_and(|extension| {
            matches!(
                extension.as_str(),
                "js" | "jsx" | "ts" | "tsx" | "mjs" | "cjs" | "mts" | "cts"
            )
        })
}

fn safe_identifier(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .take(96)
        .collect()
}

fn repository_layout(value: RepositoryLayout) -> &'static str {
    match value {
        RepositoryLayout::SingleProject => "single_project",
        RepositoryLayout::Monorepo => "monorepo",
    }
}

fn package_manager(value: PackageManager) -> &'static str {
    match value {
        PackageManager::Npm => "npm",
        PackageManager::Pnpm => "pnpm",
        PackageManager::Yarn => "yarn",
        PackageManager::Other => "other",
    }
}

fn service_kind(value: ServiceKind) -> &'static str {
    match value {
        ServiceKind::StaticFrontend => "static_frontend",
        ServiceKind::Application => "application",
        ServiceKind::Postgres => "postgres",
        ServiceKind::Worker => "worker",
        ServiceKind::ScheduledJob => "scheduled_job",
        ServiceKind::AdditionalBackend => "additional_backend",
    }
}

fn framework_name(value: FrameworkPattern) -> &'static str {
    match value {
        FrameworkPattern::ViteStatic => "vite_static",
        FrameworkPattern::StaticExport => "static_export",
        FrameworkPattern::NodeHttp => "node_http",
        FrameworkPattern::Nextjs16Standalone => "nextjs16_standalone",
        FrameworkPattern::Postgresql18 => "postgresql18",
        FrameworkPattern::DockerCompose => "docker_compose",
        FrameworkPattern::CustomNextServer => "custom_next_server",
        FrameworkPattern::Unsupported => "unsupported",
    }
}

fn malformed_source() -> ApiError {
    ApiError::unprocessable(
        "compatibility_source_malformed",
        "the selected source contains malformed compatibility metadata",
    )
}
