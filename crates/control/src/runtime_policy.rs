//! Evidence-gated owned-fixture runtime allocation and owner-safe observations.
//!
//! Runtime capability is established from a digest-addressed evaluator receipt,
//! not from booleans supplied to an HTTP request.  This module deliberately does
//! not promote a deployment or release; it records only allocation intent and
//! observed sandbox lifecycle facts.

use std::{
    fs::File,
    io::Read,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::PathBuf,
};

use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Duration, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::{
    auth::Authenticated,
    error::{ApiError, SafeJson},
    foundation::FoundationState,
    intent,
    m3::{self, RuntimeWorkerAuth},
};

const MAX_RECEIPT_BYTES: u64 = 512 * 1024;
const EVIDENCE_LIFETIME_DAYS: i64 = 7;
const EVIDENCE_RECEIPT_MAX_AGE_MINUTES: i64 = 30;
const RUNTIME_POLICY_DOCUMENT: &str = r#"{"cpu_period_micros":100000,"cpu_quota_micros":25000,"healthy_reset_seconds":600,"max_connections":128,"memory_bytes":536870912,"memory_swap_bytes":0,"new_connections_burst":40,"new_connections_per_second":20,"pids":128,"restart_delays_seconds":[1,2,4,8,16,30],"restart_limit":6,"restart_window_seconds":600,"scratch_bytes":268435456,"schema":"hostlet.runtime.policy/v1"}"#;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RegisterEvaluationRequest {
    evidence_digest: String,
}

