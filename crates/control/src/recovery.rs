use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration as StdDuration,
};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chacha20poly1305::{
    Tag, XChaCha20Poly1305, XNonce,
    aead::{AeadInPlace, KeyInit},
};
use chrono::{DateTime, Duration, Timelike, Utc};
use rand::{RngCore, rngs::OsRng};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{ConnectOptions, Connection, PgConnection, PgPool, Row, postgres::PgConnectOptions};
use tokio::{
    fs,
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
};
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

use crate::db;

pub const MAX_PLAINTEXT_DUMP_BYTES: usize = 64 * 1024 * 1024;
pub const BACKUP_FORMAT: &str = "hostlet.platform-backup/v1";
const MAX_TOOL_STDERR_BYTES: usize = 64 * 1024;
const MAX_TOOL_STDOUT_BYTES: usize = 64 * 1024;
const TOOL_TIMEOUT: StdDuration = StdDuration::from_secs(120);
const FUTURE_TOLERANCE: Duration = Duration::seconds(5);
const KEY_ID_DOMAIN: &[u8] = b"hostlet-recovery-key-id/v1\0";
const TARGET_FINGERPRINT_DOMAIN: &[u8] = b"hostlet-database-target/v1\0";
const ENVELOPE_AAD_DOMAIN: &[u8] = b"hostlet-backup-envelope/v1\0";
const BACKUP_EXTENSION: &str = "hostlet-backup";
const RECEIPT_SUFFIX: &str = "receipt.json";

pub struct RecoveryKey {
    bytes: [u8; 32],
    key_id: String,
}

impl RecoveryKey {
    pub fn new(bytes: [u8; 32]) -> Self {
        let mut digest = Sha256::new();
        digest.update(KEY_ID_DOMAIN);
        digest.update(bytes);
        let key_id = format!("v1-{}", URL_SAFE_NO_PAD.encode(digest.finalize()));
        Self { bytes, key_id }
    }

    pub fn key_id(&self) -> &str {
        &self.key_id
    }
}

impl Drop for RecoveryKey {
    fn drop(&mut self) {
        self.bytes.zeroize();
    }
}

#[derive(Clone)]
pub enum PgToolMode {
    Host,
    Docker { container: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BackupManifestV1 {
    pub format: String,
    pub backup_id: Uuid,
    pub database_identity_id: Uuid,
    pub schema_version: i64,
    pub minimum_reader_version: i64,
    pub source_revision: String,
    pub source_dirty: bool,
    pub source_binary_sha256: String,
    pub source_target_fingerprint: String,
    pub snapshot_at: DateTime<Utc>,
    pub scheduled_for: Option<DateTime<Utc>>,
    pub intended_migration: Option<i64>,
    pub recovery_key_id: String,
    pub relation_counts: BTreeMap<String, u64>,
    pub plaintext_sha256: String,
    pub plaintext_bytes: u64,
    pub postgres_server_major: u16,
    pub pg_dump_major: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BackupReceiptV1 {
    pub manifest: BackupManifestV1,
    pub encrypted_payload_sha256: String,
    pub encrypted_payload_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RestoreReceiptV1 {
    pub backup_id: Uuid,
    pub database_identity_id: Uuid,
    pub source_target_fingerprint: String,
    pub restored_target_fingerprint: String,
    pub schema_version: i64,
    pub restored_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct BackupEnvelopeV1 {
    manifest: BackupManifestV1,
    nonce: String,
    ciphertext: String,
    auth_tag: String,
}

pub struct BackupRequest<'a> {
    pub database_url: &'a str,
    pub repository: &'a Path,
    pub intended_migration: Option<i64>,
    pub scheduled_for: Option<DateTime<Utc>>,
    pub tool_mode: PgToolMode,
}

#[derive(Clone, Copy)]
pub struct BackupSelection<'a> {
    pub repository: &'a Path,
    pub backup_id: Uuid,
}

pub struct UpgradeExpectation {
    pub source_schema_version: i64,
    pub intended_migration: i64,
    pub maximum_age: Duration,
}

pub struct RestoreRequest<'a> {
    pub target_database_url: &'a str,
    pub selection: BackupSelection<'a>,
    pub tool_mode: PgToolMode,
}

pub struct ScheduledBackupRequest<'a> {
    pub database_url: &'a str,
    pub repository: &'a Path,
    pub effective_at: DateTime<Utc>,
    pub tool_mode: PgToolMode,
}

#[derive(Debug, Clone, Serialize)]
pub struct RetentionOutcome {
    pub kept: Vec<Uuid>,
    pub deleted: Vec<Uuid>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ScheduledBackupOutcome {
    pub created: Option<BackupReceiptV1>,
    pub retention: RetentionOutcome,
}

pub struct VerifiedUpgradeReceipt {
    receipt: BackupReceiptV1,
    intended_migration: i64,
    verified_at: DateTime<Utc>,
}

pub struct RecoveryError {
    code: &'static str,
}

impl RecoveryError {
    fn new(code: &'static str) -> Self {
        Self { code }
    }

    pub fn code(&self) -> &'static str {
        self.code
    }
}

impl std::fmt::Debug for RecoveryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RecoveryError")
            .field("code", &self.code)
            .finish()
    }
}

impl std::fmt::Display for RecoveryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "recovery failed: {}", self.code)
    }
}

impl std::error::Error for RecoveryError {}

pub async fn create_backup(
    request: BackupRequest<'_>,
    key: &RecoveryKey,
) -> Result<BackupReceiptV1, RecoveryError> {
    validate_repository(request.repository).await?;
    validate_tool_mode(&request.tool_mode)?;
    let options = request
        .database_url
        .parse::<PgConnectOptions>()
        .map_err(|_| RecoveryError::new("invalid_database_configuration"))?
        .disable_statement_logging();
    let mut connection = tokio::time::timeout(
        StdDuration::from_secs(10),
        PgConnection::connect_with(&options),
    )
    .await
    .map_err(|_| RecoveryError::new("database_connect_timeout"))?
    .map_err(|_| RecoveryError::new("database_unavailable"))?;
    configure_direct_connection(&mut connection).await?;
    sqlx::query("SELECT pg_advisory_lock($1)")
        .bind(db::HOSTLET_MIGRATION_LOCK)
        .execute(&mut connection)
        .await
        .map_err(|_| RecoveryError::new("backup_lock_failed"))?;
    sqlx::query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut connection)
        .await
        .map_err(|_| RecoveryError::new("snapshot_start_failed"))?;
    let result = create_backup_in_snapshot(&request, key, &mut connection).await;
    let _ = sqlx::query("ROLLBACK").execute(&mut connection).await;
    result
}

