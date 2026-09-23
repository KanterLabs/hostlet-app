//! Dedicated HOST-225 durable build queue and trusted source materializer.
//! M1 bookkeeping jobs deliberately remain in `jobs.rs`.

use std::{
    collections::{BTreeMap, HashSet},
    fs::OpenOptions,
    io::{Read, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Component, Path, PathBuf},
};

use axum::{
    Json, Router,
    extract::{Path as AxumPath, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use hostlet_contracts::project::{FrameworkPattern, ServiceKind, StandardProjectSpec};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, Postgres, Transaction};
use uuid::Uuid;
use zeroize::Zeroize;

use crate::{
    auth::Authenticated,
    error::{ApiError, SafeJson},
    foundation::FoundationState,
    intent::{self, Replay},
    m3::BuildWorkerAuth,
};

const NODE24_PROFILE: &str = "m3-owned-node24-v1";
const NODE22_PROFILE: &str = "m3-owned-node22-v1";
const CACHE_MISS_PROFILE: &str = "m3-owned-node24-cache-miss-v1";
const MATERIALIZER_REVISION: &str = "hostlet.source-bundle/hbs1";
const ANALYZER_REVISION: &str = "hostlet.compatibility/v1+hostlet.compatibility-bounds/v1";
const RESERVED_SECONDS: i32 = 600;
const MAX_SECRETS: usize = 128;
const MAX_ARTIFACTS: usize = 2;
const DIGEST_BYTES: usize = 71;
const SOURCE_REJECTION_COMPLETION_SECONDS: f64 = 30.0;

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct SecretRefRequest {
    service_id: Uuid,
    secret_version_id: Uuid,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct EnqueueRequest {
    source_revision_id: Uuid,
    compatibility_report_id: Uuid,
    source_proof_id: Uuid,
    reservation_id: Uuid,
    reservation_epoch: Uuid,
    build_profile: String,
    secret_version_refs: Vec<SecretRefRequest>,
}

#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub(crate) struct BuildJobRecord {
    id: Uuid,
    project_id: Uuid,
    deployment_id: Uuid,
    source_revision_id: Uuid,
    configuration_revision_id: Uuid,
    compatibility_report_id: Uuid,
    source_commit: String,
    source_tree_sha: String,
    build_profile_id: String,
    build_profile_digest: String,
    input_manifest_digest: String,
    state: String,
    revision: i64,
    attempt_count: i32,
    current_attempt_id: Option<Uuid>,
    current_fence: i64,
    lease_expires_at: Option<DateTime<Utc>>,
    terminal_code: Option<String>,
    cleanup_status: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct BuildEnvelope {
    build: BuildJobRecord,
}

#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
struct ArtifactRecord {
    id: Uuid,
    service_id: Uuid,
    kind: String,
    archive_digest: String,
    manifest_digest: String,
    packed_bytes: i64,
    unpacked_bytes: i64,
    entry_count: i32,
    entrypoint_argv: Option<Value>,
    created_at: DateTime<Utc>,
}

#[derive(Serialize)]
struct BuildDetail {
    build: BuildJobRecord,
    artifacts: Vec<ArtifactRecord>,
    report: Value,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyRequest {}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Profile {
    id: String,
    digest: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LeaseRequest {
    worker_id: String,
    kinds: Vec<String>,
    profiles: Vec<Profile>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
struct Limits {
    cpu_millis: u32,
    memory_bytes: u64,
    timeout_seconds: u32,
    workspace_bytes: u64,
    static_output_bytes: u64,
    runtime_output_bytes: u64,
    max_entries: u32,
    console_bytes: u64,
    report_bytes: u64,
}

fn limits() -> Limits {
    Limits {
        cpu_millis: 2_000,
        memory_bytes: 2_147_483_648,
        timeout_seconds: 600,
        workspace_bytes: 4_294_967_296,
        static_output_bytes: 262_144_000,
        runtime_output_bytes: 1_073_741_824,
        max_entries: 10_000,
        console_bytes: 4_194_304,
        report_bytes: 1_048_576,
    }
}

#[derive(Serialize, Deserialize, Clone, FromRow)]
#[serde(deny_unknown_fields)]
struct ServiceLease {
    service_id: Uuid,
    kind: String,
    root: String,
    node_major: i16,
    framework: String,
    lockfile_path: String,
    build_command: String,
    output_directory: String,
    start_command: Option<String>,
    health_path: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, FromRow)]
#[serde(deny_unknown_fields)]
struct SecretLease {
    service_id: Uuid,
    secret_version_id: Uuid,
    name: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct LeaseJob {
    id: Uuid,
    kind: String,
    account_id: Uuid,
    project_id: Uuid,
    deployment_id: Uuid,
    configuration_revision_id: Uuid,
    source_revision_id: Uuid,
    compatibility_report_id: Uuid,
    source_commit: String,
    source_tree_sha: String,
    build_profile: Profile,
    input_manifest_digest: String,
    secret_version_refs: Vec<SecretLease>,
    limits: Limits,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct AttemptLease {
    id: Uuid,
    attempt_number: i32,
    fence: i64,
    worker_id: String,
    lease_expires_at: DateTime<Utc>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct LeaseResponse {
    job: LeaseJob,
    services: Vec<ServiceLease>,
    attempt: AttemptLease,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LiveAttemptRequest {
    worker_id: String,
    attempt_id: Uuid,
    fence: i64,
}

#[derive(Serialize)]
struct RenewResponse {
    job_id: Uuid,
    attempt_id: Uuid,
    fence: i64,
    lease_expires_at: DateTime<Utc>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct MaterializationResponse {
    commit_sha: String,
    tree_sha: String,
    bundle_digest: String,
    tree_manifest_digest: String,
    entry_count: u32,
    total_bytes: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CredentialsRequest {
    worker_id: String,
    attempt_id: Uuid,
    fence: i64,
    secret_version_ids: Vec<Uuid>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CancelAckRequest {
    worker_id: String,
    attempt_id: Uuid,
    fence: i64,
    cleanup_receipt_digest: String,
    elapsed_seconds: i32,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CancelAckResponse {
    job_id: Uuid,
    attempt_id: Uuid,
    fence: i64,
    cleanup_status: String,
    finalized_seconds: i32,
    debit_event_id: Option<Uuid>,
}

#[derive(Serialize)]
struct Credential {
    service_id: Uuid,
    secret_version_id: Uuid,
    name: String,
    value: String,
}
impl Drop for Credential {
    fn drop(&mut self) {
        self.value.zeroize();
    }
}
#[derive(Serialize)]
struct CredentialsResponse {
    credentials: Vec<Credential>,
}

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct ArtifactCompletion {
    service_id: Uuid,
    kind: String,
    archive_digest: String,
    manifest_digest: String,
    packed_bytes: i64,
    unpacked_bytes: i64,
    entry_count: i32,
    entrypoint_argv: Option<Vec<String>>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CompletionOutcome {
    state: String,
    code: String,
    result_manifest_digest: String,
    cleanup_receipt_digest: String,
    elapsed_seconds: i32,
    artifacts: Vec<ArtifactCompletion>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CompleteRequest {
    worker_id: String,
    attempt_id: Uuid,
    fence: i64,
    outcome: CompletionOutcome,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CompleteResponse {
    build: BuildJobRecord,
    effect: Value,
    artifacts: Vec<ArtifactRecord>,
    meter: Value,
}

#[derive(FromRow)]
struct EnqueueContext {
    project_revision: i64,
    current_configuration_revision_id: Option<Uuid>,
    configuration_revision_id: Uuid,
    source_commit: String,
    lifecycle: String,
    source_configuration_revision_id: Uuid,
    source_revision_commit: String,
    source_tree_sha: Option<String>,
    report_configuration_revision_id: Uuid,
    report_source_revision_id: Uuid,
    analyzer_revision: String,
    report_status: String,
    proof_configuration_revision_id: Uuid,
    proof_source_commit: String,
    proof_state: String,
    proof_expires_at: DateTime<Utc>,
    reservation_state: String,
    reservation_epoch: Uuid,
    reservation_first_deployment_id: Uuid,
    entitlement_id: Uuid,
    entitlement_state: String,
    period_starts_at: DateTime<Utc>,
    period_ends_at: DateTime<Utc>,
    build_seconds_limit: i32,
}

pub(crate) fn routes() -> Router<FoundationState> {
    Router::new()
        .route(
            "/v1/projects/{project_id}/deployments/{deployment_id}/builds",
            post(enqueue),
        )
        .route(
            "/v1/projects/{project_id}/builds/{build_job_id}",
            get(get_build),
        )
        .route(
            "/v1/projects/{project_id}/builds/{build_job_id}/cancel",
            post(cancel),
        )
}

pub(crate) fn internal_routes() -> Router<FoundationState> {
    Router::new()
        .route("/internal/v1/build-jobs/lease", post(lease))
        .route("/internal/v1/build-jobs/{id}/renew", post(renew))
        .route(
            "/internal/v1/build-jobs/{id}/source:materialize",
            post(materialize),
        )
        .route(
            "/internal/v1/build-jobs/{id}/credentials:resolve",
            post(resolve_credentials),
        )
        .route("/internal/v1/build-jobs/{id}/cancel:ack", post(cancel_ack))
        .route("/internal/v1/build-jobs/{id}/complete", post(complete))
}

async fn enqueue(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    AxumPath((project_id, deployment_id)): AxumPath<(String, String)>,
    headers: HeaderMap,
    SafeJson(request): SafeJson<EnqueueRequest>,
) -> Result<(StatusCode, Json<BuildEnvelope>), ApiError> {
    crate::m3::require_enabled(&state)?;
    validate_enqueue(&request)?;
    let account_id = authenticated.account_id()?;
    let project_id = intent::path_uuid(&project_id)?;
    let deployment_id = intent::path_uuid(&deployment_id)?;
    let expected = intent::if_match_revision(&headers)?;
    let key = intent::idempotency_key(&headers)?;
    let request_hash = intent::request_hash(&request)?;
    let operation = format!("m3.build.enqueue/{project_id}/{deployment_id}");
    let mut tx = state.pool.begin().await?;
    intent::acquire_operation_lock(&mut tx, account_id, &operation, key).await?;
    match intent::replay(&mut tx, account_id, &operation, key, &request_hash).await? {
        Replay::Match(value) => {
            tx.commit().await?;
            return Ok((StatusCode::OK, Json(value)));
        }
        Replay::Changed => {
            return Err(ApiError::conflict(
                "idempotency_payload_changed",
                "the idempotency key was already used with a different request",
            ));
        }
        Replay::Miss => {}
    }
    // Lock entitlement first, then all exact admitted source rows in one order.
    let account_lock: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM accounts WHERE id=$1 FOR UPDATE")
            .bind(account_id)
            .fetch_optional(&mut *tx)
            .await?;
    if account_lock.is_none() {
        return Err(ApiError::not_found());
    }
    let context: Option<EnqueueContext>=sqlx::query_as(
        "SELECT p.revision AS project_revision,p.current_configuration_revision_id,d.configuration_revision_id,d.source_commit,d.lifecycle, \
          sr.configuration_revision_id AS source_configuration_revision_id,sr.commit_sha AS source_revision_commit,sr.tree_sha AS source_tree_sha, \
          cr.configuration_revision_id AS report_configuration_revision_id,cr.source_revision_id AS report_source_revision_id,cr.analyzer_revision,cr.status AS report_status, \
          sp.configuration_revision_id AS proof_configuration_revision_id,sp.source_commit AS proof_source_commit,sp.state AS proof_state,sp.expires_at AS proof_expires_at, \
          r.state AS reservation_state,r.reservation_epoch,r.first_deployment_id AS reservation_first_deployment_id,r.entitlement_id,e.state AS entitlement_state,e.period_starts_at,e.period_ends_at,e.build_seconds_limit \
         FROM projects p JOIN deployments d ON d.account_id=p.account_id AND d.project_id=p.id \
         JOIN github_source_revisions sr ON sr.account_id=p.account_id AND sr.project_id=p.id AND sr.id=$4 \
         JOIN compatibility_reports cr ON cr.account_id=p.account_id AND cr.project_id=p.id AND cr.id=$5 \
         JOIN admission_source_proofs sp ON sp.account_id=p.account_id AND sp.project_id=p.id AND sp.deployment_id=d.id AND sp.id=$6 \
         JOIN slot_reservations r ON r.account_id=p.account_id AND r.project_id=p.id AND r.id=$7 \
         JOIN admission_entitlements e ON e.id=r.entitlement_id AND e.account_id=p.account_id \
         WHERE p.account_id=$1 AND p.id=$2 AND d.id=$3 FOR UPDATE OF p,d,sr,cr,sp,r,e"
    ).bind(account_id).bind(project_id).bind(deployment_id).bind(request.source_revision_id)
     .bind(request.compatibility_report_id).bind(request.source_proof_id).bind(request.reservation_id)
     .fetch_optional(&mut *tx).await?;
    let c = context.ok_or_else(ApiError::not_found)?;
    let now = crate::m3::policy_now(&state).await?;
    let source_tree = c.source_tree_sha.clone().ok_or_else(|| {
        ApiError::conflict(
            "build_source_unverified",
            "the exact source tree is not verified",
        )
    })?;
    if c.project_revision != expected {
        return Err(ApiError::stale_revision());
    }
    if c.current_configuration_revision_id != Some(c.configuration_revision_id)
        || c.source_configuration_revision_id != c.configuration_revision_id
        || c.report_configuration_revision_id != c.configuration_revision_id
        || c.proof_configuration_revision_id != c.configuration_revision_id
        || c.report_source_revision_id != request.source_revision_id
        || c.source_commit != c.source_revision_commit
        || c.source_commit != c.proof_source_commit
        || c.analyzer_revision != ANALYZER_REVISION
        || c.report_status != "candidate"
        || c.proof_state != "valid"
        // Source authority expires on real time, like authentication and worker
        // leases. The owned policy clock is only for subscription/lifecycle rules.
        || c.proof_expires_at <= Utc::now()
    {
        return Err(ApiError::conflict(
            "build_source_stale",
            "the current source, compatibility report, and admission proof must match exactly",
        ));
    }
    if request.reservation_epoch != c.reservation_epoch
        || !matches!(
            c.reservation_state.as_str(),
            "reserved" | "resources_retained"
        )
        || c.entitlement_state != "active"
        || c.period_starts_at > now
        || c.period_ends_at <= now
        || !matches!(c.lifecycle.as_str(), "queued" | "admission_required")
    {
        return Err(ApiError::conflict(
            "build_admission_invalid",
            "an active admitted reservation generation is required",
        ));
    }
    if c.reservation_first_deployment_id != deployment_id {
        let rollout_admitted:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM capacity_holds WHERE account_id=$1 AND project_id=$2 AND deployment_id=$3 AND reservation_id=$4 AND reservation_epoch=$5 AND kind='rollout' AND state='consumed')")
            .bind(account_id).bind(project_id).bind(deployment_id).bind(request.reservation_id).bind(request.reservation_epoch).fetch_one(&mut *tx).await?;
        if !rollout_admitted {
            return Err(ApiError::conflict(
                "build_admission_invalid",
                "a consumed rollout hold is required for this deployment",
            ));
        }
    }
    let used: i64=sqlx::query_scalar("SELECT \
        COALESCE((SELECT sum(CASE WHEN kind='debit' THEN seconds ELSE -seconds END) FROM build_usage_events WHERE entitlement_id=$1),0) + \
        COALESCE((SELECT sum(reserved_seconds) FROM build_usage_reservations WHERE entitlement_id=$1 AND state='reserved'),0)")
        .bind(c.entitlement_id).fetch_one(&mut *tx).await?;
    if used + i64::from(RESERVED_SECONDS) > i64::from(c.build_seconds_limit) {
        return Err(ApiError::conflict(
            "build_allowance_exhausted",
            "the admitted build allowance cannot reserve this build",
        ));
    }
    let spec_value: Value=sqlx::query_scalar("SELECT spec FROM configuration_revisions WHERE account_id=$1 AND project_id=$2 AND id=$3 FOR SHARE")
        .bind(account_id).bind(project_id).bind(c.configuration_revision_id).fetch_one(&mut *tx).await?;
    let spec: StandardProjectSpec =
        serde_json::from_value(spec_value).map_err(|_| ApiError::internal())?;
    let services = snapshot_services(
        &mut tx,
        account_id,
        project_id,
        c.configuration_revision_id,
        &spec,
    )
    .await?;
    let derived_profile =
        derive_profile_id(&state, &services, &c.source_commit, &request.build_profile)?;
    if request.build_profile != derived_profile {
        return Err(ApiError::unprocessable(
            "build_profile_not_admitted",
            "the owned-fixture source and service graph require a different build profile",
        ));
    }
    let profile = load_profile(&state, derived_profile)?;
    let secrets = validate_secret_refs(
        &mut tx,
        account_id,
        project_id,
        &request.secret_version_refs,
        &services,
    )
    .await?;
    let job_id = Uuid::new_v4();
    let manifest = json!({"schema":"hostlet.build-input/v1","execution_id":job_id,"source_revision_id":request.source_revision_id,
        "configuration_revision_id":c.configuration_revision_id,"compatibility_report_id":request.compatibility_report_id,
        "source_commit":c.source_commit,"source_tree_sha":source_tree,"profile":profile.clone(),
        "services":services,"secret_version_refs":secrets,"limits":limits()});
    let manifest_bytes = serde_json::to_vec(&manifest).map_err(|_| ApiError::internal())?;
    let manifest_digest = format!("sha256:{:x}", Sha256::digest(&manifest_bytes));
    let existing: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM build_jobs WHERE deployment_id=$1 AND input_manifest_digest=$2 FOR SHARE",
    )
    .bind(deployment_id)
    .bind(&manifest_digest)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(existing) = existing {
        let build = load_build(&mut tx, account_id, project_id, existing)
            .await?
            .ok_or_else(ApiError::internal)?;
        let response = BuildEnvelope { build };
        intent::store_replay(
            &mut tx,
            account_id,
            &operation,
            key,
            &request_hash,
            200,
            &response,
        )
        .await?;
        tx.commit().await?;
        return Ok((StatusCode::OK, Json(response)));
    }
    sqlx::query("INSERT INTO build_jobs (id,account_id,project_id,deployment_id,reservation_id,reservation_epoch,source_proof_id,source_revision_id,compatibility_report_id,configuration_revision_id,source_commit,source_tree_sha,build_profile_id,build_profile_digest,input_manifest,input_manifest_digest,state) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'queued')")
        .bind(job_id).bind(account_id).bind(project_id).bind(deployment_id).bind(request.reservation_id).bind(request.reservation_epoch)
        .bind(request.source_proof_id).bind(request.source_revision_id).bind(request.compatibility_report_id).bind(c.configuration_revision_id)
        .bind(&c.source_commit).bind(&source_tree).bind(&profile.id).bind(&profile.digest).bind(&manifest).bind(&manifest_digest).execute(&mut *tx).await?;
    insert_service_snapshots(
        &mut tx,
        job_id,
        account_id,
        project_id,
        c.configuration_revision_id,
        &services,
    )
    .await?;
    insert_secret_snapshots(&mut tx, job_id, account_id, project_id, &secrets).await?;
    sqlx::query("INSERT INTO build_usage_reservations(job_id,account_id,project_id,deployment_id,entitlement_id,reserved_seconds,state) VALUES($1,$2,$3,$4,$5,$6,'reserved')")
        .bind(job_id).bind(account_id).bind(project_id).bind(deployment_id).bind(c.entitlement_id).bind(RESERVED_SECONDS).execute(&mut *tx).await?;
    let build = load_build(&mut tx, account_id, project_id, job_id)
        .await?
        .ok_or_else(ApiError::internal)?;
    let response = BuildEnvelope { build };
    intent::audit(
        &mut tx,
        account_id,
        authenticated.session_id(),
        "m3.build.enqueue",
        "build_job",
        Some(job_id),
        "succeeded",
    )
    .await?;
    intent::store_replay(
        &mut tx,
        account_id,
        &operation,
        key,
        &request_hash,
        201,
        &response,
    )
    .await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(response)))
}

fn validate_enqueue(request: &EnqueueRequest) -> Result<(), ApiError> {
    if !profile_allowed(&request.build_profile)
        || request.secret_version_refs.len() > MAX_SECRETS
        || request
            .secret_version_refs
            .iter()
            .map(|v| v.secret_version_id)
            .collect::<HashSet<_>>()
            .len()
            != request.secret_version_refs.len()
    {
        return Err(ApiError::unprocessable(
            "invalid_build_request",
            "the build profile or secret references are invalid",
        ));
    }
    Ok(())
}

fn profile_allowed(value: &str) -> bool {
    matches!(value, NODE24_PROFILE | NODE22_PROFILE | CACHE_MISS_PROFILE)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProfileFile {
    schema: String,
    id: String,
    qemu_binary: PathBuf,
    qemu_digest: String,
    kernel: ProfilePinnedFile,
    initrd: ProfilePinnedFile,
    rootfs: ProfilePinnedFile,
    dependency_cache: ProfilePinnedFile,
    mkfs_ext4: PathBuf,
    sudo: PathBuf,
    systemd_run: PathBuf,
    systemctl: PathBuf,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProfilePinnedFile {
    path: PathBuf,
    digest: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProfileAdmissions {
    schema: String,
    cache_miss_source_commits: Vec<String>,
}

fn owned_file(path: &Path, parent: &Path, max_bytes: u64) -> Result<Vec<u8>, ApiError> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| {
        ApiError::unavailable(
            "build_profile_unavailable",
            "an approved owned-fixture build profile is unavailable",
        )
    })?;
    let mode = metadata.permissions().mode() & 0o777;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > max_bytes
        || !matches!(mode, 0o400 | 0o600)
        || std::fs::canonicalize(path).ok().as_deref() != Some(path)
        || path.parent() != Some(parent)
    {
        return Err(ApiError::unavailable(
            "build_profile_invalid",
            "an approved owned-fixture build profile is invalid",
        ));
    }
    std::fs::read(path).map_err(|_| {
        ApiError::unavailable(
            "build_profile_unavailable",
            "an approved owned-fixture build profile is unavailable",
        )
    })
}

fn profile_directory(state: &FoundationState) -> Result<PathBuf, ApiError> {
    let config = crate::m3::require_enabled(state)?;
    let directory = config.state_dir.join("profiles");
    let metadata = std::fs::symlink_metadata(&directory).map_err(|_| {
        ApiError::unavailable(
            "build_profile_unavailable",
            "the owned-fixture profile directory is unavailable",
        )
    })?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.permissions().mode() & 0o077 != 0
        || std::fs::canonicalize(&directory).ok().as_ref() != Some(&directory)
    {
        return Err(ApiError::unavailable(
            "build_profile_invalid",
            "the owned-fixture profile directory is invalid",
        ));
    }
    Ok(directory)
}

fn load_profile(state: &FoundationState, id: &str) -> Result<Profile, ApiError> {
    if !profile_allowed(id) {
        return Err(ApiError::unprocessable(
            "build_profile_not_admitted",
            "the build profile is not admitted",
        ));
    }
    let directory = profile_directory(state)?;
    let path = directory.join(format!("{id}.json"));
    let bytes = owned_file(&path, &directory, 65_536)?;
    let profile: ProfileFile = serde_json::from_slice(&bytes).map_err(|_| {
        ApiError::unavailable(
            "build_profile_invalid",
            "the owned-fixture build profile is malformed",
        )
    })?;
    let pinned = [
        &profile.kernel,
        &profile.initrd,
        &profile.rootfs,
        &profile.dependency_cache,
    ];
    if profile.schema != "hostlet.build-profile/v1"
        || profile.id != id
        || !valid_digest(&profile.qemu_digest)
        || pinned
            .iter()
            .any(|item| !item.path.is_absolute() || !valid_digest(&item.digest))
        || [
            &profile.qemu_binary,
            &profile.mkfs_ext4,
            &profile.sudo,
            &profile.systemd_run,
            &profile.systemctl,
        ]
        .iter()
        .any(|path| !path.is_absolute())
    {
        return Err(ApiError::unavailable(
            "build_profile_invalid",
            "the owned-fixture build profile is malformed",
        ));
    }
    Ok(Profile {
        id: id.to_owned(),
        digest: format!("sha256:{:x}", Sha256::digest(bytes)),
    })
}

fn cache_miss_source_admitted(state: &FoundationState, commit: &str) -> Result<bool, ApiError> {
    let directory = profile_directory(state)?;
    let path = directory.join("admissions.json");
    let bytes = owned_file(&path, &directory, 65_536)?;
    let admissions: ProfileAdmissions = serde_json::from_slice(&bytes).map_err(|_| {
        ApiError::unavailable(
            "build_profile_invalid",
            "the owned-fixture profile admission file is malformed",
        )
    })?;
    if admissions.schema != "hostlet.build-profile-admissions/v1"
        || admissions.cache_miss_source_commits.len() > 32
        || admissions.cache_miss_source_commits.iter().any(|value| {
            value.len() != 40
                || !value
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        })
    {
        return Err(ApiError::unavailable(
            "build_profile_invalid",
            "the owned-fixture profile admission file is malformed",
        ));
    }
    Ok(admissions
        .cache_miss_source_commits
        .iter()
        .any(|value| value == commit))
}

fn derive_profile_id<'a>(
    state: &FoundationState,
    services: &[ServiceLease],
    source_commit: &str,
    requested: &'a str,
) -> Result<&'a str, ApiError> {
    let all22 = services.iter().all(|service| service.node_major == 22);
    let all24 = services.iter().all(|service| service.node_major == 24);
    if !all22 && !all24 {
        return Err(ApiError::unprocessable(
            "unsupported_node_mix",
            "one build cannot mix Node major versions",
        ));
    }
    if all22 {
        return Ok(NODE22_PROFILE);
    }
    if requested == CACHE_MISS_PROFILE && cache_miss_source_admitted(state, source_commit)? {
        return Ok(CACHE_MISS_PROFILE);
    }
    Ok(NODE24_PROFILE)
}

async fn snapshot_services(
    tx: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    project_id: Uuid,
    configuration_id: Uuid,
    spec: &StandardProjectSpec,
) -> Result<Vec<ServiceLease>, ApiError> {
    let lockfile = spec
        .repositories
        .first()
        .and_then(|r| r.lockfile_path.clone())
        .ok_or_else(|| {
            ApiError::unprocessable("unsupported_build_graph", "a declared lockfile is required")
        })?;
    let ids:Vec<(Uuid,String)>=sqlx::query_as("SELECT service_id,kind FROM service_configurations WHERE account_id=$1 AND project_id=$2 AND configuration_revision_id=$3 ORDER BY kind FOR SHARE")
        .bind(account_id).bind(project_id).bind(configuration_id).fetch_all(&mut **tx).await?;
    let by_kind: BTreeMap<String, Uuid> = ids.into_iter().map(|(id, kind)| (kind, id)).collect();
    let mut output = Vec::new();
    for service in &spec.services {
        let (kind, framework) = match (service.kind, service.framework) {
            (ServiceKind::StaticFrontend, FrameworkPattern::ViteStatic) => {
                ("static_frontend", "vite_static")
            }
            (ServiceKind::StaticFrontend, FrameworkPattern::StaticExport) => {
                ("static_frontend", "static_export")
            }
            (ServiceKind::Application, FrameworkPattern::NodeHttp) => ("application", "node_http"),
            (ServiceKind::Application, FrameworkPattern::Nextjs16Standalone) => {
                ("application", "nextjs16_standalone")
            }
            (ServiceKind::Postgres, FrameworkPattern::Postgresql18) => continue,
            _ => {
                return Err(ApiError::unprocessable(
                    "unsupported_build_graph",
                    "the admitted service graph is outside the owned build profile",
                ));
            }
        };
        let service_id = *by_kind.get(kind).ok_or_else(|| {
            ApiError::conflict(
                "build_configuration_stale",
                "the saved service graph does not match its configuration",
            )
        })?;
        let node_major = service
            .node
            .as_ref()
            .map(|node| node.major)
            .filter(|major| matches!(major, 22 | 24))
            .ok_or_else(|| {
                ApiError::unprocessable(
                    "unsupported_node_version",
                    "the owned build profile supports Node 22 or 24",
                )
            })?;
        let build_command = service.build_command.clone().ok_or_else(|| {
            ApiError::unprocessable(
                "unsupported_build_graph",
                "each build service requires an explicit build command",
            )
        })?;
        let output_directory = service.output_directory.clone().ok_or_else(|| {
            ApiError::unprocessable(
                "unsupported_build_graph",
                "each build service requires an explicit output directory",
            )
        })?;
        let (start_command, health_path) = if kind == "application" {
            (
                Some(service.start_command.clone().ok_or_else(|| {
                    ApiError::unprocessable(
                        "unsupported_build_graph",
                        "application service requires a start command",
                    )
                })?),
                Some(
                    service
                        .health_check
                        .as_ref()
                        .map(|h| h.path.clone())
                        .ok_or_else(|| {
                            ApiError::unprocessable(
                                "unsupported_build_graph",
                                "application service requires an HTTP health path",
                            )
                        })?,
                ),
            )
        } else {
            (None, None)
        };
        output.push(ServiceLease {
            service_id,
            kind: kind.into(),
            root: service.root.clone().unwrap_or_else(|| ".".to_owned()),
            node_major: i16::try_from(node_major).map_err(|_| ApiError::internal())?,
            framework: framework.into(),
            lockfile_path: lockfile.clone(),
            build_command,
            output_directory,
            start_command,
            health_path,
        });
    }
    output.sort_by_key(|service| {
        if service.kind == "static_frontend" {
            0
        } else {
            1
        }
    });
    if output.is_empty() || output.len() > 2 {
        return Err(ApiError::unprocessable(
            "unsupported_build_graph",
            "one or two build services are required",
        ));
    }
    Ok(output)
}

#[derive(FromRow)]
struct SecretSnapshotRow {
    service_id: Uuid,
    secret_version_id: Uuid,
    name: String,
    credential_kind: String,
    status: String,
}

async fn validate_secret_refs(
    tx: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    project_id: Uuid,
    refs: &[SecretRefRequest],
    services: &[ServiceLease],
) -> Result<Vec<SecretLease>, ApiError> {
    let allowed: HashSet<Uuid> = services.iter().map(|s| s.service_id).collect();
    let mut output = Vec::new();
    for reference in refs {
        if !allowed.contains(&reference.service_id) {
            return Err(ApiError::unprocessable(
                "build_secret_scope_invalid",
                "build environment references must belong to a build service",
            ));
        }
        let row:Option<SecretSnapshotRow>=sqlx::query_as("SELECT s.service_id,sv.id AS secret_version_id,s.name,s.credential_kind,s.status FROM secrets s JOIN secret_versions sv ON sv.account_id=s.account_id AND sv.project_id=s.project_id AND sv.service_id=s.service_id AND sv.secret_id=s.id WHERE s.account_id=$1 AND s.project_id=$2 AND s.service_id=$3 AND sv.id=$4 AND s.operation='build' FOR SHARE OF s,sv")
            .bind(account_id).bind(project_id).bind(reference.service_id).bind(reference.secret_version_id).fetch_optional(&mut **tx).await?;
        let row = row.ok_or_else(|| {
            ApiError::unprocessable(
                "build_secret_scope_invalid",
                "a secret version is not available in the build scope",
            )
        })?;
        if row.credential_kind != "build_environment" || row.status != "active" {
            return Err(ApiError::unprocessable(
                "build_credential_kind_denied",
                "only active build_environment credentials may enter the guest",
            ));
        }
        output.push(SecretLease {
            service_id: row.service_id,
            secret_version_id: row.secret_version_id,
            name: row.name,
        });
    }
    output.sort_by(|a, b| {
        (a.service_id, a.name.as_str(), a.secret_version_id).cmp(&(
            b.service_id,
            b.name.as_str(),
            b.secret_version_id,
        ))
    });
    if output
        .windows(2)
        .any(|pair| pair[0].service_id == pair[1].service_id && pair[0].name == pair[1].name)
    {
        return Err(ApiError::unprocessable(
            "build_secret_scope_invalid",
            "a build environment name may be bound once per service",
        ));
    }
    Ok(output)
}

async fn insert_service_snapshots(
    tx: &mut Transaction<'_, Postgres>,
    job: Uuid,
    account: Uuid,
    project: Uuid,
    configuration: Uuid,
    services: &[ServiceLease],
) -> Result<(), ApiError> {
    for (ordinal, s) in services.iter().enumerate() {
        sqlx::query("INSERT INTO build_job_services(job_id,account_id,project_id,configuration_revision_id,service_id,ordinal,kind,root,node_major,framework,lockfile_path,build_command,output_directory,start_command,health_path) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)")
        .bind(job).bind(account).bind(project).bind(configuration).bind(s.service_id).bind(i16::try_from(ordinal).map_err(|_|ApiError::internal())?).bind(&s.kind).bind(&s.root).bind(s.node_major).bind(&s.framework).bind(&s.lockfile_path).bind(&s.build_command).bind(&s.output_directory).bind(&s.start_command).bind(&s.health_path).execute(&mut **tx).await?;
    }
    Ok(())
}

async fn insert_secret_snapshots(
    tx: &mut Transaction<'_, Postgres>,
    job: Uuid,
    account: Uuid,
    project: Uuid,
    secrets: &[SecretLease],
) -> Result<(), ApiError> {
    for s in secrets {
        let secret_id:Uuid=sqlx::query_scalar("SELECT secret_id FROM secret_versions WHERE account_id=$1 AND project_id=$2 AND service_id=$3 AND id=$4")
        .bind(account).bind(project).bind(s.service_id).bind(s.secret_version_id).fetch_one(&mut **tx).await?;
        sqlx::query("INSERT INTO build_job_secret_refs(job_id,account_id,project_id,service_id,secret_id,secret_version_id,name,credential_kind) VALUES($1,$2,$3,$4,$5,$6,$7,'build_environment')")
            .bind(job).bind(account).bind(project).bind(s.service_id).bind(secret_id).bind(s.secret_version_id).bind(&s.name).execute(&mut **tx).await?;
    }
    Ok(())
}

async fn load_build(
    tx: &mut Transaction<'_, Postgres>,
    account: Uuid,
    project: Uuid,
    job: Uuid,
) -> Result<Option<BuildJobRecord>, ApiError> {
    Ok(sqlx::query_as("SELECT id,project_id,deployment_id,source_revision_id,configuration_revision_id,compatibility_report_id,source_commit,source_tree_sha,build_profile_id,build_profile_digest,input_manifest_digest,state,revision,attempt_count,current_attempt_id,current_fence,lease_expires_at,terminal_code,cleanup_status,created_at,updated_at FROM build_jobs WHERE account_id=$1 AND project_id=$2 AND id=$3")
        .bind(account).bind(project).bind(job).fetch_optional(&mut **tx).await?)
}

async fn get_build(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    AxumPath((project_id, job_id)): AxumPath<(String, String)>,
) -> Result<Json<BuildDetail>, ApiError> {
    crate::m3::require_enabled(&state)?;
    let account = authenticated.account_id()?;
    let project = intent::path_uuid(&project_id)?;
    let job = intent::path_uuid(&job_id)?;
    let mut tx = state.pool.begin().await?;
    let build = load_build(&mut tx, account, project, job)
        .await?
        .ok_or_else(ApiError::not_found)?;
    let artifacts = load_artifacts(&mut tx, job).await?;
    let report: Option<Value> =
        sqlx::query_scalar("SELECT response_body FROM build_effects WHERE job_id=$1")
            .bind(job)
            .fetch_optional(&mut *tx)
            .await?;
    tx.commit().await?;
    Ok(Json(BuildDetail {
        build,
        artifacts,
        report: report.unwrap_or_else(|| json!({})),
    }))
}

async fn cancel(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    AxumPath((project_id, job_id)): AxumPath<(String, String)>,
    headers: HeaderMap,
    SafeJson(request): SafeJson<EmptyRequest>,
) -> Result<Json<BuildEnvelope>, ApiError> {
    crate::m3::require_enabled(&state)?;
    let account = authenticated.account_id()?;
    let project = intent::path_uuid(&project_id)?;
    let job = intent::path_uuid(&job_id)?;
    let expected = intent::if_match_revision(&headers)?;
    let key = intent::idempotency_key(&headers)?;
    let hash = intent::request_hash(&request)?;
    let operation = format!("m3.build.cancel/{job}");
    let mut tx = state.pool.begin().await?;
    intent::acquire_operation_lock(&mut tx, account, &operation, key).await?;
    match intent::replay(&mut tx, account, &operation, key, &hash).await? {
        Replay::Match(value) => {
            tx.commit().await?;
            return Ok(Json(value));
        }
        Replay::Changed => {
            return Err(ApiError::conflict(
                "idempotency_payload_changed",
                "the idempotency key was already used with a different request",
            ));
        }
        Replay::Miss => {}
    }
    let row:Option<(i64,String,Option<Uuid>,i64)>=sqlx::query_as("SELECT revision,state,current_attempt_id,current_fence FROM build_jobs WHERE account_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE")
        .bind(account).bind(project).bind(job).fetch_optional(&mut *tx).await?;
    let (revision, current, attempt, fence) = row.ok_or_else(ApiError::not_found)?;
    if revision != expected {
        return Err(ApiError::stale_revision());
    }
    if !matches!(current.as_str(), "succeeded" | "failed" | "canceled") {
        if let Some(attempt) = attempt {
            sqlx::query("UPDATE build_attempts SET state='canceled',finished_at=clock_timestamp(),terminal_code='build_canceled' WHERE job_id=$1 AND id=$2 AND fence=$3 AND state='running'").bind(job).bind(attempt).bind(fence).execute(&mut *tx).await?;
        } else {
            sqlx::query("UPDATE build_usage_reservations SET state='released',finalized_seconds=0,finalized_at=clock_timestamp() WHERE job_id=$1 AND state='reserved'").bind(job).execute(&mut *tx).await?;
        }
        sqlx::query("UPDATE build_jobs SET state='canceled',revision=revision+1,current_attempt_id=NULL,current_fence=current_fence+1,lease_expires_at=NULL,terminal_code='build_canceled',cleanup_status=$2,updated_at=clock_timestamp() WHERE id=$1")
            .bind(job).bind(if attempt.is_some(){"pending"}else{"not_started"}).execute(&mut *tx).await?;
    }
    let build = load_build(&mut tx, account, project, job)
        .await?
        .ok_or_else(ApiError::internal)?;
    let response = BuildEnvelope { build };
    intent::audit(
        &mut tx,
        account,
        authenticated.session_id(),
        "m3.build.cancel",
        "build_job",
        Some(job),
        "succeeded",
    )
    .await?;
    intent::store_replay(&mut tx, account, &operation, key, &hash, 200, &response).await?;
    tx.commit().await?;
    Ok(Json(response))
}

fn valid_worker_id(value: &str) -> bool {
    (1..=128).contains(&value.len()) && !value.bytes().any(|b| b.is_ascii_control())
}

async fn lease(
    State(state): State<FoundationState>,
    _: BuildWorkerAuth,
    SafeJson(request): SafeJson<LeaseRequest>,
) -> Result<Response, ApiError> {
    crate::m3::require_enabled(&state)?;
    if !valid_worker_id(&request.worker_id)
        || request.kinds != ["project_build"]
        || request.profiles.is_empty()
        || request.profiles.len() > 3
        || request
            .profiles
            .iter()
            .map(|profile| profile.id.as_str())
            .collect::<HashSet<_>>()
            .len()
            != request.profiles.len()
    {
        return Err(ApiError::unprocessable(
            "invalid_build_worker",
            "the worker identity, kind, or profile is unsupported",
        ));
    }
    for offered in &request.profiles {
        let current = load_profile(&state, &offered.id)?;
        if current.digest != offered.digest {
            return Err(ApiError::unprocessable(
                "build_profile_digest_changed",
                "the worker profile does not match the approved current profile bytes",
            ));
        }
    }
    let profile_ids: Vec<String> = request
        .profiles
        .iter()
        .map(|profile| profile.id.clone())
        .collect();
    let profile_digests: Vec<String> = request
        .profiles
        .iter()
        .map(|profile| profile.digest.clone())
        .collect();
    let mut tx = state.pool.begin().await?;
    let candidate:Option<(Uuid,Uuid,Uuid)>=sqlx::query_as(
        "SELECT j.id,j.account_id,j.project_id FROM build_jobs j \
         WHERE j.state IN ('queued','retriable') AND j.attempt_count<j.max_attempts \
           AND EXISTS(SELECT 1 FROM unnest($1::text[],$2::text[]) offered(id,digest) \
             WHERE offered.id=j.build_profile_id AND offered.digest=j.build_profile_digest) \
           AND NOT EXISTS(SELECT 1 FROM build_jobs active WHERE active.account_id=j.account_id AND (active.state='running' OR active.cleanup_status='pending')) \
         ORDER BY j.created_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1"
    ).bind(&profile_ids).bind(&profile_digests).fetch_optional(&mut *tx).await?;
    let Some((job_id, account_id, project_id)) = candidate else {
        tx.commit().await?;
        return Ok(StatusCode::NO_CONTENT.into_response());
    };
    // Serialize launch entitlement and account concurrency with the same owner row used by enqueue.
    sqlx::query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE")
        .bind(account_id)
        .execute(&mut *tx)
        .await?;
    let still_clear: bool = sqlx::query_scalar(
        "SELECT NOT EXISTS(SELECT 1 FROM build_jobs WHERE account_id=$1 AND (state='running' OR cleanup_status='pending'))",
    )
    .bind(account_id)
    .fetch_one(&mut *tx)
    .await?;
    if !still_clear {
        tx.commit().await?;
        return Ok(StatusCode::NO_CONTENT.into_response());
    }
    let validity:Option<bool>=sqlx::query_scalar(
        "SELECT r.state IN ('reserved','resources_retained') AND r.reservation_epoch=j.reservation_epoch \
          AND e.state='active' AND e.period_starts_at<=transaction_timestamp() AND e.period_ends_at>transaction_timestamp() \
          AND sp.state='valid' AND sp.expires_at>transaction_timestamp() \
         FROM build_jobs j JOIN slot_reservations r ON r.id=j.reservation_id AND r.account_id=j.account_id AND r.project_id=j.project_id \
         JOIN admission_entitlements e ON e.id=r.entitlement_id AND e.account_id=j.account_id \
         JOIN admission_source_proofs sp ON sp.id=j.source_proof_id AND sp.account_id=j.account_id AND sp.project_id=j.project_id AND sp.deployment_id=j.deployment_id \
         WHERE j.id=$1 FOR SHARE OF r,e,sp"
    ).bind(job_id).fetch_optional(&mut *tx).await?;
    if validity != Some(true) {
        sqlx::query("UPDATE build_jobs SET state='failed',revision=revision+1,terminal_code='build_admission_stale',updated_at=clock_timestamp() WHERE id=$1").bind(job_id).execute(&mut *tx).await?;
        sqlx::query("UPDATE build_usage_reservations SET state='released',finalized_seconds=0,finalized_at=clock_timestamp() WHERE job_id=$1 AND state='reserved'").bind(job_id).execute(&mut *tx).await?;
        tx.commit().await?;
        return Ok(StatusCode::NO_CONTENT.into_response());
    }
    let (attempt_count, current_fence): (i32, i64) =
        sqlx::query_as("SELECT attempt_count,current_fence FROM build_jobs WHERE id=$1")
            .bind(job_id)
            .fetch_one(&mut *tx)
            .await?;
    let attempt_number = attempt_count + 1;
    let fence = current_fence + 1;
    let attempt_id = Uuid::new_v4();
    let lease_expires_at: DateTime<Utc> =
        sqlx::query_scalar("SELECT clock_timestamp()+make_interval(secs=>$1)")
            .bind(state.worker_lease_seconds.clamp(5, 300) as f64)
            .fetch_one(&mut *tx)
            .await?;
    sqlx::query("INSERT INTO build_attempts(id,account_id,project_id,job_id,attempt_number,fence,worker_id,state,lease_started_at,lease_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,'running',clock_timestamp(),$8)")
        .bind(attempt_id).bind(account_id).bind(project_id).bind(job_id).bind(attempt_number).bind(fence).bind(&request.worker_id).bind(lease_expires_at).execute(&mut *tx).await?;
    sqlx::query("UPDATE build_jobs SET state='running',revision=revision+1,attempt_count=$2,current_attempt_id=$3,current_fence=$4,lease_expires_at=$5,updated_at=clock_timestamp() WHERE id=$1")
        .bind(job_id).bind(attempt_number).bind(attempt_id).bind(fence).bind(lease_expires_at).execute(&mut *tx).await?;
    let row:(Uuid,Uuid,Uuid,Uuid,Uuid,Uuid,String,String,String,String,String)=sqlx::query_as("SELECT account_id,project_id,deployment_id,configuration_revision_id,source_revision_id,compatibility_report_id,source_commit,source_tree_sha,build_profile_id,build_profile_digest,input_manifest_digest FROM build_jobs WHERE id=$1")
        .bind(job_id).fetch_one(&mut *tx).await?;
    let services:Vec<ServiceLease>=sqlx::query_as("SELECT service_id,kind,root,node_major,framework,lockfile_path,build_command,output_directory,start_command,health_path FROM build_job_services WHERE job_id=$1 ORDER BY ordinal").bind(job_id).fetch_all(&mut *tx).await?;
    let secrets:Vec<SecretLease>=sqlx::query_as("SELECT service_id,secret_version_id,name FROM build_job_secret_refs WHERE job_id=$1 ORDER BY service_id,name,secret_version_id").bind(job_id).fetch_all(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(LeaseResponse {
        job: LeaseJob {
            id: job_id,
            kind: "project_build".to_owned(),
            account_id: row.0,
            project_id: row.1,
            deployment_id: row.2,
            configuration_revision_id: row.3,
            source_revision_id: row.4,
            compatibility_report_id: row.5,
            source_commit: row.6,
            source_tree_sha: row.7,
            build_profile: Profile {
                id: row.8,
                digest: row.9,
            },
            input_manifest_digest: row.10,
            secret_version_refs: secrets,
            limits: limits(),
        },
        services,
        attempt: AttemptLease {
            id: attempt_id,
            attempt_number,
            fence,
            worker_id: request.worker_id,
            lease_expires_at,
        },
    })
    .into_response())
}

async fn lock_live_attempt(
    tx: &mut Transaction<'_, Postgres>,
    job: Uuid,
    request: &LiveAttemptRequest,
) -> Result<(Uuid, Uuid, Uuid), ApiError> {
    if !valid_worker_id(&request.worker_id) || request.fence <= 0 {
        return Err(ApiError::conflict(
            "build_job_fenced",
            "the build lease is no longer current",
        ));
    }
    let row:Option<(Uuid,Uuid,Uuid)>=sqlx::query_as(
        "SELECT j.account_id,j.project_id,j.deployment_id FROM build_jobs j JOIN build_attempts a ON a.job_id=j.id AND a.id=j.current_attempt_id AND a.fence=j.current_fence \
         WHERE j.id=$1 AND j.state='running' AND j.current_attempt_id=$2 AND j.current_fence=$3 AND j.lease_expires_at>clock_timestamp() \
           AND a.state='running' AND a.worker_id=$4 AND a.lease_expires_at>clock_timestamp() FOR UPDATE OF j,a"
    ).bind(job).bind(request.attempt_id).bind(request.fence).bind(&request.worker_id).fetch_optional(&mut **tx).await?;
    row.ok_or_else(|| {
        ApiError::conflict("build_job_fenced", "the build lease is no longer current")
    })
}

async fn renew(
    State(state): State<FoundationState>,
    _: BuildWorkerAuth,
    AxumPath(job): AxumPath<String>,
    SafeJson(request): SafeJson<LiveAttemptRequest>,
) -> Result<Json<RenewResponse>, ApiError> {
    crate::m3::require_enabled(&state)?;
    let job = intent::path_uuid(&job)?;
    let mut tx = state.pool.begin().await?;
    lock_live_attempt(&mut tx, job, &request).await?;
    let expires: DateTime<Utc> =
        sqlx::query_scalar("SELECT clock_timestamp()+make_interval(secs=>$1)")
            .bind(state.worker_lease_seconds.clamp(5, 300) as f64)
            .fetch_one(&mut *tx)
            .await?;
    sqlx::query("UPDATE build_attempts SET lease_expires_at=$1 WHERE job_id=$2 AND id=$3 AND fence=$4 AND state='running'").bind(expires).bind(job).bind(request.attempt_id).bind(request.fence).execute(&mut *tx).await?;
    sqlx::query("UPDATE build_jobs SET lease_expires_at=$1,updated_at=clock_timestamp() WHERE id=$2 AND current_attempt_id=$3 AND current_fence=$4 AND state='running'").bind(expires).bind(job).bind(request.attempt_id).bind(request.fence).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(RenewResponse {
        job_id: job,
        attempt_id: request.attempt_id,
        fence: request.fence,
        lease_expires_at: expires,
    }))
}

#[derive(FromRow)]
struct MaterializeJob {
    account_id: Uuid,
    project_id: Uuid,
    deployment_id: Uuid,
    source_revision_id: Uuid,
    configuration_revision_id: Uuid,
    compatibility_report_id: Uuid,
    source_commit: String,
    source_tree_sha: String,
    source_materialization_id: Option<Uuid>,
    source_bundle_digest: Option<String>,
    source_tree_manifest_digest: Option<String>,
}

async fn materialize(
    State(state): State<FoundationState>,
    _: BuildWorkerAuth,
    AxumPath(job): AxumPath<String>,
    SafeJson(request): SafeJson<LiveAttemptRequest>,
) -> Result<Json<MaterializationResponse>, ApiError> {
    let config = crate::m3::require_enabled(&state)?;
    let job = intent::path_uuid(&job)?;
    let mut tx = state.pool.begin().await?;
    lock_live_attempt(&mut tx, job, &request).await?;
    let row:MaterializeJob=sqlx::query_as("SELECT account_id,project_id,deployment_id,source_revision_id,configuration_revision_id,compatibility_report_id,source_commit,source_tree_sha,source_materialization_id,source_bundle_digest,source_tree_manifest_digest FROM build_jobs WHERE id=$1")
        .bind(job).fetch_one(&mut *tx).await?;
    if let (Some(materialization), Some(bundle), Some(tree)) = (
        row.source_materialization_id,
        row.source_bundle_digest.clone(),
        row.source_tree_manifest_digest.clone(),
    ) {
        let counts:(i32,i64)=sqlx::query_as("SELECT entry_count,total_bytes FROM source_materializations WHERE id=$1 AND state='ready'").bind(materialization).fetch_optional(&mut *tx).await?.ok_or_else(ApiError::internal)?;
        verify_cas_digest(&config.state_dir, &bundle)?;
        verify_cas_digest(&config.state_dir, &tree)?;
        tx.commit().await?;
        return Ok(Json(MaterializationResponse {
            commit_sha: row.source_commit,
            tree_sha: row.source_tree_sha,
            bundle_digest: bundle,
            tree_manifest_digest: tree,
            entry_count: u32::try_from(counts.0).map_err(|_| ApiError::internal())?,
            total_bytes: u64::try_from(counts.1).map_err(|_| ApiError::internal())?,
        }));
    }
    let snapshot = crate::github::authorized_build_source_snapshot(
        &state,
        &mut tx,
        row.account_id,
        row.project_id,
        row.source_revision_id,
        row.configuration_revision_id,
        &row.source_commit,
        &row.source_tree_sha,
    )
    .await;
    let snapshot = match snapshot {
        Ok(snapshot) => snapshot,
        Err(error) if deterministic_source_rejection(&error) => {
            handoff_source_rejection(&mut tx, job, &request).await?;
            tx.commit().await?;
            return Err(ApiError::unprocessable(
                "build_source_rejected",
                "the exact build source failed immutable source verification",
            ));
        }
        Err(error) => return Err(error),
    };
    let materialized = canonical_source_bundle(&snapshot.files);
    let (bundle_bytes, manifest, content_bytes) = match materialized {
        Ok(materialized) => materialized,
        Err(error) if deterministic_source_rejection(&error) => {
            handoff_source_rejection(&mut tx, job, &request).await?;
            tx.commit().await?;
            return Err(ApiError::unprocessable(
                "build_source_rejected",
                "the exact build source failed immutable source verification",
            ));
        }
        Err(error) => return Err(error),
    };
    let bundle_digest = format!("sha256:{:x}", Sha256::digest(bundle_bytes.as_slice()));
    let manifest_bytes = serde_json::to_vec(&manifest).map_err(|_| ApiError::internal())?;
    let tree_manifest_digest = format!("sha256:{:x}", Sha256::digest(&manifest_bytes));
    store_cas(&config.state_dir, &bundle_digest, bundle_bytes.as_slice())?;
    store_cas(&config.state_dir, &tree_manifest_digest, &manifest_bytes)?;
    let materialization = Uuid::new_v4();
    let entries = i32::try_from(snapshot.files.len()).map_err(|_| ApiError::internal())?;
    let total = i64::try_from(content_bytes).map_err(|_| ApiError::internal())?;
    let materialization:Uuid=sqlx::query_scalar(
        "INSERT INTO source_materializations(id,account_id,project_id,deployment_id,source_revision_id,configuration_revision_id,compatibility_report_id,commit_sha,tree_sha,materializer_revision,bundle_digest,tree_manifest_digest,entry_count,total_bytes,authorization_observed_at,state) \
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,clock_timestamp(),'ready') \
         ON CONFLICT(deployment_id,source_revision_id,configuration_revision_id,commit_sha,tree_sha,materializer_revision) DO UPDATE SET updated_at=source_materializations.updated_at \
         RETURNING id"
    ).bind(materialization).bind(row.account_id).bind(row.project_id).bind(row.deployment_id).bind(row.source_revision_id).bind(row.configuration_revision_id).bind(row.compatibility_report_id)
     .bind(&row.source_commit).bind(&row.source_tree_sha).bind(MATERIALIZER_REVISION).bind(&bundle_digest).bind(&tree_manifest_digest).bind(entries).bind(total).fetch_one(&mut *tx).await?;
    // A tuple replay may only reuse byte-identical materialization metadata.
    let stored:Option<(String,String,i32,i64)>=sqlx::query_as("SELECT bundle_digest,tree_manifest_digest,entry_count,total_bytes FROM source_materializations WHERE id=$1 AND state='ready' FOR SHARE")
        .bind(materialization).fetch_optional(&mut *tx).await?;
    if stored.as_ref()
        != Some(&(
            bundle_digest.clone(),
            tree_manifest_digest.clone(),
            entries,
            total,
        ))
    {
        handoff_source_rejection(&mut tx, job, &request).await?;
        tx.commit().await?;
        return Err(ApiError::unprocessable(
            "build_source_rejected",
            "the exact build source failed immutable source verification",
        ));
    }
    let updated=sqlx::query("UPDATE build_jobs SET source_materialization_id=$2,source_bundle_digest=$3,source_tree_manifest_digest=$4,updated_at=clock_timestamp() WHERE id=$1 AND state='running' AND current_attempt_id=$5 AND current_fence=$6")
        .bind(job).bind(materialization).bind(&bundle_digest).bind(&tree_manifest_digest).bind(request.attempt_id).bind(request.fence).execute(&mut *tx).await?;
    if updated.rows_affected() != 1 {
        return Err(ApiError::conflict(
            "build_job_fenced",
            "the build lease is no longer current",
        ));
    }
    tx.commit().await?;
    Ok(Json(MaterializationResponse {
        commit_sha: row.source_commit,
        tree_sha: row.source_tree_sha,
        bundle_digest,
        tree_manifest_digest,
        entry_count: u32::try_from(entries).map_err(|_| ApiError::internal())?,
        total_bytes: u64::try_from(total).map_err(|_| ApiError::internal())?,
    }))
}

async fn handoff_source_rejection(
    tx: &mut Transaction<'_, Postgres>,
    job: Uuid,
    request: &LiveAttemptRequest,
) -> Result<(), ApiError> {
    let expires: DateTime<Utc> =
        sqlx::query_scalar("SELECT clock_timestamp()+make_interval(secs=>$1)")
            .bind(SOURCE_REJECTION_COMPLETION_SECONDS)
            .fetch_one(&mut **tx)
            .await?;
    let attempt = sqlx::query(
        "UPDATE build_attempts SET lease_expires_at=$1 WHERE job_id=$2 AND id=$3 AND fence=$4 AND state='running' AND worker_id=$5",
    )
    .bind(expires)
    .bind(job)
    .bind(request.attempt_id)
    .bind(request.fence)
    .bind(&request.worker_id)
    .execute(&mut **tx)
    .await?;
    let build = sqlx::query(
        "UPDATE build_jobs SET lease_expires_at=$1,updated_at=clock_timestamp() WHERE id=$2 AND state='running' AND current_attempt_id=$3 AND current_fence=$4",
    )
    .bind(expires)
    .bind(job)
    .bind(request.attempt_id)
    .bind(request.fence)
    .execute(&mut **tx)
    .await?;
    if attempt.rows_affected() != 1 || build.rows_affected() != 1 {
        return Err(ApiError::conflict(
            "build_job_fenced",
            "the build lease is no longer current",
        ));
    }
    Ok(())
}

fn deterministic_source_rejection(error: &ApiError) -> bool {
    matches!(
        error.code(),
        "build_source_rejected"
            | "build_source_stale"
            | "github_access_denied"
            | "github_provider_limit_exceeded"
            | "invalid_github_source"
            | "source_limit_exceeded"
            | "source_path_invalid"
            | "unsupported_github_source"
    )
}

fn canonical_source_bundle(
    files: &[crate::github_provider::BuildSourceFile],
) -> Result<(zeroize::Zeroizing<Vec<u8>>, Value, usize), ApiError> {
    let mut ordered: Vec<_> = files.iter().collect();
    ordered.sort_by(|a, b| a.path.as_bytes().cmp(b.path.as_bytes()));
    if ordered.len() > 10_000 {
        return Err(ApiError::unprocessable(
            "source_limit_exceeded",
            "the source contains too many entries",
        ));
    }
    let mut bundle = zeroize::Zeroizing::new(Vec::new());
    bundle.extend_from_slice(b"HBS1");
    bundle.extend_from_slice(
        &u32::try_from(ordered.len())
            .map_err(|_| ApiError::internal())?
            .to_be_bytes(),
    );
    let mut entries = Vec::with_capacity(ordered.len());
    let mut total = 0usize;
    let mut folded = HashSet::new();
    for file in ordered {
        validate_bundle_path(&file.path)?;
        if !folded.insert(file.path.to_lowercase()) {
            return Err(ApiError::unprocessable(
                "unsupported_github_source",
                "source paths collide when compared without case",
            ));
        }
        let path = file.path.as_bytes();
        let path_len = u16::try_from(path.len()).map_err(|_| {
            ApiError::unprocessable(
                "source_path_invalid",
                "a source path exceeds the materializer limit",
            )
        })?;
        let mode = if file.executable { 0o755u32 } else { 0o644u32 };
        let size = u64::try_from(file.content.len()).map_err(|_| ApiError::internal())?;
        bundle.extend_from_slice(&path_len.to_be_bytes());
        bundle.extend_from_slice(path);
        bundle.extend_from_slice(&mode.to_be_bytes());
        bundle.extend_from_slice(&size.to_be_bytes());
        bundle.extend_from_slice(file.content.as_slice());
        total = total
            .checked_add(file.content.len())
            .ok_or_else(ApiError::internal)?;
        entries.push(json!({"path":file.path,"mode":mode,"size":size,"git_blob_sha1":file.blob_sha,"sha256":format!("sha256:{:x}",Sha256::digest(file.content.as_slice()))}));
    }
    Ok((
        bundle,
        json!({"schema":"hostlet.source-tree-manifest/v1","format":"HBS1","entries":entries}),
        total,
    ))
}

fn validate_bundle_path(value: &str) -> Result<(), ApiError> {
    let path = Path::new(value);
    if value.is_empty()
        || value.len() > 1024
        || value.contains('\\')
        || value.bytes().any(|b| b.is_ascii_control())
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(ApiError::unprocessable(
            "source_path_invalid",
            "the source contains an unsafe path",
        ));
    }
    Ok(())
}

fn cas_path(root: &Path, digest: &str) -> Result<PathBuf, ApiError> {
    let hash = digest
        .strip_prefix("sha256:")
        .filter(|v| {
            v.len() == 64
                && v.bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        })
        .ok_or_else(|| {
            ApiError::unprocessable("invalid_digest", "a lowercase sha256 digest is required")
        })?;
    Ok(root.join("private-cas").join("sha256").join(hash))
}

fn secure_directory(path: &Path) -> Result<(), ApiError> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
        Ok(_) => {
            return Err(ApiError::unavailable(
                "cas_unavailable",
                "the private content store is not a secure directory",
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir(path).map_err(|_| {
                ApiError::unavailable(
                    "cas_unavailable",
                    "the private content store is unavailable",
                )
            })?;
        }
        Err(_) => {
            return Err(ApiError::unavailable(
                "cas_unavailable",
                "the private content store is unavailable",
            ));
        }
    }
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).map_err(|_| {
        ApiError::unavailable(
            "cas_unavailable",
            "the private content store is unavailable",
        )
    })?;
    let metadata = std::fs::symlink_metadata(path).map_err(|_| {
        ApiError::unavailable(
            "cas_unavailable",
            "the private content store is unavailable",
        )
    })?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.permissions().mode() & 0o077 != 0
    {
        return Err(ApiError::unavailable(
            "cas_unavailable",
            "the private content store is not a secure directory",
        ));
    }
    Ok(())
}

fn store_cas(root: &Path, digest: &str, bytes: &[u8]) -> Result<(), ApiError> {
    let final_path = cas_path(root, digest)?;
    let parent = final_path.parent().ok_or_else(ApiError::internal)?;
    secure_directory(&root.join("private-cas"))?;
    secure_directory(&root.join("private-cas/sha256"))?;
    secure_directory(parent)?;
    if final_path.exists() {
        return verify_cas_bytes(&final_path, digest);
    }
    let temporary = parent.join(format!(".tmp-{}", Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(|_| {
            ApiError::unavailable(
                "cas_unavailable",
                "the private content store is unavailable",
            )
        })?;
    if file.write_all(bytes).and_then(|_| file.sync_all()).is_err() {
        let _ = std::fs::remove_file(&temporary);
        return Err(ApiError::unavailable(
            "cas_unavailable",
            "the private content store is unavailable",
        ));
    }
    drop(file);
    match std::fs::hard_link(&temporary, &final_path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => {
            let _ = std::fs::remove_file(&temporary);
            return Err(ApiError::unavailable(
                "cas_unavailable",
                "the private content store is unavailable",
            ));
        }
    }
    let _ = std::fs::remove_file(&temporary);
    OpenOptions::new()
        .read(true)
        .open(parent)
        .and_then(|dir| dir.sync_all())
        .map_err(|_| {
            ApiError::unavailable(
                "cas_unavailable",
                "the private content store is unavailable",
            )
        })?;
    verify_cas_bytes(&final_path, digest)
}

fn verify_cas_digest(root: &Path, digest: &str) -> Result<(), ApiError> {
    verify_cas_bytes(&cas_path(root, digest)?, digest)
}
fn verify_cas_bytes(path: &Path, digest: &str) -> Result<(), ApiError> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| {
        ApiError::unavailable(
            "cas_object_missing",
            "a required private CAS object is unavailable",
        )
    })?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.permissions().mode() & 0o077 != 0
    {
        return Err(ApiError::unavailable(
            "cas_object_invalid",
            "a private CAS object failed verification",
        ));
    }
    let mut file = OpenOptions::new().read(true).open(path).map_err(|_| {
        ApiError::unavailable(
            "cas_object_missing",
            "a required private CAS object is unavailable",
        )
    })?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let read = file.read(&mut buffer).map_err(|_| {
            ApiError::unavailable(
                "cas_object_invalid",
                "a private CAS object failed verification",
            )
        })?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    let actual = format!("sha256:{:x}", hash.finalize());
    if actual != digest {
        return Err(ApiError::unavailable(
            "cas_object_invalid",
            "a private CAS object failed verification",
        ));
    }
    Ok(())
}

#[derive(FromRow)]
struct CredentialRow {
    service_id: Uuid,
    secret_version_id: Uuid,
    secret_id: Uuid,
    name: String,
    key_version: String,
    nonce: Vec<u8>,
    ciphertext: Vec<u8>,
    auth_tag: Vec<u8>,
}

async fn resolve_credentials(
    State(state): State<FoundationState>,
    _: BuildWorkerAuth,
    AxumPath(job): AxumPath<String>,
    SafeJson(request): SafeJson<CredentialsRequest>,
) -> Result<Json<CredentialsResponse>, ApiError> {
    crate::m3::require_enabled(&state)?;
    let job = intent::path_uuid(&job)?;
    if request.secret_version_ids.len() > MAX_SECRETS
        || request
            .secret_version_ids
            .iter()
            .collect::<HashSet<_>>()
            .len()
            != request.secret_version_ids.len()
    {
        return Err(ApiError::unprocessable(
            "build_secret_scope_invalid",
            "secret version ids must be unique and bounded",
        ));
    }
    let live = LiveAttemptRequest {
        worker_id: request.worker_id.clone(),
        attempt_id: request.attempt_id,
        fence: request.fence,
    };
    let mut tx = state.pool.begin().await?;
    let (account, project, _) = lock_live_attempt(&mut tx, job, &live).await?;
    sqlx::query("UPDATE build_attempts SET launched_at=COALESCE(launched_at,clock_timestamp()) WHERE job_id=$1 AND id=$2 AND fence=$3 AND state='running'").bind(job).bind(request.attempt_id).bind(request.fence).execute(&mut *tx).await?;
    let rows:Vec<CredentialRow>=sqlx::query_as(
        "SELECT r.service_id,r.secret_version_id,r.secret_id,r.name,sv.key_version,sv.nonce,sv.ciphertext,sv.auth_tag \
         FROM build_job_secret_refs r JOIN secrets s ON s.account_id=r.account_id AND s.project_id=r.project_id AND s.service_id=r.service_id AND s.id=r.secret_id \
          AND s.operation='build' AND s.credential_kind='build_environment' AND s.status='active' \
         JOIN secret_versions sv ON sv.account_id=r.account_id AND sv.project_id=r.project_id AND sv.service_id=r.service_id AND sv.secret_id=r.secret_id AND sv.id=r.secret_version_id \
         WHERE r.job_id=$1 AND r.account_id=$2 AND r.project_id=$3 AND r.credential_kind='build_environment' AND r.secret_version_id=ANY($4) \
         ORDER BY r.service_id,r.name,r.secret_version_id FOR SHARE OF s,sv"
    ).bind(job).bind(account).bind(project).bind(&request.secret_version_ids).fetch_all(&mut *tx).await?;
    if rows.len() != request.secret_version_ids.len() {
        return Err(ApiError::unprocessable(
            "build_secret_scope_invalid",
            "only exact secret versions bound at enqueue may be resolved",
        ));
    }
    let key = state
        .secret_key
        .as_deref()
        .ok_or_else(ApiError::foundation_unavailable)?;
    let mut credentials = Vec::with_capacity(rows.len());
    for row in rows {
        if row.key_version != key.key_version() {
            return Err(ApiError::foundation_unavailable());
        }
        let aad = build_secret_aad(
            account,
            project,
            row.service_id,
            row.secret_id,
            row.secret_version_id,
        );
        let plaintext = key
            .decrypt(&aad, &row.nonce, &row.ciphertext, &row.auth_tag)
            .map_err(|_| ApiError::foundation_unavailable())?;
        let value = String::from_utf8(plaintext).map_err(|error| {
            let mut bytes = error.into_bytes();
            bytes.zeroize();
            ApiError::foundation_unavailable()
        })?;
        credentials.push(Credential {
            service_id: row.service_id,
            secret_version_id: row.secret_version_id,
            name: row.name,
            value,
        });
    }
    tx.commit().await?;
    Ok(Json(CredentialsResponse { credentials }))
}

async fn cancel_ack(
    State(state): State<FoundationState>,
    _: BuildWorkerAuth,
    AxumPath(job): AxumPath<String>,
    SafeJson(request): SafeJson<CancelAckRequest>,
) -> Result<Json<CancelAckResponse>, ApiError> {
    let config = crate::m3::require_enabled(&state)?;
    let job = intent::path_uuid(&job)?;
    if !valid_worker_id(&request.worker_id)
        || request.fence <= 0
        || request.elapsed_seconds < 0
        || request.elapsed_seconds > RESERVED_SECONDS
        || !valid_digest(&request.cleanup_receipt_digest)
    {
        return Err(ApiError::unprocessable(
            "build_cancel_ack_invalid",
            "the cancellation cleanup acknowledgment is invalid",
        ));
    }
    let bytes = serde_json::to_vec(&request).map_err(|_| ApiError::internal())?;
    let hash = Sha256::digest(&bytes).to_vec();
    let mut tx = state.pool.begin().await?;
    let existing:Option<(Vec<u8>,Value,String)>=sqlx::query_as("SELECT r.completion_hash,r.response_body,j.state FROM build_attempt_receipts r JOIN build_jobs j ON j.id=r.job_id WHERE r.job_id=$1 AND r.attempt_id=$2 AND r.fence=$3 FOR SHARE OF r,j").bind(job).bind(request.attempt_id).bind(request.fence).fetch_optional(&mut *tx).await?;
    if let Some((stored, response, job_state)) = existing {
        if job_state == "canceled" {
            return Err(ApiError::conflict(
                "build_job_fenced",
                "the build lease is no longer current",
            ));
        }
        if stored != hash {
            return Err(ApiError::conflict(
                "build_cancel_ack_conflict",
                "the canceled attempt already has a different cleanup acknowledgment",
            ));
        }
        let response = serde_json::from_value(response).map_err(|_| ApiError::internal())?;
        tx.commit().await?;
        return Ok(Json(response));
    }
    let scope:Option<(Uuid,Uuid,Uuid)>=sqlx::query_as("SELECT j.account_id,j.project_id,j.deployment_id FROM build_jobs j JOIN build_attempts a ON a.job_id=j.id WHERE j.id=$1 AND j.state='canceled' AND j.cleanup_status='pending' AND a.id=$2 AND a.fence=$3 AND a.worker_id=$4 AND a.state='canceled' FOR UPDATE OF j,a")
        .bind(job).bind(request.attempt_id).bind(request.fence).bind(&request.worker_id).fetch_optional(&mut *tx).await?;
    let (account, project, deployment) = scope.ok_or_else(|| {
        ApiError::conflict(
            "build_job_fenced",
            "the canceled build attempt is not awaiting this cleanup acknowledgment",
        )
    })?;
    let cleanup: CleanupManifest = read_cas_json(
        &config.state_dir,
        &request.cleanup_receipt_digest,
        1_048_576,
    )?;
    if cleanup.schema != "hostlet.build-cleanup/v1"
        || cleanup.job_id != job
        || cleanup.attempt_id != request.attempt_id
        || cleanup.fence != request.fence
        || cleanup.status != "confirmed"
    {
        return Err(ApiError::unprocessable(
            "build_cleanup_invalid",
            "cancellation acknowledgment requires a matching confirmed cleanup receipt",
        ));
    }
    let billed = request.elapsed_seconds;
    let debit = if billed > 0 {
        let entitlement:Uuid=sqlx::query_scalar("SELECT entitlement_id FROM build_usage_reservations WHERE job_id=$1 AND state='reserved' FOR UPDATE").bind(job).fetch_one(&mut *tx).await?;
        let event = Uuid::new_v4();
        sqlx::query("INSERT INTO build_usage_events(id,account_id,project_id,deployment_id,entitlement_id,attempt_id,kind,seconds) VALUES($1,$2,$3,$4,$5,$6,'debit',$7)").bind(event).bind(account).bind(project).bind(deployment).bind(entitlement).bind(request.attempt_id).bind(billed).execute(&mut *tx).await?;
        Some(event)
    } else {
        None
    };
    sqlx::query("UPDATE build_usage_reservations SET state='finalized',finalized_seconds=$2,debit_event_id=$3,finalized_at=clock_timestamp() WHERE job_id=$1 AND state='reserved'").bind(job).bind(billed).bind(debit).execute(&mut *tx).await?;
    sqlx::query("UPDATE build_jobs SET cleanup_status='confirmed',revision=revision+1,updated_at=clock_timestamp() WHERE id=$1 AND state='canceled' AND cleanup_status='pending'").bind(job).execute(&mut *tx).await?;
    let response = CancelAckResponse {
        job_id: job,
        attempt_id: request.attempt_id,
        fence: request.fence,
        cleanup_status: "confirmed".to_owned(),
        finalized_seconds: billed,
        debit_event_id: debit,
    };
    let body = serde_json::to_value(&response).map_err(|_| ApiError::internal())?;
    sqlx::query("INSERT INTO build_attempt_receipts(attempt_id,job_id,fence,completion_hash,response_body) VALUES($1,$2,$3,$4,$5)").bind(request.attempt_id).bind(job).bind(request.fence).bind(hash).bind(body).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(response))
}

fn append_aad(output: &mut Vec<u8>, value: &[u8]) {
    output.extend_from_slice(&u32::try_from(value.len()).unwrap_or(u32::MAX).to_be_bytes());
    output.extend_from_slice(value);
}
fn build_secret_aad(
    account: Uuid,
    project: Uuid,
    service: Uuid,
    secret: Uuid,
    version: Uuid,
) -> Vec<u8> {
    let mut output = Vec::with_capacity(192);
    for field in [
        b"hostlet-secret/v1".as_slice(),
        account.as_bytes(),
        project.as_bytes(),
        service.as_bytes(),
        b"build",
        b"build_environment",
        secret.as_bytes(),
        version.as_bytes(),
    ] {
        append_aad(&mut output, field);
    }
    output
}

#[derive(Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct ResultManifest {
    schema: String,
    job_id: Uuid,
    attempt_id: Uuid,
    fence: i64,
    input_manifest_digest: String,
    state: String,
    code: String,
    elapsed_seconds: i32,
    artifacts: Vec<ArtifactCompletion>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CleanupManifest {
    schema: String,
    job_id: Uuid,
    attempt_id: Uuid,
    fence: i64,
    status: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ArtifactManifest {
    schema: String,
    job_id: Uuid,
    attempt_id: Uuid,
    fence: i64,
    input_manifest_digest: String,
    source_commit: String,
    service_id: Uuid,
    kind: String,
    archive_digest: String,
    packed_bytes: i64,
    unpacked_bytes: i64,
    entry_count: i32,
    entrypoint_argv: Option<Vec<String>>,
}

fn read_cas_json<T: for<'de> Deserialize<'de>>(
    root: &Path,
    digest: &str,
    max: u64,
) -> Result<T, ApiError> {
    let path = cas_path(root, digest)?;
    verify_cas_bytes(&path, digest)?;
    let metadata = std::fs::metadata(&path).map_err(|_| {
        ApiError::unavailable(
            "cas_object_missing",
            "a required private CAS object is unavailable",
        )
    })?;
    if metadata.len() > max {
        return Err(ApiError::unprocessable(
            "build_result_invalid",
            "a completion manifest exceeds its limit",
        ));
    }
    let bytes = std::fs::read(path).map_err(|_| {
        ApiError::unavailable(
            "cas_object_missing",
            "a required private CAS object is unavailable",
        )
    })?;
    serde_json::from_slice(&bytes).map_err(|_| {
        ApiError::unprocessable("build_result_invalid", "a completion manifest is malformed")
    })
}

fn valid_completion(outcome: &CompletionOutcome) -> bool {
    let state_code = match outcome.state.as_str() {
        "succeeded" => {
            outcome.code == "build_succeeded"
                && outcome.elapsed_seconds > 0
                && !outcome.artifacts.is_empty()
        }
        "failed" => {
            matches!(
                outcome.code.as_str(),
                "build_failed"
                    | "dependency_not_available_offline"
                    | "build_timeout"
                    | "memory_limit"
                    | "workspace_limit"
                    | "static_output_too_large"
                    | "runtime_output_too_large"
                    | "output_invalid"
                    | "source_policy_rejected"
                    | "platform_fault"
                    | "cleanup_failed"
            ) && outcome.artifacts.is_empty()
        }
        "retriable" => {
            outcome.code == "platform_prelaunch_fault"
                && outcome.elapsed_seconds == 0
                && outcome.artifacts.is_empty()
        }
        _ => false,
    };
    state_code
        && outcome.elapsed_seconds >= 0
        && outcome.elapsed_seconds <= RESERVED_SECONDS
        && outcome.artifacts.len() <= MAX_ARTIFACTS
        && valid_digest(&outcome.result_manifest_digest)
        && valid_digest(&outcome.cleanup_receipt_digest)
}
fn valid_digest(value: &str) -> bool {
    value.len() == DIGEST_BYTES
        && value.strip_prefix("sha256:").is_some_and(|hash| {
            hash.len() == 64
                && hash
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        })
}

async fn complete(
    State(state): State<FoundationState>,
    _: BuildWorkerAuth,
    AxumPath(job): AxumPath<String>,
    SafeJson(request): SafeJson<CompleteRequest>,
) -> Result<Json<CompleteResponse>, ApiError> {
    let config = crate::m3::require_enabled(&state)?;
    let job = intent::path_uuid(&job)?;
    if !valid_worker_id(&request.worker_id) || !valid_completion(&request.outcome) {
        return Err(ApiError::unprocessable(
            "build_result_invalid",
            "the build completion is outside the accepted contract",
        ));
    }
    let completion_bytes =
        serde_json::to_vec(&request.outcome).map_err(|_| ApiError::internal())?;
    let mut hasher = Sha256::new();
    hasher.update(job.as_bytes());
    hasher.update(request.attempt_id.as_bytes());
    hasher.update(request.fence.to_be_bytes());
    hasher.update(request.worker_id.as_bytes());
    hasher.update(&completion_bytes);
    let completion_hash = hasher.finalize().to_vec();
    let mut tx = state.pool.begin().await?;
    let existing:Option<(Vec<u8>,Value)>=sqlx::query_as("SELECT completion_hash,response_body FROM build_attempt_receipts WHERE job_id=$1 AND attempt_id=$2 AND fence=$3 FOR SHARE").bind(job).bind(request.attempt_id).bind(request.fence).fetch_optional(&mut *tx).await?;
    if let Some((stored, response)) = existing {
        if stored != completion_hash {
            return Err(ApiError::conflict(
                "build_completion_conflict",
                "the build already has a different terminal completion",
            ));
        }
        let response = serde_json::from_value(response).map_err(|_| ApiError::internal())?;
        tx.commit().await?;
        return Ok(Json(response));
    }
    let live = LiveAttemptRequest {
        worker_id: request.worker_id.clone(),
        attempt_id: request.attempt_id,
        fence: request.fence,
    };
    let (account, project, deployment) = lock_live_attempt(&mut tx, job, &live).await?;
    let (input_digest,source_commit,source_bundle):(String,String,Option<String>)=sqlx::query_as("SELECT input_manifest_digest,source_commit,source_bundle_digest FROM build_jobs WHERE id=$1").bind(job).fetch_one(&mut *tx).await?;
    if source_bundle.is_none()
        && !((request.outcome.state == "failed"
            && request.outcome.code == "source_policy_rejected"
            && request.outcome.elapsed_seconds == 0)
            || (request.outcome.state == "retriable"
                && request.outcome.code == "platform_prelaunch_fault"
                && request.outcome.elapsed_seconds == 0))
    {
        return Err(ApiError::conflict(
            "source_materialization_required",
            "the exact source must be materialized before completion",
        ));
    }
    let result: ResultManifest = read_cas_json(
        &config.state_dir,
        &request.outcome.result_manifest_digest,
        1_048_576,
    )?;
    if result.schema != "hostlet.build-result/v1"
        || result.job_id != job
        || result.attempt_id != request.attempt_id
        || result.fence != request.fence
        || result.input_manifest_digest != input_digest
        || result.state != request.outcome.state
        || result.code != request.outcome.code
        || result.elapsed_seconds != request.outcome.elapsed_seconds
        || result.artifacts != request.outcome.artifacts
    {
        return Err(ApiError::unprocessable(
            "build_result_invalid",
            "the result manifest does not match the fenced completion",
        ));
    }
    let cleanup: CleanupManifest = read_cas_json(
        &config.state_dir,
        &request.outcome.cleanup_receipt_digest,
        1_048_576,
    )?;
    if cleanup.schema != "hostlet.build-cleanup/v1"
        || cleanup.job_id != job
        || cleanup.attempt_id != request.attempt_id
        || cleanup.fence != request.fence
        || !matches!(cleanup.status.as_str(), "confirmed" | "pending")
        || request.outcome.state == "succeeded" && cleanup.status != "confirmed"
    {
        return Err(ApiError::unprocessable(
            "build_cleanup_invalid",
            "the cleanup receipt does not match the fenced completion",
        ));
    }
    let service_kinds: Vec<(Uuid, String, String, Option<String>)> = sqlx::query_as(
        "SELECT service_id,kind,framework,start_command FROM build_job_services WHERE job_id=$1 ORDER BY ordinal",
    )
    .bind(job)
    .fetch_all(&mut *tx)
    .await?;
    let expected: BTreeMap<Uuid, (String, String, Option<String>)> = service_kinds
        .into_iter()
        .map(|(id, kind, framework, start)| (id, (kind, framework, start)))
        .collect();
    let mut seen = HashSet::new();
    for artifact in &request.outcome.artifacts {
        if !seen.insert(artifact.kind.clone())
            || !valid_digest(&artifact.archive_digest)
            || !valid_digest(&artifact.manifest_digest)
            || artifact.packed_bytes < 0
            || artifact.unpacked_bytes < 0
            || artifact.entry_count < 0
            || artifact.entry_count
                > i32::try_from(limits().max_entries).map_err(|_| ApiError::internal())?
            || artifact.packed_bytes
                > i64::try_from(limits().runtime_output_bytes).map_err(|_| ApiError::internal())?
            || (artifact.kind == "static"
                && artifact.unpacked_bytes
                    > i64::try_from(limits().static_output_bytes)
                        .map_err(|_| ApiError::internal())?)
            || (artifact.kind == "application"
                && artifact.unpacked_bytes
                    > i64::try_from(limits().runtime_output_bytes)
                        .map_err(|_| ApiError::internal())?)
        {
            return Err(ApiError::unprocessable(
                "build_artifact_invalid",
                "artifact metadata is invalid",
            ));
        }
        let required = expected.get(&artifact.service_id).map(|(kind, _, _)| {
            if kind == "static_frontend" {
                "static"
            } else {
                "application"
            }
        });
        if required != Some(artifact.kind.as_str()) {
            return Err(ApiError::unprocessable(
                "build_artifact_invalid",
                "an artifact does not match the immutable service graph",
            ));
        }
        let expected_argv = match expected.get(&artifact.service_id) {
            Some((kind, _, _)) if kind == "static_frontend" => None,
            Some((_, framework, Some(start)))
                if start == "npm run start" && framework == "node_http" =>
            {
                Some(vec!["node".to_owned(), "dist/server.mjs".to_owned()])
            }
            Some((_, framework, Some(start)))
                if start == "npm run start" && framework == "nextjs16_standalone" =>
            {
                Some(vec!["node".to_owned(), "server.js".to_owned()])
            }
            _ => {
                return Err(ApiError::unprocessable(
                    "build_artifact_invalid",
                    "the packaged application entrypoint does not match the immutable service graph",
                ));
            }
        };
        if artifact.entrypoint_argv.as_ref() != expected_argv.as_ref() {
            return Err(ApiError::unprocessable(
                "build_artifact_invalid",
                "the packaged application entrypoint is invalid",
            ));
        }
        let manifest: ArtifactManifest =
            read_cas_json(&config.state_dir, &artifact.manifest_digest, 1_048_576)?;
        if manifest.schema != "hostlet.build-artifact/v1"
            || manifest.job_id != job
            || manifest.attempt_id != request.attempt_id
            || manifest.fence != request.fence
            || manifest.input_manifest_digest != input_digest
            || manifest.source_commit != source_commit
            || manifest.service_id != artifact.service_id
            || manifest.kind != artifact.kind
            || manifest.archive_digest != artifact.archive_digest
            || manifest.packed_bytes != artifact.packed_bytes
            || manifest.unpacked_bytes != artifact.unpacked_bytes
            || manifest.entry_count != artifact.entry_count
            || manifest.entrypoint_argv.as_ref() != artifact.entrypoint_argv.as_ref()
        {
            return Err(ApiError::unprocessable(
                "build_artifact_invalid",
                "an artifact manifest does not match the fenced build",
            ));
        }
        verify_cas_digest(&config.state_dir, &artifact.archive_digest)?;
    }
    if request.outcome.state == "succeeded" && seen.len() != expected.len() {
        return Err(ApiError::unprocessable(
            "build_artifact_invalid",
            "successful completion must register every declared build output",
        ));
    }
    for artifact in &request.outcome.artifacts {
        let entrypoint = artifact.entrypoint_argv.as_ref().map(|argv| json!(argv));
        sqlx::query("INSERT INTO build_artifacts(id,account_id,project_id,job_id,attempt_id,fence,service_id,kind,archive_digest,manifest_digest,packed_bytes,unpacked_bytes,entry_count,entrypoint_argv,cas_state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'registered')")
        .bind(Uuid::new_v4()).bind(account).bind(project).bind(job).bind(request.attempt_id).bind(request.fence).bind(artifact.service_id).bind(&artifact.kind).bind(&artifact.archive_digest).bind(&artifact.manifest_digest).bind(artifact.packed_bytes).bind(artifact.unpacked_bytes).bind(artifact.entry_count).bind(entrypoint).execute(&mut *tx).await?;
    }
    let billed = request.outcome.elapsed_seconds;
    let debit = if billed > 0 {
        let event = Uuid::new_v4();
        let entitlement:Uuid=sqlx::query_scalar("SELECT entitlement_id FROM build_usage_reservations WHERE job_id=$1 AND state='reserved' FOR UPDATE").bind(job).fetch_one(&mut *tx).await?;
        sqlx::query("INSERT INTO build_usage_events(id,account_id,project_id,deployment_id,entitlement_id,attempt_id,kind,seconds) VALUES($1,$2,$3,$4,$5,$6,'debit',$7)").bind(event).bind(account).bind(project).bind(deployment).bind(entitlement).bind(request.attempt_id).bind(billed).execute(&mut *tx).await?;
        Some(event)
    } else {
        None
    };
    if request.outcome.state != "retriable" {
        sqlx::query("UPDATE build_usage_reservations SET state='finalized',finalized_seconds=$2,debit_event_id=$3,finalized_at=clock_timestamp() WHERE job_id=$1 AND state='reserved'").bind(job).bind(billed).bind(debit).execute(&mut *tx).await?;
    }
    sqlx::query("UPDATE build_attempts SET state=$4,finished_at=clock_timestamp(),terminal_code=$5,completion_hash=$6 WHERE job_id=$1 AND id=$2 AND fence=$3 AND state='running'").bind(job).bind(request.attempt_id).bind(request.fence).bind(&request.outcome.state).bind(&request.outcome.code).bind(&completion_hash).execute(&mut *tx).await?;
    sqlx::query("UPDATE build_jobs SET state=$2,revision=revision+1,current_attempt_id=NULL,lease_expires_at=NULL,terminal_code=$3,cleanup_status=$4,updated_at=clock_timestamp() WHERE id=$1 AND current_attempt_id=$5 AND current_fence=$6 AND state='running'")
        .bind(job).bind(&request.outcome.state).bind(&request.outcome.code).bind(if cleanup.status=="confirmed"{"confirmed"}else{"pending"}).bind(request.attempt_id).bind(request.fence).execute(&mut *tx).await?;
    let build = load_build(&mut tx, account, project, job)
        .await?
        .ok_or_else(ApiError::internal)?;
    let artifacts = load_artifacts(&mut tx, job).await?;
    let effect = json!({"state":request.outcome.state,"code":request.outcome.code,"result_manifest_digest":request.outcome.result_manifest_digest,"cleanup_receipt_digest":request.outcome.cleanup_receipt_digest});
    let meter = json!({"reserved_seconds":RESERVED_SECONDS,"finalized_seconds":billed,"debit_event_id":debit});
    let response = CompleteResponse {
        build,
        effect: effect.clone(),
        artifacts,
        meter,
    };
    let response_body = serde_json::to_value(&response).map_err(|_| ApiError::internal())?;
    sqlx::query("INSERT INTO build_attempt_receipts(attempt_id,job_id,fence,completion_hash,response_body) VALUES($1,$2,$3,$4,$5)")
        .bind(request.attempt_id).bind(job).bind(request.fence).bind(&completion_hash).bind(&response_body).execute(&mut *tx).await?;
    if request.outcome.state != "retriable" {
        sqlx::query("INSERT INTO build_effects(job_id,attempt_id,fence,state,code,completion_hash,response_body) VALUES($1,$2,$3,$4,$5,$6,$7)")
        .bind(job).bind(request.attempt_id).bind(request.fence).bind(&request.outcome.state).bind(&request.outcome.code).bind(&completion_hash).bind(response_body).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(Json(response))
}

async fn load_artifacts(
    tx: &mut Transaction<'_, Postgres>,
    job: Uuid,
) -> Result<Vec<ArtifactRecord>, ApiError> {
    Ok(sqlx::query_as("SELECT id,service_id,kind,archive_digest,manifest_digest,packed_bytes,unpacked_bytes,entry_count,entrypoint_argv,created_at FROM build_artifacts WHERE job_id=$1 ORDER BY kind").bind(job).fetch_all(&mut **tx).await?)
}

#[derive(FromRow)]
struct ExpiredBuildLease {
    job_id: Uuid,
    account_id: Uuid,
    project_id: Uuid,
    deployment_id: Uuid,
    attempt_id: Uuid,
    attempt_count: i32,
    fence: i64,
    launched_at: Option<DateTime<Utc>>,
}

/// Reaps lost M3 leases without weakening M1 job semantics. Pre-launch loss may
/// retry; a lost worker after launch is metered and terminal because cleanup
/// evidence is unavailable.
pub(crate) async fn reap_expired(pool: &sqlx::PgPool) -> Result<(), ApiError> {
    for _ in 0..64 {
        let mut tx = pool.begin().await?;
        let row: Option<ExpiredBuildLease> = sqlx::query_as(
        "SELECT j.id AS job_id,j.account_id,j.project_id,j.deployment_id,j.current_attempt_id AS attempt_id,j.attempt_count,j.current_fence AS fence,a.launched_at FROM build_jobs j JOIN build_attempts a ON a.job_id=j.id AND a.id=j.current_attempt_id AND a.fence=j.current_fence WHERE j.state='running' AND j.lease_expires_at<=clock_timestamp() ORDER BY j.lease_expires_at,j.id FOR UPDATE OF j,a SKIP LOCKED LIMIT 1"
    ).fetch_optional(&mut *tx).await?;
        let Some(row) = row else {
            tx.commit().await?;
            break;
        };
        let ExpiredBuildLease {
            job_id: job,
            account_id: account,
            project_id: project,
            deployment_id: deployment,
            attempt_id: attempt,
            attempt_count,
            fence,
            launched_at: launched,
        } = row;
        let terminal = launched.is_some() || attempt_count >= 3;
        let code = if launched.is_some() {
            "lease_expired_after_launch"
        } else if terminal {
            "attempts_exhausted"
        } else {
            "platform_prelaunch_fault"
        };
        let attempt_state = if terminal { "failed" } else { "retriable" };
        let billed = if launched.is_some() {
            sqlx::query_scalar("SELECT LEAST($2,GREATEST(1,CEIL(EXTRACT(EPOCH FROM (clock_timestamp()-launched_at)))::integer)) FROM build_attempts WHERE id=$1").bind(attempt).bind(RESERVED_SECONDS).fetch_one(&mut *tx).await?
        } else {
            0
        };
        sqlx::query("UPDATE build_attempts SET state=$4,finished_at=clock_timestamp(),terminal_code=$5 WHERE job_id=$1 AND id=$2 AND fence=$3 AND state='running'").bind(job).bind(attempt).bind(fence).bind(attempt_state).bind(code).execute(&mut *tx).await?;
        sqlx::query("UPDATE build_jobs SET state=$2,revision=revision+1,current_attempt_id=NULL,lease_expires_at=NULL,terminal_code=CASE WHEN $3 THEN $4 ELSE NULL END,cleanup_status=CASE WHEN $5 THEN 'pending' ELSE cleanup_status END,updated_at=clock_timestamp() WHERE id=$1").bind(job).bind(attempt_state).bind(terminal).bind(code).bind(launched.is_some()).execute(&mut *tx).await?;
        if terminal {
            let debit = if billed > 0 {
                let entitlement:Uuid=sqlx::query_scalar("SELECT entitlement_id FROM build_usage_reservations WHERE job_id=$1 AND state='reserved' FOR UPDATE").bind(job).fetch_one(&mut *tx).await?;
                let event = Uuid::new_v4();
                sqlx::query("INSERT INTO build_usage_events(id,account_id,project_id,deployment_id,entitlement_id,attempt_id,kind,seconds) VALUES($1,$2,$3,$4,$5,$6,'debit',$7)").bind(event).bind(account).bind(project).bind(deployment).bind(entitlement).bind(attempt).bind(billed).execute(&mut *tx).await?;
                Some(event)
            } else {
                None
            };
            sqlx::query("UPDATE build_usage_reservations SET state='finalized',finalized_seconds=$2,debit_event_id=$3,finalized_at=clock_timestamp() WHERE job_id=$1 AND state='reserved'").bind(job).bind(billed).bind(debit).execute(&mut *tx).await?;
            let hash = Sha256::digest(format!("{code}:{attempt}:{fence}").as_bytes());
            let response = json!({"state":"failed","code":code,"cleanup_status":if launched.is_some(){"pending"}else{"not_started"},"finalized_seconds":billed});
            sqlx::query("INSERT INTO build_effects(job_id,attempt_id,fence,state,code,completion_hash,response_body) VALUES($1,$2,$3,'failed',$4,$5,$6) ON CONFLICT(job_id) DO NOTHING").bind(job).bind(attempt).bind(fence).bind(code).bind(hash.as_slice()).bind(response).execute(&mut *tx).await?;
        }
        tx.commit().await?;
    }
    Ok(())
}
