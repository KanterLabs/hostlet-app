use std::collections::HashSet;

use axum::{
    Json, Router,
    extract::{FromRequestParts, Path, State},
    http::{HeaderMap, StatusCode, header, request::Parts},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use hostlet_contracts::project::{ProjectId, SecretVersionId, SecretVersionReference, ServiceId};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Transaction};
use subtle::ConstantTimeEq;
use uuid::Uuid;
use zeroize::Zeroize;

use crate::{
    auth::Authenticated,
    error::{ApiError, SafeJson},
    foundation::FoundationState,
    intent::{self, Replay},
};

const JOB_KIND: &str = "foundation_bookkeeping";
const JOB_OPERATION: &str = "build";
const MAX_SECRET_REFS: usize = 32;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JobRecord {
    pub id: Uuid,
    pub project_id: ProjectId,
    pub service_id: ServiceId,
    pub kind: String,
    pub operation: String,
    pub source_commit: String,
    pub state: String,
    pub revision: u64,
    pub attempt_count: u32,
    pub current_attempt_id: Option<Uuid>,
    pub current_fence: u64,
    pub lease_expires_at: Option<DateTime<Utc>>,
    pub secret_version_refs: Vec<SecretVersionReference>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateJobRequest {
    kind: String,
    operation: String,
    service_id: String,
    source_commit: String,
    secret_version_refs: Vec<SecretVersionReference>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CancelJobRequest {}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LeaseRequest {
    worker_id: String,
    kinds: Vec<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LeaseResponse {
    pub job: JobRecord,
    pub attempt: AttemptLease,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttemptLease {
    pub id: Uuid,
    pub attempt_number: u32,
    pub fence: u64,
    pub worker_id: String,
    pub lease_expires_at: DateTime<Utc>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LeaseIdentityRequest {
    worker_id: String,
    attempt_id: Uuid,
    fence: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RenewResponse {
    pub job_id: Uuid,
    pub attempt_id: Uuid,
    pub fence: u64,
    pub lease_expires_at: DateTime<Utc>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ResolveCredentialsRequest {
    worker_id: String,
    attempt_id: Uuid,
    fence: i64,
    secret_version_ids: Vec<Uuid>,
}

#[derive(Serialize)]
struct ResolveCredentialsResponse {
    credentials: Vec<ResolvedCredential>,
}

#[derive(Serialize)]
struct ResolvedCredential {
    secret_version_id: Uuid,
    name: String,
    value: SecretResponseValue,
}

struct SecretResponseValue(String);

impl Serialize for SecretResponseValue {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl Drop for SecretResponseValue {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CompleteRequest {
    worker_id: String,
    attempt_id: Uuid,
    fence: i64,
    outcome: CompletionOutcome,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CompletionOutcome {
    state: String,
    code: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompleteResponse {
    pub job: JobRecord,
    pub effect: Option<JobEffectResponse>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JobEffectResponse {
    pub id: Uuid,
    pub outcome_state: String,
    pub outcome_code: String,
}

#[derive(sqlx::FromRow)]
struct JobRow {
    id: Uuid,
    project_id: Uuid,
    service_id: Uuid,
    kind: String,
    operation: String,
    source_commit: String,
    state: String,
    revision: i64,
    attempt_count: i32,
    current_attempt_id: Option<Uuid>,
    current_fence: i64,
    lease_expires_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

pub struct WorkerAuth;

impl FromRequestParts<FoundationState> for WorkerAuth {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &FoundationState,
    ) -> Result<Self, Self::Rejection> {
        let supplied = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .filter(|value| !value.is_empty());
        let Some((supplied, expected)) = supplied.zip(state.worker_token_hash.as_ref()) else {
            return Err(ApiError::unauthorized());
        };
        let supplied_hash: [u8; 32] = Sha256::digest(supplied.as_bytes()).into();
        if supplied_hash.ct_eq(expected).unwrap_u8() != 1 {
            return Err(ApiError::unauthorized());
        }
        Ok(Self)
    }
}

pub fn routes() -> Router<FoundationState> {
    Router::new()
        .route("/v1/projects/{project_id}/jobs", post(create_job))
        .route("/v1/projects/{project_id}/jobs/{job_id}", get(get_job))
        .route(
            "/v1/projects/{project_id}/jobs/{job_id}/cancel",
            post(cancel_job),
        )
}

pub fn internal_routes() -> Router<FoundationState> {
    Router::new()
        .route("/internal/v1/jobs/lease", post(lease_job))
        .route("/internal/v1/jobs/{job_id}/renew", post(renew_job))
        .route(
            "/internal/v1/jobs/{job_id}/credentials:resolve",
            post(resolve_credentials),
        )
        .route("/internal/v1/jobs/{job_id}/complete", post(complete_job))
}

fn valid_source_commit(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_worker_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && value.bytes().all(|byte| byte.is_ascii_graphic())
}

fn valid_outcome(outcome: &CompletionOutcome) -> bool {
    matches!(
        (outcome.state.as_str(), outcome.code.as_str()),
        ("succeeded", "bookkeeping_complete")
            | ("failed", "bookkeeping_failed")
            | ("retriable", "retry_requested")
    )
}

fn as_u64(value: i64) -> Result<u64, ApiError> {
    u64::try_from(value).map_err(|_| ApiError::internal())
}

fn as_u32(value: i32) -> Result<u32, ApiError> {
    u32::try_from(value).map_err(|_| ApiError::internal())
}

struct WorkerAuditContext<'a> {
    job_id: Uuid,
    worker_id: &'a str,
    attempt_id: Uuid,
    fence: i64,
}

async fn worker_audit(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    event_type: &str,
    context: WorkerAuditContext<'_>,
    outcome: &str,
) -> Result<(), ApiError> {
    sqlx::query(
        "INSERT INTO audit_events \
         (id, account_id, event_type, target_type, target_id, outcome, metadata) \
         VALUES ($1,$2,$3,'job',$4,$5, \
                 jsonb_build_object('worker_id',$6,'attempt_id',$7,'fence',$8))",
    )
    .bind(Uuid::new_v4())
    .bind(account_id)
    .bind(event_type)
    .bind(context.job_id)
    .bind(outcome)
    .bind(context.worker_id)
    .bind(context.attempt_id)
    .bind(context.fence)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

async fn load_job(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    project_id: Uuid,
    job_id: Uuid,
) -> Result<JobRecord, ApiError> {
    let row: JobRow = sqlx::query_as(
        "SELECT id, project_id, service_id, kind, operation, source_commit, state, revision, \
                attempt_count, current_attempt_id, current_fence, lease_expires_at, \
                created_at, updated_at \
         FROM jobs WHERE account_id = $1 AND project_id = $2 AND id = $3",
    )
    .bind(account_id)
    .bind(project_id)
    .bind(job_id)
    .fetch_optional(&mut **transaction)
    .await?
    .ok_or_else(ApiError::not_found)?;
    job_record(transaction, account_id, row).await
}

async fn job_record(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    row: JobRow,
) -> Result<JobRecord, ApiError> {
    let refs: Vec<(Uuid,)> = sqlx::query_as(
        "SELECT secret_version_id FROM job_secret_refs \
         WHERE account_id = $1 AND project_id = $2 AND job_id = $3 \
         ORDER BY secret_version_id",
    )
    .bind(account_id)
    .bind(row.project_id)
    .bind(row.id)
    .fetch_all(&mut **transaction)
    .await?;
    Ok(JobRecord {
        id: row.id,
        project_id: ProjectId(row.project_id.to_string()),
        service_id: ServiceId(row.service_id.to_string()),
        kind: row.kind,
        operation: row.operation,
        source_commit: row.source_commit,
        state: row.state,
        revision: as_u64(row.revision)?,
        attempt_count: as_u32(row.attempt_count)?,
        current_attempt_id: row.current_attempt_id,
        current_fence: as_u64(row.current_fence)?,
        lease_expires_at: row.lease_expires_at,
        secret_version_refs: refs
            .into_iter()
            .map(|(version_id,)| SecretVersionReference {
                service_id: ServiceId(row.service_id.to_string()),
                secret_version_id: SecretVersionId(version_id.to_string()),
            })
            .collect(),
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

async fn create_job(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    SafeJson(request): SafeJson<CreateJobRequest>,
) -> Result<(StatusCode, Json<JobRecord>), ApiError> {
    if request.kind != JOB_KIND {
        return Err(ApiError::unprocessable(
            "unsupported_job_kind",
            "M1 supports platform bookkeeping jobs only",
        ));
    }
    if request.operation != JOB_OPERATION {
        return Err(ApiError::unprocessable(
            "unsupported_job_operation",
            "M1 bookkeeping jobs support the build credential-policy operation only",
        ));
    }
    if !valid_source_commit(&request.source_commit) {
        return Err(ApiError::unprocessable(
            "invalid_source_commit",
            "source_commit must be 40 or 64 lowercase hexadecimal characters",
        ));
    }
    if request.secret_version_refs.len() > MAX_SECRET_REFS {
        return Err(ApiError::unprocessable(
            "too_many_secret_references",
            "a job may bind at most 32 secret versions",
        ));
    }
    let account_id = authenticated.account_id()?;
    let project_id = intent::path_uuid(&project_id)?;
    let service_id = intent::path_uuid(&request.service_id)?;
    let key = intent::idempotency_key(&headers)?;
    let hash = intent::request_hash(&request)?;
    let operation = format!("job.create/{project_id}");
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
                "job.create",
                "job",
                None,
                "idempotency_conflict",
            )
            .await?;
            transaction.commit().await?;
            return Err(ApiError::conflict(
                "idempotency_payload_changed",
                "the idempotency key was already used with a different request",
            ));
        }
        Replay::Miss => {}
    }
    let owned_service: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM services \
         WHERE account_id = $1 AND project_id = $2 AND id = $3)",
    )
    .bind(account_id)
    .bind(project_id)
    .bind(service_id)
    .fetch_one(&mut *transaction)
    .await?;
    if !owned_service {
        intent::audit(
            &mut transaction,
            account_id,
            authenticated.session_id(),
            "job.create",
            "service",
            Some(service_id),
            "denied",
        )
        .await?;
        transaction.commit().await?;
        return Err(ApiError::not_found());
    }

    let mut seen_versions = HashSet::new();
    let mut seen_secrets = HashSet::new();
    let mut resolved_refs = Vec::with_capacity(request.secret_version_refs.len());
    for reference in &request.secret_version_refs {
        let reference_service_id = intent::path_uuid(&reference.service_id.0)?;
        let version_id = intent::path_uuid(&reference.secret_version_id.0)?;
        if reference_service_id != service_id || !seen_versions.insert(version_id) {
            return Err(ApiError::unprocessable(
                "invalid_secret_reference",
                "secret references must be unique and belong to the job service",
            ));
        }
        let metadata: Option<(Uuid, String, String)> = sqlx::query_as(
            "SELECT s.id, s.operation, s.credential_kind \
             FROM secret_versions sv JOIN secrets s \
               ON s.account_id = sv.account_id AND s.project_id = sv.project_id \
              AND s.service_id = sv.service_id AND s.id = sv.secret_id \
             WHERE sv.account_id = $1 AND sv.project_id = $2 AND sv.service_id = $3 \
               AND sv.id = $4 AND s.status = 'active'",
        )
        .bind(account_id)
        .bind(project_id)
        .bind(service_id)
        .bind(version_id)
        .fetch_optional(&mut *transaction)
        .await?;
        let Some((secret_id, secret_operation, credential_kind)) = metadata else {
            return Err(ApiError::not_found());
        };
        if !seen_secrets.insert(secret_id) {
            return Err(ApiError::unprocessable(
                "duplicate_secret_definition",
                "a job may bind only one version of each secret",
            ));
        }
        if secret_operation != JOB_OPERATION {
            return Err(ApiError::unprocessable(
                "secret_operation_mismatch",
                "the secret version is not scoped to this job operation",
            ));
        }
        if !matches!(
            credential_kind.as_str(),
            "source_repository_read" | "build_environment"
        ) {
            return Err(ApiError::unprocessable(
                "credential_kind_not_allowed",
                "build bookkeeping cannot bind production or management credentials",
            ));
        }
        resolved_refs.push((secret_id, version_id, credential_kind));
    }

    let job_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO jobs \
         (id, account_id, project_id, service_id, kind, operation, source_commit) \
         VALUES ($1,$2,$3,$4,$5,$6,$7)",
    )
    .bind(job_id)
    .bind(account_id)
    .bind(project_id)
    .bind(service_id)
    .bind(JOB_KIND)
    .bind(JOB_OPERATION)
    .bind(&request.source_commit)
    .execute(&mut *transaction)
    .await?;
    for (secret_id, version_id, credential_kind) in resolved_refs {
        sqlx::query(
            "INSERT INTO job_secret_refs \
             (account_id, project_id, service_id, job_id, secret_id, secret_version_id, operation, credential_kind) \
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        )
        .bind(account_id)
        .bind(project_id)
        .bind(service_id)
        .bind(job_id)
        .bind(secret_id)
        .bind(version_id)
        .bind(JOB_OPERATION)
        .bind(credential_kind)
        .execute(&mut *transaction)
        .await?;
    }
    let response = load_job(&mut transaction, account_id, project_id, job_id).await?;
    intent::audit(
        &mut transaction,
        account_id,
        authenticated.session_id(),
        "job.create",
        "job",
        Some(job_id),
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

async fn get_job(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    Path((project_id, job_id)): Path<(String, String)>,
) -> Result<Json<JobRecord>, ApiError> {
    let account_id = authenticated.account_id()?;
    let project_id = intent::path_uuid(&project_id)?;
    let job_id = intent::path_uuid(&job_id)?;
    let mut transaction = state.pool.begin().await?;
    let response = load_job(&mut transaction, account_id, project_id, job_id).await?;
    transaction.commit().await?;
    Ok(Json(response))
}

async fn cancel_job(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    Path((project_id, job_id)): Path<(String, String)>,
    headers: HeaderMap,
    SafeJson(request): SafeJson<CancelJobRequest>,
) -> Result<Json<JobRecord>, ApiError> {
    let account_id = authenticated.account_id()?;
    let project_id = intent::path_uuid(&project_id)?;
    let job_id = intent::path_uuid(&job_id)?;
    let key = intent::idempotency_key(&headers)?;
    let expected_revision = intent::if_match_revision(&headers)?;
    let hash = intent::request_hash(&request)?;
    let operation = format!("job.cancel/{project_id}/{job_id}");
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
                "job.cancel",
                "job",
                Some(job_id),
                "idempotency_conflict",
            )
            .await?;
            transaction.commit().await?;
            return Err(ApiError::conflict(
                "idempotency_payload_changed",
                "the idempotency key was already used with a different request",
            ));
        }
        Replay::Miss => {}
    }
    let row: Option<(i64, String, Option<Uuid>)> = sqlx::query_as(
        "SELECT revision, state, current_attempt_id FROM jobs \
         WHERE account_id = $1 AND project_id = $2 AND id = $3 FOR UPDATE",
    )
    .bind(account_id)
    .bind(project_id)
    .bind(job_id)
    .fetch_optional(&mut *transaction)
    .await?;
    let (revision, job_state, attempt_id) = row.ok_or_else(ApiError::not_found)?;
    if revision != expected_revision {
        intent::audit(
            &mut transaction,
            account_id,
            authenticated.session_id(),
            "job.cancel",
            "job",
            Some(job_id),
            "stale_revision",
        )
        .await?;
        transaction.commit().await?;
        return Err(ApiError::stale_revision());
    }
    if matches!(job_state.as_str(), "succeeded" | "failed" | "canceled") {
        intent::audit(
            &mut transaction,
            account_id,
            authenticated.session_id(),
            "job.cancel",
            "job",
            Some(job_id),
            "terminal",
        )
        .await?;
        transaction.commit().await?;
        return Err(ApiError::conflict(
            "job_terminal",
            "the job is already terminal",
        ));
    }
    if let Some(attempt_id) = attempt_id {
        sqlx::query(
            "UPDATE job_attempts SET state = 'canceled', finished_at = clock_timestamp(), \
             terminal_code = 'owner_canceled' \
             WHERE account_id = $1 AND project_id = $2 AND job_id = $3 AND id = $4 \
               AND state = 'running'",
        )
        .bind(account_id)
        .bind(project_id)
        .bind(job_id)
        .bind(attempt_id)
        .execute(&mut *transaction)
        .await?;
    }
    sqlx::query(
        "UPDATE jobs SET state = 'canceled', revision = revision + 1, \
         current_attempt_id = NULL, current_fence = current_fence + 1, \
         lease_expires_at = NULL, updated_at = clock_timestamp() \
         WHERE account_id = $1 AND project_id = $2 AND id = $3",
    )
    .bind(account_id)
    .bind(project_id)
    .bind(job_id)
    .execute(&mut *transaction)
    .await?;
    let response = load_job(&mut transaction, account_id, project_id, job_id).await?;
    intent::audit(
        &mut transaction,
        account_id,
        authenticated.session_id(),
        "job.cancel",
        "job",
        Some(job_id),
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

pub async fn reap_expired(pool: &PgPool) -> Result<(), ApiError> {
    for _ in 0..64 {
        let mut transaction = pool.begin().await?;
        let row: Option<(Uuid, Uuid, Uuid, Uuid, i32, i64)> = sqlx::query_as(
            "SELECT id, account_id, project_id, current_attempt_id, attempt_count, current_fence \
             FROM jobs WHERE state = 'running' AND lease_expires_at <= clock_timestamp() \
             ORDER BY lease_expires_at, id FOR UPDATE SKIP LOCKED LIMIT 1",
        )
        .fetch_optional(&mut *transaction)
        .await?;
        let Some((job_id, account_id, project_id, attempt_id, attempt_count, fence)) = row else {
            transaction.commit().await?;
            return Ok(());
        };
        sqlx::query(
            "UPDATE job_attempts SET state = 'expired', finished_at = clock_timestamp(), \
             terminal_code = 'lease_expired' \
             WHERE account_id = $1 AND project_id = $2 AND job_id = $3 AND id = $4 \
               AND fence = $5 AND state = 'running'",
        )
        .bind(account_id)
        .bind(project_id)
        .bind(job_id)
        .bind(attempt_id)
        .bind(fence)
        .execute(&mut *transaction)
        .await?;
        if attempt_count >= 3 {
            sqlx::query(
                "UPDATE jobs SET state = 'failed', revision = revision + 1, \
                 current_attempt_id = NULL, lease_expires_at = NULL, \
                 updated_at = clock_timestamp() \
                 WHERE id = $1 AND account_id = $2 AND project_id = $3",
            )
            .bind(job_id)
            .bind(account_id)
            .bind(project_id)
            .execute(&mut *transaction)
            .await?;
            let completion_hash = Sha256::digest(b"failed:attempts_exhausted");
            sqlx::query(
                "INSERT INTO job_effects \
                 (id, account_id, project_id, job_id, attempt_id, fence, outcome_state, \
                  outcome_code, response_body, completion_hash) \
                 VALUES ($1,$2,$3,$4,$5,$6,'failed','attempts_exhausted', \
                         jsonb_build_object('state','failed','code','attempts_exhausted'),$7) \
                 ON CONFLICT (job_id) DO NOTHING",
            )
            .bind(Uuid::new_v4())
            .bind(account_id)
            .bind(project_id)
            .bind(job_id)
            .bind(attempt_id)
            .bind(fence)
            .bind(completion_hash.as_slice())
            .execute(&mut *transaction)
            .await?;
        } else {
            sqlx::query(
                "UPDATE jobs SET state = 'retriable', revision = revision + 1, \
                 current_attempt_id = NULL, lease_expires_at = NULL, \
                 updated_at = clock_timestamp() \
                 WHERE id = $1 AND account_id = $2 AND project_id = $3",
            )
            .bind(job_id)
            .bind(account_id)
            .bind(project_id)
            .execute(&mut *transaction)
            .await?;
        }
        let worker_id: String = sqlx::query_scalar(
            "SELECT worker_id FROM job_attempts WHERE job_id = $1 AND id = $2 AND fence = $3",
        )
        .bind(job_id)
        .bind(attempt_id)
        .bind(fence)
        .fetch_one(&mut *transaction)
        .await?;
        worker_audit(
            &mut transaction,
            account_id,
            "job.lease_expired",
            WorkerAuditContext {
                job_id,
                worker_id: &worker_id,
                attempt_id,
                fence,
            },
            if attempt_count >= 3 {
                "failed"
            } else {
                "retriable"
            },
        )
        .await?;
        transaction.commit().await?;
    }
    Ok(())
}

async fn lease_job(
    _worker_auth: WorkerAuth,
    State(state): State<FoundationState>,
    SafeJson(request): SafeJson<LeaseRequest>,
) -> Result<Response, ApiError> {
    if !valid_worker_id(&request.worker_id) {
        return Err(ApiError::bad_request(
            "invalid_worker_id",
            "worker_id must contain 1 to 128 visible ASCII characters",
        ));
    }
    if request.kinds.as_slice() != [JOB_KIND] {
        return Err(ApiError::unprocessable(
            "unsupported_job_kind",
            "the M1 worker leases foundation bookkeeping jobs only",
        ));
    }
    reap_expired(&state.pool).await?;
    let mut transaction = state.pool.begin().await?;
    let candidate: Option<(Uuid, Uuid, Uuid, i32, i64)> = sqlx::query_as(
        "SELECT id, account_id, project_id, attempt_count, current_fence \
         FROM jobs WHERE state IN ('queued','retriable') AND attempt_count < max_attempts \
           AND kind = 'foundation_bookkeeping' \
         ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1",
    )
    .fetch_optional(&mut *transaction)
    .await?;
    let Some((job_id, account_id, project_id, old_attempt_count, old_fence)) = candidate else {
        transaction.commit().await?;
        return Ok(StatusCode::NO_CONTENT.into_response());
    };
    let attempt_id = Uuid::new_v4();
    let attempt_number = old_attempt_count + 1;
    let fence = old_fence + 1;
    let lease_expires_at: DateTime<Utc> =
        sqlx::query_scalar("SELECT clock_timestamp() + ($1::bigint * interval '1 second')")
            .bind(state.worker_lease_seconds)
            .fetch_one(&mut *transaction)
            .await?;
    sqlx::query(
        "UPDATE jobs SET state = 'running', revision = revision + 1, \
         attempt_count = $1, current_attempt_id = $2, current_fence = $3, \
         lease_expires_at = $4, updated_at = clock_timestamp() \
         WHERE id = $5 AND account_id = $6 AND project_id = $7",
    )
    .bind(attempt_number)
    .bind(attempt_id)
    .bind(fence)
    .bind(lease_expires_at)
    .bind(job_id)
    .bind(account_id)
    .bind(project_id)
    .execute(&mut *transaction)
    .await?;
    sqlx::query(
        "INSERT INTO job_attempts \
         (id, account_id, project_id, job_id, attempt_number, fence, worker_id, state, \
          lease_started_at, lease_expires_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,'running',clock_timestamp(),$8)",
    )
    .bind(attempt_id)
    .bind(account_id)
    .bind(project_id)
    .bind(job_id)
    .bind(attempt_number)
    .bind(fence)
    .bind(&request.worker_id)
    .bind(lease_expires_at)
    .execute(&mut *transaction)
    .await?;
    let job = load_job(&mut transaction, account_id, project_id, job_id).await?;
    let response = LeaseResponse {
        job,
        attempt: AttemptLease {
            id: attempt_id,
            attempt_number: as_u32(attempt_number)?,
            fence: as_u64(fence)?,
            worker_id: request.worker_id,
            lease_expires_at,
        },
    };
    worker_audit(
        &mut transaction,
        account_id,
        "job.lease",
        WorkerAuditContext {
            job_id,
            worker_id: &response.attempt.worker_id,
            attempt_id,
            fence,
        },
        "succeeded",
    )
    .await?;
    transaction.commit().await?;
    Ok((StatusCode::OK, Json(response)).into_response())
}

fn fenced() -> ApiError {
    ApiError::conflict(
        "job_fenced",
        "the worker no longer owns a live lease for this job",
    )
}

async fn renew_job(
    _worker_auth: WorkerAuth,
    State(state): State<FoundationState>,
    Path(job_id): Path<String>,
    SafeJson(request): SafeJson<LeaseIdentityRequest>,
) -> Result<Json<RenewResponse>, ApiError> {
    let job_id = intent::path_uuid(&job_id)?;
    if !valid_worker_id(&request.worker_id) || request.fence <= 0 {
        return Err(fenced());
    }
    let mut transaction = state.pool.begin().await?;
    let locked: Option<(Uuid, Uuid)> = sqlx::query_as(
        "SELECT j.account_id, j.project_id FROM jobs j \
         JOIN job_attempts a ON a.account_id = j.account_id AND a.project_id = j.project_id \
          AND a.job_id = j.id AND a.id = j.current_attempt_id \
         WHERE j.id = $1 AND j.state = 'running' AND j.current_attempt_id = $2 \
           AND j.current_fence = $3 AND a.worker_id = $4 AND a.state = 'running' \
         FOR UPDATE OF j, a",
    )
    .bind(job_id)
    .bind(request.attempt_id)
    .bind(request.fence)
    .bind(&request.worker_id)
    .fetch_optional(&mut *transaction)
    .await?;
    if locked.is_none() {
        transaction.rollback().await?;
        return Err(fenced());
    }
    let lease_live: bool = sqlx::query_scalar(
        "SELECT COALESCE(j.lease_expires_at > clock_timestamp() \
                AND a.lease_expires_at > clock_timestamp(), false) \
         FROM jobs j JOIN job_attempts a ON a.job_id = j.id AND a.id = j.current_attempt_id \
         WHERE j.id = $1 AND a.id = $2 AND j.current_fence = $3",
    )
    .bind(job_id)
    .bind(request.attempt_id)
    .bind(request.fence)
    .fetch_one(&mut *transaction)
    .await?;
    if !lease_live {
        transaction.rollback().await?;
        return Err(fenced());
    }
    let lease_expires_at: DateTime<Utc> =
        sqlx::query_scalar("SELECT clock_timestamp() + ($1::bigint * interval '1 second')")
            .bind(state.worker_lease_seconds)
            .fetch_one(&mut *transaction)
            .await?;
    sqlx::query(
        "UPDATE jobs SET lease_expires_at = $1, updated_at = clock_timestamp() \
         WHERE id = $2 AND current_attempt_id = $3 AND current_fence = $4",
    )
    .bind(lease_expires_at)
    .bind(job_id)
    .bind(request.attempt_id)
    .bind(request.fence)
    .execute(&mut *transaction)
    .await?;
    sqlx::query(
        "UPDATE job_attempts SET lease_expires_at = $1 \
         WHERE job_id = $2 AND id = $3 AND fence = $4",
    )
    .bind(lease_expires_at)
    .bind(job_id)
    .bind(request.attempt_id)
    .bind(request.fence)
    .execute(&mut *transaction)
    .await?;
    let (account_id, _) = locked.ok_or_else(fenced)?;
    worker_audit(
        &mut transaction,
        account_id,
        "job.renew",
        WorkerAuditContext {
            job_id,
            worker_id: &request.worker_id,
            attempt_id: request.attempt_id,
            fence: request.fence,
        },
        "succeeded",
    )
    .await?;
    transaction.commit().await?;
    Ok(Json(RenewResponse {
        job_id,
        attempt_id: request.attempt_id,
        fence: as_u64(request.fence)?,
        lease_expires_at,
    }))
}

async fn resolve_credentials(
    _worker_auth: WorkerAuth,
    State(state): State<FoundationState>,
    Path(job_id): Path<String>,
    SafeJson(request): SafeJson<ResolveCredentialsRequest>,
) -> Result<Json<ResolveCredentialsResponse>, ApiError> {
    let job_id = intent::path_uuid(&job_id)?;
    if !valid_worker_id(&request.worker_id)
        || request.fence <= 0
        || request.secret_version_ids.len() > MAX_SECRET_REFS
        || request
            .secret_version_ids
            .iter()
            .collect::<HashSet<_>>()
            .len()
            != request.secret_version_ids.len()
    {
        return Err(fenced());
    }
    let secret_key = state
        .secret_key
        .as_deref()
        .ok_or_else(ApiError::foundation_unavailable)?;
    let mut transaction = state.pool.begin().await?;
    let resolved = crate::secrets::resolve_for_locked_live_job(
        &mut transaction,
        secret_key,
        job_id,
        &request.worker_id,
        request.attempt_id,
        request.fence,
        &request.secret_version_ids,
    )
    .await
    .map_err(crate::secrets::SecretResolveError::into_api_error)?;
    let credentials = resolved
        .into_iter()
        .map(|secret| ResolvedCredential {
            secret_version_id: secret.secret_version_id,
            name: secret.name,
            value: SecretResponseValue(secret.value.expose().to_owned()),
        })
        .collect();
    let account_id: Uuid = sqlx::query_scalar("SELECT account_id FROM jobs WHERE id = $1")
        .bind(job_id)
        .fetch_one(&mut *transaction)
        .await?;
    worker_audit(
        &mut transaction,
        account_id,
        "job.credentials_resolve",
        WorkerAuditContext {
            job_id,
            worker_id: &request.worker_id,
            attempt_id: request.attempt_id,
            fence: request.fence,
        },
        "succeeded",
    )
    .await?;
    transaction.commit().await?;
    Ok(Json(ResolveCredentialsResponse { credentials }))
}

async fn complete_job(
    _worker_auth: WorkerAuth,
    State(state): State<FoundationState>,
    Path(job_id): Path<String>,
    SafeJson(request): SafeJson<CompleteRequest>,
) -> Result<Json<CompleteResponse>, ApiError> {
    let job_id = intent::path_uuid(&job_id)?;
    if !valid_worker_id(&request.worker_id)
        || request.fence <= 0
        || !valid_outcome(&request.outcome)
    {
        return Err(ApiError::bad_request(
            "invalid_completion",
            "the completion outcome is not supported",
        ));
    }
    let completion_hash = intent::request_hash(&request)?;
    let mut transaction = state.pool.begin().await?;
    let job: Option<(Uuid, Uuid, String, Option<Uuid>, i64, i32)> = sqlx::query_as(
        "SELECT account_id, project_id, state, current_attempt_id, current_fence, attempt_count \
         FROM jobs WHERE id = $1 FOR UPDATE",
    )
    .bind(job_id)
    .fetch_optional(&mut *transaction)
    .await?;
    let Some((account_id, project_id, job_state, current_attempt_id, current_fence, attempt_count)) =
        job
    else {
        transaction.rollback().await?;
        return Err(fenced());
    };

    if job_state == "retriable" && current_fence == request.fence {
        let prior: Option<(String, Vec<u8>)> = sqlx::query_as(
            "SELECT worker_id, completion_hash FROM job_attempts \
             WHERE account_id = $1 AND project_id = $2 AND job_id = $3 \
               AND id = $4 AND fence = $5 AND state = 'retriable'",
        )
        .bind(account_id)
        .bind(project_id)
        .bind(job_id)
        .bind(request.attempt_id)
        .bind(request.fence)
        .fetch_optional(&mut *transaction)
        .await?;
        let Some((worker_id, stored_hash)) = prior else {
            transaction.rollback().await?;
            return Err(fenced());
        };
        if worker_id != request.worker_id || stored_hash != completion_hash {
            transaction.rollback().await?;
            return Err(ApiError::conflict(
                "completion_conflict",
                "the retry completion was already committed with another outcome",
            ));
        }
        let job = load_job(&mut transaction, account_id, project_id, job_id).await?;
        transaction.commit().await?;
        return Ok(Json(CompleteResponse { job, effect: None }));
    }

    if matches!(job_state.as_str(), "succeeded" | "failed")
        && current_attempt_id == Some(request.attempt_id)
        && current_fence == request.fence
    {
        let prior: Option<(String, Vec<u8>, serde_json::Value)> = sqlx::query_as(
            "SELECT a.worker_id, e.completion_hash, e.response_body \
             FROM job_attempts a JOIN job_effects e \
               ON e.account_id = a.account_id AND e.project_id = a.project_id \
              AND e.job_id = a.job_id AND e.attempt_id = a.id AND e.fence = a.fence \
             WHERE a.account_id = $1 AND a.project_id = $2 AND a.job_id = $3 \
               AND a.id = $4 AND a.fence = $5",
        )
        .bind(account_id)
        .bind(project_id)
        .bind(job_id)
        .bind(request.attempt_id)
        .bind(request.fence)
        .fetch_optional(&mut *transaction)
        .await?;
        let Some((worker_id, stored_hash, body)) = prior else {
            transaction.rollback().await?;
            return Err(fenced());
        };
        if worker_id != request.worker_id || stored_hash != completion_hash {
            transaction.rollback().await?;
            return Err(ApiError::conflict(
                "completion_conflict",
                "the terminal completion was already committed with another outcome",
            ));
        }
        let response = serde_json::from_value(body).map_err(|_| ApiError::internal())?;
        transaction.commit().await?;
        return Ok(Json(response));
    }

    let locked_attempt: Option<(DateTime<Utc>, DateTime<Utc>)> = sqlx::query_as(
        "SELECT j.lease_expires_at, a.lease_expires_at \
         FROM jobs j JOIN job_attempts a \
           ON a.account_id = j.account_id AND a.project_id = j.project_id \
          AND a.job_id = j.id AND a.id = j.current_attempt_id \
         WHERE j.id = $1 AND j.state = 'running' AND j.current_attempt_id = $2 \
           AND j.current_fence = $3 AND a.worker_id = $4 AND a.state = 'running' \
         FOR UPDATE OF a",
    )
    .bind(job_id)
    .bind(request.attempt_id)
    .bind(request.fence)
    .bind(&request.worker_id)
    .fetch_optional(&mut *transaction)
    .await?;
    if locked_attempt.is_none() {
        transaction.rollback().await?;
        return Err(fenced());
    }
    let lease_live: bool = sqlx::query_scalar(
        "SELECT COALESCE(j.lease_expires_at > clock_timestamp() \
                AND a.lease_expires_at > clock_timestamp(), false) \
         FROM jobs j JOIN job_attempts a ON a.job_id = j.id AND a.id = j.current_attempt_id \
         WHERE j.id = $1 AND a.id = $2 AND j.current_fence = $3",
    )
    .bind(job_id)
    .bind(request.attempt_id)
    .bind(request.fence)
    .fetch_one(&mut *transaction)
    .await?;
    if !lease_live {
        transaction.rollback().await?;
        return Err(fenced());
    }

    let exhausted = request.outcome.state == "retriable" && attempt_count >= 3;
    let effective_state = if exhausted {
        "failed"
    } else {
        request.outcome.state.as_str()
    };
    let effective_code = if exhausted {
        "attempts_exhausted"
    } else {
        request.outcome.code.as_str()
    };
    sqlx::query(
        "UPDATE job_attempts SET state = $1, finished_at = clock_timestamp(), \
         terminal_code = $2, completion_hash = $3 \
         WHERE account_id = $4 AND project_id = $5 AND job_id = $6 AND id = $7 \
           AND fence = $8 AND state = 'running'",
    )
    .bind(effective_state)
    .bind(effective_code)
    .bind(&completion_hash)
    .bind(account_id)
    .bind(project_id)
    .bind(job_id)
    .bind(request.attempt_id)
    .bind(request.fence)
    .execute(&mut *transaction)
    .await?;
    let terminal = effective_state != "retriable";
    sqlx::query(
        "UPDATE jobs SET state = $1, revision = revision + 1, \
         current_attempt_id = CASE WHEN $2 THEN current_attempt_id ELSE NULL END, \
         lease_expires_at = NULL, updated_at = clock_timestamp() \
         WHERE id = $3 AND account_id = $4 AND project_id = $5",
    )
    .bind(effective_state)
    .bind(terminal)
    .bind(job_id)
    .bind(account_id)
    .bind(project_id)
    .execute(&mut *transaction)
    .await?;
    let job = load_job(&mut transaction, account_id, project_id, job_id).await?;
    let effect = terminal.then(|| JobEffectResponse {
        id: Uuid::new_v4(),
        outcome_state: effective_state.to_owned(),
        outcome_code: effective_code.to_owned(),
    });
    let response = CompleteResponse { job, effect };
    if let Some(effect) = &response.effect {
        let body = serde_json::to_value(&response).map_err(|_| ApiError::internal())?;
        sqlx::query(
            "INSERT INTO job_effects \
             (id, account_id, project_id, job_id, attempt_id, fence, outcome_state, \
              outcome_code, response_body, completion_hash) \
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        )
        .bind(effect.id)
        .bind(account_id)
        .bind(project_id)
        .bind(job_id)
        .bind(request.attempt_id)
        .bind(request.fence)
        .bind(&effect.outcome_state)
        .bind(&effect.outcome_code)
        .bind(body)
        .bind(&completion_hash)
        .execute(&mut *transaction)
        .await?;
    }
    worker_audit(
        &mut transaction,
        account_id,
        "job.complete",
        WorkerAuditContext {
            job_id,
            worker_id: &request.worker_id,
            attempt_id: request.attempt_id,
            fence: request.fence,
        },
        effective_state,
    )
    .await?;
    transaction.commit().await?;
    Ok(Json(response))
}