async fn create_backup_in_snapshot(
    request: &BackupRequest<'_>,
    key: &RecoveryKey,
    connection: &mut PgConnection,
) -> Result<BackupReceiptV1, RecoveryError> {
    let snapshot_id: String = sqlx::query_scalar("SELECT pg_export_snapshot()")
        .fetch_one(&mut *connection)
        .await
        .map_err(|_| RecoveryError::new("snapshot_export_failed"))?;
    let snapshot_at: DateTime<Utc> = sqlx::query_scalar("SELECT transaction_timestamp()")
        .fetch_one(&mut *connection)
        .await
        .map_err(|_| RecoveryError::new("snapshot_inspection_failed"))?;
    let prefix = db::inspect_schema_prefix(&mut *connection)
        .await
        .map_err(|_| RecoveryError::new("schema_inspection_failed"))?;
    let source_target_fingerprint = target_fingerprint(&mut *connection).await?;
    let relation_counts = relation_counts(&mut *connection).await?;
    let postgres_version: i32 =
        sqlx::query_scalar("SELECT current_setting('server_version_num')::int")
            .fetch_one(&mut *connection)
            .await
            .map_err(|_| RecoveryError::new("snapshot_inspection_failed"))?;

    let dump = run_pg_dump(
        request.database_url,
        &snapshot_id,
        &source_target_fingerprint,
        &request.tool_mode,
    )
    .await?;
    if dump.stdout.is_empty() {
        return Err(RecoveryError::new("backup_dump_empty"));
    }
    let pg_dump_major = parse_pg_tool_major(&dump.tool_version)
        .ok_or_else(|| RecoveryError::new("pg_dump_version_invalid"))?;
    let postgres_server_major = u16::try_from(postgres_version / 10_000)
        .map_err(|_| RecoveryError::new("postgres_version_invalid"))?;
    if postgres_server_major != 18 || pg_dump_major != 18 {
        return Err(RecoveryError::new("postgres_tool_version_mismatch"));
    }

    let provenance = build_provenance().await?;
    let plaintext = dump.stdout;
    let manifest = BackupManifestV1 {
        format: BACKUP_FORMAT.to_owned(),
        backup_id: Uuid::new_v4(),
        database_identity_id: prefix.database_identity_id,
        schema_version: prefix.current_version,
        minimum_reader_version: prefix.minimum_reader_version,
        source_revision: provenance.source_revision,
        source_dirty: provenance.dirty,
        source_binary_sha256: provenance.binary_sha256,
        source_target_fingerprint,
        snapshot_at,
        scheduled_for: request.scheduled_for,
        intended_migration: request.intended_migration,
        recovery_key_id: key.key_id().to_owned(),
        relation_counts,
        plaintext_sha256: hex_sha256(&plaintext),
        plaintext_bytes: plaintext.len() as u64,
        postgres_server_major,
        pg_dump_major,
    };
    let (envelope, encrypted_payload_sha256, encrypted_payload_bytes) =
        encrypt_envelope(manifest.clone(), &plaintext, key)?;
    let receipt = BackupReceiptV1 {
        manifest,
        encrypted_payload_sha256,
        encrypted_payload_bytes,
    };
    persist_backup(request.repository, &envelope, &receipt).await?;
    Ok(receipt)
}

pub async fn verify_backup(
    selection: BackupSelection<'_>,
    key: &RecoveryKey,
) -> Result<BackupReceiptV1, RecoveryError> {
    let (_, receipt) = read_and_decrypt(selection, key).await?;
    Ok(receipt)
}

pub async fn verify_upgrade_for_locked_database(
    connection: &mut PgConnection,
    selection: BackupSelection<'_>,
    key: &RecoveryKey,
    expectation: UpgradeExpectation,
) -> Result<VerifiedUpgradeReceipt, RecoveryError> {
    if expectation.maximum_age <= Duration::zero() {
        return Err(RecoveryError::new("backup_maximum_age_invalid"));
    }
    let receipt = verify_backup(selection, key).await?;
    let prefix = db::inspect_schema_prefix(&mut *connection)
        .await
        .map_err(|_| RecoveryError::new("schema_inspection_failed"))?;
    let current_target = target_fingerprint(&mut *connection).await?;
    let database_now: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&mut *connection)
        .await
        .map_err(|_| RecoveryError::new("database_time_unavailable"))?;

    if receipt.manifest.database_identity_id != prefix.database_identity_id {
        return Err(RecoveryError::new("backup_database_identity_mismatch"));
    }
    if receipt.manifest.source_target_fingerprint != current_target {
        return Err(RecoveryError::new("backup_target_mismatch"));
    }
    if receipt.manifest.schema_version != expectation.source_schema_version
        || prefix.current_version != expectation.source_schema_version
    {
        return Err(RecoveryError::new("backup_schema_version_mismatch"));
    }
    if receipt.manifest.intended_migration != Some(expectation.intended_migration)
        || !prefix
            .pending_versions
            .contains(&expectation.intended_migration)
    {
        return Err(RecoveryError::new("backup_migration_mismatch"));
    }
    if receipt.manifest.snapshot_at > database_now + FUTURE_TOLERANCE {
        return Err(RecoveryError::new("backup_timestamp_in_future"));
    }
    if database_now - receipt.manifest.snapshot_at > expectation.maximum_age {
        return Err(RecoveryError::new("backup_stale"));
    }
    Ok(VerifiedUpgradeReceipt {
        receipt,
        intended_migration: expectation.intended_migration,
        verified_at: database_now,
    })
}

pub async fn record_verified_upgrade(
    connection: &mut PgConnection,
    verified: &VerifiedUpgradeReceipt,
) -> Result<(), RecoveryError> {
    let receipt_json = serde_json::to_value(&verified.receipt)
        .map_err(|_| RecoveryError::new("backup_receipt_encode_failed"))?;
    let inserted = sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO platform_backup_receipts (\
            backup_id, database_identity_id, schema_version, intended_migration, receipt, verified_at\
         ) VALUES ($1, $2, $3, $4, $5, $6) \
         ON CONFLICT (backup_id) DO NOTHING RETURNING backup_id",
    )
    .bind(verified.receipt.manifest.backup_id)
    .bind(verified.receipt.manifest.database_identity_id)
    .bind(verified.receipt.manifest.schema_version)
    .bind(verified.intended_migration)
    .bind(&receipt_json)
    .bind(verified.verified_at)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|_| RecoveryError::new("backup_receipt_record_failed"))?;
    if inserted.is_some() {
        return Ok(());
    }
    let matches: bool = sqlx::query_scalar(
        "SELECT database_identity_id = $2 \
              AND schema_version = $3 \
              AND intended_migration = $4 \
              AND receipt = $5 \
         FROM platform_backup_receipts WHERE backup_id = $1",
    )
    .bind(verified.receipt.manifest.backup_id)
    .bind(verified.receipt.manifest.database_identity_id)
    .bind(verified.receipt.manifest.schema_version)
    .bind(verified.intended_migration)
    .bind(receipt_json)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|_| RecoveryError::new("backup_receipt_record_failed"))?
    .unwrap_or(false);
    if !matches {
        return Err(RecoveryError::new("backup_receipt_conflict"));
    }
    Ok(())
}

