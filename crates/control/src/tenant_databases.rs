//! HOST-223 durable tenant PostgreSQL control boundary.
//!
//! This module records owned intent and safe receipts. The separately enrolled
//! database worker performs PostgreSQL and archive operations. Owner input never
//! supplies SQL, database names, role names, object paths, or network targets.

use std::collections::{BTreeSet, HashSet};

use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Datelike, Duration, NaiveDate, Utc};
use rand::{RngCore, rngs::OsRng};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgPool, Postgres, Transaction};
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

use crate::{
    auth::Authenticated,
    error::{ApiError, SafeJson},
    foundation::FoundationState,
    intent::{self, Replay},
    m3::{self, DatabaseWorkerAuth},
};

const CREATE_DATABASE_OPERATION: &str = "tenant_database.create";
const CREATE_EXPORT_OPERATION: &str = "tenant_database.export.create";
const CREATE_RECOVERY_OPERATION: &str = "tenant_database.recovery.create";
const GRANT_PLAN_VERSION: &str = "hostlet.tenant-grants/v1";
const ARCHIVE_FORMAT: &str = "hostlet.tenant-backup/v1";
const APPLICATION_CONNECTION_LIMIT: i32 = 10;
const STORAGE_LIMIT_BYTES: i64 = 1024 * 1024 * 1024;
const OWNED_MIGRATION_ENTRIES: [&str; 2] = [
    "dist/migrations/002_additive_client_compatibility.sql",
    "dist/migrations/003_destructive.sql",
];
const EXPORT_TTL_HOURS: i64 = 24;
const BACKUP_RETENTION_DAYS: i64 = 7;
const MAX_WORKER_KINDS: usize = 16;
const MAX_CREDENTIAL_IDS: usize = 8;

