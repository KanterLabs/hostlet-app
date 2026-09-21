use std::collections::{HashMap, HashSet};

use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use hostlet_contracts::project::{AccountId, ProjectId, ServiceId};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;
use zeroize::Zeroize;

use crate::{
    auth::Authenticated,
    crypto::SecretKey,
    error::{ApiError, SafeJson},
    foundation::FoundationState,
    intent::{self, Replay},
};

const CREATE_SECRET_OPERATION: &str = "secret.create";
const CREATE_VERSION_OPERATION: &str = "secret.version.create";
const SECRET_AAD_DOMAIN: &[u8] = b"hostlet-secret/v1";
const SECRET_REPLAY_DOMAIN: &[u8] = b"hostlet-secret-replay/v1";
const MAX_SECRET_VALUE_BYTES: usize = 16_384;
const MAX_JOB_SECRET_REFS: usize = 32;

type SecretRow = (
    Uuid,
    Uuid,
    Uuid,
    Uuid,
    String,
    String,
    String,
    String,
    i64,
    DateTime<Utc>,
);

type SecretVersionRow = (Uuid, Uuid, i64, DateTime<Utc>);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SecretMetadata {
    id: Uuid,
    owner_account_id: AccountId,
    project_id: ProjectId,
    service_id: ServiceId,
    name: String,
    operation: String,
    credential_kind: String,
    status: String,
    revision: u64,
    created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SecretVersionMetadata {
    id: Uuid,
    secret_id: Uuid,
    version: u64,
    created_at: DateTime<Utc>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateSecretRequest {
    name: String,
    operation: String,
    credential_kind: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateSecretVersionRequest {
    value: SecretValue,
}

pub(crate) struct SecretValue(String);

impl SecretValue {
    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for SecretValue {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        String::deserialize(deserializer).map(Self)
    }
}

impl Drop for SecretValue {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

pub(crate) struct ResolvedJobSecret {
    pub secret_version_id: Uuid,
    pub name: String,
    pub value: SecretValue,
}

pub(crate) enum SecretResolveError {
    Fenced,
    ScopeDenied,
    CredentialKindNotAllowed,
    Unavailable,
}

impl SecretResolveError {
    pub(crate) fn into_api_error(self) -> ApiError {
        match self {
            Self::Fenced => ApiError::conflict("job_fenced", "the job lease is no longer current"),
            Self::ScopeDenied => ApiError::not_found(),
            Self::CredentialKindNotAllowed => ApiError::unprocessable(
                "credential_kind_not_allowed",
                "the credential kind is not available to this operation",
            ),
            Self::Unavailable => ApiError::foundation_unavailable(),
        }
    }
}

pub fn routes() -> Router<FoundationState> {
    Router::new()
        .route(
            "/v1/projects/{project_id}/services/{service_id}/secrets",
            post(create_secret),
        )
        .route(
            "/v1/projects/{project_id}/services/{service_id}/secrets/{secret_id}",
            get(get_secret),
        )
        .route(
            "/v1/projects/{project_id}/services/{service_id}/secrets/{secret_id}/versions",
            post(create_secret_version),
        )
        .route(
            "/v1/projects/{project_id}/services/{service_id}/secrets/{secret_id}/versions/{version_id}",
            get(get_secret_version),
        )
}

pub async fn check_keyring(pool: &PgPool, key: &SecretKey) -> Result<(), ApiError> {
    let mismatch: bool = sqlx::query_scalar(
        "SELECT EXISTS (\
             SELECT 1 FROM secret_versions WHERE key_version <> $1 \
             UNION ALL \
             SELECT 1 FROM idempotency_records \
             WHERE (request_key_version IS NOT NULL AND request_key_version <> $1) \
                OR (operation LIKE 'secret.version.create/%' \
                    AND request_key_version IS NULL)\
         )",
    )
    .bind(key.key_version())
    .fetch_one(pool)
    .await
    .map_err(ApiError::from)?;
    if mismatch {
        Err(ApiError::foundation_unavailable())
    } else {
        Ok(())
    }
}

fn validate_secret_request(request: &CreateSecretRequest) -> Result<(), ApiError> {
    if request.name.trim().is_empty()
        || request.name.len() > 128
        || request.name.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err(ApiError::unprocessable(
            "invalid_secret",
            "secret name must contain 1 to 128 non-control bytes",
        ));
    }
    if !matches!(
        request.operation.as_str(),
        "build" | "runtime" | "database_migration" | "platform_management"
    ) {
        return Err(ApiError::unprocessable(
            "invalid_secret",
            "the secret operation is unsupported",
        ));
    }
    if !matches!(
        request.credential_kind.as_str(),
        "source_repository_read"
            | "build_environment"
            | "production_database"
            | "platform_management"
    ) {
        return Err(ApiError::unprocessable(
            "invalid_secret",
            "the credential kind is unsupported",
        ));
    }
    Ok(())
}

fn validate_secret_value(value: &SecretValue) -> Result<(), ApiError> {
    if value.0.is_empty() || value.0.len() > MAX_SECRET_VALUE_BYTES {
        return Err(ApiError::unprocessable(
            "invalid_secret",
            "secret value must contain 1 to 16384 UTF-8 bytes",
        ));
    }
    Ok(())
}

fn as_u64(value: i64) -> Result<u64, ApiError> {
    u64::try_from(value).map_err(|_| ApiError::internal())
}

fn metadata(row: SecretRow) -> Result<SecretMetadata, ApiError> {
    let (
        id,
        account_id,
        project_id,
        service_id,
        name,
        operation,
        credential_kind,
        status,
        revision,
        created_at,
    ) = row;
    Ok(SecretMetadata {
        id,
        owner_account_id: AccountId(account_id.to_string()),
        project_id: ProjectId(project_id.to_string()),
        service_id: ServiceId(service_id.to_string()),
        name,
        operation,
        credential_kind,
        status,
        revision: as_u64(revision)?,
        created_at,
    })
}

fn version_metadata(row: SecretVersionRow) -> Result<SecretVersionMetadata, ApiError> {
    let (id, secret_id, version, created_at) = row;
    Ok(SecretVersionMetadata {
        id,
        secret_id,
        version: as_u64(version)?,
        created_at,
    })
}

async fn load_secret(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    project_id: Uuid,
    service_id: Uuid,
    secret_id: Uuid,
) -> Result<Option<SecretMetadata>, ApiError> {
    let row: Option<SecretRow> = sqlx::query_as(
        "SELECT id, account_id, project_id, service_id, name, operation, \
                credential_kind, status, revision, created_at \
         FROM secrets WHERE account_id = $1 AND project_id = $2 \
           AND service_id = $3 AND id = $4",
    )
    .bind(account_id)
    .bind(project_id)
    .bind(service_id)
    .bind(secret_id)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(ApiError::from)?;
    row.map(metadata).transpose()
}

async fn create_secret(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    Path((project_id, service_id)): Path<(String, String)>,
    headers: HeaderMap,
    SafeJson(request): SafeJson<CreateSecretRequest>,
) -> Result<(StatusCode, Json<SecretMetadata>), ApiError> {
    validate_secret_request(&request)?;
    let account_id = authenticated.account_id()?;
    let project_id = intent::path_uuid(&project_id)?;
    let service_id = intent::path_uuid(&service_id)?;
    let key = intent::idempotency_key(&headers)?;
    let request_hash = intent::request_hash(&request)?;
    let operation = format!("{CREATE_SECRET_OPERATION}/{project_id}/{service_id}");
    let mut transaction = state.pool.begin().await.map_err(ApiError::from)?;
    intent::acquire_operation_lock(&mut transaction, account_id, &operation, key).await?;
    let replay: Replay<SecretMetadata> =
        intent::replay(&mut transaction, account_id, &operation, key, &request_hash).await?;
    match replay {
        Replay::Match(response) => {
            transaction.commit().await.map_err(ApiError::from)?;
            return Ok((StatusCode::CREATED, Json(response)));
        }
        Replay::Changed => {
            intent::audit(
                &mut transaction,
                account_id,
                authenticated.session_id(),
                CREATE_SECRET_OPERATION,
                "secret",
                None,
                "idempotency_conflict",
            )
            .await?;
            transaction.commit().await.map_err(ApiError::from)?;
            return Err(ApiError::conflict(
                "idempotency_payload_changed",
                "the idempotency key was already used with a different request",
            ));
        }
        Replay::Miss => {}
    }

    let service_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM services \
         WHERE account_id = $1 AND project_id = $2 AND id = $3)",
    )
    .bind(account_id)
    .bind(project_id)
    .bind(service_id)
    .fetch_one(&mut *transaction)
    .await
    .map_err(ApiError::from)?;
    if !service_exists {
        intent::audit(
            &mut transaction,
            account_id,
            authenticated.session_id(),
            CREATE_SECRET_OPERATION,
            "secret",
            None,
            "denied",
        )
        .await?;
        transaction.commit().await.map_err(ApiError::from)?;
        return Err(ApiError::not_found());
    }

    let secret_id = Uuid::new_v4();
    let row: Result<SecretRow, sqlx::Error> = sqlx::query_as(
        "INSERT INTO secrets \
         (id, account_id, project_id, service_id, name, operation, credential_kind) \
         VALUES ($1,$2,$3,$4,$5,$6,$7) \
         RETURNING id, account_id, project_id, service_id, name, operation, \
                   credential_kind, status, revision, created_at",
    )
    .bind(secret_id)
    .bind(account_id)
    .bind(project_id)
    .bind(service_id)
    .bind(request.name.trim())
    .bind(&request.operation)
    .bind(&request.credential_kind)
    .fetch_one(&mut *transaction)
    .await;
    let row = match row {
        Ok(row) => row,
        Err(error)
            if error
                .as_database_error()
                .is_some_and(|db| db.is_unique_violation()) =>
        {
            return Err(ApiError::conflict(
                "secret_already_exists",
                "a secret with this scope and name already exists",
            ));
        }
        Err(error) => return Err(ApiError::from(error)),
    };
    let response = metadata(row)?;
    intent::audit(
        &mut transaction,
        account_id,
        authenticated.session_id(),
        CREATE_SECRET_OPERATION,
        "secret",
        Some(secret_id),
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
    transaction.commit().await.map_err(ApiError::from)?;
    Ok((StatusCode::CREATED, Json(response)))
}

async fn get_secret(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    Path((project_id, service_id, secret_id)): Path<(String, String, String)>,
) -> Result<Json<SecretMetadata>, ApiError> {
    let account_id = authenticated.account_id()?;
    let project_id = intent::path_uuid(&project_id)?;
    let service_id = intent::path_uuid(&service_id)?;
    let secret_id = intent::path_uuid(&secret_id)?;
    let mut transaction = state.pool.begin().await.map_err(ApiError::from)?;
    let response = load_secret(
        &mut transaction,
        account_id,
        project_id,
        service_id,
        secret_id,
    )
    .await?
    .ok_or_else(ApiError::not_found)?;
    transaction.commit().await.map_err(ApiError::from)?;
    Ok(Json(response))
}

fn append_field(output: &mut Vec<u8>, value: &[u8]) {
    let length = u32::try_from(value.len()).unwrap_or(u32::MAX);
    output.extend_from_slice(&length.to_be_bytes());
    output.extend_from_slice(value);
}

fn secret_aad(
    account_id: Uuid,
    project_id: Uuid,
    service_id: Uuid,
    operation: &str,
    credential_kind: &str,
    secret_id: Uuid,
    version_id: Uuid,
) -> Vec<u8> {
    let mut output = Vec::with_capacity(192);
    append_field(&mut output, SECRET_AAD_DOMAIN);
    append_field(&mut output, account_id.as_bytes());
    append_field(&mut output, project_id.as_bytes());
    append_field(&mut output, service_id.as_bytes());
    append_field(&mut output, operation.as_bytes());
    append_field(&mut output, credential_kind.as_bytes());
    append_field(&mut output, secret_id.as_bytes());
    append_field(&mut output, version_id.as_bytes());
    output
}

fn version_request_bytes(
    account_id: Uuid,
    project_id: Uuid,
    service_id: Uuid,
    secret_id: Uuid,
    value: &SecretValue,
) -> Vec<u8> {
    let mut output = Vec::with_capacity(value.0.len() + 128);
    append_field(&mut output, SECRET_REPLAY_DOMAIN);
    append_field(&mut output, account_id.as_bytes());
    append_field(&mut output, project_id.as_bytes());
    append_field(&mut output, service_id.as_bytes());
    append_field(&mut output, secret_id.as_bytes());
    append_field(&mut output, value.0.as_bytes());
    output
}

async fn secret_replay(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    operation: &str,
    key: &str,
    fingerprint: &[u8],
    key_version: &str,
) -> Result<Replay<SecretVersionMetadata>, ApiError> {
    let row: Option<(Vec<u8>, Option<String>, Value)> = sqlx::query_as(
        "SELECT request_hash, request_key_version, response_body \
         FROM idempotency_records \
         WHERE actor_account_id = $1 AND operation = $2 AND key = $3",
    )
    .bind(account_id)
    .bind(operation)
    .bind(key)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(ApiError::from)?;
    match row {
        None => Ok(Replay::Miss),
        Some((_, None, _)) => Err(ApiError::foundation_unavailable()),
        Some((_, Some(stored_key_version), _)) if stored_key_version != key_version => {
            Err(ApiError::foundation_unavailable())
        }
        Some((stored, _, _)) if stored != fingerprint => Ok(Replay::Changed),
        Some((_, _, body)) => serde_json::from_value(body)
            .map(Replay::Match)
            .map_err(|_| ApiError::internal()),
    }
}

async fn store_secret_replay(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    operation: &str,
    idempotency_key: &str,
    fingerprint: &[u8],
    key_version: &str,
    response: &SecretVersionMetadata,
) -> Result<(), ApiError> {
    let body = serde_json::to_value(response).map_err(|_| ApiError::internal())?;
    sqlx::query(
        "INSERT INTO idempotency_records \
         (actor_account_id, operation, key, request_hash, request_key_version, \
          response_status, response_body) VALUES ($1,$2,$3,$4,$5,201,$6)",
    )
    .bind(account_id)
    .bind(operation)
    .bind(idempotency_key)
    .bind(fingerprint)
    .bind(key_version)
    .bind(body)
    .execute(&mut **transaction)
    .await
    .map_err(ApiError::from)?;
    Ok(())
}

async fn create_secret_version(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    Path((project_id, service_id, secret_id)): Path<(String, String, String)>,
    headers: HeaderMap,
    SafeJson(request): SafeJson<CreateSecretVersionRequest>,
) -> Result<(StatusCode, Json<SecretVersionMetadata>), ApiError> {
    validate_secret_value(&request.value)?;
    let account_id = authenticated.account_id()?;
    let project_id = intent::path_uuid(&project_id)?;
    let service_id = intent::path_uuid(&service_id)?;
    let secret_id = intent::path_uuid(&secret_id)?;
    let idempotency_key = intent::idempotency_key(&headers)?;
    let expected_revision = intent::if_match_revision(&headers)?;
    let secret_key = state
        .secret_key
        .as_deref()
        .ok_or_else(ApiError::foundation_unavailable)?;
    let mut canonical_request = version_request_bytes(
        account_id,
        project_id,
        service_id,
        secret_id,
        &request.value,
    );
    let fingerprint = secret_key.replay_fingerprint(&canonical_request);
    canonical_request.zeroize();
    let operation = format!("{CREATE_VERSION_OPERATION}/{secret_id}");
    let mut transaction = state.pool.begin().await.map_err(ApiError::from)?;
    intent::acquire_operation_lock(&mut transaction, account_id, &operation, idempotency_key)
        .await?;
    match secret_replay(
        &mut transaction,
        account_id,
        &operation,
        idempotency_key,
        &fingerprint,
        secret_key.key_version(),
    )
    .await?
    {
        Replay::Match(response) => {
            transaction.commit().await.map_err(ApiError::from)?;
            return Ok((StatusCode::CREATED, Json(response)));
        }
        Replay::Changed => {
            intent::audit(
                &mut transaction,
                account_id,
                authenticated.session_id(),
                CREATE_VERSION_OPERATION,
                "secret_version",
                None,
                "idempotency_conflict",
            )
            .await?;
            transaction.commit().await.map_err(ApiError::from)?;
            return Err(ApiError::conflict(
                "idempotency_payload_changed",
                "the idempotency key was already used with a different request",
            ));
        }
        Replay::Miss => {}
    }

    let row: Option<(String, String, i64)> = sqlx::query_as(
        "SELECT operation, credential_kind, revision FROM secrets \
         WHERE account_id = $1 AND project_id = $2 AND service_id = $3 AND id = $4 \
           AND status = 'active' \
         FOR UPDATE",
    )
    .bind(account_id)
    .bind(project_id)
    .bind(service_id)
    .bind(secret_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(ApiError::from)?;
    let Some((secret_operation, credential_kind, revision)) = row else {
        intent::audit(
            &mut transaction,
            account_id,
            authenticated.session_id(),
            CREATE_VERSION_OPERATION,
            "secret_version",
            None,
            "denied",
        )
        .await?;
        transaction.commit().await.map_err(ApiError::from)?;
        return Err(ApiError::not_found());
    };
    if revision != expected_revision {
        intent::audit(
            &mut transaction,
            account_id,
            authenticated.session_id(),
            CREATE_VERSION_OPERATION,
            "secret_version",
            None,
            "stale_revision",
        )
        .await?;
        transaction.commit().await.map_err(ApiError::from)?;
        return Err(ApiError::stale_revision());
    }

    let next_version: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(version_number), 0) + 1 \
         FROM secret_versions WHERE secret_id = $1",
    )
    .bind(secret_id)
    .fetch_one(&mut *transaction)
    .await
    .map_err(ApiError::from)?;
    let version_id = Uuid::new_v4();
    let aad = secret_aad(
        account_id,
        project_id,
        service_id,
        &secret_operation,
        &credential_kind,
        secret_id,
        version_id,
    );
    let encrypted = secret_key
        .encrypt(&aad, request.value.0.as_bytes())
        .map_err(|_| ApiError::foundation_unavailable())?;
    let row: SecretVersionRow = sqlx::query_as(
        "INSERT INTO secret_versions \
         (id, account_id, project_id, service_id, secret_id, version_number, \
          key_version, nonce, ciphertext, auth_tag) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) \
         RETURNING id, secret_id, version_number, created_at",
    )
    .bind(version_id)
    .bind(account_id)
    .bind(project_id)
    .bind(service_id)
    .bind(secret_id)
    .bind(next_version)
    .bind(secret_key.key_version())
    .bind(encrypted.nonce.as_slice())
    .bind(&encrypted.ciphertext)
    .bind(encrypted.auth_tag.as_slice())
    .fetch_one(&mut *transaction)
    .await
    .map_err(ApiError::from)?;
    sqlx::query(
        "UPDATE secrets SET revision = revision + 1, updated_at = transaction_timestamp() \
         WHERE account_id = $1 AND project_id = $2 AND service_id = $3 AND id = $4",
    )
    .bind(account_id)
    .bind(project_id)
    .bind(service_id)
    .bind(secret_id)
    .execute(&mut *transaction)
    .await
    .map_err(ApiError::from)?;
    let response = version_metadata(row)?;
    intent::audit(
        &mut transaction,
        account_id,
        authenticated.session_id(),
        CREATE_VERSION_OPERATION,
        "secret_version",
        Some(version_id),
        "succeeded",
    )
    .await?;
    store_secret_replay(
        &mut transaction,
        account_id,
        &operation,
        idempotency_key,
        &fingerprint,
        secret_key.key_version(),
        &response,
    )
    .await?;
    transaction.commit().await.map_err(ApiError::from)?;
    Ok((StatusCode::CREATED, Json(response)))
}

async fn get_secret_version(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    Path((project_id, service_id, secret_id, version_id)): Path<(String, String, String, String)>,
) -> Result<Json<SecretVersionMetadata>, ApiError> {
    let account_id = authenticated.account_id()?;
    let project_id = intent::path_uuid(&project_id)?;
    let service_id = intent::path_uuid(&service_id)?;
    let secret_id = intent::path_uuid(&secret_id)?;
    let version_id = intent::path_uuid(&version_id)?;
    let row: Option<SecretVersionRow> = sqlx::query_as(
        "SELECT id, secret_id, version_number, created_at FROM secret_versions \
         WHERE account_id = $1 AND project_id = $2 AND service_id = $3 \
           AND secret_id = $4 AND id = $5",
    )
    .bind(account_id)
    .bind(project_id)
    .bind(service_id)
    .bind(secret_id)
    .bind(version_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(ApiError::from)?;
    Ok(Json(version_metadata(
        row.ok_or_else(ApiError::not_found)?,
    )?))
}

pub(crate) async fn resolve_for_locked_live_job(
    transaction: &mut Transaction<'_, Postgres>,
    key: &SecretKey,
    job_id: Uuid,
    worker_id: &str,
    attempt_id: Uuid,
    fence: i64,
    requested_version_ids: &[Uuid],
) -> Result<Vec<ResolvedJobSecret>, SecretResolveError> {
    if requested_version_ids.len() > MAX_JOB_SECRET_REFS
        || requested_version_ids.iter().collect::<HashSet<_>>().len() != requested_version_ids.len()
    {
        return Err(SecretResolveError::ScopeDenied);
    }
    let locked_job: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM jobs WHERE id = $1 FOR UPDATE")
            .bind(job_id)
            .fetch_optional(&mut **transaction)
            .await
            .map_err(|_| SecretResolveError::Unavailable)?;
    if locked_job.is_none() {
        return Err(SecretResolveError::Fenced);
    }
    let scope: Option<(Uuid, Uuid, Uuid, String)> = sqlx::query_as(
        "SELECT j.account_id, j.project_id, j.service_id, j.operation \
         FROM jobs j JOIN job_attempts a \
           ON a.account_id = j.account_id AND a.project_id = j.project_id \
          AND a.job_id = j.id AND a.id = j.current_attempt_id \
         WHERE j.id = $1 AND j.current_attempt_id = $2 AND j.current_fence = $3 \
           AND j.state = 'running' AND a.state = 'running' AND a.fence = $3 \
           AND a.worker_id = $4 AND j.lease_expires_at > clock_timestamp() \
           AND a.lease_expires_at > clock_timestamp()",
    )
    .bind(job_id)
    .bind(attempt_id)
    .bind(fence)
    .bind(worker_id)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(|_| SecretResolveError::Unavailable)?;
    let Some((account_id, project_id, service_id, job_operation)) = scope else {
        return Err(SecretResolveError::Fenced);
    };
    if requested_version_ids.is_empty() {
        return Ok(Vec::new());
    }

    type ResolveRow = (
        Uuid,
        Uuid,
        String,
        String,
        String,
        String,
        Vec<u8>,
        Vec<u8>,
        Vec<u8>,
    );
    let rows: Vec<ResolveRow> = sqlx::query_as(
        "SELECT sv.id, sv.secret_id, s.name, s.operation, s.credential_kind, \
                sv.key_version, sv.nonce, sv.ciphertext, sv.auth_tag \
         FROM job_secret_refs r \
         JOIN secrets s ON s.account_id = r.account_id AND s.project_id = r.project_id \
          AND s.service_id = r.service_id AND s.id = r.secret_id \
          AND s.operation = r.operation AND s.credential_kind = r.credential_kind \
         JOIN secret_versions sv ON sv.account_id = r.account_id \
          AND sv.project_id = r.project_id AND sv.service_id = r.service_id \
          AND sv.secret_id = r.secret_id AND sv.id = r.secret_version_id \
         WHERE r.job_id = $1 AND r.account_id = $2 AND r.project_id = $3 \
           AND r.service_id = $4 AND r.operation = $5 AND s.status = 'active' \
           AND r.secret_version_id = ANY($6)",
    )
    .bind(job_id)
    .bind(account_id)
    .bind(project_id)
    .bind(service_id)
    .bind(&job_operation)
    .bind(requested_version_ids)
    .fetch_all(&mut **transaction)
    .await
    .map_err(|_| SecretResolveError::Unavailable)?;
    if rows.len() != requested_version_ids.len() {
        return Err(SecretResolveError::ScopeDenied);
    }

    let mut resolved = HashMap::with_capacity(rows.len());
    for (
        version_id,
        secret_id,
        name,
        operation,
        credential_kind,
        key_version,
        nonce,
        ciphertext,
        auth_tag,
    ) in rows
    {
        if operation != "build" || job_operation != "build" {
            return Err(SecretResolveError::CredentialKindNotAllowed);
        }
        if !matches!(
            credential_kind.as_str(),
            "source_repository_read" | "build_environment"
        ) {
            return Err(SecretResolveError::CredentialKindNotAllowed);
        }
        if key_version != key.key_version() {
            return Err(SecretResolveError::Unavailable);
        }
        let aad = secret_aad(
            account_id,
            project_id,
            service_id,
            &operation,
            &credential_kind,
            secret_id,
            version_id,
        );
        let plaintext = key
            .decrypt(&aad, &nonce, &ciphertext, &auth_tag)
            .map_err(|_| SecretResolveError::Unavailable)?;
        let value = match String::from_utf8(plaintext) {
            Ok(value) => value,
            Err(error) => {
                let mut plaintext = error.into_bytes();
                plaintext.zeroize();
                return Err(SecretResolveError::Unavailable);
            }
        };
        resolved.insert(
            version_id,
            ResolvedJobSecret {
                secret_version_id: version_id,
                name,
                value: SecretValue(value),
            },
        );
    }

    requested_version_ids
        .iter()
        .map(|version_id| {
            resolved
                .remove(version_id)
                .ok_or(SecretResolveError::ScopeDenied)
        })
        .collect()
}