pub(crate) async fn check_keyring(pool: &PgPool, key: &RecoveryKey) -> Result<(), RecoveryError> {
    let mismatch: bool = sqlx::query_scalar(
        "SELECT EXISTS (\
            SELECT 1 FROM platform_backup_receipts \
            WHERE receipt #>> '{manifest,recovery_key_id}' IS DISTINCT FROM $1\
        )",
    )
    .bind(key.key_id())
    .fetch_one(pool)
    .await
    .map_err(|_| RecoveryError::new("backup_key_receipt_check_failed"))?;
    if mismatch {
        return Err(RecoveryError::new("backup_recovery_key_mismatch"));
    }
    Ok(())
}

pub async fn restore_backup(
    request: RestoreRequest<'_>,
    key: &RecoveryKey,
) -> Result<RestoreReceiptV1, RecoveryError> {
    validate_tool_mode(&request.tool_mode)?;
    let (plaintext, receipt) = read_and_decrypt(request.selection, key).await?;
    let options = request
        .target_database_url
        .parse::<PgConnectOptions>()
        .map_err(|_| RecoveryError::new("invalid_restore_database_configuration"))?
        .disable_statement_logging();
    let mut connection = tokio::time::timeout(
        StdDuration::from_secs(10),
        PgConnection::connect_with(&options),
    )
    .await
    .map_err(|_| RecoveryError::new("restore_database_connect_timeout"))?
    .map_err(|_| RecoveryError::new("restore_database_unavailable"))?;
    configure_direct_connection(&mut connection).await?;
    sqlx::query("SELECT pg_advisory_lock($1)")
        .bind(db::HOSTLET_MIGRATION_LOCK)
        .execute(&mut connection)
        .await
        .map_err(|_| RecoveryError::new("restore_lock_failed"))?;
    if db::database_has_user_objects(&mut connection)
        .await
        .map_err(|_| RecoveryError::new("restore_target_inspection_failed"))?
    {
        return Err(RecoveryError::new("restore_target_not_empty"));
    }
    let restored_target_fingerprint = target_fingerprint(&mut connection).await?;
    if restored_target_fingerprint == receipt.manifest.source_target_fingerprint {
        return Err(RecoveryError::new("restore_source_target_refused"));
    }
    run_pg_restore(
        &mut connection,
        request.target_database_url,
        &request.tool_mode,
        &restored_target_fingerprint,
        plaintext.as_slice(),
    )
    .await?;
    let restored_identity: Uuid =
        sqlx::query_scalar("SELECT id FROM database_identity WHERE singleton = true")
            .fetch_one(&mut connection)
            .await
            .map_err(|_| RecoveryError::new("restore_verification_failed"))?;
    let restored_schema: i64 = sqlx::query_scalar(
        "SELECT current_version FROM platform_schema_compatibility WHERE singleton = true",
    )
    .fetch_one(&mut connection)
    .await
    .map_err(|_| RecoveryError::new("restore_verification_failed"))?;
    if restored_identity != receipt.manifest.database_identity_id
        || restored_schema != receipt.manifest.schema_version
    {
        return Err(RecoveryError::new("restore_verification_failed"));
    }
    let restored_counts = relation_counts(&mut connection).await?;
    if restored_counts != receipt.manifest.relation_counts {
        return Err(RecoveryError::new("restore_relation_counts_mismatch"));
    }
    let restored_at: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&mut connection)
        .await
        .map_err(|_| RecoveryError::new("restore_verification_failed"))?;
    Ok(RestoreReceiptV1 {
        backup_id: receipt.manifest.backup_id,
        database_identity_id: restored_identity,
        source_target_fingerprint: receipt.manifest.source_target_fingerprint,
        restored_target_fingerprint,
        schema_version: restored_schema,
        restored_at,
    })
}

pub async fn run_scheduled_backup(
    request: ScheduledBackupRequest<'_>,
    key: &RecoveryKey,
) -> Result<ScheduledBackupOutcome, RecoveryError> {
    validate_repository(request.repository).await?;
    let lock_path = request.repository.join(".hostlet-scheduler.lock");
    let _lock = RepositoryLock::acquire(lock_path).await?;
    let scheduled_for = request
        .effective_at
        .with_minute(0)
        .and_then(|time| time.with_second(0))
        .and_then(|time| time.with_nanosecond(0))
        .ok_or_else(|| RecoveryError::new("backup_schedule_time_invalid"))?;
    let current_target = inspect_database_target(request.database_url).await?;
    let existing = load_verified_repository_receipts(request.repository, key).await?;
    if existing.iter().any(|receipt| {
        receipt.manifest.database_identity_id != current_target.database_identity_id
            || receipt.manifest.source_target_fingerprint != current_target.fingerprint
    }) {
        return Err(RecoveryError::new("backup_repository_target_mismatch"));
    }
    let created = if existing
        .iter()
        .any(|receipt| receipt.manifest.scheduled_for == Some(scheduled_for))
    {
        None
    } else {
        Some(
            create_backup(
                BackupRequest {
                    database_url: request.database_url,
                    repository: request.repository,
                    intended_migration: None,
                    scheduled_for: Some(scheduled_for),
                    tool_mode: request.tool_mode,
                },
                key,
            )
            .await?,
        )
    };
    let mut retained_receipts = existing;
    if let Some(receipt) = &created {
        retained_receipts.push(receipt.clone());
    }
    let retention =
        apply_retention_verified(request.repository, request.effective_at, retained_receipts)
            .await?;
    Ok(ScheduledBackupOutcome { created, retention })
}

async fn apply_retention_verified(
    repository: &Path,
    effective_at: DateTime<Utc>,
    receipts: Vec<BackupReceiptV1>,
) -> Result<RetentionOutcome, RecoveryError> {
    let hourly_cutoff = effective_at - Duration::hours(48);
    let cutoff_date = hourly_cutoff.date_naive();
    let earliest_daily_date = cutoff_date - Duration::days(7);
    let mut keep = BTreeSet::new();
    let mut daily = BTreeMap::new();
    for receipt in &receipts {
        let timestamp = receipt.manifest.scheduled_for;
        let Some(timestamp) = timestamp else {
            keep.insert(receipt.manifest.backup_id);
            continue;
        };
        if timestamp >= hourly_cutoff {
            keep.insert(receipt.manifest.backup_id);
        } else {
            let date = timestamp.date_naive();
            if date < earliest_daily_date || date >= cutoff_date {
                continue;
            }
            let entry = daily.entry(date).or_insert(receipt);
            let entry_time = entry
                .manifest
                .scheduled_for
                .expect("daily entries are scheduled");
            if timestamp > entry_time {
                *entry = receipt;
            }
        }
    }
    keep.extend(daily.values().map(|receipt| receipt.manifest.backup_id));

    let mut kept = Vec::new();
    let mut deleted = Vec::new();
    for receipt in receipts {
        let backup_id = receipt.manifest.backup_id;
        if keep.contains(&backup_id) {
            kept.push(backup_id);
        } else {
            remove_backup_pair(repository, backup_id).await?;
            deleted.push(backup_id);
        }
    }
    kept.sort_unstable();
    deleted.sort_unstable();
    Ok(RetentionOutcome { kept, deleted })
}