#[derive(Serialize)]
struct EvaluationResponse {
    id: Uuid,
    evaluation_subject_id: Uuid,
    evaluation_generation: i64,
    evaluation_fence: i64,
    evidence_digest: String,
    capability_digest: String,
    result: String,
    reason_code: String,
    observed_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateAllocationRequest {
    build_job_id: Uuid,
    artifact_id: Uuid,
    evaluation_id: Uuid,
}

#[derive(Clone, Serialize)]
struct RuntimePolicy {
    schema: &'static str,
    digest: String,
    memory_bytes: i64,
    memory_swap_bytes: i64,
    cpu_quota_micros: i64,
    cpu_period_micros: i64,
    pids: i32,
    scratch_bytes: i64,
    max_connections: i32,
    new_connections_per_second: i32,
    new_connections_burst: i32,
    restart_delays_seconds: [i32; 6],
    restart_limit: i32,
    restart_window_seconds: i32,
    healthy_reset_seconds: i32,
}

#[derive(Serialize)]
struct AllocationResponse {
    id: Uuid,
    account_id: Uuid,
    project_id: Uuid,
    deployment_id: Uuid,
    service_id: Uuid,
    generation: i64,
    fence: i64,
    state: String,
    artifact_digest: String,
    artifact_manifest_digest: String,
    source_commit: String,
    configuration_revision_id: Uuid,
    build_profile_digest: String,
    runtime_binary_digest: String,
    platform: String,
    profile: String,
    executor_profile: &'static str,
    argv: Vec<String>,
    application_port: i32,
    health_port: i32,
    health_path: String,
    capability_digest: String,
    policy: RuntimePolicy,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RecordObservationRequest {
    allocation_id: Uuid,
    generation: i64,
    fence: i64,
    state: String,
    receipt_digest: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ResolveRuntimeCredentialRequest {
    generation: i64,
    fence: i64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ResolveEvaluationCredentialRequest {
    build_job_id: Uuid,
    artifact_id: Uuid,
    evaluation_subject_id: Uuid,
    generation: i64,
    fence: i64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ResolveRestoreProbeCredentialRequest {
    build_job_id: Uuid,
    artifact_id: Uuid,
    evaluation_subject_id: Uuid,
    generation: i64,
    fence: i64,
    recovery_id: Uuid,
    tenant_database_id: Uuid,
    database_generation: Uuid,
}

#[derive(Serialize)]
struct ResolveRuntimeCredentialResponse {
    credential_id: Uuid,
    database_ref: String,
    role_ref: String,
    database_name: String,
    role_name: String,
    value: RuntimeSecretValue,
}

struct RuntimeSecretValue(Zeroizing<String>);

impl Serialize for RuntimeSecretValue {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(self.0.as_str())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RuntimeCredentialPlaintext {
    #[serde(deserialize_with = "deserialize_zeroizing")]
    database_ref: Zeroizing<String>,
    #[serde(deserialize_with = "deserialize_zeroizing")]
    role_ref: Zeroizing<String>,
    #[serde(deserialize_with = "deserialize_zeroizing")]
    password: Zeroizing<String>,
}

struct CredentialScope {
    account_id: Uuid,
    project_id: Uuid,
    configuration_revision_id: Uuid,
    reservation_id: Uuid,
    reservation_epoch: Uuid,
}

#[derive(sqlx::FromRow)]
struct EvaluationCredentialScope {
    account_id: Uuid,
    project_id: Uuid,
    configuration_revision_id: Uuid,
    reservation_id: Uuid,
    reservation_epoch: Uuid,
}

#[derive(sqlx::FromRow)]
struct RestoreProbeCredentialScope {
    account_id: Uuid,
    project_id: Uuid,
    configuration_revision_id: Uuid,
    reservation_id: Uuid,
    reservation_epoch: Uuid,
    source_allocation_id: Uuid,
    source_allocation_generation: i64,
    source_allocation_fence: i64,
}

#[derive(sqlx::FromRow)]
struct EvaluationIntentArtifact {
    id: Uuid,
    archive_digest: String,
    manifest_digest: String,
    build_profile_digest: String,
    source_commit: String,
    framework: String,
    node_major: i16,
}

#[derive(Serialize)]
struct ObservationResponse {
    id: Uuid,
    allocation_id: Uuid,
    generation: i64,
    fence: i64,
    sequence: i64,
    state: String,
    reason_code: String,
    observed_at: DateTime<Utc>,
}

#[derive(Serialize)]
struct CompatibilityResponse {
    profiles: Vec<CompatibilityProfile>,
}

#[derive(Serialize)]
struct CompatibilityProfile {
    profile: String,
    framework: String,
    node_major: i16,
    result: String,
    reason_code: String,
    expires_at: DateTime<Utc>,
}

#[derive(Serialize)]
struct OwnerObservationResponse {
    observations: Vec<OwnerObservation>,
}

#[derive(Serialize, sqlx::FromRow)]
struct OwnerObservation {
    allocation_id: Uuid,
    deployment_id: Uuid,
    service_id: Uuid,
    generation: i64,
    state: String,
    reason_code: String,
    observed_at: DateTime<Utc>,
    memory_bytes: i64,
    cpu_quota_micros: i64,
    cpu_period_micros: i64,
    pids: i32,
    scratch_bytes: i64,
    max_connections: i32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EvaluationReceipt {
    schema: String,
    allocation_id: Uuid,
    generation: u64,
    fence: u64,
    operation: String,
    result: String,
    status: String,
    reason_code: String,
    artifact_digest: String,
    runtime_binary_digest: String,
    policy_digest: String,
    capability_digest: Option<String>,
    platform: String,
    profile: String,
    sandbox_id: Option<String>,
    oci_config_digest: Option<String>,
    runsc_status: Option<String>,
    namespace_inodes: Vec<u64>,
    observed_limits: Option<ObservedLimits>,
    network: Option<NetworkReceipt>,
    health: Option<HealthReceipt>,
    cleanup: Option<CleanupReceipt>,
    observed_at_unix_ms: i64,
    evaluation: EvaluationFacts,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct EvaluationFacts {
    evaluator_digest: String,
    oci_schema_digest: String,
    unpack_tool_digest: String,
    patterns: Vec<PatternFacts>,
    compatibility: CompatibilityFacts,
    performance: PerformanceFacts,
    network: NetworkFacts,
    resources: ResourceFacts,
    benchmark: BenchmarkFacts,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PatternFacts {
    framework: String,
    node_major: i16,
    artifact_digest: String,
    manifest_digest: String,
    build_profile_digest: String,
    source_commit: String,
    assertions_passed: u32,
    assertions_total: u32,
    cold_starts_healthy: u32,
    cold_starts_total: u32,
    cold_start_ms: Vec<u32>,
    warm_idle_seconds: u32,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CompatibilityFacts {
    warm_run_seconds: u32,
    p95_startup_ms: u32,
    baseline_samples: u32,
    sandbox_samples: u32,
    baseline_p95_request_ms: f64,
    sandbox_p95_request_ms: f64,
    baseline_throughput_rps: f64,
    sandbox_throughput_rps: f64,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PerformanceFacts {
    decision: String,
    throughput_target_ratio: f64,
    throughput_target_met: bool,
    production_ready: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct NetworkFacts {
    forbidden_passed: u32,
    forbidden_total: u32,
    allowed_passed: u32,
    allowed_total: u32,
    independent_observation: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct BenchmarkFacts {
    baseline_cpu_usec: u64,
    sandbox_cpu_usec: u64,
    baseline_peak_memory_bytes: u64,
    sandbox_peak_memory_bytes: u64,
    baseline_request_samples_ms: Vec<f64>,
    sandbox_request_samples_ms: Vec<f64>,
    startup_samples_ms: Vec<u32>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ResourceFacts {
    cpu_max: String,
    memory_max_bytes: i64,
    memory_swap_max_bytes: i64,
    pids_max: i32,
    scratch_max_bytes: i64,
    max_connections: i32,
    new_connections_per_second: i32,
    new_connections_burst: i32,
    enforced_reason_codes: Vec<String>,
    restart_delays_seconds: Vec<i32>,
    restart_limit: i32,
    restart_window_seconds: i32,
    healthy_reset_seconds: i32,
    idle_stop_observed: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ExecutorReceipt {
    schema: String,
    allocation_id: Uuid,
    generation: u64,
    fence: u64,
    operation: String,
    result: String,
    status: String,
    reason_code: String,
    artifact_digest: String,
    runtime_binary_digest: String,
    policy_digest: String,
    capability_digest: Option<String>,
    platform: String,
    profile: String,
    sandbox_id: Option<String>,
    oci_config_digest: Option<String>,
    runsc_status: Option<String>,
    namespace_inodes: Vec<u64>,
    observed_limits: Option<ObservedLimits>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    scratch_observation: Option<ScratchObservation>,
    network: Option<NetworkReceipt>,
    health: Option<HealthReceipt>,
    cleanup: Option<CleanupReceipt>,
    observed_at_unix_ms: i64,
    #[serde(default)]
    evaluation: Option<Value>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ScratchObservation {
    capacity_bytes: u64,
    available_bytes: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct HealthReceipt {
    passing: bool,
    checks: Vec<HealthCheck>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ObservedLimits {
    cgroup_path: String,
    cpu_max: String,
    memory_max_bytes: u64,
    memory_swap_max_bytes: u64,
    pids_max: u64,
    memory_current_bytes: u64,
    memory_peak_bytes: u64,
    pids_current: u64,
    cpu_usage_usec: u64,
    cpu_nr_throttled: u64,
    cpu_throttled_usec: u64,
    memory_events: MemoryEvents,
    pids_events: PidsEvents,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct MemoryEvents {
    low: u64,
    high: u64,
    max: u64,
    oom: u64,
    oom_kill: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PidsEvents {
    max: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct HealthCheck {
    kind: String,
    address: String,
    port: u16,
    path: String,
    status_code: Option<u16>,
    passed: bool,
    elapsed_ms: u64,
    reason_code: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct NetworkReceipt {
    rules_digest: Option<String>,
    application_namespace_inode: Option<u64>,
    gateway_namespace_inode: Option<u64>,
    counters: Vec<NetworkCounter>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct NetworkCounter {
    name: String,
    packets: u64,
    bytes: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CleanupReceipt {
    sandbox_absent: bool,
    application_namespace_absent: bool,
    gateway_namespace_absent: bool,
    cgroup_absent: bool,
    mounts_absent: bool,
    state_retained: bool,
}

#[derive(sqlx::FromRow)]
struct AllocationCandidate {
    account_id: Uuid,
    project_id: Uuid,
    deployment_id: Uuid,
    reservation_id: Uuid,
    reservation_epoch: Uuid,
    configuration_revision_id: Uuid,
    source_commit: String,
    build_profile_digest: String,
    artifact_id: Uuid,
    service_id: Uuid,
    archive_digest: String,
    manifest_digest: String,
    framework: String,
    node_major: i16,
    entrypoint_argv: Value,
    health_path: Option<String>,
    deployment_lifecycle: String,
    reservation_state: String,
}

#[derive(sqlx::FromRow)]
struct EvaluationRow {
    id: Uuid,
    result: String,
    reason_code: String,
    runtime_binary_digest: String,
    policy_digest: String,
    platform: String,
    capability_digest: String,
    expires_at: DateTime<Utc>,
    facts: Value,
}

#[derive(sqlx::FromRow)]
struct LockedAllocation {
    id: Uuid,
    account_id: Uuid,
    project_id: Uuid,
    deployment_id: Uuid,
    service_id: Uuid,
    generation: i64,
    fence: i64,
    state: String,
    artifact_digest: String,
    artifact_manifest_digest: String,
    source_commit: String,
    configuration_revision_id: Uuid,
    build_profile_digest: String,
    runtime_binary_digest: String,
    policy_digest: String,
    capability_digest: String,
    platform: String,
    profile: String,
    argv: Value,
    application_port: i32,
    health_port: i32,
    health_path: String,
}

pub(crate) fn routes() -> Router<FoundationState> {
    Router::new()
        .route("/v1/runtime/compatibility", get(get_compatibility))
        .route(
            "/v1/projects/{project_id}/runtime/observations",
            get(get_owner_observations),
        )
}

pub(crate) fn internal_routes() -> Router<FoundationState> {
    Router::new()
        .route(
            "/internal/v1/runtime/evaluations",
            post(register_evaluation),
        )
        .route(
            "/internal/v1/runtime/evaluations/credentials",
            post(resolve_evaluation_credential),
        )
        .route(
            "/internal/v1/runtime/restore-probes/credentials",
            post(resolve_restore_probe_credential),
        )
        .route("/internal/v1/runtime/allocations", post(create_allocation))
        .route(
            "/internal/v1/runtime/allocations/{allocation_id}/credentials",
            post(resolve_runtime_credential),
        )
        .route(
            "/internal/v1/runtime/observations",
            post(record_observation),
        )
}

async fn resolve_evaluation_credential(
    State(state): State<FoundationState>,
    _: RuntimeWorkerAuth,
    SafeJson(request): SafeJson<ResolveEvaluationCredentialRequest>,
) -> Result<Json<ResolveRuntimeCredentialResponse>, ApiError> {
    m3::require_enabled(&state)?;
    if request.evaluation_subject_id.is_nil() || request.generation <= 0 || request.fence <= 0 {
        return Err(runtime_fenced());
    }
    let scope: Option<EvaluationCredentialScope> = sqlx::query_as(
        "SELECT j.account_id,j.project_id,j.configuration_revision_id,j.reservation_id,j.reservation_epoch \
         FROM build_jobs j \
         JOIN build_artifacts a ON a.job_id=j.id AND a.account_id=j.account_id AND a.project_id=j.project_id \
         JOIN deployments d ON d.id=j.deployment_id AND d.account_id=j.account_id AND d.project_id=j.project_id \
         JOIN slot_reservations r ON r.id=j.reservation_id AND r.account_id=j.account_id \
              AND r.project_id=j.project_id AND r.reservation_epoch=j.reservation_epoch \
         JOIN projects p ON p.id=j.project_id AND p.account_id=j.account_id \
         JOIN build_usage_reservations u ON u.job_id=j.id AND u.account_id=j.account_id \
              AND u.project_id=j.project_id AND u.deployment_id=j.deployment_id \
         WHERE j.id=$1 AND a.id=$2 AND j.state='succeeded' AND a.cas_state='registered' \
           AND a.kind='application' AND a.entrypoint_argv IS NOT NULL \
           AND j.build_profile_id='m3-owned-node24-v1' AND r.state<>'released' AND u.state='finalized' \
           AND p.hosted_slots=1 AND p.slot_state IN ('reserved','resources_retained','release_pending') \
           AND (d.lifecycle='queued' OR (d.lifecycle='healthy' AND EXISTS ( \
               SELECT 1 FROM runtime_allocations ra \
               WHERE ra.account_id=j.account_id AND ra.project_id=j.project_id \
                 AND ra.deployment_id=j.deployment_id AND ra.build_job_id=j.id AND ra.artifact_id=a.id \
                 AND ra.configuration_revision_id=j.configuration_revision_id \
                 AND ra.reservation_id=j.reservation_id AND ra.reservation_epoch=j.reservation_epoch \
                 AND ra.state IN ('running','healthy','stopped') \
           ))) AND d.configuration_revision_id=j.configuration_revision_id \
           AND d.source_commit=j.source_commit",
    )
    .bind(request.build_job_id)
    .bind(request.artifact_id)
    .fetch_optional(&state.pool)
    .await?;
    let scope = scope.ok_or_else(allocation_ineligible)?;
    let intent_id = Uuid::new_v4();
    let accepted: Option<Uuid> = sqlx::query_scalar(
        "INSERT INTO runtime_evaluation_intents \
         (id,evaluation_subject_id,generation,fence,build_job_id,artifact_id,account_id,project_id, \
          configuration_revision_id,reservation_id,reservation_epoch,purpose,state) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'owned_fixture_evaluation','requested') \
         ON CONFLICT (evaluation_subject_id,generation,fence) DO UPDATE SET updated_at=transaction_timestamp() \
         WHERE runtime_evaluation_intents.build_job_id=EXCLUDED.build_job_id \
           AND runtime_evaluation_intents.artifact_id=EXCLUDED.artifact_id \
           AND runtime_evaluation_intents.account_id=EXCLUDED.account_id \
           AND runtime_evaluation_intents.project_id=EXCLUDED.project_id \
           AND runtime_evaluation_intents.configuration_revision_id=EXCLUDED.configuration_revision_id \
           AND runtime_evaluation_intents.reservation_id=EXCLUDED.reservation_id \
           AND runtime_evaluation_intents.reservation_epoch=EXCLUDED.reservation_epoch \
           AND runtime_evaluation_intents.purpose='owned_fixture_evaluation' \
           AND runtime_evaluation_intents.state IN ('requested','credential_issued') \
         RETURNING id",
    )
    .bind(intent_id)
    .bind(request.evaluation_subject_id)
    .bind(request.generation)
    .bind(request.fence)
    .bind(request.build_job_id)
    .bind(request.artifact_id)
    .bind(scope.account_id)
    .bind(scope.project_id)
    .bind(scope.configuration_revision_id)
    .bind(scope.reservation_id)
    .bind(scope.reservation_epoch)
    .fetch_optional(&state.pool)
    .await?;
    let intent_id = accepted.ok_or_else(|| {
        ApiError::conflict(
            "runtime_evaluation_intent_conflict",
            "the evaluation identity is already bound to another fixture",
        )
    })?;
    let credential = resolve_scoped_runtime_credential(
        &state,
        CredentialScope {
            account_id: scope.account_id,
            project_id: scope.project_id,
            configuration_revision_id: scope.configuration_revision_id,
            reservation_id: scope.reservation_id,
            reservation_epoch: scope.reservation_epoch,
        },
    )
    .await?;
    sqlx::query(
        "UPDATE runtime_evaluation_intents SET state='credential_issued',updated_at=transaction_timestamp() \
         WHERE id=$1 AND state IN ('requested','credential_issued')",
    )
    .bind(intent_id)
    .execute(&state.pool)
    .await?;
    Ok(Json(credential))
}

async fn resolve_restore_probe_credential(
    State(state): State<FoundationState>,
    _: RuntimeWorkerAuth,
    SafeJson(request): SafeJson<ResolveRestoreProbeCredentialRequest>,
) -> Result<Json<ResolveRuntimeCredentialResponse>, ApiError> {
    m3::require_enabled(&state)?;
    if request.evaluation_subject_id.is_nil()
        || request.generation <= 0
        || request.fence <= 0
        || request.recovery_id.is_nil()
        || request.tenant_database_id.is_nil()
        || request.database_generation.is_nil()
    {
        return Err(runtime_fenced());
    }

    let mut tx = state.pool.begin().await?;
    let scope: Option<RestoreProbeCredentialScope> = sqlx::query_as(
        "SELECT j.account_id,j.project_id,j.configuration_revision_id,j.reservation_id,j.reservation_epoch, \
                ra.id AS source_allocation_id,ra.generation AS source_allocation_generation, \
                ra.fence AS source_allocation_fence \
         FROM build_jobs j \
         JOIN build_artifacts a ON a.job_id=j.id AND a.account_id=j.account_id AND a.project_id=j.project_id \
         JOIN deployments d ON d.id=j.deployment_id AND d.account_id=j.account_id AND d.project_id=j.project_id \
         JOIN slot_reservations r ON r.id=j.reservation_id AND r.account_id=j.account_id \
              AND r.project_id=j.project_id AND r.reservation_epoch=j.reservation_epoch \
         JOIN projects p ON p.id=j.project_id AND p.account_id=j.account_id \
         JOIN build_usage_reservations u ON u.job_id=j.id AND u.account_id=j.account_id \
              AND u.project_id=j.project_id AND u.deployment_id=j.deployment_id \
         JOIN runtime_allocations ra ON ra.account_id=j.account_id AND ra.project_id=j.project_id \
              AND ra.deployment_id=j.deployment_id AND ra.build_job_id=j.id AND ra.artifact_id=a.id \
              AND ra.configuration_revision_id=j.configuration_revision_id \
              AND ra.reservation_id=j.reservation_id AND ra.reservation_epoch=j.reservation_epoch \
         JOIN tenant_databases td ON td.account_id=j.account_id AND td.project_id=j.project_id \
              AND td.id=$4 AND td.generation=$5 AND td.configuration_revision_id=j.configuration_revision_id \
              AND td.reservation_id=j.reservation_id AND td.reservation_epoch=j.reservation_epoch \
         JOIN tenant_database_recoveries recovery ON recovery.account_id=j.account_id \
              AND recovery.project_id=j.project_id AND recovery.tenant_database_id=td.id \
              AND recovery.database_generation=td.generation AND recovery.id=$3 \
         JOIN tenant_database_operations operation ON operation.account_id=j.account_id \
              AND operation.project_id=j.project_id AND operation.tenant_database_id=td.id \
              AND operation.database_generation=td.generation AND operation.kind='restore_drill' \
              AND operation.operation_key=recovery.id::text \
         WHERE j.id=$1 AND a.id=$2 AND j.state='succeeded' AND a.cas_state='registered' \
           AND a.kind='application' AND a.entrypoint_argv IS NOT NULL \
           AND j.build_profile_id='m3-owned-node24-v1' AND u.state='finalized' \
           AND d.lifecycle IN ('queued','healthy') AND d.configuration_revision_id=j.configuration_revision_id \
           AND d.source_commit=j.source_commit AND r.state<>'released' \
           AND p.hosted_slots=1 AND p.slot_state IN ('reserved','resources_retained','release_pending') \
           AND ra.state IN ('running','healthy','stopped') \
           AND ra.id=(SELECT current.id FROM runtime_allocations current \
                      WHERE current.account_id=ra.account_id AND current.project_id=ra.project_id \
                        AND current.deployment_id=ra.deployment_id AND current.service_id=ra.service_id \
                        AND current.build_job_id=ra.build_job_id AND current.artifact_id=ra.artifact_id \
                        AND current.configuration_revision_id=ra.configuration_revision_id \
                        AND current.reservation_id=ra.reservation_id AND current.reservation_epoch=ra.reservation_epoch \
                        AND current.state IN ('running','healthy','stopped') \
                      ORDER BY current.generation DESC,current.fence DESC,current.id DESC LIMIT 1) \
           AND td.state IN ('ready','recovery_attention') \
           AND recovery.state='validated' AND recovery.replacement_identity IS NOT NULL \
           AND recovery.restored_at IS NOT NULL AND recovery.validated_at IS NOT NULL \
           AND recovery.elapsed_milliseconds IS NOT NULL \
           AND recovery.replacement_ref=recovery.id::text \
           AND operation.state='succeeded' AND operation.result->>'code'='recovery_validated' \
           AND operation.spec->>'recovery_id'=recovery.id::text \
           AND operation.spec->>'archive_id'=recovery.archive_id::text \
           AND operation.spec->>'replacement_ref'=recovery.id::text \
           AND operation.result#>>'{proof,recovery_id}'=recovery.id::text \
           AND operation.result#>>'{proof,archive_id}'=recovery.archive_id::text \
           AND operation.result#>>'{proof,replacement_ref}'=recovery.id::text \
           AND operation.result#>>'{proof,replacement_identity}'=recovery.replacement_identity::text \
           AND operation.result#>>'{proof,elapsed_milliseconds}'=recovery.elapsed_milliseconds::text \
           AND operation.result#>>'{proof,replacement_endpoint_sha256}' ~ '^sha256:[0-9a-f]{64}$' \
           AND operation.result#>>'{proof,validation,rows_match}'='true' \
           AND operation.result#>>'{proof,validation,relationships_match}'='true' \
           AND operation.result#>>'{proof,validation,grants_match}'='true' \
           AND operation.result#>>'{proof,validation,application_connection_verified}'='true' \
           AND operation.result#>>'{proof,validation,source_unchanged}'='true' \
         FOR SHARE OF ra,recovery,operation",
    )
    .bind(request.build_job_id)
    .bind(request.artifact_id)
    .bind(request.recovery_id)
    .bind(request.tenant_database_id)
    .bind(request.database_generation)
    .fetch_optional(&mut *tx)
    .await?;
    let scope = scope.ok_or_else(restore_probe_ineligible)?;

    let evaluation_intent_id = Uuid::new_v4();
    let accepted: Option<Uuid> = sqlx::query_scalar(
        "INSERT INTO runtime_evaluation_intents \
         (id,evaluation_subject_id,generation,fence,build_job_id,artifact_id,account_id,project_id, \
          configuration_revision_id,reservation_id,reservation_epoch,purpose,state) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'owned_fixture_evaluation','requested') \
         ON CONFLICT (evaluation_subject_id,generation,fence) DO UPDATE SET updated_at=transaction_timestamp() \
         WHERE runtime_evaluation_intents.build_job_id=EXCLUDED.build_job_id \
           AND runtime_evaluation_intents.artifact_id=EXCLUDED.artifact_id \
           AND runtime_evaluation_intents.account_id=EXCLUDED.account_id \
           AND runtime_evaluation_intents.project_id=EXCLUDED.project_id \
           AND runtime_evaluation_intents.configuration_revision_id=EXCLUDED.configuration_revision_id \
           AND runtime_evaluation_intents.reservation_id=EXCLUDED.reservation_id \
           AND runtime_evaluation_intents.reservation_epoch=EXCLUDED.reservation_epoch \
           AND runtime_evaluation_intents.purpose='owned_fixture_evaluation' \
           AND runtime_evaluation_intents.state IN ('requested','credential_issued') \
         RETURNING id",
    )
    .bind(evaluation_intent_id)
    .bind(request.evaluation_subject_id)
    .bind(request.generation)
    .bind(request.fence)
    .bind(request.build_job_id)
    .bind(request.artifact_id)
    .bind(scope.account_id)
    .bind(scope.project_id)
    .bind(scope.configuration_revision_id)
    .bind(scope.reservation_id)
    .bind(scope.reservation_epoch)
    .fetch_optional(&mut *tx)
    .await?;
    let evaluation_intent_id = accepted.ok_or_else(|| {
        ApiError::conflict(
            "runtime_evaluation_intent_conflict",
            "the evaluation identity is already bound to another fixture",
        )
    })?;
    let restore_probe_intent_id = Uuid::new_v4();
    let probe_accepted: Option<Uuid> = sqlx::query_scalar(
        "INSERT INTO runtime_restore_probe_intents \
         (id,evaluation_intent_id,account_id,project_id,recovery_id,tenant_database_id,database_generation, \
          source_allocation_id,source_allocation_generation,source_allocation_fence,state) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'requested') \
         ON CONFLICT (evaluation_intent_id) DO UPDATE SET updated_at=transaction_timestamp() \
         WHERE runtime_restore_probe_intents.account_id=EXCLUDED.account_id \
           AND runtime_restore_probe_intents.project_id=EXCLUDED.project_id \
           AND runtime_restore_probe_intents.recovery_id=EXCLUDED.recovery_id \
           AND runtime_restore_probe_intents.tenant_database_id=EXCLUDED.tenant_database_id \
           AND runtime_restore_probe_intents.database_generation=EXCLUDED.database_generation \
           AND runtime_restore_probe_intents.source_allocation_id=EXCLUDED.source_allocation_id \
           AND runtime_restore_probe_intents.source_allocation_generation=EXCLUDED.source_allocation_generation \
           AND runtime_restore_probe_intents.source_allocation_fence=EXCLUDED.source_allocation_fence \
           AND runtime_restore_probe_intents.state IN ('requested','credential_issued') \
         RETURNING id",
    )
    .bind(restore_probe_intent_id)
    .bind(evaluation_intent_id)
    .bind(scope.account_id)
    .bind(scope.project_id)
    .bind(request.recovery_id)
    .bind(request.tenant_database_id)
    .bind(request.database_generation)
    .bind(scope.source_allocation_id)
    .bind(scope.source_allocation_generation)
    .bind(scope.source_allocation_fence)
    .fetch_optional(&mut *tx)
    .await?;
    let restore_probe_intent_id = probe_accepted.ok_or_else(|| {
        ApiError::conflict(
            "runtime_restore_probe_intent_conflict",
            "the evaluation identity is already bound to another restore probe",
        )
    })?;

    let credential = resolve_database_runtime_credential(
        &state,
        scope.account_id,
        scope.project_id,
        request.tenant_database_id,
        request.database_generation,
        Some(format!("hdr_{}", request.recovery_id.simple())),
    )
    .await?;
    sqlx::query(
        "UPDATE runtime_evaluation_intents SET state='credential_issued',updated_at=transaction_timestamp() \
         WHERE id=$1 AND state IN ('requested','credential_issued')",
    )
    .bind(evaluation_intent_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE runtime_restore_probe_intents SET state='credential_issued',updated_at=transaction_timestamp() \
         WHERE id=$1 AND state IN ('requested','credential_issued')",
    )
    .bind(restore_probe_intent_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(credential))
}

async fn resolve_runtime_credential(
    State(state): State<FoundationState>,
    _: RuntimeWorkerAuth,
    Path(allocation_id): Path<String>,
    SafeJson(request): SafeJson<ResolveRuntimeCredentialRequest>,
) -> Result<Json<ResolveRuntimeCredentialResponse>, ApiError> {
    m3::require_enabled(&state)?;
    let allocation_id = intent::path_uuid(&allocation_id)?;
    if request.generation <= 0 || request.fence <= 0 {
        return Err(runtime_fenced());
    }
    let allocation: Option<(Uuid, Uuid, Uuid, Uuid, Uuid)> = sqlx::query_as(
        "SELECT account_id,project_id,configuration_revision_id,reservation_id,reservation_epoch \
         FROM runtime_allocations WHERE id=$1 AND generation=$2 AND fence=$3 \
           AND state IN ('allocated','running','healthy','backoff')",
    )
    .bind(allocation_id)
    .bind(request.generation)
    .bind(request.fence)
    .fetch_optional(&state.pool)
    .await?;
    let Some((
        account_id,
        project_id,
        configuration_revision_id,
        reservation_id,
        reservation_epoch,
    )) = allocation
    else {
        return Err(runtime_fenced());
    };
    resolve_scoped_runtime_credential(
        &state,
        CredentialScope {
            account_id,
            project_id,
            configuration_revision_id,
            reservation_id,
            reservation_epoch,
        },
    )
    .await
    .map(Json)
}

async fn resolve_scoped_runtime_credential(
    state: &FoundationState,
    scope: CredentialScope,
) -> Result<ResolveRuntimeCredentialResponse, ApiError> {
    let database: Option<(Uuid, Uuid)> = sqlx::query_as(
        "SELECT id,generation FROM tenant_databases \
         WHERE account_id=$1 AND project_id=$2 AND configuration_revision_id=$3 \
           AND reservation_id=$4 AND reservation_epoch=$5 AND state IN ('ready','recovery_attention')",
    )
    .bind(scope.account_id)
    .bind(scope.project_id)
    .bind(scope.configuration_revision_id)
    .bind(scope.reservation_id)
    .bind(scope.reservation_epoch)
    .fetch_optional(&state.pool)
    .await?;
    let (database_id, database_generation) = database.ok_or_else(ApiError::not_found)?;
    resolve_database_runtime_credential(
        state,
        scope.account_id,
        scope.project_id,
        database_id,
        database_generation,
        None,
    )
    .await
}

async fn resolve_database_runtime_credential(
    state: &FoundationState,
    account_id: Uuid,
    project_id: Uuid,
    database_id: Uuid,
    database_generation: Uuid,
    database_name: Option<String>,
) -> Result<ResolveRuntimeCredentialResponse, ApiError> {
    let key = state
        .secret_key
        .as_deref()
        .ok_or_else(ApiError::foundation_unavailable)?;
    let credential = crate::tenant_databases::resolve_runtime_credential(
        &state.pool,
        key,
        account_id,
        project_id,
        database_id,
        database_generation,
    )
    .await?;
    let parsed: RuntimeCredentialPlaintext = serde_json::from_str(credential.value.as_str())
        .map_err(|_| ApiError::foundation_unavailable())?;
    let database_identity = Uuid::parse_str(parsed.database_ref.as_str())
        .map_err(|_| ApiError::foundation_unavailable())?;
    let role_identity = Uuid::parse_str(parsed.role_ref.as_str())
        .map_err(|_| ApiError::foundation_unavailable())?;
    let decoded_password = Zeroizing::new(
        URL_SAFE_NO_PAD
            .decode(parsed.password.as_bytes())
            .map_err(|_| ApiError::foundation_unavailable())?,
    );
    let expected_database_name = format!("hdb_{}", database_identity.simple());
    let expected_role_name = format!("ha_{}", role_identity.simple());
    if parsed.database_ref.as_str() != credential.database_ref.as_str()
        || parsed.role_ref.as_str() != credential.role_ref.as_str()
        || credential.database_name.as_str() != expected_database_name
        || credential.role_name.as_str() != expected_role_name
        || decoded_password.len() != 32
    {
        return Err(ApiError::foundation_unavailable());
    }
    Ok(ResolveRuntimeCredentialResponse {
        credential_id: credential.credential_id,
        database_ref: credential.database_ref,
        role_ref: credential.role_ref,
        database_name: database_name.unwrap_or(credential.database_name),
        role_name: credential.role_name,
        value: RuntimeSecretValue(credential.value),
    })
}

async fn register_evaluation(
    State(state): State<FoundationState>,
    _: RuntimeWorkerAuth,
    SafeJson(request): SafeJson<RegisterEvaluationRequest>,
) -> Result<(StatusCode, Json<EvaluationResponse>), ApiError> {
    let policy_now = m3::policy_now(&state).await?;
    let real_now = Utc::now();
    let bytes = read_cas_receipt(&state, &request.evidence_digest)?;
    let receipt: EvaluationReceipt = serde_json::from_slice(&bytes).map_err(|_| {
        ApiError::unprocessable(
            "runtime_evidence_invalid",
            "the runtime evidence receipt does not match the supported schema",
        )
    })?;
    let observed_at = receipt_time(receipt.observed_at_unix_ms)?;
    let expires_at = policy_now + Duration::days(EVIDENCE_LIFETIME_DAYS);
    validate_evaluation_envelope(&receipt, real_now)?;
    let computed_pass = evaluation_passes(&receipt.evaluation);
    let passed = computed_pass && receipt.result == "passed";
    let result = if passed { "passed" } else { "failed" };
    let reason_code = if passed {
        "runtime_capability_verified"
    } else {
        "runtime_isolation_unverified"
    };
    let policy_digest = runtime_policy_digest();
    if receipt.policy_digest != policy_digest {
        return Err(ApiError::conflict(
            "runtime_policy_mismatch",
            "the evidence was produced for a different runtime policy",
        ));
    }
    let capability_digest = capability_digest(&request.evidence_digest, &receipt);
    let id = Uuid::new_v4();
    let facts = serde_json::to_value(&receipt.evaluation).map_err(|_| ApiError::internal())?;
    let mut tx = state.pool.begin().await?;
    let intent: Option<EvaluationIntentArtifact> = sqlx::query_as(
            "SELECT i.id,a.archive_digest,a.manifest_digest,j.build_profile_digest, \
                    j.source_commit,s.framework,s.node_major \
             FROM runtime_evaluation_intents i \
             JOIN build_jobs j ON j.id=i.build_job_id AND j.account_id=i.account_id AND j.project_id=i.project_id \
             JOIN build_artifacts a ON a.id=i.artifact_id AND a.job_id=i.build_job_id \
             JOIN build_job_services s ON s.job_id=j.id AND s.service_id=a.service_id \
             WHERE i.evaluation_subject_id=$1 AND i.generation=$2 AND i.fence=$3 \
               AND i.purpose='owned_fixture_evaluation' AND i.state IN ('credential_issued','consumed') \
               AND i.updated_at >= $4 \
             FOR UPDATE OF i",
        )
        .bind(receipt.allocation_id)
        .bind(i64::try_from(receipt.generation).map_err(|_| evidence_invalid())?)
        .bind(i64::try_from(receipt.fence).map_err(|_| evidence_invalid())?)
        .bind(real_now - Duration::minutes(EVIDENCE_RECEIPT_MAX_AGE_MINUTES))
        .fetch_optional(&mut *tx)
        .await?;
    let Some(intent) = intent else {
        return Err(ApiError::conflict(
            "runtime_evaluation_intent_missing",
            "the evidence is not bound to an active owned-fixture evaluation intent",
        ));
    };
    for pattern in &receipt.evaluation.patterns {
        let recorded: bool = sqlx::query_scalar(
            "SELECT EXISTS( \
               SELECT 1 FROM build_artifacts a \
               JOIN build_jobs j ON j.id=a.job_id AND j.account_id=a.account_id AND j.project_id=a.project_id \
               JOIN build_job_services s ON s.job_id=j.id AND s.service_id=a.service_id \
               WHERE j.state='succeeded' AND a.cas_state='registered' AND a.kind='application' \
                 AND a.archive_digest=$1 AND a.manifest_digest=$2 AND j.build_profile_digest=$3 \
                 AND j.source_commit=$4 AND s.framework=$5 AND s.node_major=$6 \
             )",
        )
        .bind(&pattern.artifact_digest)
        .bind(&pattern.manifest_digest)
        .bind(&pattern.build_profile_digest)
        .bind(&pattern.source_commit)
        .bind(&pattern.framework)
        .bind(pattern.node_major)
        .fetch_one(&mut *tx)
        .await?;
        if !recorded {
            return Err(ApiError::conflict(
                "runtime_evaluation_artifact_mismatch",
                "each evaluated pattern must bind an exact succeeded artifact record",
            ));
        }
    }
    let exact_fixture_observed = receipt.evaluation.patterns.iter().any(|pattern| {
        pattern_well_formed(pattern)
            && pattern.artifact_digest == intent.archive_digest
            && pattern.manifest_digest == intent.manifest_digest
            && pattern.build_profile_digest == intent.build_profile_digest
            && pattern.source_commit == intent.source_commit
            && pattern.framework == intent.framework
            && pattern.node_major == intent.node_major
    });
    if !exact_fixture_observed {
        return Err(ApiError::conflict(
            "runtime_evaluation_artifact_mismatch",
            "the evidence does not include the evaluation intent's exact artifact tuple",
        ));
    }
    let prior_digest: Option<String> = sqlx::query_scalar(
        "SELECT evidence_digest FROM runtime_evaluations WHERE evaluation_intent_id=$1",
    )
    .bind(intent.id)
    .fetch_optional(&mut *tx)
    .await?;
    if prior_digest
        .as_deref()
        .is_some_and(|digest| digest != request.evidence_digest)
    {
        return Err(ApiError::conflict(
            "runtime_evaluation_intent_consumed",
            "the evaluation intent is already bound to different evidence",
        ));
    }
    let row: (Uuid, Uuid, i64, i64, String, String, DateTime<Utc>, DateTime<Utc>) = sqlx::query_as(
        "INSERT INTO runtime_evaluations \
         (id,evaluation_intent_id,evaluation_subject_id,evaluation_generation,evaluation_fence,evidence_digest,capability_digest,result,reason_code,runtime_binary_digest,policy_digest,platform,profile,observed_at,expires_at,facts) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) \
         ON CONFLICT (evidence_digest) DO UPDATE SET evidence_digest=EXCLUDED.evidence_digest \
         RETURNING id,evaluation_subject_id,evaluation_generation,evaluation_fence,result,reason_code,observed_at,expires_at",
    )
    .bind(id)
    .bind(intent.id)
    .bind(receipt.allocation_id)
    .bind(i64::try_from(receipt.generation).map_err(|_| evidence_invalid())?)
    .bind(i64::try_from(receipt.fence).map_err(|_| evidence_invalid())?)
    .bind(&request.evidence_digest)
    .bind(&capability_digest)
    .bind(result)
    .bind(reason_code)
    .bind(&receipt.runtime_binary_digest)
    .bind(&policy_digest)
    .bind(&receipt.platform)
    .bind("evidence_gated_owned_fixture")
    .bind(observed_at)
    .bind(expires_at)
    .bind(facts)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE runtime_evaluation_intents SET state='consumed',updated_at=transaction_timestamp() WHERE id=$1",
    )
    .bind(intent.id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE runtime_restore_probe_intents SET state='consumed',updated_at=transaction_timestamp() \
         WHERE evaluation_intent_id=$1 AND state IN ('credential_issued','consumed')",
    )
    .bind(intent.id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok((
        StatusCode::CREATED,
        Json(EvaluationResponse {
            id: row.0,
            evaluation_subject_id: row.1,
            evaluation_generation: row.2,
            evaluation_fence: row.3,
            evidence_digest: request.evidence_digest,
            capability_digest,
            result: row.4,
            reason_code: row.5,
            observed_at: row.6,
            expires_at: row.7,
        }),
    ))
}

async fn create_allocation(
    State(state): State<FoundationState>,
    _: RuntimeWorkerAuth,
    SafeJson(request): SafeJson<CreateAllocationRequest>,
) -> Result<(StatusCode, Json<AllocationResponse>), ApiError> {
    m3::require_enabled(&state)?;
    let now = m3::policy_now(&state).await?;
    let mut tx = state.pool.begin().await?;
    let candidate: Option<AllocationCandidate> = sqlx::query_as(
        "SELECT j.account_id,j.project_id,j.deployment_id,j.reservation_id,j.reservation_epoch, \
                j.configuration_revision_id,j.source_commit,j.build_profile_digest, \
                a.id AS artifact_id,a.service_id,a.archive_digest,a.manifest_digest, \
                s.framework,s.node_major,a.entrypoint_argv,s.health_path, \
                d.lifecycle AS deployment_lifecycle,r.state AS reservation_state \
         FROM build_jobs j \
         JOIN build_artifacts a ON a.job_id=j.id AND a.account_id=j.account_id AND a.project_id=j.project_id \
         JOIN build_job_services s ON s.job_id=j.id AND s.service_id=a.service_id \
         JOIN deployments d ON d.id=j.deployment_id AND d.account_id=j.account_id AND d.project_id=j.project_id \
         JOIN slot_reservations r ON r.id=j.reservation_id AND r.account_id=j.account_id \
              AND r.project_id=j.project_id AND r.reservation_epoch=j.reservation_epoch \
         WHERE j.id=$1 AND a.id=$2 AND j.state='succeeded' AND a.cas_state='registered' \
           AND a.kind='application' AND s.kind='application' \
           AND d.configuration_revision_id=j.configuration_revision_id AND d.source_commit=j.source_commit \
         FOR UPDATE OF j,r",
    )
    .bind(request.build_job_id)
    .bind(request.artifact_id)
    .fetch_optional(&mut *tx)
    .await?;
    let candidate = candidate.ok_or_else(allocation_ineligible)?;
    if candidate.deployment_lifecycle != "queued" || candidate.reservation_state == "released" {
        return Err(allocation_ineligible());
    }
    let evaluation: Option<EvaluationRow> = sqlx::query_as(
        "SELECT id,result,reason_code,runtime_binary_digest,policy_digest,platform,capability_digest,expires_at,facts \
         FROM runtime_evaluations WHERE id=$1 FOR SHARE",
    )
    .bind(request.evaluation_id)
    .fetch_optional(&mut *tx)
    .await?;
    let evaluation = evaluation.ok_or_else(allocation_ineligible)?;
    if evaluation.result != "passed"
        || evaluation.reason_code != "runtime_capability_verified"
        || evaluation.expires_at <= now
        || evaluation.policy_digest != runtime_policy_digest()
    {
        return Err(allocation_ineligible());
    }
    let facts: EvaluationFacts =
        serde_json::from_value(evaluation.facts).map_err(|_| allocation_ineligible())?;
    let pattern = facts
        .patterns
        .iter()
        .find(|pattern| pattern_matches(pattern, &candidate))
        .ok_or_else(allocation_ineligible)?;
    let profile = runtime_profile(pattern)?;
    let argv = artifact_argv(&candidate.framework, candidate.entrypoint_argv.clone())?;
    let health_path = candidate
        .health_path
        .as_deref()
        .ok_or_else(allocation_ineligible)?;
    if !safe_health_path(health_path) {
        return Err(allocation_ineligible());
    }

    // The configured service row serializes generation assignment without a
    // process-local lock. This supports replay and API restart safely.
    sqlx::query(
        "SELECT id FROM services WHERE account_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE",
    )
    .bind(candidate.account_id)
    .bind(candidate.project_id)
    .bind(candidate.service_id)
    .execute(&mut *tx)
    .await?;
    if let Some(existing) = load_exact_allocation(&mut tx, &candidate, evaluation.id).await? {
        tx.commit().await?;
        return Ok((StatusCode::OK, Json(allocation_response(existing)?)));
    }
    let (generation, fence): (i64, i64) = sqlx::query_as(
        "SELECT COALESCE(max(generation),0)+1,COALESCE(max(fence),0)+1 \
         FROM runtime_allocations WHERE service_id=$1",
    )
    .bind(candidate.service_id)
    .fetch_one(&mut *tx)
    .await?;
    let id = Uuid::new_v4();
    let allocation: LockedAllocation = sqlx::query_as(
        "INSERT INTO runtime_allocations \
         (id,account_id,project_id,deployment_id,service_id,build_job_id,artifact_id,evaluation_id, \
          reservation_id,reservation_epoch,configuration_revision_id,source_commit,generation,fence,state, \
          artifact_digest,artifact_manifest_digest,build_profile_digest,runtime_binary_digest,policy_digest, \
          capability_digest,platform,profile,argv,application_port,health_port,health_path) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'allocated',$15,$16,$17,$18,$19,$20,$21,$22,$23,3000,3000,$24) \
         RETURNING id,account_id,project_id,deployment_id,service_id,generation,fence,state,artifact_digest, \
                   artifact_manifest_digest,source_commit,configuration_revision_id,build_profile_digest, \
                   runtime_binary_digest,policy_digest,capability_digest,platform,profile,argv, \
                   application_port,health_port,health_path",
    )
    .bind(id)
    .bind(candidate.account_id)
    .bind(candidate.project_id)
    .bind(candidate.deployment_id)
    .bind(candidate.service_id)
    .bind(request.build_job_id)
    .bind(candidate.artifact_id)
    .bind(evaluation.id)
    .bind(candidate.reservation_id)
    .bind(candidate.reservation_epoch)
    .bind(candidate.configuration_revision_id)
    .bind(&candidate.source_commit)
    .bind(generation)
    .bind(fence)
    .bind(&candidate.archive_digest)
    .bind(&candidate.manifest_digest)
    .bind(&candidate.build_profile_digest)
    .bind(&evaluation.runtime_binary_digest)
    .bind(&evaluation.policy_digest)
    .bind(&evaluation.capability_digest)
    .bind(&evaluation.platform)
    .bind(profile)
    .bind(serde_json::to_value(&argv).map_err(|_| ApiError::internal())?)
    .bind(health_path)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(allocation_response(allocation)?)))
}

async fn record_observation(
    State(state): State<FoundationState>,
    _: RuntimeWorkerAuth,
    SafeJson(request): SafeJson<RecordObservationRequest>,
) -> Result<(StatusCode, Json<ObservationResponse>), ApiError> {
    m3::require_enabled(&state)?;
    let bytes = read_cas_receipt(&state, &request.receipt_digest)?;
    let receipt: ExecutorReceipt = serde_json::from_slice(&bytes).map_err(|_| {
        ApiError::unprocessable(
            "runtime_receipt_invalid",
            "the runtime receipt does not match the supported schema",
        )
    })?;
    validate_executor_receipt(&receipt)?;
    let observed_at = receipt_time(receipt.observed_at_unix_ms)?;
    if observed_at > Utc::now() + Duration::minutes(5) {
        return Err(ApiError::unprocessable(
            "runtime_receipt_invalid",
            "the runtime receipt timestamp is invalid",
        ));
    }
    let mut tx = state.pool.begin().await?;
    let allocation: Option<LockedAllocation> = sqlx::query_as(
        "SELECT id,account_id,project_id,deployment_id,service_id,generation,fence,state,artifact_digest, \
                artifact_manifest_digest,source_commit,configuration_revision_id,build_profile_digest, \
                runtime_binary_digest,policy_digest,capability_digest,platform,profile,argv, \
                application_port,health_port,health_path \
         FROM runtime_allocations WHERE id=$1 FOR UPDATE",
    )
    .bind(request.allocation_id)
    .fetch_optional(&mut *tx)
    .await?;
    let allocation = allocation.ok_or_else(ApiError::not_found)?;
    if request.generation != allocation.generation
        || request.fence != allocation.fence
        || receipt.allocation_id != allocation.id
        || receipt.generation != allocation.generation as u64
        || receipt.fence != allocation.fence as u64
        || receipt.artifact_digest != allocation.artifact_digest
        || receipt.runtime_binary_digest != allocation.runtime_binary_digest
        || receipt.policy_digest != allocation.policy_digest
        || receipt.capability_digest.as_deref() != Some(allocation.capability_digest.as_str())
        || receipt.platform != allocation.platform
    {
        return Err(ApiError::conflict(
            "runtime_fence_stale",
            "the observation does not match the current allocation generation and fence",
        ));
    }
    let prior: Option<(Uuid, i64, String, String, DateTime<Utc>)> = sqlx::query_as(
        "SELECT id,sequence,state,reason_code,observed_at FROM runtime_observations \
         WHERE receipt_digest=$1 AND allocation_id=$2",
    )
    .bind(&request.receipt_digest)
    .bind(allocation.id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(row) = prior {
        if row.2 != request.state {
            return Err(ApiError::conflict(
                "runtime_receipt_reused",
                "the receipt digest is already bound to a different observation",
            ));
        }
        tx.commit().await?;
        return Ok((
            StatusCode::OK,
            Json(ObservationResponse {
                id: row.0,
                allocation_id: allocation.id,
                generation: allocation.generation,
                fence: allocation.fence,
                sequence: row.1,
                state: row.2,
                reason_code: row.3,
                observed_at: row.4,
            }),
        ));
    }
    validate_state_receipt(&request.state, &receipt)?;
    if !transition_allowed(&allocation.state, &request.state) {
        return Err(ApiError::conflict(
            "runtime_transition_forbidden",
            "the requested runtime lifecycle transition is not allowed",
        ));
    }
    let receipt_json = serde_json::to_value(&receipt).map_err(|_| ApiError::internal())?;
    let sequence: i64 = sqlx::query_scalar(
        "SELECT COALESCE(max(sequence),0)+1 FROM runtime_observations WHERE allocation_id=$1",
    )
    .bind(allocation.id)
    .fetch_one(&mut *tx)
    .await?;
    let id = Uuid::new_v4();
    let inserted: Option<(Uuid, i64, String, String, DateTime<Utc>)> = sqlx::query_as(
        "INSERT INTO runtime_observations \
         (id,allocation_id,account_id,project_id,deployment_id,service_id,generation,fence,sequence,state,reason_code,receipt_digest,safe_receipt,observed_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) \
         ON CONFLICT (receipt_digest) DO NOTHING \
         RETURNING id,sequence,state,reason_code,observed_at",
    )
    .bind(id)
    .bind(allocation.id)
    .bind(allocation.account_id)
    .bind(allocation.project_id)
    .bind(allocation.deployment_id)
    .bind(allocation.service_id)
    .bind(allocation.generation)
    .bind(allocation.fence)
    .bind(sequence)
    .bind(&request.state)
    .bind(&receipt.reason_code)
    .bind(&request.receipt_digest)
    .bind(receipt_json)
    .bind(observed_at)
    .fetch_optional(&mut *tx)
    .await?;
    let row = if let Some(row) = inserted {
        sqlx::query("UPDATE runtime_allocations SET state=$1,reason_code=$2,updated_at=transaction_timestamp() WHERE id=$3")
            .bind(&request.state)
            .bind(&receipt.reason_code)
            .bind(allocation.id)
            .execute(&mut *tx)
            .await?;
        row
    } else {
        sqlx::query_as(
            "SELECT id,sequence,state,reason_code,observed_at FROM runtime_observations \
             WHERE receipt_digest=$1 AND allocation_id=$2",
        )
        .bind(&request.receipt_digest)
        .bind(allocation.id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| {
            ApiError::conflict(
                "runtime_receipt_reused",
                "the receipt digest is already bound to another allocation",
            )
        })?
    };
    tx.commit().await?;
    Ok((
        StatusCode::CREATED,
        Json(ObservationResponse {
            id: row.0,
            allocation_id: allocation.id,
            generation: allocation.generation,
            fence: allocation.fence,
            sequence: row.1,
            state: row.2,
            reason_code: row.3,
            observed_at: row.4,
        }),
    ))
}

async fn get_compatibility(
    State(state): State<FoundationState>,
    _: Authenticated,
) -> Result<Json<CompatibilityResponse>, ApiError> {
    let now = m3::policy_now(&state).await?;
    let rows: Vec<(String, String, String, DateTime<Utc>, Value)> = sqlx::query_as(
        "SELECT profile,result,reason_code,expires_at,facts FROM runtime_evaluations \
         WHERE result='passed' AND expires_at>$1 ORDER BY created_at DESC,id DESC",
    )
    .bind(now)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(CompatibilityResponse {
        profiles: rows
            .into_iter()
            .flat_map(|row| {
                serde_json::from_value::<EvaluationFacts>(row.4)
                    .ok()
                    .into_iter()
                    .flat_map(move |facts| {
                        facts.patterns.into_iter().filter(pattern_passes).map({
                            let profile = row.0.clone();
                            let result = row.1.clone();
                            let reason_code = row.2.clone();
                            move |pattern| CompatibilityProfile {
                                profile: runtime_profile(&pattern)
                                    .map(str::to_owned)
                                    .unwrap_or_else(|_| profile.clone()),
                                framework: pattern.framework,
                                node_major: pattern.node_major,
                                result: result.clone(),
                                reason_code: reason_code.clone(),
                                expires_at: row.3,
                            }
                        })
                    })
            })
            .collect(),
    }))
}

async fn get_owner_observations(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    Path(project_id): Path<String>,
) -> Result<Json<OwnerObservationResponse>, ApiError> {
    m3::require_enabled(&state)?;
    let account_id = authenticated.account_id()?;
    let project_id = intent::path_uuid(&project_id)?;
    let owns: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM projects WHERE account_id=$1 AND id=$2)")
            .bind(account_id)
            .bind(project_id)
            .fetch_one(&state.pool)
            .await?;
    if !owns {
        return Err(ApiError::not_found());
    }
    let observations = sqlx::query_as(
        "SELECT o.allocation_id,o.deployment_id,o.service_id,o.generation,o.state,o.reason_code,o.observed_at, \
                536870912::bigint AS memory_bytes,25000::bigint AS cpu_quota_micros,100000::bigint AS cpu_period_micros, \
                128::integer AS pids,268435456::bigint AS scratch_bytes,128::integer AS max_connections \
         FROM runtime_observations o WHERE o.account_id=$1 AND o.project_id=$2 \
         ORDER BY o.observed_at DESC,o.id DESC LIMIT 200",
    )
    .bind(account_id)
    .bind(project_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(OwnerObservationResponse { observations }))
}

fn read_cas_receipt(state: &FoundationState, digest: &str) -> Result<Vec<u8>, ApiError> {
    let hex = digest_hex(digest)?;
    let root = &m3::require_enabled(state)?.state_dir;
    let path: PathBuf = root
        .join("evidence")
        .join("sha256")
        .join(&hex[..2])
        .join(format!("{}.json", &hex[2..]));
    let link_metadata = std::fs::symlink_metadata(&path).map_err(|_| evidence_missing())?;
    if !link_metadata.file_type().is_file()
        || link_metadata.len() > MAX_RECEIPT_BYTES
        || link_metadata.permissions().mode() & 0o077 != 0
        || std::fs::canonicalize(&path).ok().as_ref() != Some(&path)
    {
        return Err(evidence_invalid());
    }
    let mut file = File::open(&path).map_err(|_| evidence_missing())?;
    let opened = file.metadata().map_err(|_| evidence_invalid())?;
    if opened.dev() != link_metadata.dev() || opened.ino() != link_metadata.ino() {
        return Err(evidence_invalid());
    }
    let mut bytes = Vec::with_capacity(opened.len() as usize);
    file.read_to_end(&mut bytes)
        .map_err(|_| evidence_invalid())?;
    if bytes.len() as u64 != opened.len()
        || Sha256::digest(&bytes).as_slice() != decode_hex(&hex)?.as_slice()
    {
        return Err(ApiError::conflict(
            "runtime_evidence_digest_mismatch",
            "the evidence file does not match its digest",
        ));
    }
    Ok(bytes)
}

fn validate_evaluation_envelope(
    receipt: &EvaluationReceipt,
    real_now: DateTime<Utc>,
) -> Result<(), ApiError> {
    let observed_at = receipt_time(receipt.observed_at_unix_ms)?;
    if receipt.schema != "hostlet.runtime.executor-receipt/v1"
        || receipt.profile != "owned_fixture_evaluation"
        || receipt.operation != "validate"
        || receipt.allocation_id.is_nil()
        || receipt.capability_digest.is_some()
        || receipt.sandbox_id.is_some()
        || receipt.oci_config_digest.is_some()
        || receipt.runsc_status.is_some()
        || !receipt.namespace_inodes.is_empty()
        || receipt.observed_limits.is_some()
        || receipt.network.is_some()
        || receipt.health.is_some()
        || receipt.cleanup.is_some()
        || receipt.generation == 0
        || receipt.fence == 0
        || !matches!(receipt.platform.as_str(), "systrap" | "kvm")
        || !is_digest(&receipt.artifact_digest)
        || !is_digest(&receipt.runtime_binary_digest)
        || !is_digest(&receipt.policy_digest)
        || !matches!(receipt.result.as_str(), "passed" | "failed")
        || receipt.status != "prepared"
        || receipt.reason_code.is_empty()
        || receipt.reason_code.len() > 96
        || observed_at > real_now + Duration::minutes(5)
        || observed_at < real_now - Duration::minutes(EVIDENCE_RECEIPT_MAX_AGE_MINUTES)
    {
        return Err(evidence_invalid());
    }
    if !performance_assessment_matches(&receipt.evaluation) {
        return Err(ApiError::unprocessable(
            "runtime_evidence_invalid",
            "the evaluation performance assessment is missing, unsupported, or inconsistent",
        ));
    }
    Ok(())
}

fn performance_assessment_matches(facts: &EvaluationFacts) -> bool {
    let compatibility = &facts.compatibility;
    let performance = &facts.performance;
    performance.decision == "owned_fixture_only"
        && performance.throughput_target_ratio == 0.5
        && !performance.production_ready
        && finite_positive(compatibility.baseline_throughput_rps)
        && finite_positive(compatibility.sandbox_throughput_rps)
        && performance.throughput_target_met
            == (compatibility.sandbox_throughput_rps
                >= compatibility.baseline_throughput_rps * performance.throughput_target_ratio)
}

fn evaluation_passes(facts: &EvaluationFacts) -> bool {
    let compatibility = &facts.compatibility;
    let network = &facts.network;
    let resources = &facts.resources;
    let benchmark = &facts.benchmark;
    let reasons = [
        "cpu_throttled",
        "runtime_oom",
        "process_limit_exceeded",
        "scratch_limit_exceeded",
        "network_connection_limit",
        "crash_loop_backoff",
    ];
    !facts.patterns.is_empty()
        && facts.patterns.len() <= 8
        && is_digest(&facts.evaluator_digest)
        && is_digest(&facts.oci_schema_digest)
        && is_digest(&facts.unpack_tool_digest)
        && facts.patterns.iter().all(pattern_well_formed)
        && facts.patterns.iter().any(|pattern| {
            pattern.framework == "node_http" && pattern.node_major == 22 && pattern_passes(pattern)
        })
        && facts.patterns.iter().any(|pattern| {
            pattern.framework == "node_http" && pattern.node_major == 24 && pattern_passes(pattern)
        })
        && compatibility.warm_run_seconds >= 60
        && compatibility.p95_startup_ms <= 5_000
        && compatibility.baseline_samples > 0
        && compatibility.sandbox_samples > 0
        && compatibility.baseline_samples as usize == benchmark.baseline_request_samples_ms.len()
        && compatibility.sandbox_samples as usize == benchmark.sandbox_request_samples_ms.len()
        && !benchmark.startup_samples_ms.is_empty()
        && benchmark.baseline_cpu_usec > 0
        && benchmark.sandbox_cpu_usec > 0
        && benchmark.baseline_peak_memory_bytes > 0
        && benchmark.sandbox_peak_memory_bytes > 0
        && benchmark.baseline_request_samples_ms.len() <= 10_000
        && benchmark.sandbox_request_samples_ms.len() <= 10_000
        && benchmark.startup_samples_ms.len() <= 1_000
        && finite_positive(compatibility.baseline_p95_request_ms)
        && finite_positive(compatibility.sandbox_p95_request_ms)
        && approximately_equal(
            compatibility.baseline_p95_request_ms,
            percentile_95(&benchmark.baseline_request_samples_ms),
        )
        && approximately_equal(
            compatibility.sandbox_p95_request_ms,
            percentile_95(&benchmark.sandbox_request_samples_ms),
        )
        && compatibility.p95_startup_ms
            == percentile_95_u32(&benchmark.startup_samples_ms).unwrap_or(u32::MAX)
        && compatibility.sandbox_p95_request_ms
            <= (2.0 * compatibility.baseline_p95_request_ms)
                .max(compatibility.baseline_p95_request_ms + 25.0)
        && finite_positive(compatibility.baseline_throughput_rps)
        && finite_positive(compatibility.sandbox_throughput_rps)
        && performance_assessment_matches(facts)
        && network.forbidden_total > 0
        && network.forbidden_passed == network.forbidden_total
        && network.allowed_total > 0
        && network.allowed_passed == network.allowed_total
        && network.independent_observation
        && resources.cpu_max == "25000 100000"
        && resources.memory_max_bytes == 536_870_912
        && resources.memory_swap_max_bytes == 0
        && resources.pids_max == 128
        && resources.scratch_max_bytes == 268_435_456
        && resources.max_connections == 128
        && resources.new_connections_per_second == 20
        && resources.new_connections_burst == 40
        && reasons.iter().all(|reason| {
            resources
                .enforced_reason_codes
                .iter()
                .any(|found| found == reason)
        })
        && resources.restart_delays_seconds == [1, 2, 4, 8, 16, 30]
        && resources.restart_limit == 6
        && resources.restart_window_seconds == 600
        && resources.healthy_reset_seconds == 600
        && !resources.idle_stop_observed
}

fn validate_executor_receipt(receipt: &ExecutorReceipt) -> Result<(), ApiError> {
    if receipt.schema != "hostlet.runtime.executor-receipt/v1"
        || receipt.profile != "evidence_gated_owned_fixture"
        || receipt.generation == 0
        || receipt.fence == 0
        || !matches!(receipt.platform.as_str(), "systrap" | "kvm")
        || !is_digest(&receipt.artifact_digest)
        || !is_digest(&receipt.runtime_binary_digest)
        || !is_digest(&receipt.policy_digest)
        || !receipt.capability_digest.as_deref().is_some_and(is_digest)
        || !matches!(receipt.result.as_str(), "passed" | "failed")
        || receipt.evaluation.is_some()
        || receipt.reason_code.is_empty()
        || receipt.reason_code.len() > 96
        || !matches!(
            receipt.reason_code.as_str(),
            "runtime_prepared"
                | "runtime_started"
                | "runtime_stopped"
                | "runtime_cleaned"
                | "runtime_exit"
                | "runtime_oom"
                | "cpu_throttled"
                | "process_limit_exceeded"
                | "scratch_limit_exceeded"
                | "network_connection_limit"
                | "health_failed"
                | "crash_loop_backoff"
                | "runtime_isolation_unverified"
                | "runtime_internal_failure"
                | "runtime_cleanup_incomplete"
        )
        || receipt.namespace_inodes.len() > 8
        || receipt.sandbox_id.as_ref().is_some_and(|value| {
            value.is_empty() || value.len() > 128 || value.chars().any(char::is_control)
        })
        || receipt
            .oci_config_digest
            .as_deref()
            .is_some_and(|value| !is_digest(value))
        || receipt
            .runsc_status
            .as_deref()
            .is_some_and(|value| !matches!(value, "created" | "running" | "stopped"))
        || receipt
            .health
            .as_ref()
            .is_some_and(|health| health.checks.len() > 32)
        || receipt.network.as_ref().is_some_and(|network| {
            network.counters.len() > 64
                || network
                    .rules_digest
                    .as_deref()
                    .is_some_and(|value| !is_digest(value))
                || network.counters.iter().any(|counter| {
                    counter.name.is_empty()
                        || counter.name.len() > 64
                        || counter.name.chars().any(char::is_control)
                })
        })
        || receipt
            .observed_limits
            .as_ref()
            .is_some_and(|limits| limits.cgroup_path.len() > 256)
        || receipt.scratch_observation.as_ref().is_some_and(|scratch| {
            scratch.capacity_bytes != 268_435_456
                || scratch.available_bytes > scratch.capacity_bytes
        })
        || (receipt.reason_code == "scratch_limit_exceeded"
            && receipt
                .scratch_observation
                .as_ref()
                .is_none_or(|scratch| scratch.available_bytes != 0))
        || receipt.health.as_ref().is_some_and(|health| {
            health.checks.iter().any(|check| {
                check.kind != "http"
                    || check.address.is_empty()
                    || check.address.len() > 128
                    || check.port == 0
                    || !safe_health_path(&check.path)
                    || check.reason_code.is_empty()
                    || check.reason_code.len() > 96
                    || (check.passed && check.status_code != Some(200))
            })
        })
    {
        return Err(ApiError::unprocessable(
            "runtime_receipt_invalid",
            "the runtime receipt does not match the supported schema",
        ));
    }
    Ok(())
}

fn validate_state_receipt(state: &str, receipt: &ExecutorReceipt) -> Result<(), ApiError> {
    let limits_match = receipt.observed_limits.as_ref().is_some_and(|limits| {
        limits.cpu_max == "25000 100000"
            && limits.memory_max_bytes == 536_870_912
            && limits.memory_swap_max_bytes == 0
            && limits.pids_max == 128
    });
    let namespace_proof = receipt.namespace_inodes.len() >= 2
        && receipt.network.as_ref().is_some_and(|network| {
            network.rules_digest.as_deref().is_some_and(is_digest)
                && network.application_namespace_inode.is_some()
                && network.gateway_namespace_inode.is_some()
        });
    let valid = match state {
        "running" => {
            matches!(
                receipt.operation.as_str(),
                "start" | "inspect" | "reconcile"
            ) && receipt.status == "running"
                && receipt.runsc_status.as_deref() == Some("running")
                && limits_match
                && namespace_proof
                && receipt.health.as_ref().is_none_or(|h| !h.passing)
        }
        "healthy" => {
            matches!(receipt.operation.as_str(), "inspect" | "reconcile")
                && receipt.status == "running"
                && receipt.result == "passed"
                && receipt.runsc_status.as_deref() == Some("running")
                && limits_match
                && namespace_proof
                && receipt.health.as_ref().is_some_and(|h| {
                    h.passing && !h.checks.is_empty() && h.checks.iter().all(|check| check.passed)
                })
        }
        "backoff" => {
            matches!(
                receipt.operation.as_str(),
                "record_exit" | "inspect" | "reconcile"
            ) && limits_match
                && namespace_proof
                && matches!(
                    receipt.status.as_str(),
                    "restart_scheduled" | "crash_loop_backoff"
                )
        }
        "stopped" => {
            matches!(receipt.operation.as_str(), "stop" | "record_exit")
                && receipt.status == "stopped"
        }
        "cleaned" => {
            receipt.operation == "cleanup"
                && receipt.status == "cleaned"
                && receipt.result == "passed"
                && receipt.cleanup.as_ref().is_some_and(|cleanup| {
                    cleanup.sandbox_absent
                        && cleanup.application_namespace_absent
                        && cleanup.gateway_namespace_absent
                        && cleanup.cgroup_absent
                        && cleanup.mounts_absent
                        && !cleanup.state_retained
                })
        }
        _ => false,
    };
    if !valid {
        return Err(ApiError::conflict(
            "runtime_observation_mismatch",
            "the requested lifecycle state does not match the executor receipt",
        ));
    }
    Ok(())
}

fn transition_allowed(from: &str, to: &str) -> bool {
    matches!(
        (from, to),
        ("allocated", "running")
            | ("allocated", "backoff")
            | ("allocated", "stopped")
            | ("running", "running")
            | ("running", "healthy")
            | ("running", "backoff")
            | ("running", "stopped")
            | ("healthy", "healthy")
            | ("healthy", "backoff")
            | ("healthy", "stopped")
            | ("backoff", "backoff")
            | ("backoff", "running")
            | ("backoff", "healthy")
            | ("backoff", "stopped")
            | ("stopped", "stopped")
            | ("stopped", "cleaned")
            | ("cleaned", "cleaned")
    )
}

async fn load_exact_allocation(
    tx: &mut Transaction<'_, Postgres>,
    candidate: &AllocationCandidate,
    evaluation_id: Uuid,
) -> Result<Option<LockedAllocation>, ApiError> {
    Ok(sqlx::query_as(
        "SELECT id,account_id,project_id,deployment_id,service_id,generation,fence,state,artifact_digest, \
                artifact_manifest_digest,source_commit,configuration_revision_id,build_profile_digest, \
                runtime_binary_digest,policy_digest,capability_digest,platform,profile,argv, \
                application_port,health_port,health_path \
         FROM runtime_allocations WHERE artifact_id=$1 AND evaluation_id=$2",
    )
    .bind(candidate.artifact_id)
    .bind(evaluation_id)
    .fetch_optional(&mut **tx)
    .await?)
}

fn allocation_response(row: LockedAllocation) -> Result<AllocationResponse, ApiError> {
    let argv = serde_json::from_value(row.argv).map_err(|_| ApiError::foundation_unavailable())?;
    Ok(AllocationResponse {
        id: row.id,
        account_id: row.account_id,
        project_id: row.project_id,
        deployment_id: row.deployment_id,
        service_id: row.service_id,
        generation: row.generation,
        fence: row.fence,
        state: row.state,
        artifact_digest: row.artifact_digest,
        artifact_manifest_digest: row.artifact_manifest_digest,
        source_commit: row.source_commit,
        configuration_revision_id: row.configuration_revision_id,
        build_profile_digest: row.build_profile_digest,
        runtime_binary_digest: row.runtime_binary_digest,
        platform: row.platform,
        profile: row.profile,
        executor_profile: "evidence_gated_owned_fixture",
        argv,
        application_port: row.application_port,
        health_port: row.health_port,
        health_path: row.health_path,
        capability_digest: row.capability_digest,
        policy: runtime_policy(),
    })
}

fn pattern_matches(pattern: &PatternFacts, candidate: &AllocationCandidate) -> bool {
    pattern_passes(pattern)
        && pattern.artifact_digest == candidate.archive_digest
        && pattern.manifest_digest == candidate.manifest_digest
        && pattern.build_profile_digest == candidate.build_profile_digest
        && pattern.source_commit == candidate.source_commit
        && pattern.framework == candidate.framework
        && pattern.node_major == candidate.node_major
}

fn pattern_well_formed(pattern: &PatternFacts) -> bool {
    matches!(
        pattern.framework.as_str(),
        "node_http" | "nextjs16_standalone"
    ) && matches!(pattern.node_major, 22 | 24)
        && is_digest(&pattern.artifact_digest)
        && is_digest(&pattern.manifest_digest)
        && is_digest(&pattern.build_profile_digest)
        && is_commit(&pattern.source_commit)
        && pattern.assertions_total > 0
        && pattern.cold_starts_total > 0
        && pattern.cold_starts_total as usize == pattern.cold_start_ms.len()
        && pattern.cold_start_ms.len() <= 100
}

fn pattern_passes(pattern: &PatternFacts) -> bool {
    pattern_well_formed(pattern)
        && pattern.assertions_passed == pattern.assertions_total
        && pattern.cold_starts_total >= 3
        && pattern.cold_starts_healthy == pattern.cold_starts_total
        && pattern
            .cold_start_ms
            .iter()
            .all(|milliseconds| *milliseconds <= 10_000)
        && pattern.warm_idle_seconds >= 60
}

fn safe_health_path(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.starts_with('/')
        && !value.contains(['?', '#'])
        && !value.chars().any(char::is_control)
}

fn runtime_profile(pattern: &PatternFacts) -> Result<&'static str, ApiError> {
    match (pattern.framework.as_str(), pattern.node_major) {
        ("node_http", 22) => Ok("node22-http-v1"),
        ("node_http", 24) => Ok("node24-http-v1"),
        ("nextjs16_standalone", 22) => Ok("nextjs16-node22-v1"),
        ("nextjs16_standalone", 24) => Ok("nextjs16-node24-v1"),
        _ => Err(allocation_ineligible()),
    }
}

fn artifact_argv(framework: &str, value: Value) -> Result<Vec<String>, ApiError> {
    let argv: Vec<String> = serde_json::from_value(value).map_err(|_| allocation_ineligible())?;
    let expected: &[&str] = match framework {
        "node_http" => &["node", "dist/server.mjs"],
        "nextjs16_standalone" => &["node", "server.js"],
        _ => return Err(allocation_ineligible()),
    };
    if argv.len() != expected.len()
        || !argv
            .iter()
            .zip(expected)
            .all(|(actual, expected)| actual == expected)
    {
        return Err(allocation_ineligible());
    }
    Ok(argv)
}

fn runtime_policy() -> RuntimePolicy {
    RuntimePolicy {
        schema: "hostlet.runtime.policy/v1",
        digest: runtime_policy_digest(),
        memory_bytes: 536_870_912,
        memory_swap_bytes: 0,
        cpu_quota_micros: 25_000,
        cpu_period_micros: 100_000,
        pids: 128,
        scratch_bytes: 268_435_456,
        max_connections: 128,
        new_connections_per_second: 20,
        new_connections_burst: 40,
        restart_delays_seconds: [1, 2, 4, 8, 16, 30],
        restart_limit: 6,
        restart_window_seconds: 600,
        healthy_reset_seconds: 600,
    }
}

fn runtime_policy_digest() -> String {
    format!(
        "sha256:{}",
        hex_encode(&Sha256::digest(RUNTIME_POLICY_DOCUMENT.as_bytes()))
    )
}

fn capability_digest(evidence_digest: &str, receipt: &EvaluationReceipt) -> String {
    let input = format!(
        "hostlet.runtime.capability/v1\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n",
        evidence_digest,
        receipt.allocation_id,
        receipt.generation,
        receipt.fence,
        receipt.runtime_binary_digest,
        receipt.policy_digest,
        receipt.platform
    );
    format!("sha256:{}", hex_encode(&Sha256::digest(input.as_bytes())))
}

fn receipt_time(unix_ms: i64) -> Result<DateTime<Utc>, ApiError> {
    Utc.timestamp_millis_opt(unix_ms)
        .single()
        .ok_or_else(evidence_invalid)
}

fn digest_hex(value: &str) -> Result<String, ApiError> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return Err(evidence_invalid());
    };
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(evidence_invalid());
    }
    Ok(hex.to_owned())
}

fn decode_hex(value: &str) -> Result<Vec<u8>, ApiError> {
    (0..value.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&value[index..index + 2], 16).map_err(|_| evidence_invalid())
        })
        .collect()
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn is_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

fn is_commit(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn finite_positive(value: f64) -> bool {
    value.is_finite() && value > 0.0
}

fn percentile_95(values: &[f64]) -> f64 {
    if values.is_empty() || values.iter().any(|value| !finite_positive(*value)) {
        return f64::NAN;
    }
    let mut ordered = values.to_vec();
    ordered.sort_by(f64::total_cmp);
    ordered[((ordered.len() * 95).div_ceil(100)).saturating_sub(1)]
}

fn percentile_95_u32(values: &[u32]) -> Option<u32> {
    if values.is_empty() {
        return None;
    }
    let mut ordered = values.to_vec();
    ordered.sort_unstable();
    Some(ordered[((ordered.len() * 95).div_ceil(100)).saturating_sub(1)])
}

fn approximately_equal(left: f64, right: f64) -> bool {
    left.is_finite() && right.is_finite() && (left - right).abs() <= 0.001
}

fn deserialize_zeroizing<'de, D>(deserializer: D) -> Result<Zeroizing<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    String::deserialize(deserializer).map(Zeroizing::new)
}

fn allocation_ineligible() -> ApiError {
    ApiError::conflict(
        "runtime_allocation_ineligible",
        "the exact admitted build and runtime evidence tuple is not eligible",
    )
}

fn runtime_fenced() -> ApiError {
    ApiError::conflict(
        "runtime_fence_stale",
        "the runtime allocation generation or fence is stale",
    )
}

fn restore_probe_ineligible() -> ApiError {
    ApiError::conflict(
        "runtime_restore_probe_ineligible",
        "the artifact, allocation, database generation, or validated recovery is ineligible",
    )
}

fn evidence_missing() -> ApiError {
    ApiError::unprocessable(
        "runtime_evidence_missing",
        "the digest-addressed runtime evidence file is unavailable",
    )
}

fn evidence_invalid() -> ApiError {
    ApiError::unprocessable(
        "runtime_evidence_invalid",
        "the runtime evidence file is invalid or unsafe",
    )
}