const OPERATION_KINDS: &[&str] = &[
    "provision",
    "backup_daily",
    "backup_pre_migration",
    "export",
    "restore_drill",
    "observe_storage",
    "migration_trial",
    "migration_live_apply",
    "archive_expire",
];

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TenantDatabaseRecord {
    pub id: Uuid,
    pub project_id: Uuid,
    pub service_id: Uuid,
    pub configuration_revision_id: Uuid,
    pub first_deployment_id: Uuid,
    pub reservation_id: Uuid,
    pub reservation_epoch: Uuid,
    pub generation: Uuid,
    pub state: String,
    pub postgres_major: u16,
    pub application_connection_limit: u32,
    pub storage_limit_bytes: u64,
    pub source_data_generation: u64,
    pub growth_mode: String,
    pub measured_storage_bytes: Option<u64>,
    pub storage_observed_at: Option<DateTime<Utc>>,
    pub revision: u64,
    pub last_error_code: Option<String>,
    pub last_usable_backup_at: Option<DateTime<Utc>>,
    pub last_successful_drill_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub ready_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArchiveRecord {
    pub id: Uuid,
    pub tenant_database_id: Uuid,
    pub database_generation: Uuid,
    pub kind: String,
    pub state: String,
    pub scheduled_for: Option<NaiveDate>,
    pub intended_migration_revision: Option<String>,
    pub source_data_generation: u64,
    pub snapshot_at: Option<DateTime<Utc>>,
    pub verified_at: Option<DateTime<Utc>>,
    pub expires_at: DateTime<Utc>,
    pub plaintext_sha256: Option<String>,
    pub plaintext_bytes: Option<u64>,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecoveryRecord {
    pub id: Uuid,
    pub tenant_database_id: Uuid,
    pub archive_id: Uuid,
    pub state: String,
    pub policy_week: NaiveDate,
    pub replacement_identity: Option<Uuid>,
    pub validated_at: Option<DateTime<Utc>>,
    pub elapsed_milliseconds: Option<u64>,
    pub last_error_code: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatabaseOperationRecord {
    pub id: Uuid,
    pub account_id: Uuid,
    pub project_id: Uuid,
    pub tenant_database_id: Uuid,
    pub database_generation: Uuid,
    pub kind: String,
    pub state: String,
    pub spec: Value,
    pub credential_ids: Vec<Uuid>,
    pub attempt_count: u32,
    pub current_attempt_id: Option<Uuid>,
    pub current_fence: u64,
    pub lease_expires_at: Option<DateTime<Utc>>,
    pub policy_time: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatabaseAttemptLease {
    pub id: Uuid,
    pub attempt_number: u32,
    pub fence: u64,
    pub worker_id: String,
    pub lease_expires_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatabaseLeaseResponse {
    pub operation: DatabaseOperationRecord,
    pub attempt: DatabaseAttemptLease,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatabaseCompleteResponse {
    pub operation: DatabaseOperationRecord,
    pub effect: DatabaseOperationEffect,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatabaseOperationEffect {
    pub id: Uuid,
    pub kind: String,
    pub created: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateDatabaseRequest {
    configuration_revision_id: Uuid,
    service_id: Uuid,
    reservation_id: Uuid,
    reservation_epoch: Uuid,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateExportRequest {}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateRecoveryRequest {
    archive_id: Uuid,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LeaseRequest {
    worker_id: String,
    kinds: Vec<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct LeaseIdentityRequest {
    worker_id: String,
    attempt_id: Uuid,
    fence: i64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ResolveCredentialsRequest {
    worker_id: String,
    attempt_id: Uuid,
    fence: i64,
    credential_ids: Vec<Uuid>,
}

#[derive(Serialize)]
struct ResolveCredentialsResponse {
    credentials: Vec<ResolvedCredential>,
}

#[derive(Serialize)]
struct ResolvedCredential {
    id: Uuid,
    purpose: String,
    role_ref: String,
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
    proof: Value,
}

#[derive(Serialize)]
struct RenewResponse {
    operation_id: Uuid,
    attempt_id: Uuid,
    fence: u64,
    lease_expires_at: DateTime<Utc>,
}

#[derive(Serialize)]
struct SchedulerResponse {
    policy_time: DateTime<Utc>,
    daily_enqueued: u64,
    storage_observations_enqueued: u64,
    drills_enqueued: u64,
    expired_archives: u64,
}

#[derive(FromRow)]
struct TenantDatabaseRow {
    id: Uuid,
    project_id: Uuid,
    service_id: Uuid,
    configuration_revision_id: Uuid,
    first_deployment_id: Uuid,
    reservation_id: Uuid,
    reservation_epoch: Uuid,
    generation: Uuid,
    state: String,
    postgres_major: i16,
    application_connection_limit: i32,
    storage_limit_bytes: i64,
    source_data_generation: i64,
    growth_mode: String,
    measured_storage_bytes: Option<i64>,
    storage_observed_at: Option<DateTime<Utc>>,
    revision: i64,
    last_error_code: Option<String>,
    last_usable_backup_at: Option<DateTime<Utc>>,
    last_successful_drill_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    ready_at: Option<DateTime<Utc>>,
}

#[derive(FromRow)]
struct ArchiveRow {
    id: Uuid,
    tenant_database_id: Uuid,
    database_generation: Uuid,
    kind: String,
    state: String,
    scheduled_for: Option<NaiveDate>,
    intended_migration_revision: Option<String>,
    source_data_generation: i64,
    snapshot_at: Option<DateTime<Utc>>,
    verified_at: Option<DateTime<Utc>>,
    expires_at: DateTime<Utc>,
    plaintext_sha256: Option<String>,
    plaintext_bytes: Option<i64>,
    created_at: DateTime<Utc>,
}

#[derive(FromRow)]
struct RecoveryRow {
    id: Uuid,
    tenant_database_id: Uuid,
    archive_id: Uuid,
    state: String,
    policy_week: NaiveDate,
    replacement_identity: Option<Uuid>,
    validated_at: Option<DateTime<Utc>>,
    elapsed_milliseconds: Option<i64>,
    last_error_code: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

#[derive(FromRow)]
struct OperationRow {
    id: Uuid,
    account_id: Uuid,
    project_id: Uuid,
    tenant_database_id: Uuid,
    database_generation: Uuid,
    kind: String,
    state: String,
    spec: Value,
    credential_ids: Vec<Uuid>,
    attempt_count: i32,
    current_attempt_id: Option<Uuid>,
    current_fence: i64,
    lease_expires_at: Option<DateTime<Utc>>,
    policy_time: DateTime<Utc>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

#[derive(FromRow)]
struct ExpiredArchiveRow {
    account_id: Uuid,
    project_id: Uuid,
    tenant_database_id: Uuid,
    database_generation: Uuid,
    archive_id: String,
    object_ref: String,
    encrypted_sha256: String,
    expires_at: DateTime<Utc>,
}

#[derive(FromRow)]
struct EncryptedCredentialRow {
    id: Uuid,
    purpose: String,
    role_ref: String,
    key_version: String,
    nonce: Vec<u8>,
    ciphertext: Vec<u8>,
    auth_tag: Vec<u8>,
}

#[derive(FromRow)]
struct RuntimeCredentialRow {
    id: Uuid,
    role_ref: String,
    key_version: String,
    purpose: String,
    nonce: Vec<u8>,
    ciphertext: Vec<u8>,
    auth_tag: Vec<u8>,
    database_ref: String,
}

#[derive(FromRow)]
struct PlannedMigrationRow {
    account_id: Uuid,
    project_id: Uuid,
    tenant_database_id: Uuid,
    database_generation: Uuid,
    migration_revision: String,
    migration_digest: String,
    source_data_generation: i64,
    current_schema_revision: String,
    candidate_schema_revision: String,
    migration_artifact: Value,
    pre_migration_archive_id: Uuid,
    encrypted_sha256: String,
}

#[derive(FromRow)]
struct MigrationGateRow {
    id: Uuid,
    migration_revision: String,
    migration_digest: String,
    pre_migration_archive_id: Uuid,
    source_data_generation: i64,
    current_schema_revision: String,
    candidate_schema_revision: String,
    current_binary_digest: String,
    retained_binary_evidence: Value,
    compatibility_evidence: Value,
    once_effect_id: Option<Uuid>,
    live_apply_operation_id: Option<Uuid>,
}

#[derive(FromRow)]
struct PreparedMigrationRow {
    account_id: Uuid,
    project_id: Uuid,
    database_generation: Uuid,
    migration_revision: String,
    migration_digest: String,
    pre_migration_archive_id: Uuid,
    source_data_generation: i64,
    current_schema_revision: String,
    candidate_schema_revision: String,
    current_binary_digest: String,
    compatibility_evidence: Value,
    migration_artifact: Value,
    tenant_database_id: Uuid,
    deployment_id: Uuid,
}

pub fn routes() -> Router<FoundationState> {
    Router::new()
        .route(
            "/v1/projects/{project_id}/deployments/{deployment_id}/tenant-databases",
            post(create_database),
        )
        .route(
            "/v1/projects/{project_id}/services/{service_id}/tenant-database",
            get(get_database),
        )
        .route(
            "/v1/projects/{project_id}/services/{service_id}/tenant-database/backups",
            get(list_backups),
        )
        .route(
            "/v1/projects/{project_id}/services/{service_id}/tenant-database/exports",
            post(create_export),
        )
        .route(
            "/v1/projects/{project_id}/services/{service_id}/tenant-database/exports/{archive_id}",
            get(get_export),
        )
        .route(
            "/v1/projects/{project_id}/services/{service_id}/tenant-database/recovery-drills",
            post(create_recovery),
        )
        .route(
            "/v1/projects/{project_id}/services/{service_id}/tenant-database/recovery-drills/{recovery_id}",
            get(get_recovery),
        )
}

pub fn internal_routes() -> Router<FoundationState> {
    Router::new()
        .route(
            "/internal/v1/tenant-database-scheduler/tick",
            post(scheduler_tick),
        )
        .route(
            "/internal/v1/tenant-database-operations/lease",
            post(lease_operation),
        )
        .route(
            "/internal/v1/tenant-database-operations/{operation_id}/renew",
            post(renew_operation),
        )
        .route(
            "/internal/v1/tenant-database-operations/{operation_id}/credentials:resolve",
            post(resolve_credentials),
        )
        .route(
            "/internal/v1/tenant-database-operations/{operation_id}/complete",
            post(complete_operation),
        )
}

async fn create_database(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    Path((project_id, deployment_id)): Path<(String, String)>,
    headers: HeaderMap,
    SafeJson(request): SafeJson<CreateDatabaseRequest>,
) -> Result<(StatusCode, Json<TenantDatabaseRecord>), ApiError> {
    m3::require_enabled(&state)?;
    let account_id = authenticated.account_id()?;
    let project_id = intent::path_uuid(&project_id)?;
    let deployment_id = intent::path_uuid(&deployment_id)?;
    let expected_revision = intent::if_match_revision(&headers)?;
    let key = intent::idempotency_key(&headers)?;
    let operation_name = format!("{CREATE_DATABASE_OPERATION}/{project_id}/{deployment_id}");
    let request_hash = intent::request_hash(&request)?;
    let policy_time = m3::policy_now(&state).await?;

    let mut tx = state.pool.begin().await?;
    intent::acquire_operation_lock(&mut tx, account_id, &operation_name, key).await?;
    match intent::replay(&mut tx, account_id, &operation_name, key, &request_hash).await? {
        Replay::Match(record) => {
            tx.commit().await?;
            return Ok((StatusCode::CREATED, Json(record)));
        }
        Replay::Changed => {
            return Err(ApiError::conflict(
                "idempotency_payload_changed",
                "the idempotency key was already used with a different payload",
            ));
        }
        Replay::Miss => {}
    }

    let eligible: Option<(i64, Value)> = sqlx::query_as(
        "SELECT p.revision, cr.spec FROM projects p \
         JOIN configuration_revisions cr ON cr.account_id=p.account_id AND cr.project_id=p.id AND cr.id=$4 \
         JOIN service_configurations sc ON sc.account_id=p.account_id AND sc.project_id=p.id \
              AND sc.configuration_revision_id=cr.id AND sc.service_id=$5 AND sc.kind='postgres' \
         JOIN deployments d ON d.account_id=p.account_id AND d.project_id=p.id AND d.id=$3 \
              AND d.configuration_revision_id=cr.id \
         JOIN slot_reservations sr ON sr.account_id=p.account_id AND sr.project_id=p.id \
              AND sr.id=$6 AND sr.reservation_epoch=$7 AND sr.state <> 'released' \
         WHERE p.account_id=$1 AND p.id=$2 AND p.current_configuration_revision_id=cr.id \
         FOR UPDATE OF p",
    )
    .bind(account_id)
    .bind(project_id)
    .bind(deployment_id)
    .bind(request.configuration_revision_id)
    .bind(request.service_id)
    .bind(request.reservation_id)
    .bind(request.reservation_epoch)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((revision, spec)) = eligible else {
        return Err(ApiError::not_found());
    };
    if revision != expected_revision {
        return Err(ApiError::stale_revision());
    }
    let (connection_limit, storage_limit) = project_database_limits(&spec)?;

    if let Some(row) =
        fetch_database_by_service(&mut tx, account_id, project_id, request.service_id).await?
    {
        let record = row.into_record()?;
        intent::store_replay(
            &mut tx,
            account_id,
            &operation_name,
            key,
            &request_hash,
            201,
            &record,
        )
        .await?;
        tx.commit().await?;
        return Ok((StatusCode::CREATED, Json(record)));
    }

    let database_id = Uuid::new_v4();
    let generation = Uuid::new_v4();
    let database_ref = database_id.to_string();
    let role_refs = [
        ("runtime", Uuid::new_v4().to_string()),
        ("migration", Uuid::new_v4().to_string()),
        ("backup", Uuid::new_v4().to_string()),
    ];
    sqlx::query(
        "INSERT INTO tenant_databases (id,account_id,project_id,service_id,configuration_revision_id,\
          first_deployment_id,reservation_id,reservation_epoch,generation,state,postgres_major,\
          application_connection_limit,storage_limit_bytes,database_ref,placement_ref,\
          runtime_network_policy_ref,management_network_policy_ref,grant_plan_version) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'provision_requested',18,$10,$11,$12,$13,$14,$15,$16)",
    )
    .bind(database_id)
    .bind(account_id)
    .bind(project_id)
    .bind(request.service_id)
    .bind(request.configuration_revision_id)
    .bind(deployment_id)
    .bind(request.reservation_id)
    .bind(request.reservation_epoch)
    .bind(generation)
    .bind(connection_limit)
    .bind(storage_limit)
    .bind(&database_ref)
    .bind(format!("owned-fixture:{database_id}"))
    .bind(format!("runtime:{database_id}"))
    .bind(format!("management:{database_id}"))
    .bind(GRANT_PLAN_VERSION)
    .execute(&mut *tx)
    .await?;

    let mut credential_ids = Vec::new();
    for (purpose, role_ref) in &role_refs {
        credential_ids.push(
            create_credential(
                &state,
                &mut tx,
                account_id,
                project_id,
                database_id,
                generation,
                purpose,
                role_ref,
                &database_ref,
            )
            .await?,
        );
    }
    let operation_id = Uuid::new_v4();
    let spec = json!({
        "database_ref": database_ref,
        "role_refs": {
            "runtime": role_refs[0].1,
            "migration": role_refs[1].1,
            "backup": role_refs[2].1,
            "management": database_id
        },
        "application_connection_limit": connection_limit,
        "storage_limit_bytes": storage_limit,
        "grant_plan_version": GRANT_PLAN_VERSION
    });
    insert_operation(
        &mut tx,
        OperationInsert {
            id: operation_id,
            account_id,
            project_id,
            database_id,
            generation,
            kind: "provision",
            operation_key: "initial",
            spec: &spec,
            credential_ids: &credential_ids,
            policy_time,
        },
    )
    .await?;
    let row = fetch_database_by_id(&mut tx, account_id, project_id, database_id)
        .await?
        .ok_or_else(ApiError::internal)?;
    let record = row.into_record()?;
    intent::audit(
        &mut tx,
        account_id,
        authenticated.session_id(),
        "tenant_database.create",
        "tenant_database",
        Some(database_id),
        "queued",
    )
    .await?;
    intent::store_replay(
        &mut tx,
        account_id,
        &operation_name,
        key,
        &request_hash,
        201,
        &record,
    )
    .await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(record)))
}

async fn get_database(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    Path((project_id, service_id)): Path<(String, String)>,
) -> Result<Json<TenantDatabaseRecord>, ApiError> {
    m3::require_enabled(&state)?;
    let account_id = authenticated.account_id()?;
    let project_id = intent::path_uuid(&project_id)?;
    let service_id = intent::path_uuid(&service_id)?;
    let mut tx = state.pool.begin().await?;
    let row = fetch_database_by_service(&mut tx, account_id, project_id, service_id)
        .await?
        .ok_or_else(ApiError::not_found)?;
    let record = row.into_record()?;
    intent::audit(
        &mut tx,
        account_id,
        authenticated.session_id(),
        "tenant_database.read",
        "tenant_database",
        Some(record.id),
        "success",
    )
    .await?;
    tx.commit().await?;
    Ok(Json(record))
}

async fn list_backups(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    Path((project_id, service_id)): Path<(String, String)>,
) -> Result<Json<Vec<ArchiveRecord>>, ApiError> {
    m3::require_enabled(&state)?;
    let account_id = authenticated.account_id()?;
    let project_id = intent::path_uuid(&project_id)?;
    let service_id = intent::path_uuid(&service_id)?;
    let database_id: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM tenant_databases WHERE account_id=$1 AND project_id=$2 AND service_id=$3 AND state <> 'removed'",
    )
    .bind(account_id)
    .bind(project_id)
    .bind(service_id)
    .fetch_optional(&state.pool)
    .await?;
    let database_id = database_id.ok_or_else(ApiError::not_found)?;
    let rows = sqlx::query_as::<_, ArchiveRow>(
        "SELECT id,tenant_database_id,database_generation,kind,state,scheduled_for,\
          intended_migration_revision,source_data_generation,snapshot_at,verified_at,expires_at,\
          plaintext_sha256,plaintext_bytes,created_at FROM tenant_database_archives \
         WHERE account_id=$1 AND project_id=$2 AND tenant_database_id=$3 AND kind <> 'export' \
         ORDER BY created_at DESC,id DESC LIMIT 100",
    )
    .bind(account_id)
    .bind(project_id)
    .bind(database_id)
    .fetch_all(&state.pool)
    .await?;
    rows.into_iter()
        .map(ArchiveRow::into_record)
        .collect::<Result<Vec<_>, _>>()
        .map(Json)
}

async fn create_export(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    Path((project_id, service_id)): Path<(String, String)>,
    headers: HeaderMap,
    SafeJson(request): SafeJson<CreateExportRequest>,
) -> Result<(StatusCode, Json<ArchiveRecord>), ApiError> {
    m3::require_enabled(&state)?;
    let account_id = authenticated.account_id()?;
    let project_id = intent::path_uuid(&project_id)?;
    let service_id = intent::path_uuid(&service_id)?;
    let expected_revision = intent::if_match_revision(&headers)?;
    let key = intent::idempotency_key(&headers)?;
    let policy_time = m3::policy_now(&state).await?;
    let operation_name = format!("{CREATE_EXPORT_OPERATION}/{project_id}/{service_id}");
    let request_hash = intent::request_hash(&request)?;
    let mut tx = state.pool.begin().await?;
    intent::acquire_operation_lock(&mut tx, account_id, &operation_name, key).await?;
    match intent::replay(&mut tx, account_id, &operation_name, key, &request_hash).await? {
        Replay::Match(record) => {
            tx.commit().await?;
            return Ok((StatusCode::CREATED, Json(record)));
        }
        Replay::Changed => {
            return Err(ApiError::conflict(
                "idempotency_payload_changed",
                "the idempotency key was already used with a different payload",
            ));
        }
        Replay::Miss => {}
    }
    let row = fetch_database_by_service_for_update(&mut tx, account_id, project_id, service_id)
        .await?
        .ok_or_else(ApiError::not_found)?;
    if row.revision != expected_revision {
        return Err(ApiError::stale_revision());
    }
    if !matches!(row.state.as_str(), "ready" | "recovery_attention") {
        return Err(ApiError::conflict(
            "tenant_database_not_ready",
            "the tenant database is not ready for export",
        ));
    }
    let archive_id = Uuid::new_v4();
    let expires_at = policy_time + Duration::hours(EXPORT_TTL_HOURS);
    insert_archive(
        &mut tx,
        ArchiveInsert {
            id: archive_id,
            account_id,
            project_id,
            database_id: row.id,
            generation: row.generation,
            kind: "export",
            scheduled_for: None,
            intended_migration_revision: None,
            source_data_generation: row.source_data_generation,
            expires_at,
        },
    )
    .await?;
    let backup_credential = active_credential_id(&mut tx, row.id, "backup").await?;
    let spec = archive_spec(
        row.id,
        archive_id,
        "export",
        None,
        None,
        row.source_data_generation,
        expires_at,
    );
    insert_operation(
        &mut tx,
        OperationInsert {
            id: Uuid::new_v4(),
            account_id,
            project_id,
            database_id: row.id,
            generation: row.generation,
            kind: "export",
            operation_key: &archive_id.to_string(),
            spec: &spec,
            credential_ids: &[backup_credential],
            policy_time,
        },
    )
    .await?;
    let record = fetch_archive(&mut tx, account_id, project_id, archive_id)
        .await?
        .ok_or_else(ApiError::internal)?
        .into_record()?;
    intent::audit(
        &mut tx,
        account_id,
        authenticated.session_id(),
        "tenant_database.export.create",
        "tenant_database_archive",
        Some(archive_id),
        "queued",
    )
    .await?;
    intent::store_replay(
        &mut tx,
        account_id,
        &operation_name,
        key,
        &request_hash,
        201,
        &record,
    )
    .await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(record)))
}

async fn get_export(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    Path((project_id, service_id, archive_id)): Path<(String, String, String)>,
) -> Result<Json<ArchiveRecord>, ApiError> {
    m3::require_enabled(&state)?;
    let account_id = authenticated.account_id()?;
    let project_id = intent::path_uuid(&project_id)?;
    let service_id = intent::path_uuid(&service_id)?;
    let archive_id = intent::path_uuid(&archive_id)?;
    let row = sqlx::query_as::<_, ArchiveRow>(
        "SELECT a.id,a.tenant_database_id,a.database_generation,a.kind,a.state,a.scheduled_for,\
          a.intended_migration_revision,a.source_data_generation,a.snapshot_at,a.verified_at,a.expires_at,\
          a.plaintext_sha256,a.plaintext_bytes,a.created_at FROM tenant_database_archives a \
         JOIN tenant_databases d ON d.account_id=a.account_id AND d.project_id=a.project_id AND d.id=a.tenant_database_id \
         WHERE a.account_id=$1 AND a.project_id=$2 AND d.service_id=$3 AND a.id=$4 AND a.kind='export'",
    )
    .bind(account_id).bind(project_id).bind(service_id).bind(archive_id)
    .fetch_optional(&state.pool).await?.ok_or_else(ApiError::not_found)?;
    Ok(Json(row.into_record()?))
}

async fn create_recovery(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    Path((project_id, service_id)): Path<(String, String)>,
    headers: HeaderMap,
    SafeJson(request): SafeJson<CreateRecoveryRequest>,
) -> Result<(StatusCode, Json<RecoveryRecord>), ApiError> {
    m3::require_enabled(&state)?;
    let account_id = authenticated.account_id()?;
    let project_id = intent::path_uuid(&project_id)?;
    let service_id = intent::path_uuid(&service_id)?;
    let expected_revision = intent::if_match_revision(&headers)?;
    let key = intent::idempotency_key(&headers)?;
    let policy_time = m3::policy_now(&state).await?;
    let operation_name = format!("{CREATE_RECOVERY_OPERATION}/{project_id}/{service_id}");
    let request_hash = intent::request_hash(&request)?;
    let mut tx = state.pool.begin().await?;
    intent::acquire_operation_lock(&mut tx, account_id, &operation_name, key).await?;
    match intent::replay(&mut tx, account_id, &operation_name, key, &request_hash).await? {
        Replay::Match(record) => {
            tx.commit().await?;
            return Ok((StatusCode::CREATED, Json(record)));
        }
        Replay::Changed => {
            return Err(ApiError::conflict(
                "idempotency_payload_changed",
                "the idempotency key was already used with a different payload",
            ));
        }
        Replay::Miss => {}
    }
    let row = fetch_database_by_service_for_update(&mut tx, account_id, project_id, service_id)
        .await?
        .ok_or_else(ApiError::not_found)?;
    if row.revision != expected_revision {
        return Err(ApiError::stale_revision());
    }
    let archive = fetch_archive(&mut tx, account_id, project_id, request.archive_id)
        .await?
        .ok_or_else(ApiError::not_found)?;
    if archive.tenant_database_id != row.id
        || archive.database_generation != row.generation
        || archive.state != "usable"
        || archive.kind == "export"
        || archive.expires_at < policy_time
    {
        return Err(ApiError::conflict(
            "backup_unavailable",
            "the selected backup is not usable for this database",
        ));
    }
    let policy_week = week_start(policy_time.date_naive());
    let (encrypted_sha256, object_ref) =
        archive_worker_metadata(&mut tx, request.archive_id).await?;
    let recovery_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO tenant_database_recoveries (id,account_id,project_id,tenant_database_id,database_generation,archive_id,policy_week) \
         VALUES ($1,$2,$3,$4,$5,$6,$7)",
    ).bind(recovery_id).bind(account_id).bind(project_id).bind(row.id).bind(row.generation).bind(request.archive_id).bind(policy_week)
    .execute(&mut *tx).await.map_err(map_recovery_conflict)?;
    let credential_ids = active_credential_ids(&mut tx, row.id).await?;
    let spec = json!({
        "recovery_id": recovery_id,
        "archive_id": request.archive_id,
        "repository_namespace": repository_namespace(row.id),
        "encrypted_sha256": encrypted_sha256,
        "object_ref": object_ref,
        "replacement_ref": recovery_id,
        "grant_plan_version": GRANT_PLAN_VERSION
    });
    insert_operation(
        &mut tx,
        OperationInsert {
            id: Uuid::new_v4(),
            account_id,
            project_id,
            database_id: row.id,
            generation: row.generation,
            kind: "restore_drill",
            operation_key: &recovery_id.to_string(),
            spec: &spec,
            credential_ids: &credential_ids,
            policy_time,
        },
    )
    .await?;
    let record = fetch_recovery(&mut tx, account_id, project_id, recovery_id)
        .await?
        .ok_or_else(ApiError::internal)?
        .into_record()?;
    intent::audit(
        &mut tx,
        account_id,
        authenticated.session_id(),
        "tenant_database.recovery.create",
        "tenant_database_recovery",
        Some(recovery_id),
        "queued",
    )
    .await?;
    intent::store_replay(
        &mut tx,
        account_id,
        &operation_name,
        key,
        &request_hash,
        201,
        &record,
    )
    .await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(record)))
}

async fn get_recovery(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    Path((project_id, service_id, recovery_id)): Path<(String, String, String)>,
) -> Result<Json<RecoveryRecord>, ApiError> {
    m3::require_enabled(&state)?;
    let account_id = authenticated.account_id()?;
    let project_id = intent::path_uuid(&project_id)?;
    let service_id = intent::path_uuid(&service_id)?;
    let recovery_id = intent::path_uuid(&recovery_id)?;
    let row = sqlx::query_as::<_, RecoveryRow>(
        "SELECT r.id,r.tenant_database_id,r.archive_id,r.state,r.policy_week,r.replacement_identity,\
          r.validated_at,r.elapsed_milliseconds,r.last_error_code,r.created_at,r.updated_at \
         FROM tenant_database_recoveries r JOIN tenant_databases d ON d.id=r.tenant_database_id \
         WHERE r.account_id=$1 AND r.project_id=$2 AND d.service_id=$3 AND r.id=$4",
    ).bind(account_id).bind(project_id).bind(service_id).bind(recovery_id)
    .fetch_optional(&state.pool).await?.ok_or_else(ApiError::not_found)?;
    Ok(Json(row.into_record()?))
}

async fn scheduler_tick(
    State(state): State<FoundationState>,
    _: DatabaseWorkerAuth,
    SafeJson(_request): SafeJson<EmptyRequest>,
) -> Result<Json<SchedulerResponse>, ApiError> {
    m3::require_enabled(&state)?;
    let policy_time = m3::policy_now(&state).await?;
    let policy_date = policy_time.date_naive();
    let policy_week = week_start(policy_date);
    let mut tx = state.pool.begin().await?;
    let databases: Vec<(Uuid, Uuid, Uuid, Uuid, i64, i64)> = sqlx::query_as(
        "SELECT account_id,project_id,id,generation,source_data_generation,storage_limit_bytes \
         FROM tenant_databases WHERE state IN ('ready','recovery_attention') ORDER BY id FOR UPDATE",
    )
    .fetch_all(&mut *tx)
    .await?;
    let mut daily_enqueued = 0_u64;
    let mut storage_observations_enqueued = 0_u64;
    for (
        account_id,
        project_id,
        database_id,
        generation,
        source_data_generation,
        storage_limit_bytes,
    ) in &databases
    {
        let archive_id = Uuid::new_v4();
        let expires_at = policy_time + Duration::days(BACKUP_RETENTION_DAYS);
        let inserted = sqlx::query_scalar::<_, Uuid>(
            "INSERT INTO tenant_database_archives \
             (id,account_id,project_id,tenant_database_id,database_generation,kind,scheduled_for,source_data_generation,expires_at) \
             VALUES ($1,$2,$3,$4,$5,'daily',$6,$7,$8) \
             ON CONFLICT (tenant_database_id,database_generation,scheduled_for) WHERE kind='daily' DO NOTHING RETURNING id",
        )
        .bind(archive_id).bind(account_id).bind(project_id).bind(database_id).bind(generation)
        .bind(policy_date).bind(source_data_generation).bind(expires_at)
        .fetch_optional(&mut *tx).await?;
        if inserted.is_some() {
            let credential_id = active_credential_id(&mut tx, *database_id, "backup").await?;
            let spec = archive_spec(
                *database_id,
                archive_id,
                "daily",
                Some(policy_date),
                None,
                *source_data_generation,
                expires_at,
            );
            insert_operation(
                &mut tx,
                OperationInsert {
                    id: Uuid::new_v4(),
                    account_id: *account_id,
                    project_id: *project_id,
                    database_id: *database_id,
                    generation: *generation,
                    kind: "backup_daily",
                    operation_key: &policy_date.to_string(),
                    spec: &spec,
                    credential_ids: &[credential_id],
                    policy_time,
                },
            )
            .await?;
            daily_enqueued += 1;
        }
        let (storage_credentials, storage_role_refs) =
            active_credential_scope(&mut tx, *database_id).await?;
        let storage_spec = json!({
            "storage_limit_bytes": storage_limit_bytes,
            "role_refs": storage_role_refs
        });
        let storage_hour = policy_time.format("%Y-%m-%dT%H").to_string();
        let storage_inserted = sqlx::query_scalar::<_, Uuid>(
            "INSERT INTO tenant_database_operations \
             (id,account_id,project_id,tenant_database_id,database_generation,kind,operation_key,spec,credential_ids,policy_time) \
             VALUES ($1,$2,$3,$4,$5,'observe_storage',$6,$7,$8,$9) \
             ON CONFLICT (tenant_database_id,database_generation,kind,operation_key) DO NOTHING RETURNING id",
        )
        .bind(Uuid::new_v4())
        .bind(account_id)
        .bind(project_id)
        .bind(database_id)
        .bind(generation)
        .bind(storage_hour)
        .bind(storage_spec)
        .bind(storage_credentials)
        .bind(policy_time)
        .fetch_optional(&mut *tx)
        .await?;
        if storage_inserted.is_some() {
            storage_observations_enqueued += 1;
        }
    }

    let expired: Vec<ExpiredArchiveRow> = sqlx::query_as(
        "SELECT a.account_id,a.project_id,a.tenant_database_id,a.database_generation,a.id::text AS archive_id,\
          a.object_ref,a.encrypted_sha256,a.expires_at FROM tenant_database_archives a \
         WHERE a.state IN ('usable','corrupt') AND a.expires_at < $1 \
           AND a.object_ref IS NOT NULL AND a.encrypted_sha256 IS NOT NULL \
           AND NOT EXISTS (SELECT 1 FROM tenant_database_operations o \
             WHERE o.tenant_database_id=a.tenant_database_id AND o.database_generation=a.database_generation \
               AND o.kind='archive_expire' AND o.operation_key=a.id::text) \
         ORDER BY a.expires_at,a.id FOR UPDATE OF a",
    ).bind(policy_time).fetch_all(&mut *tx).await?;
    let mut expired_archives = 0_u64;
    for expired in expired {
        let archive_id = Uuid::parse_str(&expired.archive_id).map_err(|_| ApiError::internal())?;
        let namespace = repository_namespace(expired.tenant_database_id);
        let spec = json!({
            "archive_id": archive_id,
            "repository_namespace": namespace,
            "object_ref": expired.object_ref,
            "encrypted_sha256": expired.encrypted_sha256,
            "database_generation": expired.database_generation,
            "expired_at": expired.expires_at
        });
        insert_operation(
            &mut tx,
            OperationInsert {
                id: Uuid::new_v4(),
                account_id: expired.account_id,
                project_id: expired.project_id,
                database_id: expired.tenant_database_id,
                generation: expired.database_generation,
                kind: "archive_expire",
                operation_key: &archive_id.to_string(),
                spec: &spec,
                credential_ids: &[],
                policy_time,
            },
        )
        .await?;
        expired_archives += 1;
    }

    let active_count = databases.len();
    let drill_budget = active_count.div_ceil(4).max(usize::from(active_count > 0));
    let candidates: Vec<(Uuid, Uuid, Uuid, Uuid, Uuid, String)> = sqlx::query_as(
        "SELECT d.account_id,d.project_id,d.id,d.generation,a.id,a.encrypted_sha256 \
         FROM tenant_databases d JOIN LATERAL (\
           SELECT id,encrypted_sha256 FROM tenant_database_archives \
           WHERE tenant_database_id=d.id AND database_generation=d.generation AND kind='daily' \
             AND state='usable' AND expires_at >= $1 AND encrypted_sha256 IS NOT NULL \
           ORDER BY snapshot_at DESC,id DESC LIMIT 1\
         ) a ON true \
         WHERE d.state IN ('ready','recovery_attention') \
           AND NOT EXISTS (SELECT 1 FROM tenant_database_recoveries r \
             WHERE r.tenant_database_id=d.id AND r.database_generation=d.generation AND r.policy_week=$2) \
         ORDER BY (SELECT max(r.validated_at) FROM tenant_database_recoveries r \
                    WHERE r.tenant_database_id=d.id AND r.database_generation=d.generation \
                      AND r.state IN ('validated','cleaned')) NULLS FIRST,d.id LIMIT $3",
    ).bind(policy_time).bind(policy_week).bind(i64::try_from(drill_budget).map_err(|_| ApiError::internal())?)
    .fetch_all(&mut *tx).await?;
    let mut drills_enqueued = 0_u64;
    for (account_id, project_id, database_id, generation, archive_id, encrypted_sha256) in
        candidates
    {
        let recovery_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO tenant_database_recoveries \
             (id,account_id,project_id,tenant_database_id,database_generation,archive_id,policy_week) \
             VALUES ($1,$2,$3,$4,$5,$6,$7)",
        ).bind(recovery_id).bind(account_id).bind(project_id).bind(database_id).bind(generation).bind(archive_id).bind(policy_week)
        .execute(&mut *tx).await?;
        let credentials = active_credential_ids(&mut tx, database_id).await?;
        let spec = json!({
            "recovery_id": recovery_id,
            "archive_id": archive_id,
            "repository_namespace": repository_namespace(database_id),
            "encrypted_sha256": encrypted_sha256,
            "replacement_ref": recovery_id,
            "grant_plan_version": GRANT_PLAN_VERSION
        });
        insert_operation(
            &mut tx,
            OperationInsert {
                id: Uuid::new_v4(),
                account_id,
                project_id,
                database_id,
                generation,
                kind: "restore_drill",
                operation_key: &recovery_id.to_string(),
                spec: &spec,
                credential_ids: &credentials,
                policy_time,
            },
        )
        .await?;
        drills_enqueued += 1;
    }
    tx.commit().await?;
    Ok(Json(SchedulerResponse {
        policy_time,
        daily_enqueued,
        storage_observations_enqueued,
        drills_enqueued,
        expired_archives,
    }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyRequest {}

async fn lease_operation(
    State(state): State<FoundationState>,
    _: DatabaseWorkerAuth,
    SafeJson(request): SafeJson<LeaseRequest>,
) -> Result<axum::response::Response, ApiError> {
    m3::require_enabled(&state)?;
    validate_worker_id(&request.worker_id)?;
    let kinds = validate_kinds(&request.kinds)?;
    let mut tx = state.pool.begin().await?;
    reap_expired_operations(&mut tx).await?;
    let row = sqlx::query_as::<_, OperationRow>(
        "SELECT id,account_id,project_id,tenant_database_id,database_generation,kind,state,spec,\
          credential_ids,attempt_count,current_attempt_id,current_fence,lease_expires_at,policy_time,created_at,updated_at \
         FROM tenant_database_operations WHERE state IN ('queued','retriable') AND kind = ANY($1) \
         ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1",
    ).bind(&kinds).fetch_optional(&mut *tx).await?;
    let Some(row) = row else {
        tx.commit().await?;
        return Ok(StatusCode::NO_CONTENT.into_response());
    };
    if row.attempt_count >= 5 {
        sqlx::query("UPDATE tenant_database_operations SET state='failed',result=$2,updated_at=clock_timestamp() WHERE id=$1")
            .bind(row.id).bind(json!({"code":"attempts_exhausted"})).execute(&mut *tx).await?;
        tx.commit().await?;
        return Ok(StatusCode::NO_CONTENT.into_response());
    }
    let attempt_id = Uuid::new_v4();
    let attempt_number = row.attempt_count + 1;
    let fence = row.current_fence + 1;
    let lease_seconds = state.worker_lease_seconds;
    let lease_expires_at: DateTime<Utc> =
        sqlx::query_scalar("SELECT clock_timestamp() + make_interval(secs => $1)")
            .bind(lease_seconds)
            .fetch_one(&mut *tx)
            .await?;
    sqlx::query(
        "INSERT INTO tenant_database_operation_attempts \
         (id,account_id,project_id,tenant_database_id,database_generation,operation_id,attempt_number,fence,worker_id,state,lease_expires_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'running',$10)",
    ).bind(attempt_id).bind(row.account_id).bind(row.project_id).bind(row.tenant_database_id).bind(row.database_generation)
    .bind(row.id).bind(attempt_number).bind(fence).bind(&request.worker_id).bind(lease_expires_at)
    .execute(&mut *tx).await?;
    sqlx::query(
        "UPDATE tenant_database_operations SET state='running',attempt_count=$2,current_attempt_id=$3,\
          current_fence=$4,lease_expires_at=$5,updated_at=clock_timestamp() WHERE id=$1",
    ).bind(row.id).bind(attempt_number).bind(attempt_id).bind(fence).bind(lease_expires_at)
    .execute(&mut *tx).await?;
    if row.kind == "provision" {
        sqlx::query("UPDATE tenant_databases SET state='provisioning',revision=revision+1,updated_at=clock_timestamp() WHERE id=$1 AND state='provision_requested'")
            .bind(row.tenant_database_id).execute(&mut *tx).await?;
    } else if row.kind == "restore_drill"
        && let Some(id) = value_uuid(&row.spec, "recovery_id")
    {
        sqlx::query("UPDATE tenant_database_recoveries SET state='restoring',restore_started_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 AND state='requested'")
            .bind(id).execute(&mut *tx).await?;
    }
    let operation = OperationRow {
        attempt_count: attempt_number,
        current_attempt_id: Some(attempt_id),
        current_fence: fence,
        lease_expires_at: Some(lease_expires_at),
        state: "running".to_owned(),
        ..row
    }
    .into_record()?;
    let response = DatabaseLeaseResponse {
        operation,
        attempt: DatabaseAttemptLease {
            id: attempt_id,
            attempt_number: to_u32(attempt_number)?,
            fence: to_u64(fence)?,
            worker_id: request.worker_id,
            lease_expires_at,
        },
    };
    tx.commit().await?;
    Ok((StatusCode::OK, Json(response)).into_response())
}

async fn renew_operation(
    State(state): State<FoundationState>,
    _: DatabaseWorkerAuth,
    Path(operation_id): Path<String>,
    SafeJson(request): SafeJson<LeaseIdentityRequest>,
) -> Result<Json<RenewResponse>, ApiError> {
    m3::require_enabled(&state)?;
    validate_worker_id(&request.worker_id)?;
    let operation_id = intent::path_uuid(&operation_id)?;
    if request.fence <= 0 {
        return Err(fenced());
    }
    let mut tx = state.pool.begin().await?;
    let lease_seconds = state.worker_lease_seconds;
    let renewed: Option<DateTime<Utc>> = sqlx::query_scalar(
        "WITH locked AS (SELECT id FROM tenant_database_operations WHERE id=$1 FOR UPDATE) \
         UPDATE tenant_database_operations o SET lease_expires_at=clock_timestamp()+make_interval(secs=>$5),updated_at=clock_timestamp() \
         FROM tenant_database_operation_attempts a WHERE o.id=(SELECT id FROM locked) AND o.id=a.operation_id \
           AND o.state='running' AND o.current_attempt_id=$2 AND o.current_fence=$3 AND a.worker_id=$4 \
           AND a.id=$2 AND a.fence=$3 AND a.state='running' AND o.lease_expires_at > clock_timestamp() AND a.lease_expires_at > clock_timestamp() \
         RETURNING o.lease_expires_at",
    ).bind(operation_id).bind(request.attempt_id).bind(request.fence).bind(&request.worker_id).bind(lease_seconds)
    .fetch_optional(&mut *tx).await?;
    let renewed = renewed.ok_or_else(fenced)?;
    sqlx::query("UPDATE tenant_database_operation_attempts SET lease_expires_at=$4 WHERE operation_id=$1 AND id=$2 AND fence=$3")
        .bind(operation_id).bind(request.attempt_id).bind(request.fence).bind(renewed).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(RenewResponse {
        operation_id,
        attempt_id: request.attempt_id,
        fence: to_u64(request.fence)?,
        lease_expires_at: renewed,
    }))
}

async fn resolve_credentials(
    State(state): State<FoundationState>,
    _: DatabaseWorkerAuth,
    Path(operation_id): Path<String>,
    SafeJson(request): SafeJson<ResolveCredentialsRequest>,
) -> Result<Json<ResolveCredentialsResponse>, ApiError> {
    m3::require_enabled(&state)?;
    validate_worker_id(&request.worker_id)?;
    let operation_id = intent::path_uuid(&operation_id)?;
    if request.fence <= 0 || request.credential_ids.len() > MAX_CREDENTIAL_IDS {
        return Err(fenced());
    }
    let requested: HashSet<_> = request.credential_ids.iter().copied().collect();
    if requested.len() != request.credential_ids.len() {
        return Err(ApiError::unprocessable(
            "invalid_credential_request",
            "credential identifiers must be unique",
        ));
    }
    let mut tx = state.pool.begin().await?;
    let declared: Option<(Uuid, Uuid, Uuid, Uuid, Vec<Uuid>)> = sqlx::query_as(
        "SELECT o.account_id,o.project_id,o.tenant_database_id,o.database_generation,o.credential_ids \
         FROM tenant_database_operations o JOIN tenant_database_operation_attempts a \
           ON a.operation_id=o.id AND a.id=o.current_attempt_id AND a.fence=o.current_fence \
         WHERE o.id=$1 AND o.state='running' AND o.current_attempt_id=$2 AND o.current_fence=$3 \
           AND a.worker_id=$4 AND a.state='running' AND o.lease_expires_at > clock_timestamp() AND a.lease_expires_at > clock_timestamp() FOR UPDATE OF o",
    ).bind(operation_id).bind(request.attempt_id).bind(request.fence).bind(&request.worker_id)
    .fetch_optional(&mut *tx).await?;
    let Some((account_id, project_id, database_id, generation, declared_ids)) = declared else {
        return Err(fenced());
    };
    let declared: HashSet<_> = declared_ids.into_iter().collect();
    if !requested.is_subset(&declared) {
        return Err(ApiError::not_found());
    }
    let key = state
        .secret_key
        .as_deref()
        .ok_or_else(ApiError::foundation_unavailable)?;
    let rows: Vec<EncryptedCredentialRow> = sqlx::query_as(
        "SELECT id,purpose,role_ref,key_version,nonce,ciphertext,auth_tag FROM tenant_database_credentials \
         WHERE account_id=$1 AND project_id=$2 AND tenant_database_id=$3 AND database_generation=$4 \
           AND id = ANY($5) AND status='active' ORDER BY id",
    ).bind(account_id).bind(project_id).bind(database_id).bind(generation).bind(&request.credential_ids)
    .fetch_all(&mut *tx).await?;
    if rows.len() != request.credential_ids.len() {
        return Err(ApiError::not_found());
    }
    let mut credentials = Vec::with_capacity(rows.len());
    for row in rows {
        if row.key_version != key.key_version() {
            return Err(ApiError::foundation_unavailable());
        }
        let aad = credential_aad(
            account_id,
            project_id,
            database_id,
            generation,
            &row.purpose,
            row.id,
        );
        let mut plaintext = key
            .decrypt(&aad, &row.nonce, &row.ciphertext, &row.auth_tag)
            .map_err(|_| ApiError::foundation_unavailable())?;
        let value = String::from_utf8(std::mem::take(&mut plaintext))
            .map_err(|_| ApiError::foundation_unavailable())?;
        credentials.push(ResolvedCredential {
            id: row.id,
            purpose: row.purpose,
            role_ref: row.role_ref,
            value: SecretResponseValue(value),
        });
    }
    tx.commit().await?;
    Ok(Json(ResolveCredentialsResponse { credentials }))
}

async fn complete_operation(
    State(state): State<FoundationState>,
    _: DatabaseWorkerAuth,
    Path(operation_id): Path<String>,
    SafeJson(request): SafeJson<CompleteRequest>,
) -> Result<Json<DatabaseCompleteResponse>, ApiError> {
    m3::require_enabled(&state)?;
    validate_worker_id(&request.worker_id)?;
    validate_completion(&request.outcome)?;
    let operation_id = intent::path_uuid(&operation_id)?;
    if request.fence <= 0 {
        return Err(fenced());
    }
    let completion_bytes =
        serde_json::to_vec(&request.outcome).map_err(|_| ApiError::internal())?;
    let completion_hash = Sha256::digest(completion_bytes).to_vec();
    let mut tx = state.pool.begin().await?;
    let row = fetch_operation_for_update(&mut tx, operation_id)
        .await?
        .ok_or_else(fenced)?;
    if row.current_attempt_id == Some(request.attempt_id)
        && row.current_fence == request.fence
        && row.state == "running"
    {
        let valid: bool = sqlx::query_scalar(
            "SELECT worker_id=$4 AND state='running' AND lease_expires_at > clock_timestamp() \
             FROM tenant_database_operation_attempts WHERE operation_id=$1 AND id=$2 AND fence=$3",
        )
        .bind(operation_id)
        .bind(request.attempt_id)
        .bind(request.fence)
        .bind(&request.worker_id)
        .fetch_optional(&mut *tx)
        .await?
        .unwrap_or(false);
        if !valid {
            return Err(fenced());
        }
        let terminal_state = request.outcome.state.as_str();
        apply_completion(&mut tx, &row, &request.outcome).await?;
        sqlx::query(
            "UPDATE tenant_database_operation_attempts SET state=$4,finished_at=clock_timestamp(),terminal_code=$5,completion_hash=$6 \
             WHERE operation_id=$1 AND id=$2 AND fence=$3",
        ).bind(operation_id).bind(request.attempt_id).bind(request.fence).bind(terminal_state).bind(&request.outcome.code).bind(&completion_hash)
        .execute(&mut *tx).await?;
        sqlx::query(
            "UPDATE tenant_database_operations SET state=$2,result=$3,current_attempt_id=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=$1",
        ).bind(operation_id).bind(terminal_state).bind(json!({"code":request.outcome.code,"proof":request.outcome.proof}))
        .execute(&mut *tx).await?;
        let operation = fetch_operation_for_update(&mut tx, operation_id)
            .await?
            .ok_or_else(ApiError::internal)?
            .into_record()?;
        tx.commit().await?;
        return Ok(Json(DatabaseCompleteResponse {
            operation,
            effect: DatabaseOperationEffect {
                id: operation_id,
                kind: row.kind,
                created: true,
            },
        }));
    }
    let prior: Option<(Vec<u8>, String)> = sqlx::query_as(
        "SELECT completion_hash,state FROM tenant_database_operation_attempts WHERE operation_id=$1 AND id=$2 AND fence=$3 AND worker_id=$4",
    ).bind(operation_id).bind(request.attempt_id).bind(request.fence).bind(&request.worker_id)
    .fetch_optional(&mut *tx).await?;
    if prior
        .as_ref()
        .is_some_and(|(hash, state)| hash == &completion_hash && state == &request.outcome.state)
    {
        let operation = row.into_record()?;
        let kind = operation.kind.clone();
        tx.commit().await?;
        return Ok(Json(DatabaseCompleteResponse {
            operation,
            effect: DatabaseOperationEffect {
                id: operation_id,
                kind,
                created: false,
            },
        }));
    }
    Err(fenced())
}

pub(crate) struct ResolvedRuntimeCredential {
    pub credential_id: Uuid,
    pub database_ref: String,
    pub role_ref: String,
    pub database_name: String,
    pub role_name: String,
    pub value: Zeroizing<String>,
}

/// Resolve only the active runtime credential after a runtime allocation has
/// independently established this exact owned database generation. This helper
/// is intentionally not an HTTP route and has no caller-selected purpose.
pub(crate) async fn resolve_runtime_credential(
    pool: &PgPool,
    key: &crate::crypto::SecretKey,
    account_id: Uuid,
    project_id: Uuid,
    tenant_database_id: Uuid,
    database_generation: Uuid,
) -> Result<ResolvedRuntimeCredential, ApiError> {
    let row: Option<RuntimeCredentialRow> = sqlx::query_as(
        "SELECT c.id,c.role_ref,c.key_version,c.purpose,c.nonce,c.ciphertext,c.auth_tag,d.database_ref \
         FROM tenant_database_credentials c JOIN tenant_databases d \
           ON d.account_id=c.account_id AND d.project_id=c.project_id AND d.id=c.tenant_database_id AND d.generation=c.database_generation \
         JOIN slot_reservations sr ON sr.account_id=d.account_id AND sr.project_id=d.project_id \
           AND sr.id=d.reservation_id AND sr.reservation_epoch=d.reservation_epoch AND sr.state <> 'released' \
         WHERE c.account_id=$1 AND c.project_id=$2 AND c.tenant_database_id=$3 AND c.database_generation=$4 \
           AND c.purpose='runtime' AND c.status='active' AND d.state IN ('ready','recovery_attention')",
    ).bind(account_id).bind(project_id).bind(tenant_database_id).bind(database_generation)
    .fetch_optional(pool).await?;
    let Some(row) = row else {
        return Err(ApiError::not_found());
    };
    if row.key_version != key.key_version() {
        return Err(ApiError::foundation_unavailable());
    }
    let aad = credential_aad(
        account_id,
        project_id,
        tenant_database_id,
        database_generation,
        &row.purpose,
        row.id,
    );
    let mut plaintext = key
        .decrypt(&aad, &row.nonce, &row.ciphertext, &row.auth_tag)
        .map_err(|_| ApiError::foundation_unavailable())?;
    let value = String::from_utf8(std::mem::take(&mut plaintext))
        .map_err(|_| ApiError::foundation_unavailable())?;
    let database_identity = Uuid::parse_str(&row.database_ref).map_err(|_| ApiError::internal())?;
    let role_identity = Uuid::parse_str(&row.role_ref).map_err(|_| ApiError::internal())?;
    Ok(ResolvedRuntimeCredential {
        credential_id: row.id,
        database_ref: row.database_ref,
        role_ref: row.role_ref,
        database_name: format!("hdb_{}", database_identity.simple()),
        role_name: format!("ha_{}", role_identity.simple()),
        value: Zeroizing::new(value),
    })
}

/// Evidence consumed by HOST-226. The caller has already bound an application
/// release to the same owner/project/database generation.
#[derive(Clone, Debug, Serialize)]
pub(crate) struct VerifiedMigrationGate {
    pub migration_id: Uuid,
    pub migration_revision: String,
    pub migration_digest: String,
    pub pre_migration_archive_id: Uuid,
    pub source_data_generation: u64,
    pub current_schema_revision: String,
    pub candidate_schema_revision: String,
    pub current_binary_digest: String,
    pub retained_binary_evidence: Value,
    pub compatibility_evidence: Value,
    pub once_effect_id: Option<Uuid>,
    pub live_apply_operation_id: Option<Uuid>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct MigrationArtifact {
    pub build_job_id: Uuid,
    pub artifact_id: Uuid,
    pub service_id: Uuid,
    pub application_archive_digest: String,
    pub manifest_digest: String,
    pub migration_entry_path: String,
    pub file_digest: String,
}

pub(crate) struct MigrationTrialRequest {
    pub account_id: Uuid,
    pub project_id: Uuid,
    pub tenant_database_id: Uuid,
    pub database_generation: Uuid,
    pub deployment_id: Uuid,
    pub configuration_revision_id: Uuid,
    pub migration_revision: String,
    pub migration_digest: String,
    pub current_schema_revision: String,
    pub candidate_schema_revision: String,
    pub current_binary_digest: String,
    pub retained_binary_digests: Vec<String>,
    pub artifact: MigrationArtifact,
}

pub(crate) async fn request_pre_migration_backup(
    state: &FoundationState,
    account_id: Uuid,
    project_id: Uuid,
    tenant_database_id: Uuid,
    database_generation: Uuid,
    migration_revision: &str,
) -> Result<Uuid, ApiError> {
    m3::require_enabled(state)?;
    if migration_revision.is_empty() || migration_revision.len() > 256 {
        return Err(ApiError::unprocessable(
            "invalid_migration_revision",
            "the migration revision is invalid",
        ));
    }
    let policy_time = m3::policy_now(state).await?;
    let mut tx = state.pool.begin().await?;
    let source_data_generation:Option<i64>=sqlx::query_scalar(
        "SELECT source_data_generation FROM tenant_databases WHERE account_id=$1 AND project_id=$2 AND id=$3 AND generation=$4 AND state IN ('ready','recovery_attention') FOR UPDATE",
    ).bind(account_id).bind(project_id).bind(tenant_database_id).bind(database_generation).fetch_optional(&mut *tx).await?;
    let source_data_generation = source_data_generation.ok_or_else(ApiError::not_found)?;
    if let Some(existing)=sqlx::query_scalar::<_,Uuid>(
        "SELECT id FROM tenant_database_archives WHERE tenant_database_id=$1 AND database_generation=$2 AND kind='pre_migration' AND intended_migration_revision=$3 AND source_data_generation=$4",
    ).bind(tenant_database_id).bind(database_generation).bind(migration_revision).bind(source_data_generation).fetch_optional(&mut *tx).await?{
        tx.commit().await?;
        return Ok(existing);
    }
    let archive_id = Uuid::new_v4();
    let expires_at = policy_time + Duration::days(BACKUP_RETENTION_DAYS);
    insert_archive(
        &mut tx,
        ArchiveInsert {
            id: archive_id,
            account_id,
            project_id,
            database_id: tenant_database_id,
            generation: database_generation,
            kind: "pre_migration",
            scheduled_for: None,
            intended_migration_revision: Some(migration_revision),
            source_data_generation,
            expires_at,
        },
    )
    .await?;
    let credential_id = active_credential_id(&mut tx, tenant_database_id, "backup").await?;
    let spec = archive_spec(
        tenant_database_id,
        archive_id,
        "pre_migration",
        None,
        Some(migration_revision),
        source_data_generation,
        expires_at,
    );
    insert_operation(
        &mut tx,
        OperationInsert {
            id: Uuid::new_v4(),
            account_id,
            project_id,
            database_id: tenant_database_id,
            generation: database_generation,
            kind: "backup_pre_migration",
            operation_key: &format!("{migration_revision}:{source_data_generation}"),
            spec: &spec,
            credential_ids: &[credential_id],
            policy_time,
        },
    )
    .await?;
    tx.commit().await?;
    Ok(archive_id)
}

pub(crate) async fn enqueue_migration_trial(
    state: &FoundationState,
    request: MigrationTrialRequest,
    archive_id: Uuid,
) -> Result<Uuid, ApiError> {
    m3::require_enabled(state)?;
    if !valid_prefixed_digest(&request.migration_digest)
        || !valid_prefixed_digest(&request.current_binary_digest)
        || request.retained_binary_digests.len() > 2
        || request
            .retained_binary_digests
            .iter()
            .any(|v| !valid_prefixed_digest(v))
        || request.artifact.build_job_id.is_nil()
        || request.artifact.artifact_id.is_nil()
        || request.artifact.service_id.is_nil()
        || !valid_prefixed_digest(&request.artifact.application_archive_digest)
        || !valid_prefixed_digest(&request.artifact.manifest_digest)
        || !OWNED_MIGRATION_ENTRIES.contains(&request.artifact.migration_entry_path.as_str())
        || request.artifact.file_digest != request.migration_digest
    {
        return Err(ApiError::unprocessable(
            "invalid_migration_evidence",
            "migration and binary digests must be exact SHA-256 values",
        ));
    }
    // Distinct releases may reuse the same immutable application artifact.
    // Runtime validation binds each probe to its release and allocation, not
    // merely to the artifact digest.
    let policy_time = m3::policy_now(state).await?;
    let mut tx = state.pool.begin().await?;
    // The worker records the policy-time snapshot in the verified receipt;
    // verified_at is real completion time and can differ after a clock advance.
    let archive:Option<(i64,String)>=sqlx::query_as(
        "SELECT a.source_data_generation,a.encrypted_sha256 FROM tenant_database_archives a JOIN tenant_databases d \
           ON d.account_id=a.account_id AND d.project_id=a.project_id AND d.id=a.tenant_database_id AND d.generation=a.database_generation \
         WHERE a.account_id=$1 AND a.project_id=$2 AND a.tenant_database_id=$3 AND a.database_generation=$4 AND a.id=$5 \
           AND a.kind='pre_migration' AND a.state='usable' AND a.intended_migration_revision=$6 \
           AND a.source_data_generation=d.source_data_generation AND a.snapshot_at >= $7 \
           AND a.verified_at IS NOT NULL AND a.expires_at >= $8 FOR UPDATE OF d",
    ).bind(request.account_id).bind(request.project_id).bind(request.tenant_database_id).bind(request.database_generation)
    .bind(archive_id).bind(&request.migration_revision).bind(policy_time-Duration::hours(1)).bind(policy_time)
    .fetch_optional(&mut *tx).await?;
    let (source_data_generation, _encrypted_sha256) = archive.ok_or_else(|| {
        ApiError::conflict(
            "pre_migration_backup_unavailable",
            "an exact fresh verified pre-migration backup is required",
        )
    })?;
    if let Some(existing)=sqlx::query_scalar::<_,Uuid>(
        "SELECT id FROM tenant_database_migrations WHERE tenant_database_id=$1 AND database_generation=$2 AND migration_revision=$3",
    ).bind(request.tenant_database_id).bind(request.database_generation).bind(&request.migration_revision).fetch_optional(&mut *tx).await?{
        tx.commit().await?;
        return Ok(existing);
    }
    let migration_id = Uuid::new_v4();
    let artifact = serde_json::to_value(&request.artifact).map_err(|_| ApiError::internal())?;
    let planned = json!({"phase":"planned","expected_retained_binary_digests":request.retained_binary_digests});
    sqlx::query(
        "INSERT INTO tenant_database_migrations \
         (id,account_id,project_id,tenant_database_id,database_generation,deployment_id,configuration_revision_id,\
          migration_revision,migration_digest,source_data_generation,pre_migration_archive_id,validation_operation_id,state,\
          current_schema_revision,candidate_schema_revision,current_binary_digest,migration_artifact,retained_binary_evidence,compatibility_evidence) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL,'planned',$12,$13,$14,$15,'[]'::jsonb,$16)",
    )
    .bind(migration_id)
    .bind(request.account_id)
    .bind(request.project_id)
    .bind(request.tenant_database_id)
    .bind(request.database_generation)
    .bind(request.deployment_id)
    .bind(request.configuration_revision_id)
    .bind(request.migration_revision)
    .bind(request.migration_digest)
    .bind(source_data_generation)
    .bind(archive_id)
    .bind(request.current_schema_revision)
    .bind(request.candidate_schema_revision)
    .bind(request.current_binary_digest)
    .bind(artifact)
    .bind(planned)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(migration_id)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct MaterializedMigrationTrial {
    pub release_id: Uuid,
    pub reconciliation_id: Uuid,
    pub attempt_id: Uuid,
    pub release_fence: i64,
    pub migration_id: Uuid,
    pub materialized_ref: String,
    pub stage_receipt_digest: String,
    pub policy_time: DateTime<Utc>,
}

/// Bind a release worker's verified HCA extraction to the planned migration and
/// queue the database worker's isolated populated apply. The reference is a
/// digest-derived path relative to the configured M3 state directory.
pub(crate) async fn enqueue_materialized_migration_trial(
    transaction: &mut Transaction<'_, Postgres>,
    request: &MaterializedMigrationTrial,
) -> Result<Uuid, ApiError> {
    if request.release_fence <= 0 || !valid_prefixed_digest(&request.stage_receipt_digest) {
        return Err(ApiError::unprocessable(
            "migration_materialization_invalid",
            "the authenticated migration materialization receipt is invalid",
        ));
    }
    let row: Option<PlannedMigrationRow> = sqlx::query_as(
        "SELECT m.account_id,m.project_id,m.tenant_database_id,m.database_generation,m.migration_revision,\
          m.migration_digest,m.source_data_generation,m.current_schema_revision,m.candidate_schema_revision,\
          m.migration_artifact,m.pre_migration_archive_id,a.encrypted_sha256 \
         FROM tenant_database_migrations m JOIN tenant_database_archives a ON a.id=m.pre_migration_archive_id \
          AND a.account_id=m.account_id AND a.project_id=m.project_id AND a.tenant_database_id=m.tenant_database_id \
          AND a.database_generation=m.database_generation \
         WHERE m.id=$1 AND m.state='planned' AND a.state='usable' AND a.expires_at>=$2 FOR UPDATE OF m",
    )
    .bind(request.migration_id)
    .bind(request.policy_time)
    .fetch_optional(&mut **transaction)
    .await?;
    let Some(row) = row else {
        return Err(ApiError::conflict(
            "migration_plan_unavailable",
            "the exact planned migration and backup are unavailable",
        ));
    };
    let expected_ref = migration_materialized_ref(&row.migration_digest)?;
    if request.materialized_ref != expected_ref {
        return Err(ApiError::unprocessable(
            "migration_materialization_ref_invalid",
            "the migration artifact reference is not derived from its exact digest",
        ));
    }
    let release_bound: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM tenant_database_migrations m \
          JOIN application_releases r ON r.migration_id=m.id \
          JOIN release_reconciliations rr ON rr.release_id=r.id AND rr.account_id=r.account_id AND rr.project_id=r.project_id \
          JOIN release_reconciliation_attempts ra ON ra.reconciliation_id=rr.id AND ra.release_id=r.id \
            AND ra.account_id=r.account_id AND ra.project_id=r.project_id \
          JOIN build_artifacts ba ON ba.id=(m.migration_artifact->>'artifact_id')::uuid \
          WHERE m.id=$1 AND r.id=$2 AND r.build_job_id=(m.migration_artifact->>'build_job_id')::uuid \
            AND ba.job_id=r.build_job_id AND ba.service_id=(m.migration_artifact->>'service_id')::uuid \
            AND ba.kind='application' AND ba.archive_digest=m.migration_artifact->>'application_archive_digest' \
            AND ba.manifest_digest=m.migration_artifact->>'manifest_digest' AND ba.cas_state='registered' \
            AND rr.id=$3 AND rr.state='running' AND rr.current_attempt_id=$4 AND rr.current_fence=$5 \
            AND rr.lease_expires_at>clock_timestamp() AND ra.id=$4 AND ra.fence=$5 AND ra.state='running' \
            AND ra.lease_expires_at>clock_timestamp())",
    )
    .bind(request.migration_id)
    .bind(request.release_id)
    .bind(request.reconciliation_id)
    .bind(request.attempt_id)
    .bind(request.release_fence)
    .fetch_one(&mut **transaction)
    .await?;
    if !release_bound {
        return Err(ApiError::conflict(
            "migration_materialization_unbound",
            "the materialized migration is not bound to the live release attempt and HCA",
        ));
    }
    let materialized_artifact = json!({
        "build_job_id": row.migration_artifact.get("build_job_id").cloned().ok_or_else(ApiError::internal)?,
        "artifact_id": row.migration_artifact.get("artifact_id").cloned().ok_or_else(ApiError::internal)?,
        "service_id": row.migration_artifact.get("service_id").cloned().ok_or_else(ApiError::internal)?,
        "application_archive_digest": row.migration_artifact.get("application_archive_digest").cloned().ok_or_else(ApiError::internal)?,
        "manifest_digest": row.migration_artifact.get("manifest_digest").cloned().ok_or_else(ApiError::internal)?,
        "migration_entry_path": row.migration_artifact.get("migration_entry_path").cloned().ok_or_else(ApiError::internal)?,
        "file_digest": row.migration_artifact.get("file_digest").cloned().ok_or_else(ApiError::internal)?,
        "materialized_ref": request.materialized_ref,
        "stage_receipt_digest": request.stage_receipt_digest
    });
    let operation_id = Uuid::new_v4();
    let credentials = active_credential_ids(transaction, row.tenant_database_id).await?;
    let spec = json!({
        "migration_id":request.migration_id,"archive_id":row.pre_migration_archive_id,
        "repository_namespace":repository_namespace(row.tenant_database_id),"encrypted_sha256":row.encrypted_sha256,
        "migration_revision":row.migration_revision,"migration_digest":row.migration_digest,
        "source_data_generation":row.source_data_generation,"current_schema_revision":row.current_schema_revision,
        "candidate_schema_revision":row.candidate_schema_revision,"artifact":materialized_artifact
    });
    insert_operation(
        transaction,
        OperationInsert {
            id: operation_id,
            account_id: row.account_id,
            project_id: row.project_id,
            database_id: row.tenant_database_id,
            generation: row.database_generation,
            kind: "migration_trial",
            operation_key: &request.migration_id.to_string(),
            spec: &spec,
            credential_ids: &credentials,
            policy_time: request.policy_time,
        },
    )
    .await?;
    sqlx::query("UPDATE tenant_database_migrations SET migration_artifact=$2,validation_operation_id=$3,updated_at=clock_timestamp() WHERE id=$1 AND state='planned'")
        .bind(request.migration_id).bind(materialized_artifact).bind(operation_id).execute(&mut **transaction).await?;
    Ok(operation_id)
}

#[allow(
    clippy::too_many_arguments,
    reason = "the release gate keeps every ownership and migration fence explicit for cross-module callers"
)]
pub(crate) async fn verified_migration_gate(
    pool: &PgPool,
    account_id: Uuid,
    project_id: Uuid,
    tenant_database_id: Uuid,
    database_generation: Uuid,
    deployment_id: Uuid,
    migration_revision: &str,
    migration_digest: &str,
    policy_time: DateTime<Utc>,
) -> Result<VerifiedMigrationGate, ApiError> {
    let row: Option<MigrationGateRow> = sqlx::query_as(
        "SELECT m.id,m.migration_revision,m.migration_digest,m.pre_migration_archive_id,m.source_data_generation,\
          m.current_schema_revision,m.candidate_schema_revision,m.current_binary_digest,m.retained_binary_evidence,\
          m.compatibility_evidence,m.once_effect_id,(SELECT o.id FROM tenant_database_operations o \
            WHERE o.tenant_database_id=m.tenant_database_id AND o.database_generation=m.database_generation \
              AND o.kind='migration_live_apply' AND o.operation_key=m.id::text ORDER BY o.created_at DESC LIMIT 1) AS live_apply_operation_id \
          FROM tenant_database_migrations m \
         JOIN tenant_database_archives a ON a.account_id=m.account_id AND a.project_id=m.project_id \
           AND a.tenant_database_id=m.tenant_database_id AND a.database_generation=m.database_generation \
           AND a.id=m.pre_migration_archive_id \
         WHERE m.account_id=$1 AND m.project_id=$2 AND m.tenant_database_id=$3 AND m.database_generation=$4 \
           AND m.deployment_id=$5 AND m.migration_revision=$6 AND m.migration_digest=$7 \
           AND m.state='applied' AND a.kind='pre_migration' AND a.state='usable' \
           AND a.intended_migration_revision=m.migration_revision AND a.source_data_generation=m.source_data_generation \
           AND a.verified_at IS NOT NULL AND a.expires_at >= $8",
    ).bind(account_id).bind(project_id).bind(tenant_database_id).bind(database_generation)
    .bind(deployment_id).bind(migration_revision).bind(migration_digest).bind(policy_time)
    .fetch_optional(pool).await?;
    let Some(row) = row else {
        return Err(ApiError::conflict(
            "migration_evidence_unavailable",
            "the exact populated migration has no current verified compatibility evidence",
        ));
    };
    let expected_retained = row
        .compatibility_evidence
        .get("expected_retained_count")
        .and_then(Value::as_u64)
        .and_then(|v| usize::try_from(v).ok())
        .unwrap_or(usize::MAX);
    if !retained_evidence_passed(&row.retained_binary_evidence, expected_retained)
        || !compatibility_evidence_passed(&row.compatibility_evidence)
    {
        return Err(ApiError::conflict(
            "migration_incompatible",
            "a current or retained application binary did not pass populated compatibility",
        ));
    }
    Ok(VerifiedMigrationGate {
        migration_id: row.id,
        migration_revision: row.migration_revision,
        migration_digest: row.migration_digest,
        pre_migration_archive_id: row.pre_migration_archive_id,
        source_data_generation: to_u64(row.source_data_generation)?,
        current_schema_revision: row.current_schema_revision,
        candidate_schema_revision: row.candidate_schema_revision,
        current_binary_digest: row.current_binary_digest,
        retained_binary_evidence: row.retained_binary_evidence,
        compatibility_evidence: row.compatibility_evidence,
        once_effect_id: row.once_effect_id,
        live_apply_operation_id: row.live_apply_operation_id,
    })
}

/// Record the live migration effect once from the fenced database operation
/// completion. Release reconciliation cannot call this transition directly.
async fn record_migration_applied_once(
    transaction: &mut Transaction<'_, Postgres>,
    migration_id: Uuid,
    once_effect_id: Uuid,
) -> Result<(), ApiError> {
    let updated = sqlx::query_as::<_, (Uuid, Uuid, i64)>(
        "UPDATE tenant_database_migrations SET state='applied',once_effect_id=$2,applied_at=clock_timestamp(),updated_at=clock_timestamp() \
         WHERE id=$1 AND state='isolated_validated' \
         RETURNING tenant_database_id,database_generation,source_data_generation",
    ).bind(migration_id).bind(once_effect_id).fetch_optional(&mut **transaction).await?;
    if let Some((database_id, database_generation, source_data_generation)) = updated {
        let advanced = sqlx::query(
            "UPDATE tenant_databases SET source_data_generation=source_data_generation+1,revision=revision+1,updated_at=clock_timestamp() \
             WHERE id=$1 AND generation=$2 AND source_data_generation=$3",
        ).bind(database_id).bind(database_generation).bind(source_data_generation).execute(&mut **transaction).await?;
        if advanced.rows_affected() != 1 {
            return Err(ApiError::conflict(
                "migration_source_generation_changed",
                "tenant data changed outside the exact isolated migration generation",
            ));
        }
        return Ok(());
    }
    let existing: Option<Uuid> = sqlx::query_scalar(
        "SELECT once_effect_id FROM tenant_database_migrations WHERE id=$1 AND state='applied'",
    )
    .bind(migration_id)
    .fetch_optional(&mut **transaction)
    .await?
    .flatten();
    if existing == Some(once_effect_id) {
        Ok(())
    } else {
        Err(ApiError::conflict(
            "migration_effect_conflict",
            "the migration was already completed by another effect",
        ))
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct MigrationProbeReceipt {
    pub application_release_id: Uuid,
    pub artifact_digest: String,
    pub runtime_allocation_id: Uuid,
    pub runtime_generation: i64,
    pub runtime_fence: i64,
    pub database_generation: Uuid,
    pub migration_id: Uuid,
    pub migration_digest: String,
    pub probe_kind: String,
    pub probe_receipt_digest: String,
    pub observed_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CrossVersionProbeReceipt {
    pub frontend_release_id: Uuid,
    pub api_release_id: Uuid,
    pub receipt_digest: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct MigrationRuntimeValidation {
    pub release_id: Uuid,
    pub reconciliation_id: Uuid,
    pub attempt_id: Uuid,
    pub release_fence: i64,
    pub migration_id: Uuid,
    pub migration_apply_receipt_digest: String,
    pub probe_receipts: Vec<MigrationProbeReceipt>,
    pub cross_version_receipts: Vec<CrossVersionProbeReceipt>,
    pub validated_at: DateTime<Utc>,
}

/// Called only from the release reconciler's authenticated, live fenced
/// completion transaction. It independently matches every receipt to the staged
/// candidate plus all currently retained rollback releases and runtime fences.
pub(crate) async fn record_migration_runtime_validation(
    transaction: &mut Transaction<'_, Postgres>,
    validation: &MigrationRuntimeValidation,
) -> Result<VerifiedMigrationGate, ApiError> {
    if validation.release_fence <= 0
        || !valid_prefixed_digest(&validation.migration_apply_receipt_digest)
        || validation.probe_receipts.is_empty()
    {
        return Err(ApiError::unprocessable(
            "migration_runtime_evidence_invalid",
            "authenticated populated runtime probe evidence is incomplete",
        ));
    }
    let migration: Option<PreparedMigrationRow> = sqlx::query_as(
        "SELECT m.account_id,m.project_id,m.database_generation,m.migration_revision,m.migration_digest,m.pre_migration_archive_id,\
          m.source_data_generation,m.current_schema_revision,m.candidate_schema_revision,m.current_binary_digest,m.compatibility_evidence,\
          m.migration_artifact,m.tenant_database_id,m.deployment_id FROM tenant_database_migrations m \
         WHERE m.id=$1 AND m.state='trial_prepared' FOR UPDATE",
    ).bind(validation.migration_id).fetch_optional(&mut **transaction).await?;
    let Some(PreparedMigrationRow {
        account_id,
        project_id,
        database_generation,
        migration_revision,
        migration_digest,
        pre_migration_archive_id: archive_id,
        source_data_generation: data_generation,
        current_schema_revision: current_schema,
        candidate_schema_revision: candidate_schema,
        current_binary_digest: current_binary,
        compatibility_evidence: prepared,
        migration_artifact,
        tenant_database_id,
        deployment_id,
    }) = migration
    else {
        return Err(ApiError::conflict(
            "migration_trial_not_prepared",
            "the exact isolated migration trial is not prepared",
        ));
    };
    if prepared
        .get("migration_apply_receipt_digest")
        .and_then(Value::as_str)
        != Some(validation.migration_apply_receipt_digest.as_str())
    {
        return Err(ApiError::conflict(
            "migration_trial_apply_receipt_mismatch",
            "runtime probes are not bound to the exact isolated database apply receipt",
        ));
    }
    let release_matches:bool=sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM application_releases r \
          JOIN release_reconciliations rr ON rr.account_id=r.account_id AND rr.project_id=r.project_id AND rr.release_id=r.id \
          JOIN release_reconciliation_attempts ra ON ra.account_id=rr.account_id AND ra.project_id=rr.project_id \
            AND ra.release_id=rr.release_id AND ra.reconciliation_id=rr.id \
          WHERE r.id=$1 AND r.account_id=$2 AND r.project_id=$3 AND r.deployment_id=$4 AND r.migration_id=$5 \
            AND r.tenant_database_id=$6 AND r.database_generation=$7 AND r.state='staged' \
            AND rr.id=$8 AND rr.state='running' AND rr.current_attempt_id=$9 AND rr.current_fence=$10 \
            AND ra.id=$9 AND ra.fence=$10 AND ra.state='running' AND rr.lease_expires_at>clock_timestamp() \
            AND ra.lease_expires_at>clock_timestamp())",
    ).bind(validation.release_id).bind(account_id).bind(project_id).bind(deployment_id).bind(validation.migration_id)
    .bind(tenant_database_id).bind(database_generation).bind(validation.reconciliation_id)
    .bind(validation.attempt_id).bind(validation.release_fence).fetch_one(&mut **transaction).await?;
    if !release_matches {
        return Err(ApiError::conflict(
            "migration_release_mismatch",
            "the migration evidence is not bound to the staged release",
        ));
    }

    let expected:Vec<(Uuid,String,Uuid,i64,i64,String)>=sqlx::query_as(
        "WITH expected_releases AS ((\
           SELECT id,backend_digest,runtime_allocation_id,'candidate'::text AS probe_kind,0 AS rank \
             FROM application_releases WHERE id=$1) \
           UNION ALL (\
           SELECT r.id,r.backend_digest,r.runtime_allocation_id,\
             CASE WHEN route.release_id=r.id THEN 'current' ELSE 'retained' END,\
             row_number() OVER (ORDER BY r.promoted_at DESC,r.id DESC)::integer \
             FROM application_releases r LEFT JOIN project_release_routes route ON route.project_id=r.project_id \
             WHERE r.account_id=$2 AND r.project_id=$3 AND r.id<>$1 AND r.state='healthy' \
               AND r.promoted_at IS NOT NULL AND r.backend_digest IS NOT NULL AND r.runtime_allocation_id IS NOT NULL \
             ORDER BY r.promoted_at DESC,r.id DESC LIMIT 3)\
         ) SELECT e.id,e.backend_digest,a.id,a.generation,a.fence,e.probe_kind \
           FROM expected_releases e JOIN runtime_allocations a ON a.id=e.runtime_allocation_id \
          WHERE e.backend_digest IS NOT NULL ORDER BY e.id",
    ).bind(validation.release_id).bind(account_id).bind(project_id).fetch_all(&mut **transaction).await?;
    if expected.is_empty()
        || expected
            .iter()
            .all(|(_, _, _, _, _, kind)| kind != "candidate")
    {
        return Err(ApiError::conflict(
            "migration_runtime_targets_missing",
            "the candidate or retained runtime targets are unavailable",
        ));
    }
    let mut observed = HashSet::new();
    let mut retained_json = Vec::new();
    for (release_id, artifact_digest, allocation_id, generation, fence, kind) in &expected {
        let receipt = validation.probe_receipts.iter().find(|receipt| {
            receipt.application_release_id == *release_id
                && receipt.artifact_digest == *artifact_digest
                && receipt.runtime_allocation_id == *allocation_id
                && receipt.runtime_generation == *generation
                && receipt.runtime_fence == *fence
                && receipt.database_generation == database_generation
                && receipt.migration_id == validation.migration_id
                && receipt.migration_digest == migration_digest
                && receipt.probe_kind == *kind
                && valid_prefixed_digest(&receipt.probe_receipt_digest)
        });
        let Some(receipt) = receipt else {
            return Err(ApiError::conflict(
                "migration_runtime_evidence_incomplete",
                "a candidate, current, or retained runtime probe receipt is missing",
            ));
        };
        if !observed.insert(receipt.application_release_id) {
            return Err(ApiError::unprocessable(
                "migration_runtime_evidence_duplicate",
                "runtime probe receipts must be unique per release",
            ));
        }
        if kind != "candidate" {
            retained_json.push(json!({"application_release_id":release_id,"binary_digest":artifact_digest,
                "runtime_allocation_id":allocation_id,"runtime_generation":generation,"runtime_fence":fence,
                "schema_revision":candidate_schema,"read_ok":true,"write_ok":true,"probe_receipt_digest":receipt.probe_receipt_digest}));
        }
    }
    if observed.len() != validation.probe_receipts.len() {
        return Err(ApiError::unprocessable(
            "migration_runtime_evidence_unexpected",
            "an unexpected runtime probe receipt was supplied",
        ));
    }
    let expected_release_ids: HashSet<_> = expected.iter().map(|v| v.0).collect();
    let cross_pairs: HashSet<_> = validation
        .cross_version_receipts
        .iter()
        .map(|receipt| (receipt.frontend_release_id, receipt.api_release_id))
        .collect();
    let expected_pair_count = expected_release_ids.len() * (expected_release_ids.len() - 1);
    if validation.cross_version_receipts.len() != expected_pair_count
        || cross_pairs.len() != expected_pair_count
        || validation.cross_version_receipts.iter().any(|receipt| {
            receipt.frontend_release_id == receipt.api_release_id
                || !expected_release_ids.contains(&receipt.frontend_release_id)
                || !expected_release_ids.contains(&receipt.api_release_id)
                || !valid_prefixed_digest(&receipt.receipt_digest)
        })
        || expected_release_ids.iter().any(|left| {
            expected_release_ids
                .iter()
                .any(|right| left != right && !cross_pairs.contains(&(*left, *right)))
        })
    {
        return Err(ApiError::conflict(
            "migration_cross_version_evidence_incomplete",
            "every retained frontend and API pairing requires an authenticated probe receipt",
        ));
    }
    let current_matches = expected
        .iter()
        .any(|(_, digest, _, _, _, kind)| kind == "current" && digest == &current_binary);
    let mut expected_retained: Vec<String> = prepared
        .get("expected_retained_binary_digests")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    let mut actual_retained: Vec<String> = expected
        .iter()
        .filter(|(_, _, _, _, _, kind)| kind == "retained")
        .map(|(_, digest, _, _, _, _)| digest.clone())
        .collect();
    expected_retained.sort_unstable();
    actual_retained.sort_unstable();
    if !current_matches || expected_retained != actual_retained {
        return Err(ApiError::conflict(
            "migration_runtime_targets_changed",
            "the current or retained release set differs from the planned migration evidence",
        ));
    }
    let compatibility = json!({"phase":"isolated_validated","prepared":prepared,"release_id":validation.release_id,
        "reconciliation_id":validation.reconciliation_id,"attempt_id":validation.attempt_id,"release_fence":validation.release_fence,
        "migration_apply_receipt_digest":validation.migration_apply_receipt_digest,"probe_receipts":validation.probe_receipts,
        "cross_version_receipts":validation.cross_version_receipts,"expected_retained_count":retained_json.len(),"populated":true,"current_binary_read_ok":true,
        "current_binary_write_ok":true,"application_connection_verified":true,"source_unchanged":true});
    sqlx::query("UPDATE tenant_database_migrations SET state='isolated_validated',retained_binary_evidence=$2,compatibility_evidence=$3,validated_at=$4,updated_at=clock_timestamp() WHERE id=$1 AND state='trial_prepared'")
        .bind(validation.migration_id).bind(Value::Array(retained_json.clone())).bind(compatibility.clone()).bind(validation.validated_at)
        .execute(&mut **transaction).await?;
    let live_apply_operation_id = Uuid::new_v4();
    let migration_credential =
        active_credential_id(transaction, tenant_database_id, "migration").await?;
    let live_spec = json!({
        "migration_id": validation.migration_id,
        "migration_revision": migration_revision.clone(),
        "migration_digest": migration_digest.clone(),
        "artifact": migration_artifact,
        "expected_source_data_generation": data_generation,
        "current_schema_revision": current_schema.clone(),
        "candidate_schema_revision": candidate_schema.clone(),
        "isolated_apply_receipt_digest": validation.migration_apply_receipt_digest.clone()
    });
    insert_operation(
        transaction,
        OperationInsert {
            id: live_apply_operation_id,
            account_id,
            project_id,
            database_id: tenant_database_id,
            generation: database_generation,
            kind: "migration_live_apply",
            operation_key: &validation.migration_id.to_string(),
            spec: &live_spec,
            credential_ids: &[migration_credential],
            policy_time: validation.validated_at,
        },
    )
    .await?;
    Ok(VerifiedMigrationGate {
        migration_id: validation.migration_id,
        migration_revision,
        migration_digest,
        pre_migration_archive_id: archive_id,
        source_data_generation: to_u64(data_generation)?,
        current_schema_revision: current_schema,
        candidate_schema_revision: candidate_schema,
        current_binary_digest: current_binary,
        retained_binary_evidence: Value::Array(retained_json),
        compatibility_evidence: compatibility,
        once_effect_id: None,
        live_apply_operation_id: Some(live_apply_operation_id),
    })
}

async fn apply_completion(
    tx: &mut Transaction<'_, Postgres>,
    row: &OperationRow,
    outcome: &CompletionOutcome,
) -> Result<(), ApiError> {
    if outcome.state != "succeeded" {
        apply_unsuccessful_completion(tx, row, outcome).await?;
        return Ok(());
    }
    match row.kind.as_str() {
        "provision" => apply_provision_success(tx, row, &outcome.proof).await,
        "backup_daily" | "backup_pre_migration" | "export" => {
            apply_archive_success(tx, row, &outcome.proof).await
        }
        "restore_drill" => apply_recovery_success(tx, row, &outcome.proof).await,
        "observe_storage" => apply_storage_success(tx, row, &outcome.proof).await,
        "migration_trial" if outcome.code == "migration_trial_prepared" => {
            apply_migration_trial_success(tx, row, &outcome.proof).await
        }
        "migration_trial" => Err(ApiError::unprocessable(
            "migration_trial_code_invalid",
            "the database worker may only prepare an isolated migration trial",
        )),
        "migration_live_apply" if outcome.code == "migration_live_applied" => {
            apply_live_migration_success(tx, row, &outcome.proof).await
        }
        "migration_live_apply" => Err(ApiError::unprocessable(
            "migration_live_apply_code_invalid",
            "the database worker must report the exact controlled live migration effect",
        )),
        "archive_expire" => apply_archive_expiry_success(tx, row, &outcome.proof).await,
        _ => Err(ApiError::unprocessable(
            "invalid_database_operation",
            "the database operation kind is unsupported",
        )),
    }
}

async fn apply_provision_success(
    tx: &mut Transaction<'_, Postgres>,
    row: &OperationRow,
    proof: &Value,
) -> Result<(), ApiError> {
    for field in [
        "app_connection_verified",
        "cross_tenant_denied",
        "system_schema_denied",
        "public_access_revoked",
    ] {
        if proof.get(field).and_then(Value::as_bool) != Some(true) {
            return Err(ApiError::unprocessable(
                "invalid_provisioning_proof",
                "the provisioning proof did not establish every required isolation invariant",
            ));
        }
    }
    let grant_hash = required_sha256(proof, "role_grants_sha256")?;
    let database_ref = required_string(proof, "database_ref", 128)?;
    if row.spec.get("database_ref").and_then(Value::as_str) != Some(database_ref) {
        return Err(ApiError::unprocessable(
            "provisioning_target_mismatch",
            "the provisioning proof does not match the assigned database",
        ));
    }
    let metadata = json!({
        "role_grants_sha256": grant_hash,
        "app_connection_verified": true,
        "cross_tenant_denied": true,
        "system_schema_denied": true,
        "public_access_revoked": true
    });
    let updated = sqlx::query(
        "UPDATE tenant_databases SET state='ready',provisioning_metadata=$2,ready_at=clock_timestamp(),\
         updated_at=clock_timestamp(),revision=revision+1,last_error_code=NULL \
         WHERE id=$1 AND generation=$3 AND state IN ('provision_requested','provisioning')",
    ).bind(row.tenant_database_id).bind(metadata).bind(row.database_generation).execute(&mut **tx).await?;
    if updated.rows_affected() != 1 {
        return Err(ApiError::conflict(
            "database_generation_stale",
            "the database generation is no longer current",
        ));
    }
    Ok(())
}

async fn apply_archive_success(
    tx: &mut Transaction<'_, Postgres>,
    row: &OperationRow,
    proof: &Value,
) -> Result<(), ApiError> {
    let archive_id = value_uuid(&row.spec, "archive_id").ok_or_else(ApiError::internal)?;
    if value_uuid(proof, "archive_id") != Some(archive_id) {
        return Err(ApiError::unprocessable(
            "archive_receipt_mismatch",
            "the archive receipt does not match the operation",
        ));
    }
    let object_ref = required_string(proof, "object_ref", 512)?;
    let expected_object_ref = format!(
        "{}/{}.htb",
        repository_namespace(row.tenant_database_id),
        archive_id
    );
    if object_ref != expected_object_ref {
        return Err(ApiError::unprocessable(
            "archive_object_ref_invalid",
            "the archive receipt is outside the assigned repository namespace",
        ));
    }
    let format = required_string(proof, "format", 96)?;
    if format != ARCHIVE_FORMAT {
        return Err(ApiError::unprocessable(
            "archive_format_invalid",
            "the archive format is unsupported",
        ));
    }
    let key_id = required_string(proof, "recovery_key_id", 128)?;
    let plaintext_sha256 = required_hex_digest(proof, "plaintext_sha256")?;
    let encrypted_sha256 = required_hex_digest(proof, "encrypted_sha256")?;
    let plaintext_bytes = required_positive_i64(proof, "plaintext_bytes")?;
    let encrypted_bytes = required_positive_i64(proof, "encrypted_bytes")?;
    let snapshot_at = required_timestamp(proof, "snapshot_at")?;
    let manifest = proof
        .get("manifest")
        .filter(|v| v.is_object())
        .cloned()
        .ok_or_else(|| {
            ApiError::unprocessable(
                "archive_manifest_invalid",
                "the archive manifest is required",
            )
        })?;
    validate_manifest(&manifest, row, archive_id)?;
    let updated = sqlx::query(
        "UPDATE tenant_database_archives SET state='usable',object_ref=$2,format=$3,recovery_key_id=$4,\
         plaintext_sha256=$5,encrypted_sha256=$6,plaintext_bytes=$7,encrypted_bytes=$8,manifest=$9,\
         snapshot_at=$10,verified_at=clock_timestamp(),updated_at=clock_timestamp() \
         WHERE id=$1 AND tenant_database_id=$11 AND database_generation=$12 AND state='creating'",
    ).bind(archive_id).bind(object_ref).bind(format).bind(key_id).bind(plaintext_sha256).bind(encrypted_sha256)
    .bind(plaintext_bytes).bind(encrypted_bytes).bind(manifest).bind(snapshot_at).bind(row.tenant_database_id).bind(row.database_generation)
    .execute(&mut **tx).await?;
    if updated.rows_affected() != 1 {
        return Err(ApiError::conflict(
            "archive_generation_stale",
            "the archive no longer belongs to a current creating operation",
        ));
    }
    Ok(())
}

async fn apply_recovery_success(
    tx: &mut Transaction<'_, Postgres>,
    row: &OperationRow,
    proof: &Value,
) -> Result<(), ApiError> {
    let recovery_id = value_uuid(&row.spec, "recovery_id").ok_or_else(ApiError::internal)?;
    if value_uuid(proof, "recovery_id") != Some(recovery_id) {
        return Err(ApiError::unprocessable(
            "recovery_receipt_mismatch",
            "the recovery receipt does not match the operation",
        ));
    }
    let replacement_identity = value_uuid(proof, "replacement_identity").ok_or_else(|| {
        ApiError::unprocessable(
            "recovery_identity_missing",
            "the replacement database identity is required",
        )
    })?;
    let elapsed = required_nonnegative_i64(proof, "elapsed_milliseconds")?;
    let validation = proof
        .get("validation")
        .filter(|v| v.is_object())
        .cloned()
        .ok_or_else(|| {
            ApiError::unprocessable(
                "recovery_validation_invalid",
                "the recovery validation is required",
            )
        })?;
    for field in [
        "rows_match",
        "relationships_match",
        "grants_match",
        "application_connection_verified",
        "source_unchanged",
    ] {
        if validation.get(field).and_then(Value::as_bool) != Some(true) {
            return Err(ApiError::unprocessable(
                "recovery_validation_failed",
                "the isolated recovery did not pass every validation",
            ));
        }
    }
    let updated = sqlx::query(
        "UPDATE tenant_database_recoveries SET state='validated',replacement_ref=$2,replacement_identity=$3,\
         validation=$4,restored_at=$5,validated_at=clock_timestamp(),elapsed_milliseconds=$6,updated_at=clock_timestamp(),last_error_code=NULL \
         WHERE id=$1 AND tenant_database_id=$7 AND database_generation=$8 AND state='restoring'",
    ).bind(recovery_id).bind(required_string(proof,"replacement_ref",256)?).bind(replacement_identity).bind(validation)
    .bind(required_timestamp(proof,"restored_at")?).bind(elapsed).bind(row.tenant_database_id).bind(row.database_generation)
    .execute(&mut **tx).await?;
    if updated.rows_affected() != 1 {
        return Err(ApiError::conflict(
            "recovery_generation_stale",
            "the recovery is no longer current",
        ));
    }
    Ok(())
}

async fn apply_storage_success(
    tx: &mut Transaction<'_, Postgres>,
    row: &OperationRow,
    proof: &Value,
) -> Result<(), ApiError> {
    let exact_fields = [
        "storage_bytes",
        "storage_limit_bytes",
        "observed_at",
        "growth_mode",
        "write_denied",
        "reads_preserved",
        "export_preserved",
    ];
    if !proof.as_object().is_some_and(|object| {
        object.len() == exact_fields.len()
            && exact_fields.iter().all(|key| object.contains_key(*key))
    }) {
        return Err(ApiError::unprocessable(
            "storage_proof_invalid",
            "storage enforcement requires the exact bounded verification receipt",
        ));
    }
    let bytes = required_nonnegative_i64(proof, "storage_bytes")?;
    let limit = required_positive_i64(proof, "storage_limit_bytes")?;
    let current: Option<(String, i64)> = sqlx::query_as(
        "SELECT growth_mode,storage_limit_bytes FROM tenant_databases \
         WHERE id=$1 AND generation=$2 FOR UPDATE",
    )
    .bind(row.tenant_database_id)
    .bind(row.database_generation)
    .fetch_optional(&mut **tx)
    .await?;
    let (current_mode, durable_limit) = current.ok_or_else(ApiError::not_found)?;
    if row.spec.get("storage_limit_bytes").and_then(Value::as_i64) != Some(limit)
        || limit != durable_limit
        || limit != STORAGE_LIMIT_BYTES
    {
        return Err(ApiError::unprocessable(
            "storage_limit_mismatch",
            "the enforced storage limit does not match the admitted database limit",
        ));
    }
    let observed_at = required_timestamp(proof, "observed_at")?;
    if observed_at != row.policy_time
        || proof.get("reads_preserved").and_then(Value::as_bool) != Some(true)
        || proof.get("export_preserved").and_then(Value::as_bool) != Some(true)
    {
        return Err(ApiError::unprocessable(
            "storage_verification_failed",
            "the observation must preserve tenant reads and backup export",
        ));
    }
    let expected_mode = if current_mode == "read_only_over_limit" || bytes > limit {
        "read_only_over_limit"
    } else {
        "writable"
    };
    if proof.get("growth_mode").and_then(Value::as_str) != Some(expected_mode)
        || proof.get("write_denied").and_then(Value::as_bool)
            != Some(expected_mode == "read_only_over_limit")
    {
        return Err(ApiError::unprocessable(
            "storage_enforcement_failed",
            "the measured size and verified growth mode do not agree",
        ));
    }
    let updated = sqlx::query(
        "UPDATE tenant_databases SET growth_mode=$2,measured_storage_bytes=$3,storage_observed_at=$4,\
         revision=revision+1,updated_at=clock_timestamp() \
         WHERE id=$1 AND generation=$5 AND (growth_mode='writable' OR $2='read_only_over_limit')",
    )
    .bind(row.tenant_database_id)
    .bind(expected_mode)
    .bind(bytes)
    .bind(observed_at)
    .bind(row.database_generation)
    .execute(&mut **tx)
    .await?;
    if updated.rows_affected() != 1 {
        return Err(ApiError::conflict(
            "storage_freeze_sticky",
            "a read-only over-limit database cannot be automatically unfrozen",
        ));
    }
    Ok(())
}

async fn apply_migration_trial_success(
    tx: &mut Transaction<'_, Postgres>,
    row: &OperationRow,
    proof: &Value,
) -> Result<(), ApiError> {
    let exact_fields = [
        "migration_id",
        "archive_id",
        "replacement_identity",
        "replacement_ref",
        "prepared_at",
        "endpoint_descriptor_hash",
        "migration_file_digest",
        "schema_revision",
        "migration_apply_receipt_digest",
        "applied_at",
    ];
    if !proof.as_object().is_some_and(|object| {
        object.len() == exact_fields.len()
            && exact_fields.iter().all(|key| object.contains_key(*key))
    }) {
        return Err(ApiError::unprocessable(
            "migration_trial_proof_invalid",
            "the database worker may report only the bounded prepared-trial receipt",
        ));
    }
    let migration_id = value_uuid(&row.spec, "migration_id").ok_or_else(ApiError::internal)?;
    let archive_id = value_uuid(&row.spec, "archive_id").ok_or_else(ApiError::internal)?;
    if value_uuid(proof, "migration_id") != Some(migration_id) {
        return Err(ApiError::unprocessable(
            "migration_receipt_mismatch",
            "the migration receipt does not match the operation",
        ));
    }
    if value_uuid(proof, "archive_id") != Some(archive_id) {
        return Err(ApiError::unprocessable(
            "migration_trial_proof_invalid",
            "the prepared trial does not match the exact archive",
        ));
    }
    let replacement_identity = value_uuid(proof, "replacement_identity").ok_or_else(|| {
        ApiError::unprocessable(
            "migration_trial_proof_invalid",
            "replacement identity is required",
        )
    })?;
    let replacement_ref = required_string(proof, "replacement_ref", 256)?;
    let prepared_at = required_timestamp(proof, "prepared_at")?;
    let endpoint_descriptor_hash = required_hex_digest(proof, "endpoint_descriptor_hash")?;
    let migration_file_digest = required_string(proof, "migration_file_digest", 72)?;
    let schema_revision = required_string(proof, "schema_revision", 256)?;
    let migration_apply_receipt_digest =
        required_string(proof, "migration_apply_receipt_digest", 72)?;
    let applied_at = required_timestamp(proof, "applied_at")?;
    if !valid_prefixed_digest(migration_file_digest)
        || !valid_prefixed_digest(migration_apply_receipt_digest)
        || row.spec.get("migration_digest").and_then(Value::as_str) != Some(migration_file_digest)
        || row
            .spec
            .get("candidate_schema_revision")
            .and_then(Value::as_str)
            != Some(schema_revision)
    {
        return Err(ApiError::unprocessable(
            "migration_trial_apply_mismatch",
            "the isolated database did not apply the exact migration artifact and schema revision",
        ));
    }
    let evidence = json!({"phase":"trial_prepared","replacement_identity":replacement_identity,"replacement_ref":replacement_ref,
        "prepared_at":prepared_at,"endpoint_descriptor_hash":endpoint_descriptor_hash,
        "migration_file_digest":migration_file_digest,"schema_revision":schema_revision,
        "migration_apply_receipt_digest":migration_apply_receipt_digest,"applied_at":applied_at});
    let updated = sqlx::query(
        "UPDATE tenant_database_migrations SET state='trial_prepared',\
         compatibility_evidence=compatibility_evidence || $2,updated_at=clock_timestamp() \
         WHERE id=$1 AND account_id=$3 AND project_id=$4 AND tenant_database_id=$5 AND database_generation=$6 \
           AND pre_migration_archive_id=$7 AND validation_operation_id=$8 AND state='planned'",
    )
    .bind(migration_id)
    .bind(evidence)
    .bind(row.account_id)
    .bind(row.project_id)
    .bind(row.tenant_database_id)
    .bind(row.database_generation)
    .bind(archive_id)
    .bind(row.id)
    .execute(&mut **tx)
    .await?;
    if updated.rows_affected() != 1 {
        return Err(ApiError::conflict(
            "migration_plan_stale",
            "the planned migration is no longer bound to this trial operation",
        ));
    }
    Ok(())
}

async fn apply_live_migration_success(
    tx: &mut Transaction<'_, Postgres>,
    row: &OperationRow,
    proof: &Value,
) -> Result<(), ApiError> {
    let exact_fields = [
        "migration_id",
        "migration_file_digest",
        "migration_apply_receipt_digest",
        "schema_revision",
        "source_data_generation_before",
        "source_data_generation_after",
        "application_mode",
        "applied_at",
    ];
    if !proof.as_object().is_some_and(|object| {
        object.len() == exact_fields.len()
            && exact_fields.iter().all(|key| object.contains_key(*key))
    }) {
        return Err(ApiError::unprocessable(
            "migration_live_apply_proof_invalid",
            "live migration completion requires the exact bounded apply receipt",
        ));
    }
    let migration_id = value_uuid(&row.spec, "migration_id").ok_or_else(ApiError::internal)?;
    let before = required_positive_i64(proof, "source_data_generation_before")?;
    let after = required_positive_i64(proof, "source_data_generation_after")?;
    let expected_before = required_positive_i64(&row.spec, "expected_source_data_generation")?;
    let application_mode = required_string(proof, "application_mode", 32)?;
    if value_uuid(proof, "migration_id") != Some(migration_id)
        || required_string(proof, "migration_file_digest", 72)?
            != required_string(&row.spec, "migration_digest", 72)?
        || required_string(proof, "schema_revision", 256)?
            != required_string(&row.spec, "candidate_schema_revision", 256)?
        || !valid_prefixed_digest(required_string(
            proof,
            "migration_apply_receipt_digest",
            72,
        )?)
        || before != expected_before
        || after != before + 1
        || !matches!(application_mode, "applied" | "already_applied")
    {
        return Err(ApiError::unprocessable(
            "migration_live_apply_mismatch",
            "the live apply receipt does not match the exact isolated migration plan",
        ));
    }
    required_timestamp(proof, "applied_at")?;
    record_migration_applied_once(tx, migration_id, row.id).await
}

async fn apply_archive_expiry_success(
    tx: &mut Transaction<'_, Postgres>,
    row: &OperationRow,
    proof: &Value,
) -> Result<(), ApiError> {
    let archive_id = value_uuid(&row.spec, "archive_id").ok_or_else(ApiError::internal)?;
    if value_uuid(proof, "archive_id") != Some(archive_id)
        || proof.get("authenticated").and_then(Value::as_bool) != Some(true)
        || proof.get("deleted").and_then(Value::as_bool) != Some(true)
    {
        return Err(ApiError::unprocessable(
            "archive_deletion_proof_invalid",
            "archive deletion requires authenticated exact-object proof",
        ));
    }
    let expected = required_hex_digest(&row.spec, "encrypted_sha256")?;
    if required_hex_digest(proof, "encrypted_sha256")? != expected {
        return Err(ApiError::unprocessable(
            "archive_deletion_digest_mismatch",
            "archive deletion proof digest does not match",
        ));
    }
    sqlx::query("UPDATE tenant_database_archives SET state='deleted',updated_at=clock_timestamp() WHERE id=$1 AND tenant_database_id=$2 AND database_generation=$3 AND state IN ('usable','corrupt','expired')")
        .bind(archive_id).bind(row.tenant_database_id).bind(row.database_generation).execute(&mut **tx).await?;
    Ok(())
}

async fn apply_unsuccessful_completion(
    tx: &mut Transaction<'_, Postgres>,
    row: &OperationRow,
    outcome: &CompletionOutcome,
) -> Result<(), ApiError> {
    if row.kind == "migration_trial" && outcome.state == "failed" {
        let migration_id = value_uuid(&row.spec, "migration_id").ok_or_else(ApiError::internal)?;
        sqlx::query(
            "UPDATE tenant_database_migrations SET state='failed',updated_at=clock_timestamp() \
             WHERE id=$1 AND validation_operation_id=$2 AND tenant_database_id=$3 \
               AND database_generation=$4 AND state='planned'",
        )
        .bind(migration_id)
        .bind(row.id)
        .bind(row.tenant_database_id)
        .bind(row.database_generation)
        .execute(&mut **tx)
        .await?;
    }
    if row.kind == "provision"
        && outcome
            .proof
            .get("resources_retained")
            .and_then(Value::as_bool)
            == Some(true)
    {
        sqlx::query("UPDATE tenant_databases SET state='failed_resources_retained',last_error_code=$2,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1 AND generation=$3")
            .bind(row.tenant_database_id).bind(&outcome.code).bind(row.database_generation).execute(&mut **tx).await?;
        sqlx::query("UPDATE slot_reservations sr SET state='resources_retained',retention_reason='tenant_database',updated_at=clock_timestamp() FROM tenant_databases d WHERE d.id=$1 AND sr.id=d.reservation_id AND sr.reservation_epoch=d.reservation_epoch AND sr.state <> 'released'")
            .bind(row.tenant_database_id).execute(&mut **tx).await?;
        sqlx::query("UPDATE projects p SET slot_state='resources_retained',hosted_slots=1,revision=revision+1,updated_at=clock_timestamp() FROM tenant_databases d WHERE d.id=$1 AND p.id=d.project_id AND p.account_id=d.account_id")
            .bind(row.tenant_database_id).execute(&mut **tx).await?;
    }
    if outcome.state == "failed"
        && row.kind == "restore_drill"
        && let Some(id) = value_uuid(&row.spec, "recovery_id")
    {
        sqlx::query("UPDATE tenant_database_recoveries SET state='failed',last_error_code=$2,updated_at=clock_timestamp() WHERE id=$1")
            .bind(id).bind(&outcome.code).execute(&mut **tx).await?;
    }
    if outcome.state == "failed"
        && matches!(
            row.kind.as_str(),
            "backup_daily" | "backup_pre_migration" | "export"
        )
        && let Some(id) = value_uuid(&row.spec, "archive_id")
    {
        sqlx::query("UPDATE tenant_database_archives SET state='corrupt',updated_at=clock_timestamp() WHERE id=$1 AND state='creating'")
            .bind(id).execute(&mut **tx).await?;
    }
    Ok(())
}

struct OperationInsert<'a> {
    id: Uuid,
    account_id: Uuid,
    project_id: Uuid,
    database_id: Uuid,
    generation: Uuid,
    kind: &'a str,
    operation_key: &'a str,
    spec: &'a Value,
    credential_ids: &'a [Uuid],
    policy_time: DateTime<Utc>,
}

async fn insert_operation(
    tx: &mut Transaction<'_, Postgres>,
    input: OperationInsert<'_>,
) -> Result<(), ApiError> {
    sqlx::query(
        "INSERT INTO tenant_database_operations \
         (id,account_id,project_id,tenant_database_id,database_generation,kind,operation_key,spec,credential_ids,policy_time) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
    ).bind(input.id).bind(input.account_id).bind(input.project_id).bind(input.database_id).bind(input.generation)
    .bind(input.kind).bind(input.operation_key).bind(input.spec).bind(input.credential_ids).bind(input.policy_time)
    .execute(&mut **tx).await?;
    Ok(())
}

struct ArchiveInsert<'a> {
    id: Uuid,
    account_id: Uuid,
    project_id: Uuid,
    database_id: Uuid,
    generation: Uuid,
    kind: &'a str,
    scheduled_for: Option<NaiveDate>,
    intended_migration_revision: Option<&'a str>,
    source_data_generation: i64,
    expires_at: DateTime<Utc>,
}

async fn insert_archive(
    tx: &mut Transaction<'_, Postgres>,
    input: ArchiveInsert<'_>,
) -> Result<(), ApiError> {
    sqlx::query(
        "INSERT INTO tenant_database_archives \
         (id,account_id,project_id,tenant_database_id,database_generation,kind,scheduled_for,intended_migration_revision,source_data_generation,expires_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
    ).bind(input.id).bind(input.account_id).bind(input.project_id).bind(input.database_id).bind(input.generation)
    .bind(input.kind).bind(input.scheduled_for).bind(input.intended_migration_revision).bind(input.source_data_generation).bind(input.expires_at)
    .execute(&mut **tx).await?;
    Ok(())
}

#[allow(
    clippy::too_many_arguments,
    reason = "credential encryption AAD deliberately receives every ownership and generation fence explicitly"
)]
async fn create_credential(
    state: &FoundationState,
    tx: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    project_id: Uuid,
    database_id: Uuid,
    generation: Uuid,
    purpose: &str,
    role_ref: &str,
    database_ref: &str,
) -> Result<Uuid, ApiError> {
    let key = state
        .secret_key
        .as_deref()
        .ok_or_else(ApiError::foundation_unavailable)?;
    let credential_id = Uuid::new_v4();
    let mut password_bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut password_bytes);
    let password = URL_SAFE_NO_PAD.encode(password_bytes);
    password_bytes.zeroize();
    let plaintext = Zeroizing::new(
        serde_json::to_string(
            &json!({"database_ref":database_ref,"role_ref":role_ref,"password":password}),
        )
        .map_err(|_| ApiError::internal())?,
    );
    let aad = credential_aad(
        account_id,
        project_id,
        database_id,
        generation,
        purpose,
        credential_id,
    );
    let encrypted = key
        .encrypt(&aad, plaintext.as_bytes())
        .map_err(|_| ApiError::foundation_unavailable())?;
    sqlx::query(
        "INSERT INTO tenant_database_credentials \
         (id,account_id,project_id,tenant_database_id,database_generation,purpose,role_ref,key_version,nonce,ciphertext,auth_tag) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
    ).bind(credential_id).bind(account_id).bind(project_id).bind(database_id).bind(generation).bind(purpose).bind(role_ref)
    .bind(key.key_version()).bind(encrypted.nonce.as_slice()).bind(encrypted.ciphertext).bind(encrypted.auth_tag.as_slice())
    .execute(&mut **tx).await?;
    Ok(credential_id)
}

pub(crate) fn credential_aad(
    account_id: Uuid,
    project_id: Uuid,
    database_id: Uuid,
    generation: Uuid,
    purpose: &str,
    credential_id: Uuid,
) -> Vec<u8> {
    format!(
        "hostlet-tenant-database-credential/v1\0{account_id}\0{project_id}\0{database_id}\0{generation}\0{purpose}\0{credential_id}"
    ).into_bytes()
}

async fn active_credential_id(
    tx: &mut Transaction<'_, Postgres>,
    database_id: Uuid,
    purpose: &str,
) -> Result<Uuid, ApiError> {
    sqlx::query_scalar("SELECT id FROM tenant_database_credentials WHERE tenant_database_id=$1 AND purpose=$2 AND status='active'")
        .bind(database_id).bind(purpose).fetch_optional(&mut **tx).await?.ok_or_else(ApiError::foundation_unavailable)
}

async fn active_credential_ids(
    tx: &mut Transaction<'_, Postgres>,
    database_id: Uuid,
) -> Result<Vec<Uuid>, ApiError> {
    let rows: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM tenant_database_credentials WHERE tenant_database_id=$1 AND status='active' ORDER BY purpose",
    ).bind(database_id).fetch_all(&mut **tx).await?;
    if rows.len() != 3 {
        return Err(ApiError::foundation_unavailable());
    }
    Ok(rows)
}

async fn active_credential_scope(
    tx: &mut Transaction<'_, Postgres>,
    database_id: Uuid,
) -> Result<(Vec<Uuid>, Value), ApiError> {
    let rows: Vec<(Uuid, String, String)> = sqlx::query_as(
        "SELECT id,purpose,role_ref FROM tenant_database_credentials \
         WHERE tenant_database_id=$1 AND status='active' ORDER BY purpose",
    )
    .bind(database_id)
    .fetch_all(&mut **tx)
    .await?;
    if rows.len() != 3 {
        return Err(ApiError::foundation_unavailable());
    }
    let mut runtime = None;
    let mut migration = None;
    let mut backup = None;
    let credential_ids = rows
        .into_iter()
        .map(|(id, purpose, role_ref)| {
            match purpose.as_str() {
                "runtime" => runtime = Some(role_ref),
                "migration" => migration = Some(role_ref),
                "backup" => backup = Some(role_ref),
                _ => return Err(ApiError::foundation_unavailable()),
            }
            Ok(id)
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    let role_refs = json!({
        "runtime": runtime.ok_or_else(ApiError::foundation_unavailable)?,
        "migration": migration.ok_or_else(ApiError::foundation_unavailable)?,
        "backup": backup.ok_or_else(ApiError::foundation_unavailable)?
    });
    Ok((credential_ids, role_refs))
}

async fn fetch_database_by_service(
    tx: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    project_id: Uuid,
    service_id: Uuid,
) -> Result<Option<TenantDatabaseRow>, ApiError> {
    fetch_database_query(account_id, project_id, Some(service_id), None, false)
        .fetch_optional(&mut **tx)
        .await
        .map_err(ApiError::from)
}

async fn fetch_database_by_service_for_update(
    tx: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    project_id: Uuid,
    service_id: Uuid,
) -> Result<Option<TenantDatabaseRow>, ApiError> {
    fetch_database_query(account_id, project_id, Some(service_id), None, true)
        .fetch_optional(&mut **tx)
        .await
        .map_err(ApiError::from)
}

async fn fetch_database_by_id(
    tx: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    project_id: Uuid,
    database_id: Uuid,
) -> Result<Option<TenantDatabaseRow>, ApiError> {
    fetch_database_query(account_id, project_id, None, Some(database_id), false)
        .fetch_optional(&mut **tx)
        .await
        .map_err(ApiError::from)
}

fn fetch_database_query(
    account_id: Uuid,
    project_id: Uuid,
    service_id: Option<Uuid>,
    database_id: Option<Uuid>,
    for_update: bool,
) -> sqlx::query::QueryAs<'static, Postgres, TenantDatabaseRow, sqlx::postgres::PgArguments> {
    let sql = if for_update {
        "SELECT d.id,d.project_id,d.service_id,d.configuration_revision_id,d.first_deployment_id,d.reservation_id,\
          d.reservation_epoch,d.generation,d.state,d.postgres_major,d.application_connection_limit,d.storage_limit_bytes,\
          d.source_data_generation,d.growth_mode,d.measured_storage_bytes,d.storage_observed_at,d.revision,d.last_error_code,\
          (SELECT max(a.snapshot_at) FROM tenant_database_archives a WHERE a.tenant_database_id=d.id AND a.database_generation=d.generation AND a.kind='daily' AND a.state='usable') AS last_usable_backup_at,\
          (SELECT max(r.validated_at) FROM tenant_database_recoveries r WHERE r.tenant_database_id=d.id AND r.database_generation=d.generation AND r.state IN ('validated','cleaned')) AS last_successful_drill_at,\
          d.created_at,d.updated_at,d.ready_at FROM tenant_databases d \
         WHERE d.account_id=$1 AND d.project_id=$2 AND ($3::uuid IS NULL OR d.service_id=$3) AND ($4::uuid IS NULL OR d.id=$4) AND d.state <> 'removed' FOR UPDATE OF d"
    } else {
        "SELECT d.id,d.project_id,d.service_id,d.configuration_revision_id,d.first_deployment_id,d.reservation_id,\
          d.reservation_epoch,d.generation,d.state,d.postgres_major,d.application_connection_limit,d.storage_limit_bytes,\
          d.source_data_generation,d.growth_mode,d.measured_storage_bytes,d.storage_observed_at,d.revision,d.last_error_code,\
          (SELECT max(a.snapshot_at) FROM tenant_database_archives a WHERE a.tenant_database_id=d.id AND a.database_generation=d.generation AND a.kind='daily' AND a.state='usable') AS last_usable_backup_at,\
          (SELECT max(r.validated_at) FROM tenant_database_recoveries r WHERE r.tenant_database_id=d.id AND r.database_generation=d.generation AND r.state IN ('validated','cleaned')) AS last_successful_drill_at,\
          d.created_at,d.updated_at,d.ready_at FROM tenant_databases d \
         WHERE d.account_id=$1 AND d.project_id=$2 AND ($3::uuid IS NULL OR d.service_id=$3) AND ($4::uuid IS NULL OR d.id=$4) AND d.state <> 'removed'"
    };
    sqlx::query_as(sql)
        .bind(account_id)
        .bind(project_id)
        .bind(service_id)
        .bind(database_id)
}

async fn fetch_archive(
    tx: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    project_id: Uuid,
    archive_id: Uuid,
) -> Result<Option<ArchiveRow>, ApiError> {
    sqlx::query_as(
        "SELECT id,tenant_database_id,database_generation,kind,state,scheduled_for,intended_migration_revision,\
          source_data_generation,snapshot_at,verified_at,expires_at,plaintext_sha256,plaintext_bytes,created_at \
         FROM tenant_database_archives WHERE account_id=$1 AND project_id=$2 AND id=$3",
    ).bind(account_id).bind(project_id).bind(archive_id).fetch_optional(&mut **tx).await.map_err(ApiError::from)
}

async fn archive_worker_metadata(
    tx: &mut Transaction<'_, Postgres>,
    archive_id: Uuid,
) -> Result<(String, String), ApiError> {
    sqlx::query_as("SELECT encrypted_sha256,object_ref FROM tenant_database_archives WHERE id=$1 AND state='usable' AND encrypted_sha256 IS NOT NULL AND object_ref IS NOT NULL")
        .bind(archive_id).fetch_optional(&mut **tx).await?.ok_or_else(|| ApiError::conflict("backup_unavailable","the selected backup has no authenticated object receipt"))
}

async fn fetch_recovery(
    tx: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    project_id: Uuid,
    recovery_id: Uuid,
) -> Result<Option<RecoveryRow>, ApiError> {
    sqlx::query_as("SELECT id,tenant_database_id,archive_id,state,policy_week,replacement_identity,validated_at,elapsed_milliseconds,last_error_code,created_at,updated_at FROM tenant_database_recoveries WHERE account_id=$1 AND project_id=$2 AND id=$3")
        .bind(account_id).bind(project_id).bind(recovery_id).fetch_optional(&mut **tx).await.map_err(ApiError::from)
}

async fn fetch_operation_for_update(
    tx: &mut Transaction<'_, Postgres>,
    operation_id: Uuid,
) -> Result<Option<OperationRow>, ApiError> {
    sqlx::query_as("SELECT id,account_id,project_id,tenant_database_id,database_generation,kind,state,spec,credential_ids,attempt_count,current_attempt_id,current_fence,lease_expires_at,policy_time,created_at,updated_at FROM tenant_database_operations WHERE id=$1 FOR UPDATE")
        .bind(operation_id).fetch_optional(&mut **tx).await.map_err(ApiError::from)
}

async fn reap_expired_operations(tx: &mut Transaction<'_, Postgres>) -> Result<(), ApiError> {
    let expired:Vec<(Uuid,Uuid,i32)>=sqlx::query_as("SELECT id,current_attempt_id,attempt_count FROM tenant_database_operations WHERE state='running' AND lease_expires_at <= clock_timestamp() ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 64")
        .fetch_all(&mut **tx).await?;
    for (operation_id, attempt_id, attempt_count) in expired {
        sqlx::query("UPDATE tenant_database_operation_attempts SET state='expired',finished_at=clock_timestamp(),terminal_code='lease_expired' WHERE operation_id=$1 AND id=$2 AND state='running'")
            .bind(operation_id).bind(attempt_id).execute(&mut **tx).await?;
        let (state, code) = if attempt_count >= 5 {
            ("failed", Some("attempts_exhausted"))
        } else {
            ("retriable", None)
        };
        sqlx::query("UPDATE tenant_database_operations SET state=$2,result=CASE WHEN $3::text IS NULL THEN result ELSE jsonb_build_object('code',$3::text) END,current_attempt_id=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=$1")
            .bind(operation_id).bind(state).bind(code).execute(&mut **tx).await?;
    }
    Ok(())
}

impl TenantDatabaseRow {
    fn into_record(self) -> Result<TenantDatabaseRecord, ApiError> {
        Ok(TenantDatabaseRecord {
            id: self.id,
            project_id: self.project_id,
            service_id: self.service_id,
            configuration_revision_id: self.configuration_revision_id,
            first_deployment_id: self.first_deployment_id,
            reservation_id: self.reservation_id,
            reservation_epoch: self.reservation_epoch,
            generation: self.generation,
            state: self.state,
            postgres_major: u16::try_from(self.postgres_major).map_err(|_| ApiError::internal())?,
            application_connection_limit: to_u32(self.application_connection_limit)?,
            storage_limit_bytes: to_u64(self.storage_limit_bytes)?,
            source_data_generation: to_u64(self.source_data_generation)?,
            growth_mode: self.growth_mode,
            measured_storage_bytes: self.measured_storage_bytes.map(to_u64).transpose()?,
            storage_observed_at: self.storage_observed_at,
            revision: to_u64(self.revision)?,
            last_error_code: self.last_error_code,
            last_usable_backup_at: self.last_usable_backup_at,
            last_successful_drill_at: self.last_successful_drill_at,
            created_at: self.created_at,
            updated_at: self.updated_at,
            ready_at: self.ready_at,
        })
    }
}

impl ArchiveRow {
    fn into_record(self) -> Result<ArchiveRecord, ApiError> {
        Ok(ArchiveRecord {
            id: self.id,
            tenant_database_id: self.tenant_database_id,
            database_generation: self.database_generation,
            kind: self.kind,
            state: self.state,
            scheduled_for: self.scheduled_for,
            intended_migration_revision: self.intended_migration_revision,
            source_data_generation: to_u64(self.source_data_generation)?,
            snapshot_at: self.snapshot_at,
            verified_at: self.verified_at,
            expires_at: self.expires_at,
            plaintext_sha256: self.plaintext_sha256,
            plaintext_bytes: self.plaintext_bytes.map(to_u64).transpose()?,
            created_at: self.created_at,
        })
    }
}

impl RecoveryRow {
    fn into_record(self) -> Result<RecoveryRecord, ApiError> {
        Ok(RecoveryRecord {
            id: self.id,
            tenant_database_id: self.tenant_database_id,
            archive_id: self.archive_id,
            state: self.state,
            policy_week: self.policy_week,
            replacement_identity: self.replacement_identity,
            validated_at: self.validated_at,
            elapsed_milliseconds: self.elapsed_milliseconds.map(to_u64).transpose()?,
            last_error_code: self.last_error_code,
            created_at: self.created_at,
            updated_at: self.updated_at,
        })
    }
}

impl OperationRow {
    fn into_record(self) -> Result<DatabaseOperationRecord, ApiError> {
        Ok(DatabaseOperationRecord {
            id: self.id,
            account_id: self.account_id,
            project_id: self.project_id,
            tenant_database_id: self.tenant_database_id,
            database_generation: self.database_generation,
            kind: self.kind,
            state: self.state,
            spec: self.spec,
            credential_ids: self.credential_ids,
            attempt_count: to_u32(self.attempt_count)?,
            current_attempt_id: self.current_attempt_id,
            current_fence: to_u64(self.current_fence)?,
            lease_expires_at: self.lease_expires_at,
            policy_time: self.policy_time,
            created_at: self.created_at,
            updated_at: self.updated_at,
        })
    }
}

fn project_database_limits(spec: &Value) -> Result<(i32, i64), ApiError> {
    let limits = spec
        .get("resources")
        .and_then(|v| v.get("limits"))
        .and_then(Value::as_array)
        .ok_or_else(|| {
            ApiError::unprocessable(
                "invalid_database_configuration",
                "the admitted configuration has no resource envelope",
            )
        })?;
    let mut connections = None;
    let mut storage = None;
    for limit in limits {
        match limit.get("resource").and_then(Value::as_str) {
            Some("database_connections") => {
                connections = limit.get("amount").and_then(Value::as_u64)
            }
            Some("database_storage") => storage = limit.get("amount").and_then(Value::as_u64),
            _ => {}
        }
    }
    let connections = connections
        .and_then(|v| i32::try_from(v).ok())
        .filter(|v| *v == APPLICATION_CONNECTION_LIMIT)
        .ok_or_else(|| {
            ApiError::unprocessable(
                "invalid_database_configuration",
                "the database connection limit is missing or unsupported",
            )
        })?;
    let gib = storage.filter(|v| *v == 1).ok_or_else(|| {
        ApiError::unprocessable(
            "invalid_database_configuration",
            "the database storage limit is missing or unsupported",
        )
    })?;
    let bytes = i64::try_from(gib * 1024 * 1024 * 1024).map_err(|_| ApiError::internal())?;
    if bytes != STORAGE_LIMIT_BYTES {
        return Err(ApiError::internal());
    }
    Ok((connections, bytes))
}

fn archive_spec(
    database_id: Uuid,
    id: Uuid,
    kind: &str,
    scheduled_for: Option<NaiveDate>,
    intended: Option<&str>,
    source_data_generation: i64,
    expires_at: DateTime<Utc>,
) -> Value {
    json!({
        "archive_id":id,
        "archive_kind":kind,
        "repository_namespace":repository_namespace(database_id),
        "scheduled_for":scheduled_for,
        "intended_migration_revision":intended,
        "source_data_generation":source_data_generation,
        "expires_at":expires_at
    })
}

fn repository_namespace(database_id: Uuid) -> String {
    format!("tenant_{}", database_id.simple())
}

fn migration_materialized_ref(digest: &str) -> Result<String, ApiError> {
    if !valid_prefixed_digest(digest) {
        return Err(ApiError::unprocessable(
            "migration_digest_invalid",
            "the migration digest is invalid",
        ));
    }
    let hex = &digest[7..];
    Ok(format!(
        "migration-artifacts/sha256/{}/{}.sql",
        &hex[..2],
        &hex[2..]
    ))
}

fn week_start(date: NaiveDate) -> NaiveDate {
    date - Duration::days(i64::from(date.weekday().num_days_from_monday()))
}

fn validate_worker_id(value: &str) -> Result<(), ApiError> {
    if value.is_empty() || value.len() > 128 || !value.bytes().all(|b| b.is_ascii_graphic()) {
        Err(ApiError::unprocessable(
            "invalid_worker_id",
            "worker_id must contain 1 to 128 graphic bytes",
        ))
    } else {
        Ok(())
    }
}

fn validate_kinds(kinds: &[String]) -> Result<Vec<String>, ApiError> {
    if kinds.is_empty() || kinds.len() > MAX_WORKER_KINDS {
        return Err(ApiError::unprocessable(
            "invalid_operation_kinds",
            "one or more bounded operation kinds are required",
        ));
    }
    let mut unique = BTreeSet::new();
    for kind in kinds {
        if !OPERATION_KINDS.contains(&kind.as_str()) || !unique.insert(kind.clone()) {
            return Err(ApiError::unprocessable(
                "invalid_operation_kinds",
                "operation kinds must be unique supported values",
            ));
        }
    }
    Ok(unique.into_iter().collect())
}

fn validate_completion(outcome: &CompletionOutcome) -> Result<(), ApiError> {
    if !matches!(outcome.state.as_str(), "succeeded" | "failed" | "retriable")
        || outcome.code.is_empty()
        || outcome.code.len() > 96
        || !outcome
            .code
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
        || !outcome.proof.is_object()
        || serde_json::to_vec(&outcome.proof)
            .map_err(|_| ApiError::internal())?
            .len()
            > 64 * 1024
    {
        return Err(ApiError::unprocessable(
            "invalid_database_completion",
            "the completion outcome is invalid",
        ));
    }
    Ok(())
}

fn validate_manifest(
    manifest: &Value,
    row: &OperationRow,
    archive_id: Uuid,
) -> Result<(), ApiError> {
    let valid = manifest.get("format").and_then(Value::as_str) == Some(ARCHIVE_FORMAT)
        && value_uuid(manifest, "archive_id") == Some(archive_id)
        && value_uuid(manifest, "tenant_database_id") == Some(row.tenant_database_id)
        && value_uuid(manifest, "database_generation") == Some(row.database_generation)
        && manifest
            .get("source_data_generation")
            .and_then(Value::as_i64)
            == row
                .spec
                .get("source_data_generation")
                .and_then(Value::as_i64)
        && manifest
            .get("postgres_server_major")
            .and_then(Value::as_u64)
            == Some(18)
        && manifest.get("pg_dump_major").and_then(Value::as_u64) == Some(18)
        && manifest.get("no_owner").and_then(Value::as_bool) == Some(true)
        && manifest.get("no_privileges").and_then(Value::as_bool) == Some(true)
        && manifest
            .get("cluster_roles_included")
            .and_then(Value::as_bool)
            == Some(false);
    if valid {
        Ok(())
    } else {
        Err(ApiError::unprocessable(
            "archive_manifest_mismatch",
            "the archive manifest does not match the exact role-free database generation",
        ))
    }
}

fn retained_evidence_passed(value: &Value, expected_count: usize) -> bool {
    let Some(items) = value
        .as_array()
        .filter(|items| items.len() == expected_count)
    else {
        return false;
    };
    let mut digests = HashSet::new();
    items.iter().all(|item| {
        let digest = item.get("binary_digest").and_then(Value::as_str);
        digest.is_some_and(valid_prefixed_digest)
            && digest.is_some_and(|v| digests.insert(v.to_owned()))
            && item
                .get("schema_revision")
                .and_then(Value::as_str)
                .is_some_and(|v| !v.is_empty() && v.len() <= 256)
            && item.get("read_ok").and_then(Value::as_bool) == Some(true)
            && item.get("write_ok").and_then(Value::as_bool) == Some(true)
    })
}

fn compatibility_evidence_passed(value: &Value) -> bool {
    value.is_object()
        && [
            "populated",
            "current_binary_read_ok",
            "current_binary_write_ok",
            "application_connection_verified",
            "source_unchanged",
        ]
        .iter()
        .all(|key| value.get(key).and_then(Value::as_bool) == Some(true))
}

fn value_uuid(value: &Value, key: &str) -> Option<Uuid> {
    value
        .get(key)
        .and_then(Value::as_str)
        .and_then(|v| Uuid::parse_str(v).ok())
}
fn required_string<'a>(value: &'a Value, key: &str, max: usize) -> Result<&'a str, ApiError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty() && v.len() <= max && !v.bytes().any(|b| b.is_ascii_control()))
        .ok_or_else(|| {
            ApiError::unprocessable(
                "invalid_database_proof",
                "a required bounded proof field is invalid",
            )
        })
}
fn required_sha256<'a>(value: &'a Value, key: &str) -> Result<&'a str, ApiError> {
    let v = required_string(value, key, 64)?;
    if valid_raw_digest(v) {
        Ok(v)
    } else {
        Err(ApiError::unprocessable(
            "invalid_database_proof",
            "a SHA-256 proof field is invalid",
        ))
    }
}
fn required_hex_digest<'a>(value: &'a Value, key: &str) -> Result<&'a str, ApiError> {
    required_sha256(value, key)
}
fn valid_raw_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn valid_prefixed_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(valid_raw_digest)
}
fn required_positive_i64(value: &Value, key: &str) -> Result<i64, ApiError> {
    value
        .get(key)
        .and_then(Value::as_i64)
        .filter(|v| *v > 0)
        .ok_or_else(|| {
            ApiError::unprocessable(
                "invalid_database_proof",
                "a required positive proof value is invalid",
            )
        })
}
fn required_nonnegative_i64(value: &Value, key: &str) -> Result<i64, ApiError> {
    value
        .get(key)
        .and_then(Value::as_i64)
        .filter(|v| *v >= 0)
        .ok_or_else(|| {
            ApiError::unprocessable(
                "invalid_database_proof",
                "a required nonnegative proof value is invalid",
            )
        })
}
fn required_timestamp(value: &Value, key: &str) -> Result<DateTime<Utc>, ApiError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .and_then(|v| DateTime::parse_from_rfc3339(v).ok())
        .map(|v| v.with_timezone(&Utc))
        .ok_or_else(|| {
            ApiError::unprocessable(
                "invalid_database_proof",
                "a required timestamp proof field is invalid",
            )
        })
}
fn to_u64(value: i64) -> Result<u64, ApiError> {
    u64::try_from(value).map_err(|_| ApiError::internal())
}
fn to_u32(value: i32) -> Result<u32, ApiError> {
    u32::try_from(value).map_err(|_| ApiError::internal())
}
fn fenced() -> ApiError {
    ApiError::conflict(
        "database_operation_fenced",
        "the database operation lease is no longer current",
    )
}
fn map_recovery_conflict(error: sqlx::Error) -> ApiError {
    if error
        .as_database_error()
        .is_some_and(|e| e.code().as_deref() == Some("23505"))
    {
        ApiError::conflict(
            "recovery_already_scheduled",
            "this database already has a recovery drill in the policy week",
        )
    } else {
        ApiError::from(error)
    }
}