struct BuildProvenance {
    source_revision: String,
    dirty: bool,
    binary_sha256: String,
}

async fn build_provenance() -> Result<BuildProvenance, RecoveryError> {
    let source_revision = env!("HOSTLET_BUILD_GIT_REVISION").to_owned();
    if source_revision.len() != 40 || !source_revision.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(RecoveryError::new("build_revision_unknown"));
    }
    let dirty = env!("HOSTLET_BUILD_GIT_DIRTY") == "true";
    let executable =
        std::env::current_exe().map_err(|_| RecoveryError::new("binary_provenance_unavailable"))?;
    let mut file = fs::File::open(executable)
        .await
        .map_err(|_| RecoveryError::new("binary_provenance_unavailable"))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .await
            .map_err(|_| RecoveryError::new("binary_provenance_unavailable"))?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    buffer.zeroize();
    Ok(BuildProvenance {
        source_revision,
        dirty,
        binary_sha256: hex_bytes(&digest.finalize()),
    })
}

async fn target_fingerprint(connection: &mut PgConnection) -> Result<String, RecoveryError> {
    let row = sqlx::query(
        "SELECT (pg_control_system()).system_identifier::text AS system_identifier, \
                d.oid::text AS database_oid, d.datname \
         FROM pg_database d WHERE d.datname = current_database()",
    )
    .fetch_one(connection)
    .await
    .map_err(|_| RecoveryError::new("database_target_identity_unavailable"))?;
    let system_identifier = row
        .try_get::<String, _>("system_identifier")
        .map_err(|_| RecoveryError::new("database_target_identity_unavailable"))?;
    let database_oid = row
        .try_get::<String, _>("database_oid")
        .map_err(|_| RecoveryError::new("database_target_identity_unavailable"))?;
    let database_name = row
        .try_get::<String, _>("datname")
        .map_err(|_| RecoveryError::new("database_target_identity_unavailable"))?;
    Ok(fingerprint_fields(
        &system_identifier,
        &database_oid,
        &database_name,
    ))
}

fn fingerprint_fields(system_identifier: &str, database_oid: &str, database_name: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(TARGET_FINGERPRINT_DOMAIN);
    for field in [system_identifier, database_oid, database_name] {
        digest.update((field.len() as u64).to_be_bytes());
        digest.update(field.as_bytes());
    }
    hex_bytes(&digest.finalize())
}

async fn configure_direct_connection(connection: &mut PgConnection) -> Result<(), RecoveryError> {
    sqlx::raw_sql(
        "SET search_path = public, pg_temp; SET statement_timeout = '120s'; SET lock_timeout = '30s'",
    )
    .execute(connection)
    .await
    .map_err(|_| RecoveryError::new("database_configuration_failed"))?;
    Ok(())
}

struct InspectedTarget {
    database_identity_id: Uuid,
    fingerprint: String,
}

async fn inspect_database_target(database_url: &str) -> Result<InspectedTarget, RecoveryError> {
    let options = database_url
        .parse::<PgConnectOptions>()
        .map_err(|_| RecoveryError::new("invalid_database_configuration"))?
        .disable_statement_logging();
    let mut connection = tokio::time::timeout(
        StdDuration::from_secs(10),
        PgConnection::connect_with(&options),
    )
    .await
    .map_err(|_| RecoveryError::new("database_connect_timeout"))?
    .map_err(|_| RecoveryError::new("database_unavailable"))?;
    configure_direct_connection(&mut connection).await?;
    let prefix = db::inspect_schema_prefix(&mut connection)
        .await
        .map_err(|_| RecoveryError::new("schema_inspection_failed"))?;
    Ok(InspectedTarget {
        database_identity_id: prefix.database_identity_id,
        fingerprint: target_fingerprint(&mut connection).await?,
    })
}

async fn relation_counts(
    connection: &mut PgConnection,
) -> Result<BTreeMap<String, u64>, RecoveryError> {
    // Count every platform relation in the same exported snapshot as the dump.
    // Additive onboarding tables must be included without weakening old-schema
    // backup verification. The migration ledger has its own checksum evidence.
    let relations: Vec<String> = sqlx::query_scalar(
        "SELECT tablename::text FROM pg_catalog.pg_tables \
         WHERE schemaname = 'public' AND tablename <> '_sqlx_migrations' ORDER BY tablename",
    )
    .fetch_all(&mut *connection)
    .await
    .map_err(|_| RecoveryError::new("backup_relation_count_failed"))?;
    let mut counts = BTreeMap::new();
    for relation in relations {
        // Identifiers come from PostgreSQL's catalog, not caller input. Quote
        // them nevertheless so every legal identifier has one SQL meaning.
        let quoted = relation.replace('"', "\"\"");
        let query = format!("SELECT COUNT(*)::bigint FROM public.\"{quoted}\"");
        let count: i64 = sqlx::query_scalar(&query)
            .fetch_one(&mut *connection)
            .await
            .map_err(|_| RecoveryError::new("backup_relation_count_failed"))?;
        counts.insert(
            relation,
            u64::try_from(count)
                .map_err(|_| RecoveryError::new("backup_relation_count_invalid"))?,
        );
    }
    Ok(counts)
}

fn encrypt_envelope(
    manifest: BackupManifestV1,
    plaintext: &[u8],
    key: &RecoveryKey,
) -> Result<(BackupEnvelopeV1, String, u64), RecoveryError> {
    if plaintext.len() > MAX_PLAINTEXT_DUMP_BYTES {
        return Err(RecoveryError::new("backup_dump_too_large"));
    }
    let manifest_bytes = serde_json::to_vec(&manifest)
        .map_err(|_| RecoveryError::new("backup_manifest_encode_failed"))?;
    let mut aad = Vec::with_capacity(ENVELOPE_AAD_DOMAIN.len() + manifest_bytes.len());
    aad.extend_from_slice(ENVELOPE_AAD_DOMAIN);
    aad.extend_from_slice(&manifest_bytes);
    let cipher = XChaCha20Poly1305::new_from_slice(&key.bytes)
        .map_err(|_| RecoveryError::new("backup_encryption_failed"))?;
    let mut nonce = [0_u8; 24];
    OsRng.fill_bytes(&mut nonce);
    let mut ciphertext = plaintext.to_vec();
    let tag =
        match cipher.encrypt_in_place_detached(XNonce::from_slice(&nonce), &aad, &mut ciphertext) {
            Ok(tag) => tag,
            Err(_) => {
                ciphertext.zeroize();
                return Err(RecoveryError::new("backup_encryption_failed"));
            }
        };
    let mut encrypted_payload = Vec::with_capacity(nonce.len() + ciphertext.len() + tag.len());
    encrypted_payload.extend_from_slice(&nonce);
    encrypted_payload.extend_from_slice(&ciphertext);
    encrypted_payload.extend_from_slice(&tag);
    let digest = hex_sha256(&encrypted_payload);
    let bytes = encrypted_payload.len() as u64;
    encrypted_payload.zeroize();
    Ok((
        BackupEnvelopeV1 {
            manifest,
            nonce: URL_SAFE_NO_PAD.encode(nonce),
            ciphertext: URL_SAFE_NO_PAD.encode(ciphertext),
            auth_tag: URL_SAFE_NO_PAD.encode(tag),
        },
        digest,
        bytes,
    ))
}

