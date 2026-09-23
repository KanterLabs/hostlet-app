//! Fenced, evidence-gated coordinated releases for owned M3 fixtures.
//!
//! An owner can stage exact durable intent, but only the runtime worker can
//! prepare and activate a route.  Preparation validates digest-addressed
//! runtime probes. Activation requires a second digest-addressed receipt from
//! the gateway switch, so a caller cannot manufacture a healthy release.

use std::{
    collections::{HashMap, HashSet},
    fs::File,
    io::Read,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::PathBuf,
};

use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
};
use chrono::{DateTime, Duration, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, Postgres, Transaction};
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::{
    auth::Authenticated,
    error::{ApiError, SafeJson},
    foundation::FoundationState,
    intent::{self, Replay},
    m3::{self, RuntimeWorkerAuth},
    tenant_databases::{
        CrossVersionProbeReceipt, MaterializedMigrationTrial, MigrationArtifact,
        MigrationProbeReceipt, MigrationRuntimeValidation, MigrationTrialRequest,
        enqueue_materialized_migration_trial, enqueue_migration_trial,
        record_migration_runtime_validation, request_pre_migration_backup,
        resolve_runtime_credential, verified_migration_gate,
    },
};

const MAX_RECEIPT_BYTES: u64 = 512 * 1024;
const DRAIN_SECONDS: i64 = 30;
const MAX_ATTEMPTS: i32 = 6;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StageReleaseRequest {
    build_job_id: Uuid,
    runtime_allocation_id: Option<Uuid>,
    tenant_database_id: Option<Uuid>,
    database_generation: Option<Uuid>,
    migration_revision: Option<String>,
    migration_digest: Option<String>,
    migration_artifact_path: Option<String>,
    managed_demo_url: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub(crate) struct ReleaseRecord {
    pub id: Uuid,
    pub project_id: Uuid,
    pub deployment_id: Uuid,
    pub configuration_revision_id: Uuid,
    pub build_job_id: Uuid,
    pub source_commit: String,
    pub frontend_digest: Option<String>,
    pub backend_digest: Option<String>,
    pub tenant_database_id: Option<Uuid>,
    pub database_generation: Option<Uuid>,
    pub migration_revision: Option<String>,
    pub migration_digest: Option<String>,
    pub migration_artifact_path: Option<String>,
    pub migration_id: Option<Uuid>,
    pub runtime_allocation_id: Option<Uuid>,
    pub runtime_service_id: Option<Uuid>,
    pub runtime_generation: Option<i64>,
    pub runtime_fence: Option<i64>,
    pub staged_health_observation_id: Option<Uuid>,
    pub staged_health_receipt_digest: Option<String>,
    pub state: String,
    pub secret_version_refs: Value,
    pub health_results: Value,
    pub expected_route_generation: i64,
    pub managed_demo_url: Option<String>,
    pub promoted_at: Option<DateTime<Utc>>,
    pub failure_code: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
struct RouteRecord {
    project_id: Uuid,
    release_id: Uuid,
    generation: i64,
    availability: String,
    availability_observed_at: DateTime<Utc>,
    demo_access_revision: i64,
    route_manifest_digest: String,
    drain_expires_at: DateTime<Utc>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReleaseListResponse {
    current_route: Option<RouteRecord>,
    releases: Vec<ReleaseRecord>,
}

#[derive(Clone, Debug, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
struct ReconciliationRecord {
    id: Uuid,
    account_id: Uuid,
    project_id: Uuid,
    release_id: Uuid,
    kind: String,
    state: String,
    expected_route_generation: i64,
    requirements: Value,
    attempt_count: i32,
    current_attempt_id: Option<Uuid>,
    current_fence: i64,
    lease_expires_at: Option<DateTime<Utc>>,
    terminal_code: Option<String>,
    result: Option<Value>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReconciliationEnvelope {
    release: ReleaseRecord,
    reconciliation: ReconciliationRecord,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyRequest {}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LeaseRequest {
    worker_id: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct LeaseIdentity {
    worker_id: String,
    attempt_id: Uuid,
    fence: i64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct AttemptLease {
    id: Uuid,
    attempt_number: i32,
    fence: i64,
    worker_id: String,
    lease_expires_at: DateTime<Utc>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ArtifactLease {
    artifact_id: Uuid,
    archive_digest: String,
    manifest_digest: String,
}

#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
struct RuntimeLease {
    allocation_id: Uuid,
    service_id: Uuid,
    generation: i64,
    fence: i64,
    state: String,
    artifact_digest: String,
    artifact_manifest_digest: String,
    runtime_binary_digest: String,
    policy_digest: String,
    capability_digest: String,
    platform: String,
    profile: String,
    argv: Vec<String>,
    application_port: i32,
    health_port: i32,
    health_path: String,
}

async fn lease_reconciliation(
    State(state): State<FoundationState>,
    _: RuntimeWorkerAuth,
    SafeJson(request): SafeJson<LeaseRequest>,
) -> Result<impl IntoResponse, ApiError> {
    m3::require_enabled(&state)?;
    validate_worker_id(&request.worker_id)?;
    let policy_now = m3::policy_now(&state).await?;
    let mut tx = state.pool.begin().await?;
    expire_reconciliations(&mut tx).await?;
    fail_migration_reconciliations(&mut tx).await?;
    let row: Option<ReconciliationRecord> = sqlx::query_as(
        "SELECT id,account_id,project_id,release_id,kind,state,expected_route_generation,requirements,attempt_count,current_attempt_id,current_fence,lease_expires_at,terminal_code,result,created_at,updated_at \
         FROM release_reconciliations r WHERE (r.state IN ('queued','retriable') AND r.attempt_count<$1) \
           OR (r.state='prepared' AND r.lease_expires_at<=clock_timestamp()) \
           OR (r.state='awaiting_trial' AND r.attempt_count<$1 AND EXISTS (\
             SELECT 1 FROM application_releases release JOIN tenant_database_migrations migration ON migration.id=release.migration_id \
             WHERE release.id=r.release_id AND migration.state='trial_prepared')) \
           OR (r.state='awaiting_live_apply' AND r.attempt_count<$1 AND EXISTS (\
             SELECT 1 FROM application_releases release JOIN tenant_database_migrations migration ON migration.id=release.migration_id \
             WHERE release.id=r.release_id AND migration.state='applied')) \
         ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1",
    )
    .bind(MAX_ATTEMPTS)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(mut reconciliation) = row else {
        tx.commit().await?;
        return Ok(StatusCode::NO_CONTENT.into_response());
    };
    let resume_prepared = reconciliation.state == "prepared";
    let post_trial = reconciliation.state == "awaiting_trial";
    let post_live_apply = reconciliation.state == "awaiting_live_apply";
    validate_route_generation(&mut tx, &reconciliation).await?;
    if resume_prepared {
        validate_prepared_route_intent(&reconciliation)?;
    }
    let candidate = load_release_lease(&mut tx, reconciliation.release_id, policy_now).await?;
    if candidate.release.state == "failed" || candidate.release.state == "retired" {
        return Err(ApiError::conflict(
            "release_reconciliation_ineligible",
            "the release is no longer eligible for reconciliation",
        ));
    }
    if reconciliation.kind == "rollback"
        && candidate.release.backend_digest.is_some()
        && candidate
            .runtime
            .as_ref()
            .is_none_or(|runtime| runtime.state != "healthy")
    {
        return Err(ApiError::conflict(
            "rollback_target_ineligible",
            "the retained release exact runtime allocation is not healthy",
        ));
    }
    validate_release_secrets(
        &mut tx,
        reconciliation.account_id,
        reconciliation.project_id,
        &candidate.release.secret_version_refs,
    )
    .await?;
    let (current, retained) = load_current_and_retained(
        &mut tx,
        reconciliation.account_id,
        reconciliation.project_id,
        reconciliation.release_id,
        policy_now,
    )
    .await?;
    let migration_state: Option<String> = if let Some(migration_id) = candidate.release.migration_id
    {
        sqlx::query_scalar("SELECT state FROM tenant_database_migrations WHERE id=$1")
            .bind(migration_id)
            .fetch_optional(&mut *tx)
            .await?
    } else {
        None
    };
    let phase = if resume_prepared {
        "prepared_switch"
    } else if post_live_apply {
        "post_live_apply"
    } else if post_trial || migration_state.as_deref() == Some("trial_prepared") {
        "isolated_validation"
    } else if migration_state.as_deref() == Some("planned") {
        "prepare_trial"
    } else {
        "standard"
    };
    let attempt_id = if resume_prepared {
        reconciliation
            .current_attempt_id
            .ok_or_else(ApiError::internal)?
    } else {
        Uuid::new_v4()
    };
    let attempt_number = if resume_prepared {
        reconciliation.attempt_count
    } else {
        reconciliation.attempt_count + 1
    };
    let fence = reconciliation.current_fence + 1;
    let required_probes = if matches!(phase, "prepare_trial") || resume_prepared {
        Vec::new()
    } else {
        required_probes(
            &candidate,
            current.as_ref(),
            &retained,
            &ProbePlanContext {
                tenant_database_id: candidate.release.tenant_database_id,
                database_generation: candidate.release.database_generation,
                migration_id: candidate.release.migration_id,
                phase: phase.to_owned(),
                reconciliation_id: reconciliation.id,
                attempt_id,
                release_fence: fence,
            },
        )?
    };
    let requirements = json!({
        "schema":"hostlet.release-reconciliation-requirements/v1",
        "required_probes":required_probes,
        "candidate_release_id":candidate.release.id,
        "current_release_id":current.as_ref().map(|r|r.release.id),
        "retained_release_ids":retained.iter().map(|r|r.release.id).collect::<Vec<_>>(),
        "policy_time":policy_now,
        "phase":phase,
    });
    let lease_expires_at: DateTime<Utc> =
        sqlx::query_scalar("SELECT clock_timestamp()+make_interval(secs=>$1)")
            .bind(state.worker_lease_seconds)
            .fetch_one(&mut *tx)
            .await?;
    if resume_prepared {
        sqlx::query(
            "UPDATE release_reconciliation_attempts SET fence=$3,worker_id=$4,state='running',lease_started_at=clock_timestamp(),\
             lease_expires_at=$5,finished_at=NULL,terminal_code=NULL,completion_hash=NULL WHERE reconciliation_id=$1 AND id=$2",
        )
        .bind(reconciliation.id)
        .bind(attempt_id)
        .bind(fence)
        .bind(&request.worker_id)
        .bind(lease_expires_at)
        .execute(&mut *tx)
        .await?;
    } else {
        sqlx::query(
            "INSERT INTO release_reconciliation_attempts \
             (id,account_id,project_id,release_id,reconciliation_id,attempt_number,fence,worker_id,state,lease_expires_at) \
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'running',$9)",
        )
        .bind(attempt_id)
        .bind(reconciliation.account_id)
        .bind(reconciliation.project_id)
        .bind(reconciliation.release_id)
        .bind(reconciliation.id)
        .bind(attempt_number)
        .bind(fence)
        .bind(&request.worker_id)
        .bind(lease_expires_at)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query(
        "UPDATE release_reconciliations SET state=$7,requirements=$2,attempt_count=$3,current_attempt_id=$4,current_fence=$5,lease_expires_at=$6,updated_at=clock_timestamp() WHERE id=$1",
    )
    .bind(reconciliation.id)
    .bind(&requirements)
    .bind(attempt_number)
    .bind(attempt_id)
    .bind(fence)
    .bind(lease_expires_at)
    .bind(if resume_prepared { "prepared" } else { "running" })
    .execute(&mut *tx)
    .await?;
    reconciliation.state = if resume_prepared {
        "prepared"
    } else {
        "running"
    }
    .to_owned();
    reconciliation.requirements = requirements;
    reconciliation.attempt_count = attempt_number;
    reconciliation.current_attempt_id = Some(attempt_id);
    reconciliation.current_fence = fence;
    reconciliation.lease_expires_at = Some(lease_expires_at);
    let response = ReconciliationLeaseResponse {
        reconciliation,
        attempt: AttemptLease {
            id: attempt_id,
            attempt_number,
            fence,
            worker_id: request.worker_id,
            lease_expires_at,
        },
        candidate: candidate.lease,
        current_release: current.map(|r| r.lease),
        retained_releases: retained.into_iter().map(|r| r.lease).collect(),
        required_probes,
        drain_seconds: DRAIN_SECONDS,
    };
    tx.commit().await?;
    Ok((StatusCode::OK, Json(response)).into_response())
}

async fn renew_reconciliation(
    State(state): State<FoundationState>,
    _: RuntimeWorkerAuth,
    Path(reconciliation_id): Path<String>,
    SafeJson(request): SafeJson<LeaseIdentity>,
) -> Result<Json<AttemptLease>, ApiError> {
    m3::require_enabled(&state)?;
    validate_worker_id(&request.worker_id)?;
    let reconciliation_id = intent::path_uuid(&reconciliation_id)?;
    let mut tx = state.pool.begin().await?;
    let renewed: Option<(i32, DateTime<Utc>)> = sqlx::query_as(
        "WITH locked AS (SELECT id FROM release_reconciliations WHERE id=$1 FOR UPDATE) \
         UPDATE release_reconciliations r SET lease_expires_at=clock_timestamp()+make_interval(secs=>$5),updated_at=clock_timestamp() \
         FROM release_reconciliation_attempts a WHERE r.id=(SELECT id FROM locked) AND r.id=a.reconciliation_id \
           AND r.state IN ('running','prepared') AND r.current_attempt_id=$2 AND r.current_fence=$3 \
           AND a.id=$2 AND a.fence=$3 AND a.worker_id=$4 AND a.state='running' \
           AND r.lease_expires_at>clock_timestamp() AND a.lease_expires_at>clock_timestamp() \
         RETURNING a.attempt_number,r.lease_expires_at",
    )
    .bind(reconciliation_id)
    .bind(request.attempt_id)
    .bind(request.fence)
    .bind(&request.worker_id)
    .bind(state.worker_lease_seconds)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((attempt_number, lease_expires_at)) = renewed else {
        return Err(fenced());
    };
    sqlx::query(
        "UPDATE release_reconciliation_attempts SET lease_expires_at=$4 WHERE reconciliation_id=$1 AND id=$2 AND fence=$3",
    )
    .bind(reconciliation_id)
    .bind(request.attempt_id)
    .bind(request.fence)
    .bind(lease_expires_at)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(AttemptLease {
        id: request.attempt_id,
        attempt_number,
        fence: request.fence,
        worker_id: request.worker_id,
        lease_expires_at,
    }))
}

async fn resolve_probe_credential(
    State(state): State<FoundationState>,
    _: RuntimeWorkerAuth,
    Path(reconciliation_id): Path<String>,
    SafeJson(request): SafeJson<ProbeCredentialRequest>,
) -> Result<Json<ProbeCredentialResponse>, ApiError> {
    m3::require_enabled(&state)?;
    validate_worker_id(&request.worker_id)?;
    if request.target != "isolated" {
        return Err(ApiError::unprocessable(
            "release_probe_target_invalid",
            "the probe credential target must be isolated",
        ));
    }
    let reconciliation_id = intent::path_uuid(&reconciliation_id)?;
    let mut tx = state.pool.begin().await?;
    let reconciliation = lock_live_reconciliation(
        &mut tx,
        reconciliation_id,
        request.attempt_id,
        request.fence,
        &request.worker_id,
        "running",
    )
    .await?;
    let phase = reconciliation
        .requirements
        .get("phase")
        .and_then(Value::as_str)
        .ok_or_else(fenced)?;
    if phase != "isolated_validation" {
        return Err(fenced());
    }
    let leased_probes: Vec<RequiredProbe> = serde_json::from_value(
        reconciliation
            .requirements
            .get("required_probes")
            .cloned()
            .ok_or_else(fenced)?,
    )
    .map_err(|_| fenced())?;
    let leased_probe = leased_probes.iter().find_map(|probe| match probe {
        RequiredProbe::Isolated(probe)
            if probe.probe_execution_id == request.probe_execution_id
                && probe.release_id == request.release_id
                && probe.target == request.target =>
        {
            Some(probe)
        }
        _ => None,
    });
    if leased_probe.is_none() {
        return Err(fenced());
    }
    let mut allowed = reconciliation
        .requirements
        .get("retained_release_ids")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter_map(|value| Uuid::parse_str(value).ok())
        .collect::<HashSet<_>>();
    if let Some(value) = reconciliation
        .requirements
        .get("candidate_release_id")
        .and_then(Value::as_str)
        .and_then(|value| Uuid::parse_str(value).ok())
    {
        allowed.insert(value);
    }
    if let Some(value) = reconciliation
        .requirements
        .get("current_release_id")
        .and_then(Value::as_str)
        .and_then(|value| Uuid::parse_str(value).ok())
    {
        allowed.insert(value);
    }
    if !allowed.contains(&request.release_id) {
        return Err(ApiError::not_found());
    }
    let target: Option<(Uuid, Uuid, Uuid, Value)> = sqlx::query_as(
        "SELECT release.tenant_database_id,release.database_generation,migration.id,migration.compatibility_evidence \
         FROM application_releases release CROSS JOIN application_releases candidate \
         JOIN tenant_database_migrations migration ON migration.id=candidate.migration_id \
         WHERE candidate.id=$1 AND release.id=$2 AND release.account_id=$3 AND release.project_id=$4 \
           AND candidate.account_id=release.account_id AND candidate.project_id=release.project_id",
    )
    .bind(reconciliation.release_id)
    .bind(request.release_id)
    .bind(reconciliation.account_id)
    .bind(reconciliation.project_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((database_id, database_generation, migration_id, evidence)) = target else {
        return Err(ApiError::not_found());
    };
    if let Some(probe) = leased_probe
        && (probe.tenant_database_id != database_id
            || probe.database_generation != database_generation
            || probe.migration_id != migration_id)
    {
        return Err(fenced());
    }
    tx.commit().await?;
    let key = state
        .secret_key
        .as_deref()
        .ok_or_else(ApiError::foundation_unavailable)?;
    let credential = resolve_runtime_credential(
        &state.pool,
        key,
        reconciliation.account_id,
        reconciliation.project_id,
        database_id,
        database_generation,
    )
    .await?;
    let replacement = evidence
        .get("replacement_identity")
        .and_then(Value::as_str)
        .and_then(|value| Uuid::parse_str(value).ok())
        .ok_or_else(|| {
            ApiError::conflict(
                "migration_trial_target_missing",
                "the prepared isolated database target is unavailable",
            )
        })?;
    if replacement != migration_id {
        return Err(ApiError::conflict(
            "migration_trial_target_mismatch",
            "the prepared isolated database identity does not match the migration",
        ));
    }
    let database_name = format!("hdr_{}", replacement.simple());
    Ok(Json(ProbeCredentialResponse {
        schema: "hostlet.runtime.probe-credential/v1".to_owned(),
        credential_id: credential.credential_id,
        probe_execution_id: request.probe_execution_id,
        reconciliation_id,
        attempt_id: request.attempt_id,
        release_fence: request.fence,
        release_id: request.release_id,
        target: request.target,
        tenant_database_id: database_id,
        database_generation,
        migration_id,
        database_name,
        role_name: credential.role_name,
        password: credential.value,
    }))
}

async fn complete_reconciliation(
    State(state): State<FoundationState>,
    _: RuntimeWorkerAuth,
    Path(reconciliation_id): Path<String>,
    SafeJson(request): SafeJson<CompleteRequest>,
) -> Result<Json<Value>, ApiError> {
    m3::require_enabled(&state)?;
    validate_worker_id(&request.worker_id)?;
    validate_completion(&request.outcome)?;
    let reconciliation_id = intent::path_uuid(&reconciliation_id)?;
    let mut tx = state.pool.begin().await?;
    let reconciliation = lock_live_reconciliation(
        &mut tx,
        reconciliation_id,
        request.attempt_id,
        request.fence,
        &request.worker_id,
        "running",
    )
    .await?;
    validate_route_generation(&mut tx, &reconciliation).await?;
    let completion_hash = intent::request_hash(&request.outcome)?;
    if request.outcome.state != "succeeded" {
        finish_unsuccessful(
            &mut tx,
            &reconciliation,
            request.attempt_id,
            request.fence,
            &request.outcome,
            &completion_hash,
        )
        .await?;
        let updated = load_reconciliation(&mut tx, reconciliation.id).await?;
        tx.commit().await?;
        return Ok(Json(json!({"reconciliation":updated})));
    }

    let policy_now = m3::policy_now(&state).await?;
    let candidate = load_release_lease(&mut tx, reconciliation.release_id, policy_now).await?;
    let (current, retained) = load_current_and_retained(
        &mut tx,
        reconciliation.account_id,
        reconciliation.project_id,
        reconciliation.release_id,
        policy_now,
    )
    .await?;
    let migration_state: Option<String> = if let Some(migration_id) = candidate.release.migration_id
    {
        sqlx::query_scalar("SELECT state FROM tenant_database_migrations WHERE id=$1")
            .bind(migration_id)
            .fetch_optional(&mut *tx)
            .await?
    } else {
        None
    };
    validate_release_secrets(
        &mut tx,
        reconciliation.account_id,
        reconciliation.project_id,
        &candidate.release.secret_version_refs,
    )
    .await?;
    let phase = reconciliation
        .requirements
        .get("phase")
        .and_then(Value::as_str)
        .unwrap_or("standard");
    if phase == "prepare_trial" {
        if !request.outcome.probe_receipt_digests.is_empty() {
            return Err(ApiError::unprocessable(
                "migration_stage_probe_unexpected",
                "migration materialization does not accept runtime probe receipts",
            ));
        }
        let migration_id = candidate
            .release
            .migration_id
            .ok_or_else(ApiError::internal)?;
        let materialized_ref = request
            .outcome
            .migration_materialized_ref
            .as_deref()
            .ok_or_else(|| {
                ApiError::unprocessable(
                    "migration_materialization_missing",
                    "the exact materialized migration reference is required",
                )
            })?;
        let stage_receipt_digest = request
            .outcome
            .migration_stage_receipt_digest
            .as_deref()
            .ok_or_else(|| {
                ApiError::unprocessable(
                    "migration_materialization_missing",
                    "the exact migration stage receipt is required",
                )
            })?;
        let stage_receipt: MigrationStageReceipt =
            serde_json::from_slice(&read_evidence(&state, stage_receipt_digest)?)
                .map_err(|_| evidence_invalid())?;
        let observed_at = Utc
            .timestamp_millis_opt(stage_receipt.observed_at_unix_ms)
            .single()
            .ok_or_else(evidence_invalid)?;
        if stage_receipt.schema != "hostlet.release-stage-receipt/v1"
            || stage_receipt.result != "staged"
            || stage_receipt.release_id != candidate.release.id
            || stage_receipt.project_id != candidate.release.project_id
            || stage_receipt.migration_materialized_ref != materialized_ref
            || observed_at > Utc::now() + Duration::minutes(5)
            || Utc::now() - observed_at > Duration::hours(1)
        {
            return Err(evidence_invalid());
        }
        let operation_id = enqueue_materialized_migration_trial(
            &mut tx,
            &MaterializedMigrationTrial {
                release_id: candidate.release.id,
                reconciliation_id: reconciliation.id,
                attempt_id: request.attempt_id,
                release_fence: request.fence,
                migration_id,
                materialized_ref: materialized_ref.to_owned(),
                stage_receipt_digest: stage_receipt_digest.to_owned(),
                policy_time: policy_now,
            },
        )
        .await?;
        sqlx::query(
            "UPDATE release_reconciliation_attempts SET state='succeeded',finished_at=clock_timestamp(),\
             terminal_code='migration_trial_materialized',completion_hash=$4 WHERE reconciliation_id=$1 AND id=$2 AND fence=$3 AND state='running'",
        )
        .bind(reconciliation.id)
        .bind(request.attempt_id)
        .bind(request.fence)
        .bind(&completion_hash)
        .execute(&mut *tx)
        .await?;
        let result = json!({"phase":"awaiting_trial","migration_operation_id":operation_id,
            "migration_materialized_ref":materialized_ref,"migration_stage_receipt_digest":stage_receipt_digest});
        sqlx::query(
            "UPDATE release_reconciliations SET state='awaiting_trial',terminal_code='migration_trial_materialized',\
             result=$2,current_attempt_id=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=$1",
        )
        .bind(reconciliation.id)
        .bind(&result)
        .execute(&mut *tx)
        .await?;
        let updated = load_reconciliation(&mut tx, reconciliation.id).await?;
        tx.commit().await?;
        return Ok(Json(
            json!({"state":"awaiting_trial","reconciliation":updated,
            "migration_operation_id":operation_id}),
        ));
    }
    let expected: Vec<RequiredProbe> = serde_json::from_value(
        reconciliation
            .requirements
            .get("required_probes")
            .cloned()
            .ok_or_else(fenced)?,
    )
    .map_err(|_| fenced())?;
    let receipts = validate_probe_receipts(
        &state,
        &expected,
        &request.outcome.probe_receipt_digests,
        reconciliation.id,
        request.attempt_id,
        request.fence,
    )?;
    let post_live_apply = phase == "post_live_apply";
    let applied_migration_rollback =
        reconciliation.kind == "rollback" && migration_state.as_deref() == Some("applied");
    if let Some(migration_id) = candidate.release.migration_id {
        let apply_digest = candidate
            .lease
            .isolated_apply_receipt_digest
            .as_deref()
            .ok_or_else(|| {
                ApiError::unprocessable(
                    "migration_apply_evidence_missing",
                    "the exact isolated migration apply receipt is unavailable",
                )
            })?;
        if request
            .outcome
            .migration_apply_receipt_digest
            .as_deref()
            .is_some_and(|value| value != apply_digest)
        {
            return Err(ApiError::conflict(
                "migration_apply_evidence_mismatch",
                "the completion does not match the server-selected isolated apply receipt",
            ));
        }
        read_evidence(&state, apply_digest)?;
        if !post_live_apply && !applied_migration_rollback {
            let validation = migration_validation(
                &candidate,
                current.as_ref(),
                &retained,
                &receipts,
                &MigrationValidationContext {
                    reconciliation_id: reconciliation.id,
                    attempt_id: request.attempt_id,
                    release_fence: request.fence,
                    migration_id,
                    apply_digest,
                },
            )?;
            let gate = record_migration_runtime_validation(&mut tx, &validation).await?;
            let operation_id = gate
                .live_apply_operation_id
                .ok_or_else(ApiError::internal)?;
            sqlx::query(
                "UPDATE release_reconciliation_attempts SET state='succeeded',finished_at=clock_timestamp(),\
                 terminal_code='isolated_validation_passed',completion_hash=$4 WHERE reconciliation_id=$1 AND id=$2 AND fence=$3 AND state='running'",
            )
            .bind(reconciliation.id)
            .bind(request.attempt_id)
            .bind(request.fence)
            .bind(&completion_hash)
            .execute(&mut *tx)
            .await?;
            let result = json!({
                "phase":"awaiting_live_apply",
                "migration_operation_id":operation_id,
                "isolated_probe_receipt_digests":request.outcome.probe_receipt_digests,
                "isolated_apply_receipt_digest":apply_digest,
            });
            sqlx::query(
                "UPDATE release_reconciliations SET state='awaiting_live_apply',terminal_code='isolated_validation_passed',\
                 result=$2,current_attempt_id=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=$1",
            )
            .bind(reconciliation.id)
            .bind(&result)
            .execute(&mut *tx)
            .await?;
            let updated = load_reconciliation(&mut tx, reconciliation.id).await?;
            tx.commit().await?;
            return Ok(Json(json!({
                "state":"awaiting_live_apply",
                "reconciliation":updated,
                "migration_operation_id":operation_id,
            })));
        }
        let gate = verified_migration_gate(
            &state.pool,
            reconciliation.account_id,
            reconciliation.project_id,
            candidate
                .release
                .tenant_database_id
                .ok_or_else(ApiError::internal)?,
            candidate
                .release
                .database_generation
                .ok_or_else(ApiError::internal)?,
            candidate.release.deployment_id,
            candidate
                .release
                .migration_revision
                .as_deref()
                .ok_or_else(ApiError::internal)?,
            candidate
                .release
                .migration_digest
                .as_deref()
                .ok_or_else(ApiError::internal)?,
            policy_now,
        )
        .await?;
        if gate.migration_id != migration_id
            || gate.once_effect_id.is_none()
            || (applied_migration_rollback && gate.live_apply_operation_id != gate.once_effect_id)
        {
            return Err(ApiError::conflict(
                "migration_live_apply_pending",
                "the controlled live migration has not completed successfully",
            ));
        }
    } else if request.outcome.migration_apply_receipt_digest.is_some() {
        return Err(ApiError::unprocessable(
            "unexpected_migration_evidence",
            "migration evidence was supplied for a release without a migration",
        ));
    }
    let route_generation = reconciliation.expected_route_generation + 1;
    let drain_expires_at = Utc::now() + Duration::seconds(DRAIN_SECONDS);
    let manifest = route_manifest(
        &candidate,
        current.as_ref(),
        &retained,
        route_generation,
        drain_expires_at,
    );
    let manifest_bytes = serde_json::to_vec(&manifest).map_err(|_| ApiError::internal())?;
    let manifest_json =
        String::from_utf8(manifest_bytes.clone()).map_err(|_| ApiError::internal())?;
    let manifest_digest = prefixed_digest(&manifest_bytes);
    let result = json!({
        "route_manifest":manifest,
        "route_manifest_json":manifest_json,
        "route_manifest_digest":manifest_digest,
        "route_generation":route_generation,
        "drain_expires_at":drain_expires_at,
        "probe_receipt_digests":request.outcome.probe_receipt_digests,
    });
    sqlx::query(
        "UPDATE release_reconciliations SET state='prepared',terminal_code=$2,result=$3,updated_at=clock_timestamp() WHERE id=$1",
    )
    .bind(reconciliation.id)
    .bind(&request.outcome.code)
    .bind(&result)
    .execute(&mut *tx)
    .await?;
    let updated = load_reconciliation(&mut tx, reconciliation.id).await?;
    tx.commit().await?;
    Ok(Json(
        serde_json::to_value(PreparedResponse {
            reconciliation: updated,
            route_manifest: result["route_manifest"].clone(),
            route_manifest_json: result["route_manifest_json"]
                .as_str()
                .ok_or_else(ApiError::internal)?
                .to_owned(),
            route_manifest_digest: manifest_digest,
            route_generation,
            drain_expires_at,
        })
        .map_err(|_| ApiError::internal())?,
    ))
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReleaseLease {
    release_id: Uuid,
    project_id: Uuid,
    deployment_id: Uuid,
    configuration_revision_id: Uuid,
    build_job_id: Uuid,
    source_commit: String,
    frontend: Option<ArtifactLease>,
    backend: Option<ArtifactLease>,
    runtime: Option<RuntimeLease>,
    tenant_database_id: Option<Uuid>,
    database_generation: Option<Uuid>,
    migration_id: Option<Uuid>,
    migration_revision: Option<String>,
    migration_digest: Option<String>,
    migration_artifact_path: Option<String>,
    isolated_apply_receipt_digest: Option<String>,
    secret_version_refs: Value,
    staged_health_observation_id: Option<Uuid>,
    staged_health_receipt_digest: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PrepareMigrationRequest {
    build_job_id: Uuid,
    tenant_database_id: Uuid,
    database_generation: Uuid,
    migration_revision: String,
    migration_digest: String,
    migration_artifact_path: String,
    current_schema_revision: String,
    candidate_schema_revision: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PrepareMigrationResponse {
    phase: String,
    archive_id: Uuid,
    migration_id: Option<Uuid>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(untagged)]
enum RequiredProbe {
    Hosted(HostedRequiredProbe),
    Isolated(Box<IsolatedRequiredProbe>),
}

struct ProbePlanContext {
    tenant_database_id: Option<Uuid>,
    database_generation: Option<Uuid>,
    migration_id: Option<Uuid>,
    phase: String,
    reconciliation_id: Uuid,
    attempt_id: Uuid,
    release_fence: i64,
}

struct MigrationValidationContext<'a> {
    reconciliation_id: Uuid,
    attempt_id: Uuid,
    release_fence: i64,
    migration_id: Uuid,
    apply_digest: &'a str,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(deny_unknown_fields)]
struct HostedRequiredProbe {
    check_kind: String,
    release_id: Uuid,
    peer_release_id: Option<Uuid>,
    allocation_id: Uuid,
    generation: i64,
    fence: i64,
    artifact_digest: String,
    executor_receipt_digest: String,
    database_generation: Option<Uuid>,
    migration_id: Option<Uuid>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(deny_unknown_fields)]
struct IsolatedRequiredProbe {
    schema: String,
    probe_execution_id: Uuid,
    reconciliation_id: Uuid,
    attempt_id: Uuid,
    release_fence: i64,
    check_kind: String,
    release_id: Uuid,
    peer_release_id: Option<Uuid>,
    source_allocation_id: Uuid,
    source_generation: i64,
    source_fence: i64,
    artifact_digest: String,
    executor_template_receipt_digest: String,
    tenant_database_id: Uuid,
    database_generation: Uuid,
    migration_id: Uuid,
    target: String,
    executor: ProbeExecutorRequest,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(deny_unknown_fields)]
struct ProbeExecutorRequest {
    runtime_binary_digest: String,
    policy_digest: String,
    capability_digest: String,
    platform: String,
    profile: String,
    argv: Vec<String>,
    application_port: i32,
    health_port: i32,
    health_path: String,
}

#[derive(Serialize)]
#[serde(deny_unknown_fields)]
struct ReconciliationLeaseResponse {
    reconciliation: ReconciliationRecord,
    attempt: AttemptLease,
    candidate: ReleaseLease,
    current_release: Option<ReleaseLease>,
    retained_releases: Vec<ReleaseLease>,
    required_probes: Vec<RequiredProbe>,
    drain_seconds: i64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CompletionOutcome {
    state: String,
    code: String,
    probe_receipt_digests: Vec<String>,
    migration_apply_receipt_digest: Option<String>,
    migration_materialized_ref: Option<String>,
    migration_stage_receipt_digest: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CompleteRequest {
    worker_id: String,
    attempt_id: Uuid,
    fence: i64,
    outcome: CompletionOutcome,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PreparedResponse {
    reconciliation: ReconciliationRecord,
    route_manifest: Value,
    route_manifest_json: String,
    route_manifest_digest: String,
    route_generation: i64,
    drain_expires_at: DateTime<Utc>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ActivateRequest {
    worker_id: String,
    attempt_id: Uuid,
    fence: i64,
    switch_receipt_digest: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProbeCredentialRequest {
    worker_id: String,
    attempt_id: Uuid,
    fence: i64,
    probe_execution_id: Uuid,
    release_id: Uuid,
    target: String,
}

#[derive(Serialize)]
#[serde(deny_unknown_fields)]
struct ProbeCredentialResponse {
    schema: String,
    credential_id: Uuid,
    probe_execution_id: Uuid,
    reconciliation_id: Uuid,
    attempt_id: Uuid,
    release_fence: i64,
    release_id: Uuid,
    target: String,
    tenant_database_id: Uuid,
    database_generation: Uuid,
    migration_id: Uuid,
    database_name: String,
    role_name: String,
    #[serde(serialize_with = "serialize_zeroizing")]
    password: Zeroizing<String>,
}

#[derive(Serialize)]
#[serde(deny_unknown_fields)]
struct ActivateResponse {
    release: ReleaseRecord,
    reconciliation: ReconciliationRecord,
    route: RouteRecord,
    retired_release_ids: Vec<Uuid>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProbeReceipt {
    schema: String,
    check_kind: String,
    release_id: Uuid,
    peer_release_id: Option<Uuid>,
    allocation_id: Uuid,
    generation: u64,
    fence: u64,
    artifact_digest: String,
    database_generation: Option<Uuid>,
    migration_id: Option<Uuid>,
    executor_receipt_digest: String,
    result: String,
    reason_code: String,
    observed_at_unix_ms: i64,
    http: ProbeHttp,
    assertions: Vec<ProbeAssertion>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IsolatedProbeReceipt {
    schema: String,
    probe_execution_id: Uuid,
    reconciliation_id: Uuid,
    attempt_id: Uuid,
    release_fence: u64,
    check_kind: String,
    release_id: Uuid,
    peer_release_id: Option<Uuid>,
    source_allocation_id: Uuid,
    source_generation: u64,
    source_fence: u64,
    artifact_digest: String,
    database_generation: Uuid,
    migration_id: Uuid,
    target: String,
    executor_receipt_digest: String,
    application_probe_receipt_digest: String,
    cleanup_receipt_digest: String,
    result: String,
    reason_code: String,
    observed_at_unix_ms: i64,
    assertions: Vec<IsolatedAssertion>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IsolatedAssertion {
    name: String,
    passed: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ApplicationProbeReceipt {
    schema: String,
    probe_execution_id: Uuid,
    allocation_id: Uuid,
    generation: u64,
    fence: u64,
    artifact_digest: String,
    database_generation: Uuid,
    migration_id: Uuid,
    check_kind: String,
    target: String,
    result: String,
    reason_code: String,
    observed_at_unix_ms: i64,
    http: ApplicationProbeHttp,
    assertions: Vec<IsolatedAssertion>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ApplicationProbeHttp {
    write_status_code: Option<u16>,
    read_status_code: Option<u16>,
    response_sha256: Option<String>,
    elapsed_ms: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProbeHttp {
    method: String,
    path: String,
    safe_status_code: Option<u16>,
    response_sha256: Option<String>,
    elapsed_ms: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProbeAssertion {
    name: String,
    passed: bool,
    observed_sha256: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SwitchReceipt {
    schema: String,
    reconciliation_id: Uuid,
    attempt_id: Uuid,
    fence: u64,
    project_id: Uuid,
    release_id: Uuid,
    previous_release_id: Option<Uuid>,
    route_generation: u64,
    route_manifest_digest: String,
    result: String,
    observed_at_unix_ms: i64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MigrationStageReceipt {
    schema: String,
    result: String,
    release_id: Uuid,
    project_id: Uuid,
    #[serde(rename = "frontend")]
    _frontend: Option<Value>,
    migration_materialized_ref: String,
    observed_at_unix_ms: i64,
}

pub(crate) fn routes() -> Router<FoundationState> {
    Router::new()
        .route(
            "/v1/projects/{project_id}/deployments/{deployment_id}/releases",
            post(stage_release),
        )
        .route(
            "/v1/projects/{project_id}/deployments/{deployment_id}/migration-trial",
            post(prepare_migration_trial),
        )
        .route("/v1/projects/{project_id}/releases", get(list_releases))
        .route(
            "/v1/projects/{project_id}/releases/{release_id}/rollback",
            post(request_rollback),
        )
}

pub(crate) fn internal_routes() -> Router<FoundationState> {
    Router::new()
        .route(
            "/internal/v1/release-reconciliations/lease",
            post(lease_reconciliation),
        )
        .route(
            "/internal/v1/release-reconciliations/{reconciliation_id}/renew",
            post(renew_reconciliation),
        )
        .route(
            "/internal/v1/release-reconciliations/{reconciliation_id}/complete",
            post(complete_reconciliation),
        )
        .route(
            "/internal/v1/release-reconciliations/{reconciliation_id}/probe-credential",
            post(resolve_probe_credential),
        )
        .route(
            "/internal/v1/release-reconciliations/{reconciliation_id}/activate",
            post(activate_reconciliation),
        )
}

async fn prepare_migration_trial(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    Path((project_id, deployment_id)): Path<(String, String)>,
    headers: HeaderMap,
    SafeJson(request): SafeJson<PrepareMigrationRequest>,
) -> Result<(StatusCode, Json<PrepareMigrationResponse>), ApiError> {
    m3::require_enabled(&state)?;
    let account_id = authenticated.account_id()?;
    let project_id = intent::path_uuid(&project_id)?;
    let deployment_id = intent::path_uuid(&deployment_id)?;
    let key = intent::idempotency_key(&headers)?;
    let hash = intent::request_hash(&request)?;
    if request.migration_revision.is_empty()
        || request.migration_revision.len() > 256
        || !is_digest(&request.migration_digest)
        || !valid_migration_path(&request.migration_artifact_path)
        || request.current_schema_revision.is_empty()
        || request.current_schema_revision.len() > 256
        || request.candidate_schema_revision.is_empty()
        || request.candidate_schema_revision.len() > 256
    {
        return Err(ApiError::unprocessable(
            "migration_trial_request_invalid",
            "the exact migration and schema revision references are required",
        ));
    }
    let operation = format!("release.migration_trial/{project_id}/{deployment_id}");
    let mut tx = state.pool.begin().await?;
    intent::acquire_operation_lock(&mut tx, account_id, &operation, key).await?;
    match intent::replay(&mut tx, account_id, &operation, key, &hash).await? {
        Replay::Match(response) => {
            tx.commit().await?;
            return Ok((StatusCode::OK, Json(response)));
        }
        Replay::Changed => return Err(idempotency_changed()),
        Replay::Miss => {}
    }
    let candidate: Option<(Uuid, Uuid, Uuid, String, String)> = sqlx::query_as(
        "SELECT j.configuration_revision_id,a.id,a.service_id,a.archive_digest,a.manifest_digest FROM build_jobs j JOIN build_artifacts a ON a.job_id=j.id \
         WHERE j.id=$1 AND j.account_id=$2 AND j.project_id=$3 AND j.deployment_id=$4 AND j.state='succeeded' \
           AND a.account_id=j.account_id AND a.project_id=j.project_id AND a.kind='application' AND a.cas_state='registered'",
    )
    .bind(request.build_job_id)
    .bind(account_id)
    .bind(project_id)
    .bind(deployment_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((configuration_revision_id, artifact_id, service_id, archive_digest, manifest_digest)) =
        candidate
    else {
        return Err(ApiError::conflict(
            "migration_candidate_ineligible",
            "the exact succeeded application artifact is unavailable",
        ));
    };
    let database_owned: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM tenant_databases WHERE account_id=$1 AND project_id=$2 AND id=$3 AND generation=$4 \
          AND state IN ('ready','recovery_attention'))",
    )
    .bind(account_id)
    .bind(project_id)
    .bind(request.tenant_database_id)
    .bind(request.database_generation)
    .fetch_one(&mut *tx)
    .await?;
    if !database_owned {
        return Err(ApiError::not_found());
    }
    let retained: Vec<String> = sqlx::query_scalar(
        "SELECT r.backend_digest FROM application_releases r WHERE r.account_id=$1 AND r.project_id=$2 AND r.state='healthy' \
          AND r.backend_digest IS NOT NULL AND r.promoted_at IS NOT NULL \
          AND NOT EXISTS(SELECT 1 FROM project_release_routes route WHERE route.account_id=r.account_id \
            AND route.project_id=r.project_id AND route.release_id=r.id) \
          ORDER BY r.promoted_at DESC,r.id DESC LIMIT 2",
    )
    .bind(account_id)
    .bind(project_id)
    .fetch_all(&mut *tx)
    .await?;
    let current_binary_digest: Option<String> = sqlx::query_scalar(
        "SELECT r.backend_digest FROM project_release_routes route JOIN application_releases r ON r.id=route.release_id \
          AND r.account_id=route.account_id AND r.project_id=route.project_id WHERE route.account_id=$1 AND route.project_id=$2",
    )
    .bind(account_id)
    .bind(project_id)
    .fetch_optional(&mut *tx)
    .await?
    .flatten();
    let current_binary_digest = current_binary_digest.ok_or_else(|| {
        ApiError::conflict(
            "migration_current_binary_missing",
            "a populated migration requires a current routed application binary",
        )
    })?;
    tx.commit().await?;

    let archive_id = request_pre_migration_backup(
        &state,
        account_id,
        project_id,
        request.tenant_database_id,
        request.database_generation,
        &request.migration_revision,
    )
    .await?;
    let archive_usable: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM tenant_database_archives WHERE account_id=$1 AND project_id=$2 AND id=$3 \
          AND tenant_database_id=$4 AND database_generation=$5 AND state='usable')",
    )
    .bind(account_id)
    .bind(project_id)
    .bind(archive_id)
    .bind(request.tenant_database_id)
    .bind(request.database_generation)
    .fetch_one(&state.pool)
    .await?;
    let (status, response) = if archive_usable {
        let migration_id = enqueue_migration_trial(
            &state,
            MigrationTrialRequest {
                account_id,
                project_id,
                tenant_database_id: request.tenant_database_id,
                database_generation: request.database_generation,
                deployment_id,
                configuration_revision_id,
                migration_revision: request.migration_revision.clone(),
                migration_digest: request.migration_digest.clone(),
                current_schema_revision: request.current_schema_revision.clone(),
                candidate_schema_revision: request.candidate_schema_revision.clone(),
                current_binary_digest,
                retained_binary_digests: retained,
                artifact: MigrationArtifact {
                    build_job_id: request.build_job_id,
                    artifact_id,
                    service_id,
                    application_archive_digest: archive_digest,
                    manifest_digest,
                    migration_entry_path: request.migration_artifact_path.clone(),
                    file_digest: request.migration_digest.clone(),
                },
            },
            archive_id,
        )
        .await?;
        (
            StatusCode::CREATED,
            PrepareMigrationResponse {
                phase: "migration_planned".to_owned(),
                archive_id,
                migration_id: Some(migration_id),
            },
        )
    } else {
        (
            StatusCode::ACCEPTED,
            PrepareMigrationResponse {
                phase: "pre_migration_backup_queued".to_owned(),
                archive_id,
                migration_id: None,
            },
        )
    };
    let mut tx = state.pool.begin().await?;
    intent::acquire_operation_lock(&mut tx, account_id, &operation, key).await?;
    intent::store_replay(
        &mut tx,
        account_id,
        &operation,
        key,
        &hash,
        status.as_u16() as i16,
        &response,
    )
    .await?;
    intent::audit(
        &mut tx,
        account_id,
        authenticated.session_id(),
        "release.migration_trial.prepare",
        "tenant_database_migration",
        response.migration_id,
        &response.phase,
    )
    .await?;
    tx.commit().await?;
    Ok((status, Json(response)))
}

async fn stage_release(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    Path((project_id, deployment_id)): Path<(String, String)>,
    headers: HeaderMap,
    SafeJson(request): SafeJson<StageReleaseRequest>,
) -> Result<(StatusCode, Json<ReconciliationEnvelope>), ApiError> {
    m3::require_enabled(&state)?;
    validate_stage_request(&request)?;
    let account_id = authenticated.account_id()?;
    let project_id = intent::path_uuid(&project_id)?;
    let deployment_id = intent::path_uuid(&deployment_id)?;
    let key = intent::idempotency_key(&headers)?;
    let request_hash = intent::request_hash(&request)?;
    let operation = format!("release.stage/{project_id}/{deployment_id}");
    let mut tx = state.pool.begin().await?;
    intent::acquire_operation_lock(&mut tx, account_id, &operation, key).await?;
    match intent::replay(&mut tx, account_id, &operation, key, &request_hash).await? {
        Replay::Match(response) => {
            tx.commit().await?;
            return Ok((StatusCode::OK, Json(response)));
        }
        Replay::Changed => return Err(idempotency_changed()),
        Replay::Miss => {}
    }

    let build: Option<(Uuid, String, Uuid, String)> = sqlx::query_as(
        "SELECT j.configuration_revision_id,j.source_commit,j.deployment_id,j.state \
         FROM build_jobs j WHERE j.id=$1 AND j.account_id=$2 AND j.project_id=$3 AND j.deployment_id=$4 FOR UPDATE",
    )
    .bind(request.build_job_id)
    .bind(account_id)
    .bind(project_id)
    .bind(deployment_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((configuration_revision_id, source_commit, _, build_state)) = build else {
        return Err(ApiError::not_found());
    };
    if build_state != "succeeded" {
        return Err(ApiError::conflict(
            "release_build_ineligible",
            "the exact build has not succeeded",
        ));
    }
    let secret_refs =
        load_build_secret_refs(&mut tx, account_id, project_id, request.build_job_id).await?;
    validate_secret_refs(&mut tx, account_id, project_id, &secret_refs).await?;

    let artifacts: Vec<(Uuid, String, String, String)> = sqlx::query_as(
        "SELECT id,kind,archive_digest,manifest_digest FROM build_artifacts \
         WHERE account_id=$1 AND project_id=$2 AND job_id=$3 AND cas_state='registered' ORDER BY kind",
    )
    .bind(account_id)
    .bind(project_id)
    .bind(request.build_job_id)
    .fetch_all(&mut *tx)
    .await?;
    let frontend = one_artifact(&artifacts, "static")?;
    let backend = one_artifact(&artifacts, "application")?;
    if frontend.is_none() && backend.is_none() {
        return Err(ApiError::conflict(
            "release_artifacts_missing",
            "the succeeded build has no registered release artifacts",
        ));
    }

    let runtime = load_candidate_runtime(
        &mut tx,
        account_id,
        project_id,
        deployment_id,
        request.build_job_id,
        request.runtime_allocation_id,
        backend.as_ref(),
    )
    .await?;
    let migration_id = load_stage_migration(
        &mut tx,
        account_id,
        project_id,
        deployment_id,
        configuration_revision_id,
        &request,
    )
    .await?;
    let expected_route_generation: i64 = sqlx::query_scalar(
        "SELECT COALESCE((SELECT generation FROM project_release_routes WHERE account_id=$1 AND project_id=$2 FOR UPDATE),0)",
    )
    .bind(account_id)
    .bind(project_id)
    .fetch_one(&mut *tx)
    .await?;

    let release_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO application_releases \
         (id,account_id,project_id,deployment_id,configuration_revision_id,build_job_id,source_commit,frontend_digest,backend_digest,\
          tenant_database_id,database_generation,migration_revision,migration_digest,migration_artifact_path,migration_id,runtime_allocation_id,runtime_service_id,runtime_generation,runtime_fence,staged_health_observation_id,staged_health_receipt_digest,\
          state,secret_version_refs,health_results,expected_route_generation,managed_demo_url,created_at,updated_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,'staged',$22,'{}'::jsonb,$23,$24,clock_timestamp(),clock_timestamp())",
    )
    .bind(release_id)
    .bind(account_id)
    .bind(project_id)
    .bind(deployment_id)
    .bind(configuration_revision_id)
    .bind(request.build_job_id)
    .bind(&source_commit)
    .bind(frontend.as_ref().map(|a| &a.archive_digest))
    .bind(backend.as_ref().map(|a| &a.archive_digest))
    .bind(request.tenant_database_id)
    .bind(request.database_generation)
    .bind(&request.migration_revision)
    .bind(&request.migration_digest)
    .bind(&request.migration_artifact_path)
    .bind(migration_id)
    .bind(runtime.as_ref().map(|r| r.allocation_id))
    .bind(runtime.as_ref().map(|r| r.service_id))
    .bind(runtime.as_ref().map(|r| r.generation))
    .bind(runtime.as_ref().map(|r| r.fence))
    .bind(runtime.as_ref().map(|r| r.observation_id))
    .bind(runtime.as_ref().map(|r| &r.receipt_digest))
    .bind(&secret_refs)
    .bind(expected_route_generation)
    .bind(&request.managed_demo_url)
    .execute(&mut *tx)
    .await?;
    insert_release_event(
        &mut tx,
        account_id,
        project_id,
        release_id,
        format!("staged:{release_id}"),
        "staged",
        None,
        json!({"build_job_id":request.build_job_id,"source_commit":source_commit}),
    )
    .await?;
    let reconciliation_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO release_reconciliations \
         (id,account_id,project_id,release_id,kind,expected_route_generation,requirements) \
         VALUES ($1,$2,$3,$4,'promote',$5,'{}'::jsonb)",
    )
    .bind(reconciliation_id)
    .bind(account_id)
    .bind(project_id)
    .bind(release_id)
    .bind(expected_route_generation)
    .execute(&mut *tx)
    .await?;
    let response = ReconciliationEnvelope {
        release: load_release(&mut tx, account_id, project_id, release_id).await?,
        reconciliation: load_reconciliation(&mut tx, reconciliation_id).await?,
    };
    intent::audit(
        &mut tx,
        account_id,
        authenticated.session_id(),
        "release.stage",
        "application_release",
        Some(release_id),
        "queued",
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

async fn list_releases(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    Path(project_id): Path<String>,
) -> Result<Json<ReleaseListResponse>, ApiError> {
    m3::require_enabled(&state)?;
    let account_id = authenticated.account_id()?;
    let project_id = intent::path_uuid(&project_id)?;
    let releases = sqlx::query_as::<_, ReleaseRecord>(&release_select(
        "WHERE account_id=$1 AND project_id=$2 ORDER BY promoted_at DESC NULLS LAST,created_at DESC,id DESC",
    ))
    .bind(account_id)
    .bind(project_id)
    .fetch_all(&state.pool)
    .await?;
    if releases.is_empty() {
        let owned: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE account_id=$1 AND id=$2)",
        )
        .bind(account_id)
        .bind(project_id)
        .fetch_one(&state.pool)
        .await?;
        if !owned {
            return Err(ApiError::not_found());
        }
    }
    let current_route = sqlx::query_as::<_, RouteRecord>(
        "SELECT project_id,release_id,generation,availability,availability_observed_at,demo_access_revision,route_manifest_digest,drain_expires_at \
         FROM project_release_routes WHERE account_id=$1 AND project_id=$2",
    )
    .bind(account_id)
    .bind(project_id)
    .fetch_optional(&state.pool)
    .await?;
    Ok(Json(ReleaseListResponse {
        current_route,
        releases,
    }))
}

async fn request_rollback(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    Path((project_id, release_id)): Path<(String, String)>,
    headers: HeaderMap,
    SafeJson(_): SafeJson<EmptyRequest>,
) -> Result<(StatusCode, Json<ReconciliationEnvelope>), ApiError> {
    m3::require_enabled(&state)?;
    let account_id = authenticated.account_id()?;
    let project_id = intent::path_uuid(&project_id)?;
    let release_id = intent::path_uuid(&release_id)?;
    let key = intent::idempotency_key(&headers)?;
    let request_hash = intent::request_hash(&json!({"release_id":release_id}))?;
    let operation = format!("release.rollback/{project_id}/{release_id}");
    let mut tx = state.pool.begin().await?;
    intent::acquire_operation_lock(&mut tx, account_id, &operation, key).await?;
    match intent::replay(&mut tx, account_id, &operation, key, &request_hash).await? {
        Replay::Match(response) => {
            tx.commit().await?;
            return Ok((StatusCode::OK, Json(response)));
        }
        Replay::Changed => return Err(idempotency_changed()),
        Replay::Miss => {}
    }
    let target = load_release(&mut tx, account_id, project_id, release_id).await?;
    if target.state != "healthy" || target.promoted_at.is_none() {
        return Err(ApiError::conflict(
            "rollback_target_ineligible",
            "the target is not a retained successful release",
        ));
    }
    if target.backend_digest.is_some() {
        let runtime_healthy: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM runtime_allocations a \
             WHERE a.id=$1 AND a.account_id=$2 AND a.project_id=$3 AND a.deployment_id=$4 \
               AND a.service_id=$5 AND a.generation=$6 AND a.fence=$7 AND a.state='healthy')",
        )
        .bind(target.runtime_allocation_id)
        .bind(account_id)
        .bind(project_id)
        .bind(target.deployment_id)
        .bind(target.runtime_service_id)
        .bind(target.runtime_generation)
        .bind(target.runtime_fence)
        .fetch_one(&mut *tx)
        .await?;
        if !runtime_healthy {
            return Err(ApiError::conflict(
                "rollback_target_ineligible",
                "the retained release exact runtime allocation is not healthy",
            ));
        }
    }
    validate_release_secrets(&mut tx, account_id, project_id, &target.secret_version_refs).await?;
    let route: Option<(Uuid, i64)> = sqlx::query_as(
        "SELECT release_id,generation FROM project_release_routes WHERE account_id=$1 AND project_id=$2 FOR UPDATE",
    )
    .bind(account_id)
    .bind(project_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((current_id, generation)) = route else {
        return Err(ApiError::conflict(
            "rollback_route_missing",
            "the project has no current route",
        ));
    };
    if current_id == release_id {
        return Err(ApiError::conflict(
            "rollback_target_current",
            "the requested release is already current",
        ));
    }
    let reconciliation_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO release_reconciliations \
         (id,account_id,project_id,release_id,kind,expected_route_generation,requirements) \
         VALUES ($1,$2,$3,$4,'rollback',$5,'{}'::jsonb)",
    )
    .bind(reconciliation_id)
    .bind(account_id)
    .bind(project_id)
    .bind(release_id)
    .bind(generation)
    .execute(&mut *tx)
    .await?;
    let response = ReconciliationEnvelope {
        release: target,
        reconciliation: load_reconciliation(&mut tx, reconciliation_id).await?,
    };
    intent::audit(
        &mut tx,
        account_id,
        authenticated.session_id(),
        "release.rollback.request",
        "application_release",
        Some(release_id),
        "queued",
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

async fn activate_reconciliation(
    State(state): State<FoundationState>,
    _: RuntimeWorkerAuth,
    Path(reconciliation_id): Path<String>,
    SafeJson(request): SafeJson<ActivateRequest>,
) -> Result<Json<ActivateResponse>, ApiError> {
    m3::require_enabled(&state)?;
    validate_worker_id(&request.worker_id)?;
    let reconciliation_id = intent::path_uuid(&reconciliation_id)?;
    let bytes = read_evidence(&state, &request.switch_receipt_digest)?;
    let receipt: SwitchReceipt = serde_json::from_slice(&bytes).map_err(|_| evidence_invalid())?;
    let policy_now = m3::policy_now(&state).await?;
    let mut tx = state.pool.begin().await?;
    let account_id: Uuid =
        sqlx::query_scalar("SELECT account_id FROM release_reconciliations WHERE id=$1")
            .bind(reconciliation_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(fenced)?;
    crate::portfolio_approval::lock_account(&mut tx, account_id).await?;
    let reconciliation = lock_live_reconciliation(
        &mut tx,
        reconciliation_id,
        request.attempt_id,
        request.fence,
        &request.worker_id,
        "prepared",
    )
    .await?;
    validate_route_generation(&mut tx, &reconciliation).await?;
    let result = reconciliation.result.as_ref().ok_or_else(fenced)?;
    let manifest_digest = value_string(result, "route_manifest_digest")?;
    let route_generation = value_i64(result, "route_generation")?;
    let drain_expires_at: DateTime<Utc> = result
        .get("drain_expires_at")
        .and_then(Value::as_str)
        .and_then(|v| v.parse().ok())
        .ok_or_else(evidence_invalid)?;
    let previous_release_id: Option<Uuid> = sqlx::query_scalar(
        "SELECT release_id FROM project_release_routes WHERE account_id=$1 AND project_id=$2 FOR UPDATE",
    )
    .bind(reconciliation.account_id)
    .bind(reconciliation.project_id)
    .fetch_optional(&mut *tx)
    .await?;
    validate_switch_receipt(
        &receipt,
        &reconciliation,
        request.attempt_id,
        request.fence,
        previous_release_id,
        route_generation,
        manifest_digest,
    )?;

    let release = load_release(
        &mut tx,
        reconciliation.account_id,
        reconciliation.project_id,
        reconciliation.release_id,
    )
    .await?;
    validate_release_secrets(
        &mut tx,
        reconciliation.account_id,
        reconciliation.project_id,
        &release.secret_version_refs,
    )
    .await?;
    let manifest = result
        .get("route_manifest")
        .cloned()
        .ok_or_else(ApiError::internal)?;
    let retained_assets = manifest
        .get("retained_assets")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    sqlx::query(
        "INSERT INTO project_release_routes \
         (project_id,account_id,release_id,generation,availability,availability_observed_at,demo_access_revision,route_manifest_digest,route_manifest,retained_asset_refs,drain_expires_at,updated_at) \
         VALUES ($1,$2,$3,$4,'available',clock_timestamp(),1,$5,$6,$7,$8,clock_timestamp()) \
         ON CONFLICT (project_id) DO UPDATE SET release_id=EXCLUDED.release_id,generation=EXCLUDED.generation,\
           availability='available',availability_observed_at=clock_timestamp(),route_manifest_digest=EXCLUDED.route_manifest_digest,\
           route_manifest=EXCLUDED.route_manifest,retained_asset_refs=EXCLUDED.retained_asset_refs,drain_expires_at=EXCLUDED.drain_expires_at,updated_at=clock_timestamp() \
         WHERE project_release_routes.account_id=EXCLUDED.account_id AND project_release_routes.generation=$9",
    )
    .bind(reconciliation.project_id)
    .bind(reconciliation.account_id)
    .bind(reconciliation.release_id)
    .bind(route_generation)
    .bind(manifest_digest)
    .bind(&manifest)
    .bind(&retained_assets)
    .bind(drain_expires_at)
    .bind(reconciliation.expected_route_generation)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE application_releases SET state='healthy',promoted_at=clock_timestamp(),health_results=$2,failure_code=NULL,updated_at=clock_timestamp() WHERE id=$1",
    )
    .bind(reconciliation.release_id)
    .bind(json!({
        "schema":"hostlet.release-health/v1",
        "probe_receipt_digests":result.get("probe_receipt_digests").cloned().unwrap_or(Value::Array(vec![])),
        "switch_receipt_digest":request.switch_receipt_digest,
    }))
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE deployments SET lifecycle='healthy',health_result_ref=$2,database_migration_revision=$3,secret_version_refs=$4 \
         WHERE account_id=$5 AND project_id=$6 AND id=$1",
    )
    .bind(release.deployment_id)
    .bind(&request.switch_receipt_digest)
    .bind(&release.migration_revision)
    .bind(&release.secret_version_refs)
    .bind(reconciliation.account_id)
    .bind(reconciliation.project_id)
    .execute(&mut *tx)
    .await?;
    crate::portfolio_approval::refresh_deployment_facts_in_transaction(
        &mut tx,
        reconciliation.release_id,
        policy_now,
    )
    .await?;
    sqlx::query(
        "UPDATE release_reconciliation_attempts SET state='succeeded',finished_at=clock_timestamp(),terminal_code='route_activated',completion_hash=$4 \
         WHERE reconciliation_id=$1 AND id=$2 AND fence=$3 AND state='running'",
    )
    .bind(reconciliation.id)
    .bind(request.attempt_id)
    .bind(request.fence)
    .bind(Sha256::digest(&bytes).as_slice())
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE release_reconciliations SET state='succeeded',terminal_code='route_activated',current_attempt_id=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=$1",
    )
    .bind(reconciliation.id)
    .execute(&mut *tx)
    .await?;
    insert_release_event(
        &mut tx,
        reconciliation.account_id,
        reconciliation.project_id,
        reconciliation.release_id,
        format!("activate:{}", reconciliation.id),
        if reconciliation.kind == "rollback" {
            "rollback"
        } else {
            "promoted"
        },
        Some(route_generation),
        json!({"route_manifest_digest":manifest_digest,"switch_receipt_digest":request.switch_receipt_digest,
               "previous_release_id":previous_release_id}),
    )
    .await?;
    let retired_release_ids = retire_excess_releases(
        &mut tx,
        reconciliation.account_id,
        reconciliation.project_id,
        reconciliation.release_id,
    )
    .await?;
    let route = sqlx::query_as::<_, RouteRecord>(
        "SELECT project_id,release_id,generation,availability,availability_observed_at,demo_access_revision,route_manifest_digest,drain_expires_at \
         FROM project_release_routes WHERE account_id=$1 AND project_id=$2",
    )
    .bind(reconciliation.account_id)
    .bind(reconciliation.project_id)
    .fetch_one(&mut *tx)
    .await?;
    let response = ActivateResponse {
        release: load_release(
            &mut tx,
            reconciliation.account_id,
            reconciliation.project_id,
            reconciliation.release_id,
        )
        .await?,
        reconciliation: load_reconciliation(&mut tx, reconciliation.id).await?,
        route,
        retired_release_ids,
    };
    tx.commit().await?;
    Ok(Json(response))
}

struct LoadedRelease {
    release: ReleaseRecord,
    lease: ReleaseLease,
    runtime: Option<RuntimeLease>,
}

#[derive(FromRow)]
struct CandidateRuntimeRow {
    allocation_id: Uuid,
    service_id: Uuid,
    generation: i64,
    fence: i64,
    artifact_digest: String,
    artifact_manifest_digest: String,
    runtime_binary_digest: String,
    policy_digest: String,
    capability_digest: String,
    platform: String,
    profile: String,
    expires_at: DateTime<Utc>,
    evaluation_result: String,
    observation_id: Uuid,
    receipt_digest: String,
}

fn release_select(suffix: &str) -> String {
    format!(
        "SELECT id,project_id,deployment_id,configuration_revision_id,build_job_id,source_commit,frontend_digest,backend_digest,\
         tenant_database_id,database_generation,migration_revision,migration_digest,migration_artifact_path,migration_id,runtime_allocation_id,runtime_service_id,runtime_generation,runtime_fence,staged_health_observation_id,staged_health_receipt_digest,\
         state,secret_version_refs,health_results,expected_route_generation,managed_demo_url,promoted_at,failure_code,created_at,updated_at \
         FROM application_releases {suffix}"
    )
}

async fn load_release(
    tx: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    project_id: Uuid,
    release_id: Uuid,
) -> Result<ReleaseRecord, ApiError> {
    sqlx::query_as::<_, ReleaseRecord>(&release_select(
        "WHERE account_id=$1 AND project_id=$2 AND id=$3",
    ))
    .bind(account_id)
    .bind(project_id)
    .bind(release_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(ApiError::not_found)
}

async fn load_reconciliation(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
) -> Result<ReconciliationRecord, ApiError> {
    sqlx::query_as(
        "SELECT id,account_id,project_id,release_id,kind,state,expected_route_generation,requirements,attempt_count,current_attempt_id,current_fence,lease_expires_at,terminal_code,result,created_at,updated_at \
         FROM release_reconciliations WHERE id=$1",
    )
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(ApiError::not_found)
}

async fn load_release_lease(
    tx: &mut Transaction<'_, Postgres>,
    release_id: Uuid,
    policy_now: DateTime<Utc>,
) -> Result<LoadedRelease, ApiError> {
    let account_project: Option<(Uuid, Uuid)> =
        sqlx::query_as("SELECT account_id,project_id FROM application_releases WHERE id=$1")
            .bind(release_id)
            .fetch_optional(&mut **tx)
            .await?;
    let Some((account_id, project_id)) = account_project else {
        return Err(ApiError::not_found());
    };
    let release = load_release(tx, account_id, project_id, release_id).await?;
    let artifacts: Vec<(Uuid, String, String, String)> = sqlx::query_as(
        "SELECT id,kind,archive_digest,manifest_digest FROM build_artifacts \
         WHERE account_id=$1 AND project_id=$2 AND job_id=$3 AND cas_state='registered' ORDER BY kind",
    )
    .bind(account_id)
    .bind(project_id)
    .bind(release.build_job_id)
    .fetch_all(&mut **tx)
    .await?;
    let frontend = one_artifact(&artifacts, "static")?;
    let backend = one_artifact(&artifacts, "application")?;
    if frontend.as_ref().map(|a| &a.archive_digest) != release.frontend_digest.as_ref()
        || backend.as_ref().map(|a| &a.archive_digest) != release.backend_digest.as_ref()
    {
        return Err(ApiError::conflict(
            "release_artifact_drift",
            "the release artifacts no longer match their exact durable references",
        ));
    }
    let runtime = if let Some(allocation_id) = release.runtime_allocation_id {
        let row: Option<RuntimeLease> = sqlx::query_as(
            "SELECT a.id AS allocation_id,a.service_id,a.generation,a.fence,a.state,a.artifact_digest,a.artifact_manifest_digest,\
                    a.runtime_binary_digest,a.policy_digest,a.capability_digest,a.platform,a.profile,\
                    ARRAY(SELECT jsonb_array_elements_text(a.argv)) AS argv,a.application_port,a.health_port,a.health_path \
             FROM runtime_allocations a JOIN runtime_evaluations e ON e.id=a.evaluation_id \
             WHERE a.id=$1 AND a.account_id=$2 AND a.project_id=$3 AND a.deployment_id=$4 \
               AND a.service_id=$5 AND a.generation=$6 AND a.fence=$7 \
               AND e.result='passed' AND e.expires_at>$8",
        )
        .bind(allocation_id)
        .bind(account_id)
        .bind(project_id)
        .bind(release.deployment_id)
        .bind(release.runtime_service_id)
        .bind(release.runtime_generation)
        .bind(release.runtime_fence)
        .bind(policy_now)
        .fetch_optional(&mut **tx)
        .await?;
        Some(row.ok_or_else(|| {
            ApiError::conflict(
                "release_runtime_ineligible",
                "the exact runtime allocation or capability evidence is unavailable",
            )
        })?)
    } else {
        None
    };
    if runtime.as_ref().map(|r| &r.artifact_digest) != release.backend_digest.as_ref() {
        return Err(ApiError::conflict(
            "release_runtime_artifact_mismatch",
            "the runtime allocation does not match the release backend artifact",
        ));
    }
    let isolated_apply_receipt_digest = if let Some(migration_id) = release.migration_id {
        sqlx::query_scalar::<_, Option<String>>(
            "SELECT compatibility_evidence->>'migration_apply_receipt_digest' FROM tenant_database_migrations WHERE id=$1",
        )
        .bind(migration_id)
        .fetch_optional(&mut **tx)
        .await?
        .flatten()
    } else {
        None
    };
    let lease = ReleaseLease {
        release_id: release.id,
        project_id: release.project_id,
        deployment_id: release.deployment_id,
        configuration_revision_id: release.configuration_revision_id,
        build_job_id: release.build_job_id,
        source_commit: release.source_commit.clone(),
        frontend,
        backend,
        runtime: runtime.clone(),
        tenant_database_id: release.tenant_database_id,
        database_generation: release.database_generation,
        migration_id: release.migration_id,
        migration_revision: release.migration_revision.clone(),
        migration_digest: release.migration_digest.clone(),
        migration_artifact_path: release.migration_artifact_path.clone(),
        isolated_apply_receipt_digest,
        secret_version_refs: release.secret_version_refs.clone(),
        staged_health_observation_id: release.staged_health_observation_id,
        staged_health_receipt_digest: release.staged_health_receipt_digest.clone(),
    };
    Ok(LoadedRelease {
        release,
        lease,
        runtime,
    })
}

async fn load_current_and_retained(
    tx: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    project_id: Uuid,
    candidate_id: Uuid,
    policy_now: DateTime<Utc>,
) -> Result<(Option<LoadedRelease>, Vec<LoadedRelease>), ApiError> {
    let current_id: Option<Uuid> = sqlx::query_scalar(
        "SELECT release_id FROM project_release_routes WHERE account_id=$1 AND project_id=$2",
    )
    .bind(account_id)
    .bind(project_id)
    .fetch_optional(&mut **tx)
    .await?;
    let ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM application_releases WHERE account_id=$1 AND project_id=$2 AND id<>$3 \
           AND state='healthy' AND promoted_at IS NOT NULL ORDER BY promoted_at DESC,id DESC LIMIT 3",
    )
    .bind(account_id)
    .bind(project_id)
    .bind(candidate_id)
    .fetch_all(&mut **tx)
    .await?;
    let mut current = None;
    let mut retained = Vec::new();
    for id in ids {
        let loaded = load_release_lease(tx, id, policy_now).await?;
        if Some(id) == current_id {
            current = Some(loaded);
        } else if retained.len() < 2 {
            retained.push(loaded);
        }
    }
    if current_id.is_some() && current.is_none() {
        return Err(ApiError::conflict(
            "current_release_ineligible",
            "the current routed release is not eligible for safe overlap",
        ));
    }
    Ok((current, retained))
}

fn required_probes(
    candidate: &LoadedRelease,
    current: Option<&LoadedRelease>,
    retained: &[LoadedRelease],
    context: &ProbePlanContext,
) -> Result<Vec<RequiredProbe>, ApiError> {
    let mut previous = Vec::new();
    if let Some(current) = current {
        previous.push(current);
    }
    previous.extend(retained.iter());
    let mut probes = Vec::new();
    if context.phase != "isolated_validation"
        && let Some(runtime) = &candidate.runtime
    {
        probes.push(probe(
            "health",
            candidate.release.id,
            None,
            runtime,
            health_receipt(candidate)?,
            context,
        )?);
    }
    if context.database_generation.is_some() {
        for release in std::iter::once(candidate).chain(previous.iter().copied()) {
            let runtime = release.runtime.as_ref().ok_or_else(|| {
                ApiError::conflict(
                    "release_database_runtime_missing",
                    "a database release requires an exact application runtime",
                )
            })?;
            probes.push(probe(
                "current_data",
                release.release.id,
                None,
                runtime,
                health_receipt(release)?,
                context,
            )?);
        }
    }
    if context.migration_id.is_some() {
        let all = std::iter::once(candidate)
            .chain(previous.iter().copied())
            .collect::<Vec<_>>();
        for frontend in &all {
            for api in &all {
                if frontend.release.id == api.release.id {
                    continue;
                }
                let runtime = api.runtime.as_ref().ok_or_else(|| {
                    ApiError::conflict(
                        "release_overlap_runtime_missing",
                        "every migrated retained release requires an exact application runtime",
                    )
                })?;
                let kind = if api.release.id == candidate.release.id {
                    "cached_old_frontend_candidate_api"
                } else {
                    "candidate_frontend_retained_api"
                };
                probes.push(probe(
                    kind,
                    frontend.release.id,
                    Some(api.release.id),
                    runtime,
                    health_receipt(api)?,
                    context,
                )?);
            }
        }
    } else {
        if candidate.release.backend_digest.is_some() {
            let runtime = candidate.runtime.as_ref().ok_or_else(ApiError::internal)?;
            for old in &previous {
                if old.release.frontend_digest.is_some() {
                    probes.push(probe(
                        "cached_old_frontend_candidate_api",
                        old.release.id,
                        Some(candidate.release.id),
                        runtime,
                        health_receipt(candidate)?,
                        context,
                    )?);
                }
            }
        }
        if candidate.release.frontend_digest.is_some() {
            for old in &previous {
                if let Some(runtime) = &old.runtime {
                    probes.push(probe(
                        "candidate_frontend_retained_api",
                        candidate.release.id,
                        Some(old.release.id),
                        runtime,
                        health_receipt(old)?,
                        context,
                    )?);
                }
            }
        }
    }
    let unique: HashSet<_> = probes.iter().cloned().collect();
    if unique.len() != probes.len() {
        return Err(ApiError::internal());
    }
    Ok(probes)
}

fn probe(
    kind: &str,
    release_id: Uuid,
    peer_release_id: Option<Uuid>,
    runtime: &RuntimeLease,
    executor_receipt_digest: &str,
    context: &ProbePlanContext,
) -> Result<RequiredProbe, ApiError> {
    if context.phase == "isolated_validation" {
        Ok(RequiredProbe::Isolated(Box::new(IsolatedRequiredProbe {
            schema: "hostlet.runtime.migration-probe-request/v1".to_owned(),
            probe_execution_id: Uuid::new_v4(),
            reconciliation_id: context.reconciliation_id,
            attempt_id: context.attempt_id,
            release_fence: context.release_fence,
            check_kind: kind.to_owned(),
            release_id,
            peer_release_id,
            source_allocation_id: runtime.allocation_id,
            source_generation: runtime.generation,
            source_fence: runtime.fence,
            artifact_digest: runtime.artifact_digest.clone(),
            executor_template_receipt_digest: executor_receipt_digest.to_owned(),
            tenant_database_id: context.tenant_database_id.ok_or_else(ApiError::internal)?,
            database_generation: context.database_generation.ok_or_else(ApiError::internal)?,
            migration_id: context.migration_id.ok_or_else(ApiError::internal)?,
            target: "isolated".to_owned(),
            executor: ProbeExecutorRequest {
                runtime_binary_digest: runtime.runtime_binary_digest.clone(),
                policy_digest: runtime.policy_digest.clone(),
                capability_digest: runtime.capability_digest.clone(),
                platform: runtime.platform.clone(),
                profile: "evidence_gated_owned_fixture".to_owned(),
                argv: runtime.argv.clone(),
                application_port: runtime.application_port,
                health_port: runtime.health_port,
                health_path: runtime.health_path.clone(),
            },
        })))
    } else {
        Ok(RequiredProbe::Hosted(HostedRequiredProbe {
            check_kind: kind.to_owned(),
            release_id,
            peer_release_id,
            allocation_id: runtime.allocation_id,
            generation: runtime.generation,
            fence: runtime.fence,
            artifact_digest: runtime.artifact_digest.clone(),
            executor_receipt_digest: executor_receipt_digest.to_owned(),
            database_generation: context.database_generation,
            migration_id: context.migration_id,
        }))
    }
}

fn health_receipt(release: &LoadedRelease) -> Result<&str, ApiError> {
    release
        .release
        .staged_health_receipt_digest
        .as_deref()
        .filter(|value| is_digest(value))
        .ok_or_else(|| {
            ApiError::conflict(
                "release_health_evidence_missing",
                "the exact accepted runtime health receipt is unavailable",
            )
        })
}

fn validate_probe_receipts(
    state: &FoundationState,
    expected: &[RequiredProbe],
    digests: &[String],
    reconciliation_id: Uuid,
    attempt_id: Uuid,
    release_fence: i64,
) -> Result<Vec<(String, ProbeReceipt)>, ApiError> {
    if digests.len() != expected.len()
        || digests.iter().collect::<HashSet<_>>().len() != digests.len()
    {
        return Err(ApiError::unprocessable(
            "release_probe_set_invalid",
            "the probe receipt set must exactly match the reconciliation lease",
        ));
    }
    let mut observed = HashSet::new();
    let mut output = Vec::with_capacity(digests.len());
    for digest in digests {
        let bytes = read_evidence(state, digest)?;
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| evidence_invalid())?;
        let (key, receipt) = if value.get("schema").and_then(Value::as_str)
            == Some("hostlet.runtime.probe-receipt/v2")
        {
            let wrapper: IsolatedProbeReceipt =
                serde_json::from_value(value).map_err(|_| evidence_invalid())?;
            let expected_probe = expected
                .iter()
                .find(|probe| {
                    matches!(probe, RequiredProbe::Isolated(item) if item.probe_execution_id == wrapper.probe_execution_id)
                })
                .ok_or_else(evidence_invalid)?;
            let RequiredProbe::Isolated(expected_probe) = expected_probe else {
                return Err(evidence_invalid());
            };
            let normalized = validate_isolated_probe_receipt(
                state,
                &wrapper,
                expected_probe,
                reconciliation_id,
                attempt_id,
                release_fence,
            )?;
            (RequiredProbe::Isolated(expected_probe.clone()), normalized)
        } else {
            let receipt: ProbeReceipt =
                serde_json::from_value(value).map_err(|_| evidence_invalid())?;
            validate_probe_receipt(state, &receipt)?;
            let key = RequiredProbe::Hosted(HostedRequiredProbe {
                check_kind: receipt.check_kind.clone(),
                release_id: receipt.release_id,
                peer_release_id: receipt.peer_release_id,
                allocation_id: receipt.allocation_id,
                generation: i64::try_from(receipt.generation).map_err(|_| evidence_invalid())?,
                fence: i64::try_from(receipt.fence).map_err(|_| evidence_invalid())?,
                artifact_digest: receipt.artifact_digest.clone(),
                executor_receipt_digest: receipt.executor_receipt_digest.clone(),
                database_generation: receipt.database_generation,
                migration_id: receipt.migration_id,
            });
            (key, receipt)
        };
        if !observed.insert(key) {
            return Err(ApiError::unprocessable(
                "release_probe_duplicate",
                "probe receipts must be unique",
            ));
        }
        output.push((digest.clone(), receipt));
    }
    if observed != expected.iter().cloned().collect::<HashSet<_>>() {
        return Err(ApiError::conflict(
            "release_probe_set_mismatch",
            "the probe receipts do not match the exact leased release identities",
        ));
    }
    Ok(output)
}

fn validate_isolated_probe_receipt(
    state: &FoundationState,
    receipt: &IsolatedProbeReceipt,
    expected: &IsolatedRequiredProbe,
    reconciliation_id: Uuid,
    attempt_id: Uuid,
    release_fence: i64,
) -> Result<ProbeReceipt, ApiError> {
    let observed_at = Utc
        .timestamp_millis_opt(receipt.observed_at_unix_ms)
        .single()
        .ok_or_else(evidence_invalid)?;
    if receipt.schema != "hostlet.runtime.probe-receipt/v2"
        || receipt.probe_execution_id != expected.probe_execution_id
        || receipt.reconciliation_id != reconciliation_id
        || receipt.reconciliation_id != expected.reconciliation_id
        || receipt.attempt_id != attempt_id
        || receipt.attempt_id != expected.attempt_id
        || i64::try_from(receipt.release_fence).ok() != Some(release_fence)
        || release_fence != expected.release_fence
        || receipt.check_kind != expected.check_kind
        || receipt.release_id != expected.release_id
        || receipt.peer_release_id != expected.peer_release_id
        || receipt.source_allocation_id != expected.source_allocation_id
        || i64::try_from(receipt.source_generation).ok() != Some(expected.source_generation)
        || i64::try_from(receipt.source_fence).ok() != Some(expected.source_fence)
        || receipt.artifact_digest != expected.artifact_digest
        || receipt.database_generation != expected.database_generation
        || receipt.migration_id != expected.migration_id
        || receipt.target != "isolated"
        || expected.target != "isolated"
        || receipt.result != "passed"
        || receipt.reason_code != "runtime_isolated_probe_passed"
        || observed_at > Utc::now() + Duration::minutes(5)
        || Utc::now() - observed_at > Duration::hours(1)
        || receipt.assertions.is_empty()
        || receipt
            .assertions
            .iter()
            .any(|assertion| assertion.name.is_empty() || !assertion.passed)
    {
        return Err(evidence_invalid());
    }
    let executor = read_evidence_value(state, &receipt.executor_receipt_digest)?;
    validate_disposable_executor(&executor, receipt, expected, false)?;
    let cleanup = read_evidence_value(state, &receipt.cleanup_receipt_digest)?;
    validate_disposable_executor(&cleanup, receipt, expected, true)?;
    let application_bytes = read_evidence(state, &receipt.application_probe_receipt_digest)?;
    let application: ApplicationProbeReceipt =
        serde_json::from_slice(&application_bytes).map_err(|_| evidence_invalid())?;
    if application.schema != "hostlet.runtime.application-probe-receipt/v1"
        || application.probe_execution_id != receipt.probe_execution_id
        || application.allocation_id != receipt.probe_execution_id
        || application.generation != 1
        || application.fence != receipt.release_fence
        || application.artifact_digest != receipt.artifact_digest
        || application.database_generation != receipt.database_generation
        || application.migration_id != receipt.migration_id
        || application.check_kind != receipt.check_kind
        || application.target != "isolated"
        || application.result != "passed"
        || application.reason_code != "runtime_application_probe_passed"
        || application.observed_at_unix_ms > receipt.observed_at_unix_ms
        || application
            .http
            .write_status_code
            .is_none_or(|status| !(200..300).contains(&status))
        || application.http.read_status_code != Some(200)
        || application.http.elapsed_ms == 0
        || application
            .http
            .response_sha256
            .as_deref()
            .is_none_or(|digest| !is_digest(digest))
        || application.assertions.is_empty()
        || application
            .assertions
            .iter()
            .any(|assertion| assertion.name.is_empty() || !assertion.passed)
    {
        return Err(evidence_invalid());
    }
    Ok(ProbeReceipt {
        schema: receipt.schema.clone(),
        check_kind: receipt.check_kind.clone(),
        release_id: receipt.release_id,
        peer_release_id: receipt.peer_release_id,
        allocation_id: receipt.source_allocation_id,
        generation: receipt.source_generation,
        fence: receipt.source_fence,
        artifact_digest: receipt.artifact_digest.clone(),
        database_generation: Some(receipt.database_generation),
        migration_id: Some(receipt.migration_id),
        executor_receipt_digest: receipt.executor_receipt_digest.clone(),
        result: receipt.result.clone(),
        reason_code: receipt.reason_code.clone(),
        observed_at_unix_ms: receipt.observed_at_unix_ms,
        http: ProbeHttp {
            method: "POST".to_owned(),
            path: "/isolated-application-probe".to_owned(),
            safe_status_code: application.http.read_status_code,
            response_sha256: application.http.response_sha256,
            elapsed_ms: application.http.elapsed_ms,
        },
        assertions: application
            .assertions
            .into_iter()
            .map(|assertion| ProbeAssertion {
                name: assertion.name,
                passed: assertion.passed,
                observed_sha256: None,
            })
            .collect(),
    })
}

fn read_evidence_value(state: &FoundationState, digest: &str) -> Result<Value, ApiError> {
    serde_json::from_slice(&read_evidence(state, digest)?).map_err(|_| evidence_invalid())
}

fn validate_disposable_executor(
    value: &Value,
    receipt: &IsolatedProbeReceipt,
    expected: &IsolatedRequiredProbe,
    cleanup: bool,
) -> Result<(), ApiError> {
    let allocation_id = receipt.probe_execution_id.to_string();
    let operation = if cleanup { "cleanup" } else { "inspect" };
    let status = if cleanup { "cleaned" } else { "running" };
    if value.get("schema").and_then(Value::as_str) != Some("hostlet.runtime.executor-receipt/v1")
        || value.get("operation").and_then(Value::as_str) != Some(operation)
        || value.get("result").and_then(Value::as_str) != Some("passed")
        || value.get("status").and_then(Value::as_str) != Some(status)
        || value.get("allocation_id").and_then(Value::as_str) != Some(allocation_id.as_str())
        || value.get("generation").and_then(Value::as_u64) != Some(1)
        || value.get("fence").and_then(Value::as_u64) != Some(receipt.release_fence)
        || value.get("artifact_digest").and_then(Value::as_str)
            != Some(expected.artifact_digest.as_str())
        || value.get("runtime_binary_digest").and_then(Value::as_str)
            != Some(expected.executor.runtime_binary_digest.as_str())
        || value.get("policy_digest").and_then(Value::as_str)
            != Some(expected.executor.policy_digest.as_str())
        || value.get("capability_digest").and_then(Value::as_str)
            != Some(expected.executor.capability_digest.as_str())
        || value.get("platform").and_then(Value::as_str)
            != Some(expected.executor.platform.as_str())
        || value.get("profile").and_then(Value::as_str) != Some("evidence_gated_owned_fixture")
    {
        return Err(evidence_invalid());
    }
    if cleanup {
        let cleanup = value.get("cleanup").ok_or_else(evidence_invalid)?;
        if cleanup.get("sandbox_absent").and_then(Value::as_bool) != Some(true)
            || cleanup
                .get("application_namespace_absent")
                .and_then(Value::as_bool)
                != Some(true)
            || cleanup
                .get("gateway_namespace_absent")
                .and_then(Value::as_bool)
                != Some(true)
            || cleanup.get("cgroup_absent").and_then(Value::as_bool) != Some(true)
            || cleanup.get("state_retained").and_then(Value::as_bool) != Some(false)
        {
            return Err(evidence_invalid());
        }
    } else if value.get("runsc_status").and_then(Value::as_str) != Some("running")
        || !value.get("observed_limits").is_some_and(Value::is_object)
        || !value
            .get("health")
            .and_then(|health| health.get("passing"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        return Err(evidence_invalid());
    }
    Ok(())
}

fn validate_probe_receipt(state: &FoundationState, receipt: &ProbeReceipt) -> Result<(), ApiError> {
    let observed_at = Utc
        .timestamp_millis_opt(receipt.observed_at_unix_ms)
        .single()
        .ok_or_else(evidence_invalid)?;
    let expected_reason = match receipt.check_kind.as_str() {
        "health" => "runtime_health_passed",
        "current_data" => "runtime_current_data_passed",
        "cached_old_frontend_candidate_api" | "candidate_frontend_retained_api" => {
            "runtime_cross_version_passed"
        }
        _ => return Err(evidence_invalid()),
    };
    if receipt.schema != "hostlet.runtime.probe-receipt/v1"
        || receipt.result != "passed"
        || receipt.reason_code != expected_reason
        || receipt.generation == 0
        || receipt.fence == 0
        || observed_at > Utc::now() + Duration::minutes(5)
        || Utc::now() - observed_at > Duration::hours(1)
        || !is_digest(&receipt.artifact_digest)
        || !is_digest(&receipt.executor_receipt_digest)
        || receipt.assertions.is_empty()
        || receipt.assertions.iter().any(|a| {
            a.name.is_empty()
                || !a.passed
                || a.observed_sha256.as_deref().is_some_and(|v| !is_digest(v))
        })
        || !matches!(receipt.http.method.as_str(), "GET" | "POST")
        || !receipt.http.path.starts_with('/')
        || receipt.http.elapsed_ms == 0
        || receipt
            .http
            .response_sha256
            .as_deref()
            .is_some_and(|v| !is_digest(v))
        || receipt.http.safe_status_code.is_none()
    {
        return Err(evidence_invalid());
    }
    if receipt.check_kind == "health" && receipt.peer_release_id.is_some() {
        return Err(evidence_invalid());
    }
    if matches!(
        receipt.check_kind.as_str(),
        "current_data" | "cached_old_frontend_candidate_api" | "candidate_frontend_retained_api"
    ) && receipt.database_generation.is_none()
    {
        return Err(evidence_invalid());
    }
    if receipt.check_kind.contains("frontend") && receipt.peer_release_id.is_none() {
        return Err(evidence_invalid());
    }
    validate_executor_receipt(state, receipt)
}

fn validate_executor_receipt(
    state: &FoundationState,
    probe: &ProbeReceipt,
) -> Result<(), ApiError> {
    let bytes = read_evidence(state, &probe.executor_receipt_digest)?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| evidence_invalid())?;
    let allocation_id = probe.allocation_id.to_string();
    if value.get("schema").and_then(Value::as_str) != Some("hostlet.runtime.executor-receipt/v1")
        || value.get("allocation_id").and_then(Value::as_str) != Some(allocation_id.as_str())
        || value.get("generation").and_then(Value::as_u64) != Some(probe.generation)
        || value.get("fence").and_then(Value::as_u64) != Some(probe.fence)
        || value.get("artifact_digest").and_then(Value::as_str)
            != Some(probe.artifact_digest.as_str())
        || value.get("runsc_status").and_then(Value::as_str) != Some("running")
        || !value.get("observed_limits").is_some_and(Value::is_object)
    {
        return Err(ApiError::conflict(
            "release_executor_identity_mismatch",
            "a probe executor receipt does not match the exact runtime allocation",
        ));
    }
    Ok(())
}

fn validate_stage_request(request: &StageReleaseRequest) -> Result<(), ApiError> {
    let database_pair =
        request.tenant_database_id.is_some() == request.database_generation.is_some();
    let migration_pair = request.migration_revision.is_some() == request.migration_digest.is_some();
    let migration_path_pair =
        request.migration_revision.is_some() == request.migration_artifact_path.is_some();
    if !database_pair
        || !migration_pair
        || !migration_path_pair
        || request.migration_revision.is_some() && request.tenant_database_id.is_none()
        || request
            .migration_revision
            .as_deref()
            .is_some_and(|v| v.is_empty() || v.len() > 256)
        || request
            .migration_digest
            .as_deref()
            .is_some_and(|v| !is_digest(v))
        || request
            .migration_artifact_path
            .as_deref()
            .is_some_and(|v| !valid_migration_path(v))
        || request.managed_demo_url.len() > 2048
        || !request.managed_demo_url.starts_with("https://")
    {
        return Err(ApiError::unprocessable(
            "release_request_invalid",
            "the release request has invalid or incomplete exact references",
        ));
    }
    Ok(())
}

fn one_artifact(
    artifacts: &[(Uuid, String, String, String)],
    kind: &str,
) -> Result<Option<ArtifactLease>, ApiError> {
    let matches = artifacts
        .iter()
        .filter(|(_, candidate_kind, _, _)| candidate_kind == kind)
        .collect::<Vec<_>>();
    if matches.len() > 1 {
        return Err(ApiError::internal());
    }
    Ok(matches
        .first()
        .map(|(id, _, archive, manifest)| ArtifactLease {
            artifact_id: *id,
            archive_digest: archive.clone(),
            manifest_digest: manifest.clone(),
        }))
}

async fn load_candidate_runtime(
    tx: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    project_id: Uuid,
    deployment_id: Uuid,
    build_job_id: Uuid,
    allocation_id: Option<Uuid>,
    backend: Option<&ArtifactLease>,
) -> Result<Option<CandidateRuntimeRow>, ApiError> {
    match (allocation_id, backend) {
        (None, None) => return Ok(None),
        (Some(_), None) | (None, Some(_)) => {
            return Err(ApiError::conflict(
                "release_runtime_mismatch",
                "an application artifact and exact healthy runtime allocation are required together",
            ));
        }
        (Some(_), Some(_)) => {}
    }
    let row: Option<CandidateRuntimeRow> = sqlx::query_as(
        "SELECT a.id AS allocation_id,a.service_id,a.generation,a.fence,a.artifact_digest,a.artifact_manifest_digest,\
                a.runtime_binary_digest,a.policy_digest,a.capability_digest,a.platform,a.profile,e.expires_at,e.result AS evaluation_result,\
                o.id AS observation_id,o.receipt_digest \
         FROM runtime_allocations a JOIN runtime_evaluations e ON e.id=a.evaluation_id \
         JOIN LATERAL (SELECT id,receipt_digest,state FROM runtime_observations WHERE allocation_id=a.id ORDER BY sequence DESC LIMIT 1) o ON true \
         WHERE a.id=$1 AND a.account_id=$2 AND a.project_id=$3 AND a.deployment_id=$4 AND a.build_job_id=$5 \
           AND a.state='healthy' AND o.state='healthy' FOR SHARE OF a,e,o",
    )
    .bind(allocation_id)
    .bind(account_id)
    .bind(project_id)
    .bind(deployment_id)
    .bind(build_job_id)
    .fetch_optional(&mut **tx)
    .await?;
    let row = row.ok_or_else(|| {
        ApiError::conflict(
            "release_runtime_unhealthy",
            "the exact runtime allocation has no current authenticated healthy observation",
        )
    })?;
    let backend = backend.expect("matched above");
    if row.artifact_digest != backend.archive_digest
        || row.artifact_manifest_digest != backend.manifest_digest
        || row.evaluation_result != "passed"
        || row.expires_at <= Utc::now()
        || !is_digest(&row.receipt_digest)
        || !is_digest(&row.runtime_binary_digest)
        || !is_digest(&row.policy_digest)
        || !is_digest(&row.capability_digest)
        || !matches!(row.platform.as_str(), "systrap" | "kvm")
        || !matches!(
            row.profile.as_str(),
            "node22-http-v1" | "node24-http-v1" | "nextjs16-node22-v1" | "nextjs16-node24-v1"
        )
    {
        return Err(ApiError::conflict(
            "release_runtime_ineligible",
            "the runtime tuple does not match the exact artifact and current capability evidence",
        ));
    }
    Ok(Some(row))
}

async fn load_stage_migration(
    tx: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    project_id: Uuid,
    deployment_id: Uuid,
    configuration_revision_id: Uuid,
    request: &StageReleaseRequest,
) -> Result<Option<Uuid>, ApiError> {
    let Some(database_id) = request.tenant_database_id else {
        return Ok(None);
    };
    let generation = request.database_generation.ok_or_else(ApiError::internal)?;
    let database_valid: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM tenant_databases WHERE account_id=$1 AND project_id=$2 AND id=$3 AND generation=$4 \
          AND state IN ('ready','recovery_attention'))",
    )
    .bind(account_id)
    .bind(project_id)
    .bind(database_id)
    .bind(generation)
    .fetch_one(&mut **tx)
    .await?;
    if !database_valid {
        return Err(ApiError::conflict(
            "release_database_ineligible",
            "the exact configured tenant database generation is unavailable",
        ));
    }
    let Some(revision) = request.migration_revision.as_deref() else {
        return Ok(None);
    };
    let digest = request
        .migration_digest
        .as_deref()
        .ok_or_else(ApiError::internal)?;
    let migration_id: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM tenant_database_migrations WHERE account_id=$1 AND project_id=$2 AND tenant_database_id=$3 \
          AND database_generation=$4 AND deployment_id=$5 AND configuration_revision_id=$6 AND migration_revision=$7 \
          AND migration_digest=$8 AND state IN ('planned','trial_prepared','isolated_validated','applied')",
    )
    .bind(account_id)
    .bind(project_id)
    .bind(database_id)
    .bind(generation)
    .bind(deployment_id)
    .bind(configuration_revision_id)
    .bind(revision)
    .bind(digest)
    .fetch_optional(&mut **tx)
    .await?;
    migration_id
        .ok_or_else(|| {
            ApiError::conflict(
                "release_migration_ineligible",
                "the exact prepared migration trial is unavailable",
            )
        })
        .map(Some)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SecretReference {
    service_id: Uuid,
    secret_id: Uuid,
    secret_version_id: Uuid,
    name: String,
    operation: String,
    credential_kind: String,
}

async fn load_build_secret_refs(
    tx: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    project_id: Uuid,
    build_job_id: Uuid,
) -> Result<Value, ApiError> {
    let rows: Vec<(Uuid, Uuid, Uuid, String, String, String)> = sqlx::query_as(
        "SELECT r.service_id,r.secret_id,r.secret_version_id,r.name,s.operation,r.credential_kind \
         FROM build_job_secret_refs r JOIN secrets s ON s.account_id=r.account_id AND s.project_id=r.project_id \
           AND s.service_id=r.service_id AND s.id=r.secret_id \
         WHERE r.account_id=$1 AND r.project_id=$2 AND r.job_id=$3 ORDER BY r.service_id,r.name,r.secret_version_id",
    )
    .bind(account_id)
    .bind(project_id)
    .bind(build_job_id)
    .fetch_all(&mut **tx)
    .await?;
    Ok(Value::Array(
        rows.into_iter()
            .map(|(service_id, secret_id, secret_version_id, name, operation, credential_kind)| {
                json!({"service_id":service_id,"secret_id":secret_id,"secret_version_id":secret_version_id,
                       "name":name,"operation":operation,"credential_kind":credential_kind})
            })
            .collect(),
    ))
}

async fn validate_release_secrets(
    tx: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    project_id: Uuid,
    value: &Value,
) -> Result<(), ApiError> {
    validate_secret_refs(tx, account_id, project_id, value).await
}

async fn validate_secret_refs(
    tx: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    project_id: Uuid,
    value: &Value,
) -> Result<(), ApiError> {
    let refs: Vec<SecretReference> = serde_json::from_value(value.clone()).map_err(|_| {
        ApiError::conflict(
            "release_secret_refs_invalid",
            "release secret references are malformed",
        )
    })?;
    let ids = refs.iter().map(|r| r.secret_version_id).collect::<Vec<_>>();
    if ids.iter().collect::<HashSet<_>>().len() != ids.len() {
        return Err(ApiError::conflict(
            "release_secret_refs_invalid",
            "release secret references must be unique",
        ));
    }
    for reference in refs {
        let valid: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM secret_versions v JOIN secrets s ON s.id=v.secret_id AND s.account_id=v.account_id \
              AND s.project_id=v.project_id AND s.service_id=v.service_id WHERE v.id=$1 AND v.account_id=$2 AND v.project_id=$3 \
              AND v.service_id=$4 AND v.secret_id=$5 AND s.name=$6 AND s.operation=$7 AND s.credential_kind=$8 AND s.status='active')",
        )
        .bind(reference.secret_version_id)
        .bind(account_id)
        .bind(project_id)
        .bind(reference.service_id)
        .bind(reference.secret_id)
        .bind(&reference.name)
        .bind(&reference.operation)
        .bind(&reference.credential_kind)
        .fetch_one(&mut **tx)
        .await?;
        if !valid {
            return Err(ApiError::conflict(
                "release_secret_version_expired",
                "a retained release secret version is no longer valid for runtime",
            ));
        }
    }
    Ok(())
}

async fn validate_route_generation(
    tx: &mut Transaction<'_, Postgres>,
    reconciliation: &ReconciliationRecord,
) -> Result<(), ApiError> {
    let generation: i64 = sqlx::query_scalar(
        "SELECT COALESCE((SELECT generation FROM project_release_routes WHERE account_id=$1 AND project_id=$2 FOR UPDATE),0)",
    )
    .bind(reconciliation.account_id)
    .bind(reconciliation.project_id)
    .fetch_one(&mut **tx)
    .await?;
    if generation != reconciliation.expected_route_generation {
        return Err(ApiError::conflict(
            "release_route_generation_stale",
            "the project route changed after this reconciliation was created",
        ));
    }
    Ok(())
}

fn validate_prepared_route_intent(reconciliation: &ReconciliationRecord) -> Result<(), ApiError> {
    let result = reconciliation.result.as_ref().ok_or_else(|| {
        ApiError::conflict(
            "release_prepared_intent_missing",
            "the prepared route intent is unavailable",
        )
    })?;
    let manifest_json = result
        .get("route_manifest_json")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ApiError::conflict(
                "release_prepared_intent_missing",
                "the exact prepared route bytes are unavailable",
            )
        })?;
    let manifest_digest = result
        .get("route_manifest_digest")
        .and_then(Value::as_str)
        .ok_or_else(evidence_invalid)?;
    let route_generation = result
        .get("route_generation")
        .and_then(Value::as_i64)
        .ok_or_else(evidence_invalid)?;
    let parsed: Value = serde_json::from_str(manifest_json).map_err(|_| evidence_invalid())?;
    let project_id = reconciliation.project_id.to_string();
    let release_id = reconciliation.release_id.to_string();
    if prefixed_digest(manifest_json.as_bytes()) != manifest_digest
        || result.get("route_manifest") != Some(&parsed)
        || route_generation != reconciliation.expected_route_generation + 1
        || parsed.get("project_id").and_then(Value::as_str) != Some(project_id.as_str())
        || parsed.get("release_id").and_then(Value::as_str) != Some(release_id.as_str())
        || parsed.get("generation").and_then(Value::as_i64) != Some(route_generation)
        || parsed.get("drain_expires_at") != result.get("drain_expires_at")
    {
        return Err(ApiError::conflict(
            "release_prepared_intent_invalid",
            "the prepared route bytes do not match the durable route intent",
        ));
    }
    Ok(())
}

async fn lock_live_reconciliation(
    tx: &mut Transaction<'_, Postgres>,
    reconciliation_id: Uuid,
    attempt_id: Uuid,
    fence: i64,
    worker_id: &str,
    expected_state: &str,
) -> Result<ReconciliationRecord, ApiError> {
    if fence <= 0 {
        return Err(fenced());
    }
    sqlx::query_as(
        "SELECT r.id,r.account_id,r.project_id,r.release_id,r.kind,r.state,r.expected_route_generation,r.requirements,\
                r.attempt_count,r.current_attempt_id,r.current_fence,r.lease_expires_at,r.terminal_code,r.result,r.created_at,r.updated_at \
         FROM release_reconciliations r JOIN release_reconciliation_attempts a ON a.reconciliation_id=r.id \
          AND a.id=r.current_attempt_id AND a.fence=r.current_fence \
         WHERE r.id=$1 AND r.state=$2 AND r.current_attempt_id=$3 AND r.current_fence=$4 \
           AND a.worker_id=$5 AND a.state='running' AND r.lease_expires_at>clock_timestamp() AND a.lease_expires_at>clock_timestamp() \
         FOR UPDATE OF r,a",
    )
    .bind(reconciliation_id)
    .bind(expected_state)
    .bind(attempt_id)
    .bind(fence)
    .bind(worker_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(fenced)
}

async fn expire_reconciliations(tx: &mut Transaction<'_, Postgres>) -> Result<(), ApiError> {
    let expired: Vec<(Uuid, Uuid, i32, String, Uuid)> = sqlx::query_as(
        "SELECT id,current_attempt_id,attempt_count,kind,release_id FROM release_reconciliations \
         WHERE state='running' AND lease_expires_at<=clock_timestamp() ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 64",
    )
    .fetch_all(&mut **tx)
    .await?;
    for (id, attempt_id, attempt_count, kind, release_id) in expired {
        sqlx::query(
            "UPDATE release_reconciliation_attempts SET state='expired',finished_at=clock_timestamp(),terminal_code='lease_expired' \
             WHERE reconciliation_id=$1 AND id=$2 AND state='running'",
        )
        .bind(id)
        .bind(attempt_id)
        .execute(&mut **tx)
        .await?;
        let exhausted = attempt_count >= MAX_ATTEMPTS;
        sqlx::query(
            "UPDATE release_reconciliations SET state=$2,terminal_code='lease_expired',current_attempt_id=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=$1",
        )
        .bind(id)
        .bind(if exhausted { "failed" } else { "retriable" })
        .execute(&mut **tx)
        .await?;
        if exhausted && kind == "promote" {
            sqlx::query(
                "UPDATE application_releases SET state='failed',failure_code='release_reconciliation_exhausted',updated_at=clock_timestamp() WHERE id=$1 AND state='staged'",
            )
            .bind(release_id)
            .execute(&mut **tx)
            .await?;
        }
    }
    Ok(())
}

async fn fail_migration_reconciliations(
    tx: &mut Transaction<'_, Postgres>,
) -> Result<(), ApiError> {
    let failed: Vec<(Uuid, Uuid, String)> = sqlx::query_as(
        "SELECT r.id,r.release_id,CASE WHEN r.state='awaiting_trial' THEN 'migration_trial_failed' ELSE 'migration_live_apply_failed' END \
         FROM release_reconciliations r JOIN application_releases release ON release.id=r.release_id \
         JOIN tenant_database_migrations migration ON migration.id=release.migration_id \
         JOIN tenant_database_operations operation ON operation.id=(r.result->>'migration_operation_id')::uuid \
         WHERE ((r.state='awaiting_trial' AND operation.kind='migration_trial') \
           OR (r.state='awaiting_live_apply' AND operation.kind='migration_live_apply')) \
           AND operation.state IN ('failed','canceled') \
         FOR UPDATE OF r,release",
    )
    .fetch_all(&mut **tx)
    .await?;
    for (reconciliation_id, release_id, code) in failed {
        sqlx::query(
            "UPDATE release_reconciliations SET state='failed',terminal_code=$2,updated_at=clock_timestamp() WHERE id=$1",
        )
        .bind(reconciliation_id)
        .bind(&code)
        .execute(&mut **tx)
        .await?;
        sqlx::query(
            "UPDATE application_releases SET state='failed',failure_code=$2,updated_at=clock_timestamp() WHERE id=$1 AND state='staged'",
        )
        .bind(release_id)
        .bind(&code)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

fn validate_completion(outcome: &CompletionOutcome) -> Result<(), ApiError> {
    if !matches!(outcome.state.as_str(), "succeeded" | "failed" | "retriable")
        || outcome.code.is_empty()
        || outcome.code.len() > 96
        || !outcome
            .code
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
        || outcome.probe_receipt_digests.iter().any(|v| !is_digest(v))
        || outcome
            .migration_apply_receipt_digest
            .as_deref()
            .is_some_and(|v| !is_digest(v))
        || outcome
            .migration_stage_receipt_digest
            .as_deref()
            .is_some_and(|v| !is_digest(v))
        || outcome
            .migration_materialized_ref
            .as_deref()
            .is_some_and(|v| {
                v.is_empty() || v.len() > 1024 || v.starts_with('/') || v.contains("..")
            })
        || outcome.state == "succeeded" && outcome.code != "release_checks_passed"
    {
        return Err(ApiError::unprocessable(
            "release_completion_invalid",
            "the release completion has an unsupported state, code, or digest",
        ));
    }
    Ok(())
}

async fn finish_unsuccessful(
    tx: &mut Transaction<'_, Postgres>,
    reconciliation: &ReconciliationRecord,
    attempt_id: Uuid,
    fence: i64,
    outcome: &CompletionOutcome,
    completion_hash: &[u8],
) -> Result<(), ApiError> {
    let state = if outcome.state == "retriable" && reconciliation.attempt_count < MAX_ATTEMPTS {
        "retriable"
    } else {
        "failed"
    };
    sqlx::query(
        "UPDATE release_reconciliation_attempts SET state=$4,finished_at=clock_timestamp(),terminal_code=$5,completion_hash=$6 \
         WHERE reconciliation_id=$1 AND id=$2 AND fence=$3 AND state='running'",
    )
    .bind(reconciliation.id)
    .bind(attempt_id)
    .bind(fence)
    .bind(state)
    .bind(&outcome.code)
    .bind(completion_hash)
    .execute(&mut **tx)
    .await?;
    sqlx::query(
        "UPDATE release_reconciliations SET state=$2,terminal_code=$3,result=$4,current_attempt_id=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=$1",
    )
    .bind(reconciliation.id)
    .bind(state)
    .bind(&outcome.code)
    .bind(json!({"probe_receipt_digests":outcome.probe_receipt_digests}))
    .execute(&mut **tx)
    .await?;
    if state == "failed" && reconciliation.kind == "promote" {
        sqlx::query(
            "UPDATE application_releases SET state='failed',failure_code=$2,updated_at=clock_timestamp() WHERE id=$1 AND state='staged'",
        )
        .bind(reconciliation.release_id)
        .bind(&outcome.code)
        .execute(&mut **tx)
        .await?;
        insert_release_event(
            tx,
            reconciliation.account_id,
            reconciliation.project_id,
            reconciliation.release_id,
            format!("failed:{}", reconciliation.id),
            "failed",
            None,
            json!({"code":outcome.code}),
        )
        .await?;
    }
    Ok(())
}

fn migration_validation(
    candidate: &LoadedRelease,
    current: Option<&LoadedRelease>,
    retained: &[LoadedRelease],
    receipts: &[(String, ProbeReceipt)],
    context: &MigrationValidationContext<'_>,
) -> Result<MigrationRuntimeValidation, ApiError> {
    let database_generation = candidate
        .release
        .database_generation
        .ok_or_else(ApiError::internal)?;
    let migration_digest = candidate
        .release
        .migration_digest
        .as_ref()
        .ok_or_else(ApiError::internal)?;
    let mut kinds = HashMap::new();
    kinds.insert(candidate.release.id, "candidate");
    if let Some(current) = current {
        kinds.insert(current.release.id, "current");
    }
    for release in retained {
        kinds.insert(release.release.id, "retained");
    }
    let mut probes = Vec::new();
    let mut cross = Vec::new();
    let mut latest = Utc
        .timestamp_opt(0, 0)
        .single()
        .ok_or_else(ApiError::internal)?;
    for (digest, receipt) in receipts {
        let observed_at = Utc
            .timestamp_millis_opt(receipt.observed_at_unix_ms)
            .single()
            .ok_or_else(evidence_invalid)?;
        latest = latest.max(observed_at);
        if receipt.check_kind == "current_data" {
            probes.push(MigrationProbeReceipt {
                application_release_id: receipt.release_id,
                artifact_digest: receipt.artifact_digest.clone(),
                runtime_allocation_id: receipt.allocation_id,
                runtime_generation: i64::try_from(receipt.generation)
                    .map_err(|_| evidence_invalid())?,
                runtime_fence: i64::try_from(receipt.fence).map_err(|_| evidence_invalid())?,
                database_generation,
                migration_id: context.migration_id,
                migration_digest: migration_digest.clone(),
                probe_kind: kinds
                    .get(&receipt.release_id)
                    .ok_or_else(evidence_invalid)?
                    .to_string(),
                probe_receipt_digest: digest.clone(),
                observed_at,
            });
        } else if receipt.check_kind.contains("frontend") {
            cross.push(CrossVersionProbeReceipt {
                frontend_release_id: receipt.release_id,
                api_release_id: receipt.peer_release_id.ok_or_else(evidence_invalid)?,
                receipt_digest: digest.clone(),
            });
        }
    }
    Ok(MigrationRuntimeValidation {
        release_id: candidate.release.id,
        reconciliation_id: context.reconciliation_id,
        attempt_id: context.attempt_id,
        release_fence: context.release_fence,
        migration_id: context.migration_id,
        migration_apply_receipt_digest: context.apply_digest.to_owned(),
        probe_receipts: probes,
        cross_version_receipts: cross,
        validated_at: latest,
    })
}

fn route_manifest(
    candidate: &LoadedRelease,
    current: Option<&LoadedRelease>,
    retained: &[LoadedRelease],
    generation: i64,
    drain_expires_at: DateTime<Utc>,
) -> Value {
    let retained_assets = current
        .into_iter()
        .chain(retained.iter())
        .filter_map(|release| {
            release.lease.frontend.as_ref().map(|artifact| {
                json!({"release_id":release.release.id,"archive_digest":artifact.archive_digest,
                       "manifest_digest":artifact.manifest_digest})
            })
        })
        .collect::<Vec<_>>();
    let backend = candidate.runtime.as_ref().map(|runtime| {
        json!({
            "backend_ref":format!("runtime-allocation:{}:{}:{}",runtime.allocation_id,runtime.generation,runtime.fence),
            "allocation_id":runtime.allocation_id,"generation":runtime.generation,"fence":runtime.fence,
            "artifact_digest":runtime.artifact_digest,"artifact_manifest_digest":runtime.artifact_manifest_digest,
        })
    });
    let database = candidate.release.tenant_database_id.map(|id| {
        json!({"tenant_database_id":id,"database_generation":candidate.release.database_generation,
               "migration_id":candidate.release.migration_id,"migration_revision":candidate.release.migration_revision,
               "migration_digest":candidate.release.migration_digest,
               "migration_artifact_path":candidate.release.migration_artifact_path})
    });
    json!({
        "schema":"hostlet.route-manifest/v1",
        "project_id":candidate.release.project_id,
        "release_id":candidate.release.id,
        "deployment_id":candidate.release.deployment_id,
        "source_commit":candidate.release.source_commit,
        "generation":generation,
        "frontend":candidate.lease.frontend.as_ref().map(|a|json!({"archive_digest":a.archive_digest,"manifest_digest":a.manifest_digest})),
        "backend":backend,
        "database":database,
        "configuration_revision_id":candidate.release.configuration_revision_id,
        "secret_version_refs":candidate.release.secret_version_refs,
        "health":{
            "staged_health_observation_id":candidate.release.staged_health_observation_id,
            "staged_health_receipt_digest":candidate.release.staged_health_receipt_digest,
        },
        "previous_release_id":current.map(|r|r.release.id),
        "retained_assets":retained_assets,
        "drain_expires_at":drain_expires_at,
    })
}

fn validate_switch_receipt(
    receipt: &SwitchReceipt,
    reconciliation: &ReconciliationRecord,
    attempt_id: Uuid,
    fence: i64,
    previous_release_id: Option<Uuid>,
    route_generation: i64,
    manifest_digest: &str,
) -> Result<(), ApiError> {
    let observed_at = Utc
        .timestamp_millis_opt(receipt.observed_at_unix_ms)
        .single()
        .ok_or_else(evidence_invalid)?;
    if receipt.schema != "hostlet.release-route-switch/v1"
        || receipt.reconciliation_id != reconciliation.id
        || receipt.attempt_id != attempt_id
        || receipt.fence != u64::try_from(fence).map_err(|_| evidence_invalid())?
        || receipt.project_id != reconciliation.project_id
        || receipt.release_id != reconciliation.release_id
        || receipt.previous_release_id != previous_release_id
        || receipt.route_generation
            != u64::try_from(route_generation).map_err(|_| evidence_invalid())?
        || receipt.route_manifest_digest != manifest_digest
        || receipt.result != "switched"
        || observed_at > Utc::now() + Duration::minutes(5)
        || Utc::now() - observed_at > Duration::hours(1)
    {
        return Err(ApiError::conflict(
            "release_switch_receipt_mismatch",
            "the gateway switch receipt does not match the prepared route",
        ));
    }
    Ok(())
}

async fn retire_excess_releases(
    tx: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    project_id: Uuid,
    current_release_id: Uuid,
) -> Result<Vec<Uuid>, ApiError> {
    let ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM application_releases WHERE account_id=$1 AND project_id=$2 AND state='healthy' AND id<>$3 \
         ORDER BY promoted_at DESC,id DESC OFFSET 2",
    )
    .bind(account_id)
    .bind(project_id)
    .bind(current_release_id)
    .fetch_all(&mut **tx)
    .await?;
    if !ids.is_empty() {
        sqlx::query(
            "UPDATE application_releases SET state='retired',updated_at=clock_timestamp() WHERE id=ANY($1) AND state='healthy'",
        )
        .bind(&ids)
        .execute(&mut **tx)
        .await?;
        for id in &ids {
            insert_release_event(
                tx,
                account_id,
                project_id,
                *id,
                format!("retired:{current_release_id}"),
                "retired",
                None,
                json!({"retained_by_release_id":current_release_id}),
            )
            .await?;
        }
    }
    Ok(ids)
}

#[allow(clippy::too_many_arguments)]
async fn insert_release_event(
    tx: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    project_id: Uuid,
    release_id: Uuid,
    event_key: String,
    kind: &str,
    route_generation: Option<i64>,
    evidence: Value,
) -> Result<(), ApiError> {
    sqlx::query(
        "INSERT INTO application_release_events (id,account_id,project_id,release_id,event_key,kind,route_generation,evidence,occurred_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()) ON CONFLICT (release_id,event_key) DO NOTHING",
    )
    .bind(Uuid::new_v4())
    .bind(account_id)
    .bind(project_id)
    .bind(release_id)
    .bind(event_key)
    .bind(kind)
    .bind(route_generation)
    .bind(evidence)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

fn read_evidence(state: &FoundationState, digest: &str) -> Result<Vec<u8>, ApiError> {
    let hex = digest_hex(digest)?;
    let root = &m3::require_enabled(state)?.state_dir;
    let path: PathBuf = root
        .join("evidence")
        .join("sha256")
        .join(&hex[..2])
        .join(format!("{}.json", &hex[2..]));
    let link = std::fs::symlink_metadata(&path).map_err(|_| evidence_missing())?;
    if !link.file_type().is_file()
        || link.len() > MAX_RECEIPT_BYTES
        || link.permissions().mode() & 0o077 != 0
        || std::fs::canonicalize(&path).ok().as_ref() != Some(&path)
    {
        return Err(evidence_invalid());
    }
    let mut file = File::open(&path).map_err(|_| evidence_missing())?;
    let opened = file.metadata().map_err(|_| evidence_invalid())?;
    if opened.dev() != link.dev() || opened.ino() != link.ino() {
        return Err(evidence_invalid());
    }
    let mut bytes = Vec::with_capacity(opened.len() as usize);
    file.read_to_end(&mut bytes)
        .map_err(|_| evidence_invalid())?;
    if bytes.len() as u64 != opened.len()
        || Sha256::digest(&bytes).as_slice() != decode_hex(&hex)?.as_slice()
    {
        return Err(ApiError::conflict(
            "release_evidence_digest_mismatch",
            "the release evidence file does not match its digest",
        ));
    }
    Ok(bytes)
}

fn value_string<'a>(value: &'a Value, field: &str) -> Result<&'a str, ApiError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(ApiError::internal)
}

fn value_i64(value: &Value, field: &str) -> Result<i64, ApiError> {
    value
        .get(field)
        .and_then(Value::as_i64)
        .ok_or_else(ApiError::internal)
}

fn prefixed_digest(bytes: &[u8]) -> String {
    format!("sha256:{}", hex_encode(&Sha256::digest(bytes)))
}

fn is_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

fn valid_migration_path(value: &str) -> bool {
    value.starts_with("dist/migrations/")
        && value.len() <= 1024
        && !value.contains(['\\', '\0', '\r', '\n'])
        && !value
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
}

fn digest_hex(value: &str) -> Result<String, ApiError> {
    value
        .strip_prefix("sha256:")
        .filter(|_| is_digest(value))
        .map(str::to_owned)
        .ok_or_else(evidence_invalid)
}

fn decode_hex(value: &str) -> Result<Vec<u8>, ApiError> {
    (0..value.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&value[i..i + 2], 16).map_err(|_| evidence_invalid()))
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

fn validate_worker_id(value: &str) -> Result<(), ApiError> {
    if value.is_empty()
        || value.len() > 128
        || value.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err(ApiError::unprocessable(
            "release_worker_id_invalid",
            "worker_id must contain 1 to 128 non-whitespace bytes",
        ));
    }
    Ok(())
}

fn serialize_zeroizing<S>(value: &Zeroizing<String>, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    serializer.serialize_str(value.as_str())
}

fn fenced() -> ApiError {
    ApiError::conflict(
        "release_reconciliation_fenced",
        "the release reconciliation lease is no longer current",
    )
}

fn evidence_missing() -> ApiError {
    ApiError::unprocessable(
        "release_evidence_missing",
        "the digest-addressed release evidence is unavailable",
    )
}

fn evidence_invalid() -> ApiError {
    ApiError::unprocessable(
        "release_evidence_invalid",
        "the digest-addressed release evidence is invalid",
    )
}

fn idempotency_changed() -> ApiError {
    ApiError::conflict(
        "idempotency_payload_changed",
        "the idempotency key was already used with a different request",
    )
}