async fn read_and_decrypt(
    selection: BackupSelection<'_>,
    key: &RecoveryKey,
) -> Result<(Zeroizing<Vec<u8>>, BackupReceiptV1), RecoveryError> {
    validate_repository(selection.repository).await?;
    let envelope_bytes = read_bounded(
        &backup_path(selection.repository, selection.backup_id),
        encoded_envelope_limit(),
        "backup_artifact_invalid",
    )
    .await?;
    let receipt_bytes = read_bounded(
        &receipt_path(selection.repository, selection.backup_id),
        1024 * 1024,
        "backup_receipt_invalid",
    )
    .await?;
    let envelope: BackupEnvelopeV1 = serde_json::from_slice(&envelope_bytes)
        .map_err(|_| RecoveryError::new("backup_artifact_invalid"))?;
    let receipt: BackupReceiptV1 = serde_json::from_slice(&receipt_bytes)
        .map_err(|_| RecoveryError::new("backup_receipt_invalid"))?;
    if envelope.manifest != receipt.manifest
        || receipt.manifest.backup_id != selection.backup_id
        || receipt.manifest.format != BACKUP_FORMAT
    {
        return Err(RecoveryError::new("backup_metadata_mismatch"));
    }
    if receipt.manifest.recovery_key_id != key.key_id() {
        return Err(RecoveryError::new("backup_recovery_key_mismatch"));
    }
    let nonce = URL_SAFE_NO_PAD
        .decode(&envelope.nonce)
        .map_err(|_| RecoveryError::new("backup_artifact_invalid"))?;
    let mut ciphertext = URL_SAFE_NO_PAD
        .decode(&envelope.ciphertext)
        .map_err(|_| RecoveryError::new("backup_artifact_invalid"))?;
    let tag = URL_SAFE_NO_PAD
        .decode(&envelope.auth_tag)
        .map_err(|_| RecoveryError::new("backup_artifact_invalid"))?;
    if nonce.len() != 24 || tag.len() != 16 || ciphertext.len() > MAX_PLAINTEXT_DUMP_BYTES {
        ciphertext.zeroize();
        return Err(RecoveryError::new("backup_artifact_invalid"));
    }
    let mut encrypted_payload = Vec::with_capacity(nonce.len() + ciphertext.len() + tag.len());
    encrypted_payload.extend_from_slice(&nonce);
    encrypted_payload.extend_from_slice(&ciphertext);
    encrypted_payload.extend_from_slice(&tag);
    let encrypted_digest = hex_sha256(&encrypted_payload);
    let encrypted_bytes = encrypted_payload.len() as u64;
    encrypted_payload.zeroize();
    if encrypted_digest != receipt.encrypted_payload_sha256
        || encrypted_bytes != receipt.encrypted_payload_bytes
    {
        ciphertext.zeroize();
        return Err(RecoveryError::new("backup_encrypted_digest_mismatch"));
    }
    let manifest_bytes = serde_json::to_vec(&envelope.manifest)
        .map_err(|_| RecoveryError::new("backup_manifest_encode_failed"))?;
    let mut aad = Vec::with_capacity(ENVELOPE_AAD_DOMAIN.len() + manifest_bytes.len());
    aad.extend_from_slice(ENVELOPE_AAD_DOMAIN);
    aad.extend_from_slice(&manifest_bytes);
    let cipher = XChaCha20Poly1305::new_from_slice(&key.bytes)
        .map_err(|_| RecoveryError::new("backup_authentication_failed"))?;
    if cipher
        .decrypt_in_place_detached(
            XNonce::from_slice(&nonce),
            &aad,
            &mut ciphertext,
            Tag::from_slice(&tag),
        )
        .is_err()
    {
        ciphertext.zeroize();
        return Err(RecoveryError::new("backup_authentication_failed"));
    }
    let plaintext = Zeroizing::new(ciphertext);
    if plaintext.len() as u64 != receipt.manifest.plaintext_bytes
        || hex_sha256(&plaintext) != receipt.manifest.plaintext_sha256
    {
        return Err(RecoveryError::new("backup_plaintext_digest_mismatch"));
    }
    Ok((plaintext, receipt))
}

async fn persist_backup(
    repository: &Path,
    envelope: &BackupEnvelopeV1,
    receipt: &BackupReceiptV1,
) -> Result<(), RecoveryError> {
    let envelope_bytes = serde_json::to_vec(envelope)
        .map_err(|_| RecoveryError::new("backup_artifact_encode_failed"))?;
    let receipt_bytes = serde_json::to_vec_pretty(receipt)
        .map_err(|_| RecoveryError::new("backup_receipt_encode_failed"))?;
    let backup_path = backup_path(repository, receipt.manifest.backup_id);
    let receipt_path = receipt_path(repository, receipt.manifest.backup_id);
    publish_new(repository, &backup_path, &envelope_bytes).await?;
    if let Err(error) = publish_new(repository, &receipt_path, &receipt_bytes).await {
        let _ = fs::remove_file(&receipt_path).await;
        let _ = fs::remove_file(&backup_path).await;
        let _ = sync_repository(repository).await;
        return Err(error);
    }
    sync_repository(repository).await?;
    Ok(())
}

async fn write_new(path: &Path, contents: &[u8]) -> Result<(), RecoveryError> {
    let owned_path = path.to_owned();
    let file = tokio::task::spawn_blocking(move || open_new_private_file(&owned_path))
        .await
        .map_err(|_| RecoveryError::new("backup_repository_write_failed"))?
        .map_err(|_| RecoveryError::new("backup_repository_write_failed"))?;
    let mut file = fs::File::from_std(file);
    let result = async {
        file.write_all(contents).await?;
        file.sync_all().await
    }
    .await;
    if result.is_err() {
        drop(file);
        let _ = fs::remove_file(path).await;
        return Err(RecoveryError::new("backup_repository_write_failed"));
    }
    Ok(())
}

async fn publish_new(
    repository: &Path,
    destination: &Path,
    contents: &[u8],
) -> Result<(), RecoveryError> {
    let temporary = repository.join(format!(".publish-{}.tmp", Uuid::new_v4()));
    write_new(&temporary, contents).await?;
    let result = fs::hard_link(&temporary, destination).await;
    let _ = fs::remove_file(&temporary).await;
    result.map_err(|_| RecoveryError::new("backup_repository_write_failed"))?;
    if let Err(error) = sync_repository(repository).await {
        let _ = fs::remove_file(destination).await;
        let _ = sync_repository(repository).await;
        return Err(error);
    }
    Ok(())
}

async fn sync_repository(repository: &Path) -> Result<(), RecoveryError> {
    let repository = repository.to_owned();
    tokio::task::spawn_blocking(move || std::fs::File::open(repository)?.sync_all())
        .await
        .map_err(|_| RecoveryError::new("backup_repository_write_failed"))?
        .map_err(|_| RecoveryError::new("backup_repository_write_failed"))
}

async fn validate_repository(repository: &Path) -> Result<(), RecoveryError> {
    match fs::symlink_metadata(repository).await {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(RecoveryError::new("backup_repository_unavailable"));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(repository)
                .await
                .map_err(|_| RecoveryError::new("backup_repository_unavailable"))?;
        }
        Err(_) => return Err(RecoveryError::new("backup_repository_unavailable")),
    }
    #[cfg(unix)]
    fs::set_permissions(repository, std::fs::Permissions::from_mode(0o700))
        .await
        .map_err(|_| RecoveryError::new("backup_repository_unavailable"))?;
    let metadata = fs::symlink_metadata(repository)
        .await
        .map_err(|_| RecoveryError::new("backup_repository_unavailable"))?;
    if !metadata.is_dir() {
        return Err(RecoveryError::new("backup_repository_unavailable"));
    }
    Ok(())
}

async fn load_verified_repository_receipts(
    repository: &Path,
    key: &RecoveryKey,
) -> Result<Vec<BackupReceiptV1>, RecoveryError> {
    validate_repository(repository).await?;
    let mut directory = fs::read_dir(repository)
        .await
        .map_err(|_| RecoveryError::new("backup_repository_read_failed"))?;
    let mut receipts = Vec::new();
    while let Some(entry) = directory
        .next_entry()
        .await
        .map_err(|_| RecoveryError::new("backup_repository_read_failed"))?
    {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(id) = name.strip_suffix(&format!(".{RECEIPT_SUFFIX}")) else {
            continue;
        };
        let Ok(backup_id) = Uuid::parse_str(id) else {
            continue;
        };
        let receipt = verify_backup(
            BackupSelection {
                repository,
                backup_id,
            },
            key,
        )
        .await?;
        receipts.push(receipt);
    }
    Ok(receipts)
}

async fn remove_backup_pair(repository: &Path, backup_id: Uuid) -> Result<(), RecoveryError> {
    let receipt = receipt_path(repository, backup_id);
    let tombstone = repository.join(format!(".delete-{backup_id}-{}.receipt", Uuid::new_v4()));
    fs::rename(&receipt, &tombstone)
        .await
        .map_err(|_| RecoveryError::new("backup_retention_delete_failed"))?;
    sync_repository(repository).await?;
    fs::remove_file(backup_path(repository, backup_id))
        .await
        .map_err(|_| RecoveryError::new("backup_retention_delete_failed"))?;
    fs::remove_file(tombstone)
        .await
        .map_err(|_| RecoveryError::new("backup_retention_delete_failed"))?;
    sync_repository(repository).await
}

async fn read_bounded(
    path: &Path,
    maximum: usize,
    error_code: &'static str,
) -> Result<Vec<u8>, RecoveryError> {
    let path = path.to_owned();
    let file = tokio::task::spawn_blocking(move || open_existing_regular_file(&path))
        .await
        .map_err(|_| RecoveryError::new(error_code))?
        .map_err(|_| RecoveryError::new(error_code))?;
    let metadata = file
        .metadata()
        .map_err(|_| RecoveryError::new(error_code))?;
    if metadata.len() > maximum as u64 {
        return Err(RecoveryError::new(error_code));
    }
    let file = fs::File::from_std(file);
    let mut output = Vec::with_capacity(metadata.len() as usize);
    file.take(maximum as u64 + 1)
        .read_to_end(&mut output)
        .await
        .map_err(|_| RecoveryError::new(error_code))?;
    if output.len() > maximum {
        return Err(RecoveryError::new(error_code));
    }
    Ok(output)
}

struct ToolOutput {
    stdout: Zeroizing<Vec<u8>>,
    tool_version: String,
}

struct RepositoryLock {
    _file: fs::File,
}

impl RepositoryLock {
    async fn acquire(path: PathBuf) -> Result<Self, RecoveryError> {
        let file = tokio::task::spawn_blocking(move || open_locked_file(&path))
            .await
            .map_err(|_| RecoveryError::new("backup_repository_busy"))?
            .map_err(|_| RecoveryError::new("backup_repository_busy"))?;
        Ok(Self {
            _file: fs::File::from_std(file),
        })
    }
}

async fn run_pg_dump(
    database_url: &str,
    snapshot_id: &str,
    expected_target_fingerprint: &str,
    mode: &PgToolMode,
) -> Result<ToolOutput, RecoveryError> {
    let version = run_tool_version("pg_dump", mode).await?;
    verify_tool_target(database_url, mode, expected_target_fingerprint).await?;
    let application_name = tool_application_name("dump");
    let mut command = pg_command("pg_dump", database_url, mode, Some(&application_name))?;
    command.args([
        "--format=custom",
        "--no-owner",
        "--no-acl",
        "--no-password",
        "--snapshot",
        snapshot_id,
    ]);
    let stdout = match run_tool(command, None, MAX_PLAINTEXT_DUMP_BYTES, "pg_dump_failed").await {
        Ok(stdout) => stdout,
        Err(error) => {
            cancel_tool_backend(database_url, &application_name).await?;
            return Err(error);
        }
    };
    Ok(ToolOutput {
        stdout,
        tool_version: version,
    })
}

async fn run_pg_restore(
    locked_connection: &mut PgConnection,
    database_url: &str,
    mode: &PgToolMode,
    expected_target_fingerprint: &str,
    plaintext: &[u8],
) -> Result<(), RecoveryError> {
    let version = run_tool_version("pg_restore", mode).await?;
    if parse_pg_tool_major(&version) != Some(18) {
        return Err(RecoveryError::new("postgres_tool_version_mismatch"));
    }
    verify_tool_target(database_url, mode, expected_target_fingerprint).await?;
    let application_name = tool_application_name("restore");
    let mut command = pg_command("pg_restore", database_url, mode, Some(&application_name))?;
    let database_name = parse_postgres_url(database_url)?.database;
    command.args([
        "--single-transaction",
        "--exit-on-error",
        "--no-owner",
        "--no-acl",
        "--no-password",
        "--dbname",
        &database_name,
    ]);
    if let Err(error) = run_tool(
        command,
        Some(plaintext),
        MAX_TOOL_STDOUT_BYTES,
        "pg_restore_failed",
    )
    .await
    {
        terminate_tool_backend(locked_connection, &application_name).await?;
        return Err(error);
    }
    Ok(())
}

async fn verify_tool_target(
    database_url: &str,
    mode: &PgToolMode,
    expected_target_fingerprint: &str,
) -> Result<(), RecoveryError> {
    let application_name = tool_application_name("preflight");
    let mut command = pg_command("psql", database_url, mode, Some(&application_name))?;
    command.args([
        "--no-psqlrc",
        "--no-password",
        "--tuples-only",
        "--no-align",
        "--field-separator=|",
        "--command",
        "SELECT (pg_control_system()).system_identifier::text, d.oid::text, d.datname FROM pg_database d WHERE d.datname = current_database()",
    ]);
    let output = match run_tool(command, None, 4096, "postgres_tool_target_check_failed").await {
        Ok(output) => output,
        Err(error) => {
            cancel_tool_backend(database_url, &application_name).await?;
            return Err(error);
        }
    };
    let output = String::from_utf8(output.to_vec())
        .map_err(|_| RecoveryError::new("postgres_tool_target_check_failed"))?;
    let mut fields = output.trim().split('|');
    let system_identifier = fields
        .next()
        .ok_or_else(|| RecoveryError::new("postgres_tool_target_check_failed"))?;
    let database_oid = fields
        .next()
        .ok_or_else(|| RecoveryError::new("postgres_tool_target_check_failed"))?;
    let database_name = fields
        .next()
        .ok_or_else(|| RecoveryError::new("postgres_tool_target_check_failed"))?;
    if fields.next().is_some()
        || fingerprint_fields(system_identifier, database_oid, database_name)
            != expected_target_fingerprint
    {
        return Err(RecoveryError::new("postgres_tool_target_mismatch"));
    }
    Ok(())
}

async fn run_tool_version(tool: &str, mode: &PgToolMode) -> Result<String, RecoveryError> {
    let mut command = match mode {
        PgToolMode::Host => safe_command(tool),
        PgToolMode::Docker { container } => {
            let mut command = safe_command("docker");
            command.args(["exec", container, tool]);
            command
        }
    };
    command.arg("--version");
    let bytes = run_tool(command, None, 4096, "postgres_tool_version_failed").await?;
    String::from_utf8(bytes.to_vec())
        .map_err(|_| RecoveryError::new("postgres_tool_version_invalid"))
}

fn tool_application_name(operation: &str) -> String {
    format!("hostlet-recovery-{operation}-{}", Uuid::new_v4())
}

async fn cancel_tool_backend(
    database_url: &str,
    application_name: &str,
) -> Result<(), RecoveryError> {
    let options = database_url
        .parse::<PgConnectOptions>()
        .map_err(|_| RecoveryError::new("postgres_tool_cancellation_failed"))?
        .disable_statement_logging();
    let mut connection = tokio::time::timeout(
        StdDuration::from_secs(10),
        PgConnection::connect_with(&options),
    )
    .await
    .map_err(|_| RecoveryError::new("postgres_tool_cancellation_failed"))?
    .map_err(|_| RecoveryError::new("postgres_tool_cancellation_failed"))?;
    configure_direct_connection(&mut connection)
        .await
        .map_err(|_| RecoveryError::new("postgres_tool_cancellation_failed"))?;
    terminate_tool_backend(&mut connection, application_name).await
}

async fn terminate_tool_backend(
    connection: &mut PgConnection,
    application_name: &str,
) -> Result<(), RecoveryError> {
    sqlx::query(
        "SELECT pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity \
         WHERE datname = current_database() AND application_name = $1 \
           AND pid <> pg_backend_pid()",
    )
    .bind(application_name)
    .execute(&mut *connection)
    .await
    .map_err(|_| RecoveryError::new("postgres_tool_cancellation_failed"))?;

    let deadline = tokio::time::Instant::now() + StdDuration::from_secs(10);
    loop {
        let remains: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity \
             WHERE datname = current_database() AND application_name = $1 \
               AND pid <> pg_backend_pid())",
        )
        .bind(application_name)
        .fetch_one(&mut *connection)
        .await
        .map_err(|_| RecoveryError::new("postgres_tool_cancellation_failed"))?;
        if !remains {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(RecoveryError::new("postgres_tool_cancellation_failed"));
        }
        tokio::time::sleep(StdDuration::from_millis(100)).await;
    }
}

fn pg_command(
    tool: &str,
    database_url: &str,
    mode: &PgToolMode,
    application_name: Option<&str>,
) -> Result<Command, RecoveryError> {
    match mode {
        PgToolMode::Host => {
            let parameters = parse_postgres_url(database_url)?;
            let mut command = safe_command(tool);
            apply_pg_environment(&mut command, &parameters, false, application_name);
            Ok(command)
        }
        PgToolMode::Docker { container } => {
            let parameters = parse_postgres_url(database_url)?;
            let mut command = safe_command("docker");
            apply_pg_environment(&mut command, &parameters, true, application_name);
            command.args([
                "exec",
                "-i",
                "--env",
                "PGHOST",
                "--env",
                "PGPORT",
                "--env",
                "PGUSER",
                "--env",
                "PGDATABASE",
            ]);
            if parameters.password.is_some() {
                command.args(["--env", "PGPASSWORD"]);
            }
            if application_name.is_some() {
                command.args(["--env", "PGAPPNAME"]);
            }
            command.args([
                container,
                "timeout",
                "--signal=KILL",
                "--kill-after=5s",
                "110s",
                tool,
            ]);
            Ok(command)
        }
    }
}

struct PgParameters {
    host: String,
    port: u16,
    user: String,
    password: Option<String>,
    database: String,
    sslmode: Option<String>,
}

fn parse_postgres_url(database_url: &str) -> Result<PgParameters, RecoveryError> {
    let parsed = url::Url::parse(database_url)
        .map_err(|_| RecoveryError::new("invalid_database_configuration"))?;
    if !matches!(parsed.scheme(), "postgres" | "postgresql") {
        return Err(RecoveryError::new("invalid_database_configuration"));
    }
    let host = parsed
        .host_str()
        .map(str::to_owned)
        .ok_or_else(|| RecoveryError::new("invalid_database_configuration"))?;
    let port = parsed.port().unwrap_or(5432);
    let user = percent_decode(parsed.username())?;
    if user.is_empty() {
        return Err(RecoveryError::new("invalid_database_configuration"));
    }
    let password = parsed.password().map(percent_decode).transpose()?;
    let mut path_segments = parsed
        .path_segments()
        .ok_or_else(|| RecoveryError::new("invalid_database_configuration"))?;
    let database = path_segments
        .next()
        .map(percent_decode)
        .transpose()?
        .filter(|database| !database.is_empty())
        .ok_or_else(|| RecoveryError::new("invalid_database_configuration"))?;
    if path_segments.any(|segment| !segment.is_empty()) {
        return Err(RecoveryError::new("invalid_database_configuration"));
    }
    let mut sslmode = None;
    for (name, value) in parsed.query_pairs() {
        if name == "sslmode"
            && sslmode.is_none()
            && matches!(
                value.as_ref(),
                "disable" | "allow" | "prefer" | "require" | "verify-ca" | "verify-full"
            )
        {
            sslmode = Some(value.into_owned());
        } else {
            return Err(RecoveryError::new("unsupported_database_configuration"));
        }
    }
    Ok(PgParameters {
        host,
        port,
        user,
        password,
        database,
        sslmode,
    })
}

fn apply_pg_environment(
    command: &mut Command,
    parameters: &PgParameters,
    docker: bool,
    application_name: Option<&str>,
) {
    command
        .env(
            "PGHOST",
            if docker {
                "127.0.0.1"
            } else {
                &parameters.host
            },
        )
        .env(
            "PGPORT",
            if docker {
                "5432".to_owned()
            } else {
                parameters.port.to_string()
            },
        )
        .env("PGUSER", &parameters.user)
        .env("PGDATABASE", &parameters.database);
    if let Some(password) = &parameters.password {
        command.env("PGPASSWORD", password);
    }
    if let Some(application_name) = application_name {
        command.env("PGAPPNAME", application_name);
    }
    if !docker && let Some(sslmode) = &parameters.sslmode {
        command.env("PGSSLMODE", sslmode);
    }
}

fn percent_decode(value: &str) -> Result<String, RecoveryError> {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err(RecoveryError::new("invalid_database_configuration"));
            }
            let high = hex_digit(bytes[index + 1])
                .ok_or_else(|| RecoveryError::new("invalid_database_configuration"))?;
            let low = hex_digit(bytes[index + 2])
                .ok_or_else(|| RecoveryError::new("invalid_database_configuration"))?;
            output.push(high << 4 | low);
            index += 3;
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(output).map_err(|_| RecoveryError::new("invalid_database_configuration"))
}

fn hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

async fn run_tool(
    mut command: Command,
    input: Option<&[u8]>,
    maximum_stdout: usize,
    error_code: &'static str,
) -> Result<Zeroizing<Vec<u8>>, RecoveryError> {
    command
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|_| RecoveryError::new(error_code))?;
    let mut stdin = child.stdin.take();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| RecoveryError::new(error_code))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| RecoveryError::new(error_code))?;

    let operation = async {
        let write_input = async {
            if let (Some(writer), Some(bytes)) = (&mut stdin, input) {
                writer.write_all(bytes).await?;
                writer.shutdown().await?;
            }
            Ok::<(), std::io::Error>(())
        };
        let read_stdout = read_stream_bounded(stdout, maximum_stdout);
        let read_stderr = read_stream_bounded(stderr, MAX_TOOL_STDERR_BYTES);
        let wait = child.wait();
        tokio::try_join!(write_input, read_stdout, read_stderr, wait)
    };
    let outcome = tokio::time::timeout(TOOL_TIMEOUT, operation).await;
    let ((), stdout, _stderr, status) = match outcome {
        Ok(Ok(output)) => output,
        Ok(Err(_)) => {
            terminate_child(&mut child).await;
            return Err(RecoveryError::new(error_code));
        }
        Err(_) => {
            terminate_child(&mut child).await;
            return Err(RecoveryError::new("postgres_tool_timeout"));
        }
    };
    if !status.success() {
        return Err(RecoveryError::new(error_code));
    }
    Ok(stdout)
}

fn safe_command(program: &str) -> Command {
    let mut command = Command::new(program);
    command.env_clear().env("LC_ALL", "C").env("LANG", "C");
    if let Some(path) = std::env::var_os("PATH") {
        command.env("PATH", path);
    }
    command
}

fn open_new_private_file(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600).custom_flags(0o00400000);
    options.open(path)
}

fn open_existing_regular_file(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(0o00400000 | 0o00004000);
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(std::io::Error::other(
            "backup artifact is not a regular file",
        ));
    }
    Ok(file)
}

fn open_locked_file(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    options.mode(0o600).custom_flags(0o00400000 | 0o00004000);
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(std::io::Error::other(
            "scheduler lock is not a regular file",
        ));
    }
    file.set_permissions({
        #[cfg(unix)]
        {
            std::fs::Permissions::from_mode(0o600)
        }
        #[cfg(not(unix))]
        {
            file.metadata()?.permissions()
        }
    })?;
    file.try_lock()?;
    Ok(file)
}

async fn read_stream_bounded(
    reader: impl AsyncRead + Unpin,
    maximum: usize,
) -> Result<Zeroizing<Vec<u8>>, std::io::Error> {
    let mut output = Zeroizing::new(Vec::new());
    reader
        .take(maximum as u64 + 1)
        .read_to_end(&mut output)
        .await?;
    if output.len() > maximum {
        return Err(std::io::Error::other("bounded process output exceeded"));
    }
    Ok(output)
}

async fn terminate_child(child: &mut tokio::process::Child) {
    let _ = child.kill().await;
    let _ = tokio::time::timeout(StdDuration::from_secs(5), child.wait()).await;
}

fn parse_pg_tool_major(version: &str) -> Option<u16> {
    version
        .split_whitespace()
        .find_map(|part| part.split('.').next()?.parse::<u16>().ok())
}

fn validate_tool_mode(mode: &PgToolMode) -> Result<(), RecoveryError> {
    let PgToolMode::Docker { container } = mode else {
        return Ok(());
    };
    if container.is_empty()
        || container.len() > 128
        || !container
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
    {
        return Err(RecoveryError::new("postgres_container_invalid"));
    }
    Ok(())
}

fn backup_path(repository: &Path, backup_id: Uuid) -> PathBuf {
    repository.join(format!("{backup_id}.{BACKUP_EXTENSION}"))
}

fn receipt_path(repository: &Path, backup_id: Uuid) -> PathBuf {
    repository.join(format!("{backup_id}.{RECEIPT_SUFFIX}"))
}

fn encoded_envelope_limit() -> usize {
    MAX_PLAINTEXT_DUMP_BYTES.saturating_mul(4) / 3 + 2 * 1024 * 1024
}

fn hex_sha256(value: &[u8]) -> String {
    hex_bytes(&Sha256::digest(value))
}

fn hex_bytes(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(encoded, "{byte:02x}");
    }
    encoded
}
