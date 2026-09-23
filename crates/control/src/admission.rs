use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::{
    auth::Authenticated,
    error::{ApiError, SafeJson},
    foundation::FoundationState,
    intent::{self, Replay},
    jobs::WorkerAuth,
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HoldRecord {
    id: Uuid,
    kind: String,
    state: String,
    project_id: Uuid,
    deployment_id: Uuid,
    source_proof_id: Uuid,
    expires_at: DateTime<Utc>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReservationRecord {
    id: Uuid,
    project_id: Uuid,
    first_deployment_id: Uuid,
    state: String,
    reservation_epoch: Uuid,
    retention_reason: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AdmissionResponse {
    hold: HoldRecord,
    reservation: Option<ReservationRecord>,
    admitted_for_later_execution: bool,
    execution_enqueued: bool,
}

#[derive(Serialize)]
#[serde(deny_unknown_fields)]
pub struct EntitlementSummary {
    source: String,
    hosted_slot_limit: i32,
    hosted_slots_used: i64,
    active_initial_holds: i64,
    build_seconds_limit: i32,
    build_seconds_debited: i64,
    build_seconds_credited: i64,
    build_seconds_remaining: i64,
    period_starts_at: DateTime<Utc>,
    period_ends_at: DateTime<Utc>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateHoldRequest {
    source_proof_id: Uuid,
    ttl_seconds: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct AdmitRequest {
    capacity_hold_id: Uuid,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CapacityFixtureRequest {
    event_id: Uuid,
    pool_key: String,
    profile: String,
    hosted_slot_limit: i32,
    rollout_headroom_limit: i32,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CapacityFixtureResponse {
    pool_key: String,
    profile: String,
    hosted_slot_limit: i32,
    rollout_headroom_limit: i32,
    revision: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct EntitlementFixtureRequest {
    event_id: Uuid,
    account_id: Uuid,
    capacity_pool_key: String,
    hosted_slot_limit: i32,
    build_seconds_limit: i32,
    period_starts_at: DateTime<Utc>,
    period_ends_at: DateTime<Utc>,
    state: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct EntitlementFixtureResponse {
    id: Uuid,
    account_id: Uuid,
    capacity_pool_key: String,
    source: String,
    hosted_slot_limit: i32,
    build_seconds_limit: i32,
    period_starts_at: DateTime<Utc>,
    period_ends_at: DateTime<Utc>,
    state: String,
    revision: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SourceProofFixtureRequest {
    event_id: Uuid,
    account_id: Uuid,
    project_id: Uuid,
    deployment_id: Uuid,
    configuration_revision_id: Uuid,
    source_commit: String,
    inventory_revision: i64,
    expires_at: DateTime<Utc>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SourceProofResponse {
    id: Uuid,
    account_id: Uuid,
    project_id: Uuid,
    deployment_id: Uuid,
    configuration_revision_id: Uuid,
    source_commit: String,
    inventory_revision: i64,
    source: String,
    state: String,
    expires_at: DateTime<Utc>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ResourceObservationRequest {
    event_id: Uuid,
    account_id: Uuid,
    project_id: Uuid,
    deployment_id: Uuid,
    reservation_id: Uuid,
    reservation_epoch: Uuid,
    outcome: String,
    resource_inventory: String,
    proof_ref: String,
    rollout_hold_id: Option<Uuid>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ResourceObservationResponse {
    id: Uuid,
    outcome: String,
    reservation: ReservationRecord,
    released_rollout_hold_id: Option<Uuid>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct BuildUsageRequest {
    event_id: Uuid,
    account_id: Uuid,
    project_id: Uuid,
    deployment_id: Uuid,
    attempt_id: Uuid,
    kind: String,
    seconds: i32,
    debit_event_id: Option<Uuid>,
    platform_fault_ref: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct BuildUsageResponse {
    id: Uuid,
    kind: String,
    attempt_id: Uuid,
    seconds: i32,
    debit_event_id: Option<Uuid>,
    build_seconds_remaining: i64,
    execution_enqueued: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReconcileRequest {}

#[derive(Serialize)]
struct ReconcileResponse {
    expired_holds: u64,
}

type EntitlementLockRow = (Uuid, String, i32, i32, DateTime<Utc>, DateTime<Utc>, String);

#[derive(sqlx::FromRow)]
struct EntitlementFixtureRow {
    id: Uuid,
    account_id: Uuid,
    capacity_pool_key: String,
    source: String,
    hosted_slot_limit: i32,
    build_seconds_limit: i32,
    period_starts_at: DateTime<Utc>,
    period_ends_at: DateTime<Utc>,
    state: String,
    revision: i64,
}

#[derive(sqlx::FromRow)]
struct LockedSourceProofRow {
    deployment_id: Uuid,
    configuration_revision_id: Uuid,
    source_commit: String,
    state: String,
    expires_at: DateTime<Utc>,
}

#[derive(sqlx::FromRow)]
struct HoldRow {
    id: Uuid,
    kind: String,
    state: String,
    project_id: Uuid,
    deployment_id: Uuid,
    source_proof_id: Uuid,
    expires_at: DateTime<Utc>,
}

#[derive(sqlx::FromRow)]
struct EntitlementSummaryRow {
    source: String,
    hosted_slot_limit: i32,
    build_seconds_limit: i32,
    period_starts_at: DateTime<Utc>,
    period_ends_at: DateTime<Utc>,
}

pub fn routes() -> Router<FoundationState> {
    Router::new()
        .route(
            "/v1/projects/{project_id}/deployments/{deployment_id}/capacity-holds",
            post(create_hold).get(get_hold),
        )
        .route(
            "/v1/projects/{project_id}/deployments/{deployment_id}/admissions",
            post(admit),
        )
        .route(
            "/v1/projects/{project_id}/slot-reservation",
            get(get_reservation),
        )
        .route("/v1/entitlements/current", get(get_entitlement))
}

pub fn internal_routes() -> Router<FoundationState> {
    Router::new()
        .route(
            "/internal/v1/admission/capacity",
            post(put_capacity_fixture),
        )
        .route(
            "/internal/v1/admission/entitlements",
            post(put_entitlement_fixture),
        )
        .route(
            "/internal/v1/admission/source-proofs",
            post(put_source_proof),
        )
        .route(
            "/internal/v1/admission/resource-observations",
            post(record_resource_observation),
        )
        .route(
            "/internal/v1/admission/build-usage",
            post(record_build_usage),
        )
        .route("/internal/v1/admission/reconcile", post(run_reconcile))
}

async fn create_hold(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    Path((project_id, deployment_id)): Path<(String, String)>,
    headers: HeaderMap,
    SafeJson(request): SafeJson<CreateHoldRequest>,
) -> Result<(StatusCode, Json<AdmissionResponse>), ApiError> {
    if !(5..=300).contains(&request.ttl_seconds) {
        return Err(ApiError::unprocessable(
            "invalid_hold_ttl",
            "ttl_seconds must be between 5 and 300",
        ));
    }
    let account_id = authenticated.account_id()?;
    let project_id = intent::path_uuid(&project_id)?;
    let deployment_id = intent::path_uuid(&deployment_id)?;
    let expected_revision = intent::if_match_revision(&headers)?;
    let key = intent::idempotency_key(&headers)?;
    let request_hash = intent::request_hash(&request)?;
    let operation = format!("admission.hold.create/{project_id}/{deployment_id}");
    let mut tx = state.pool.begin().await?;
    intent::acquire_operation_lock(&mut tx, account_id, &operation, key).await?;
    match intent::replay(&mut tx, account_id, &operation, key, &request_hash).await? {
        Replay::Match(response) => {
            let response = refresh_admission_response(&mut tx, account_id, response).await?;
            tx.commit().await?;
            return Ok((StatusCode::CREATED, Json(response)));
        }
        Replay::Changed => return Err(idempotency_conflict()),
        Replay::Miss => {}
    }

    let entitlement = lock_entitlement_and_pool(&mut tx, account_id).await?;
    expire_holds_for_scope(&mut tx, account_id, &entitlement.1).await?;
    ensure_entitlement_active(&mut tx, &entitlement).await?;
    ensure_build_allowance(&mut tx, account_id, &entitlement).await?;
    lock_project_revision(&mut tx, account_id, project_id, expected_revision).await?;
    validate_source_proof(
        &mut tx,
        account_id,
        project_id,
        deployment_id,
        request.source_proof_id,
    )
    .await?;
    ensure_lifecycle_allows_hold(&mut tx, account_id, project_id, deployment_id).await?;

    let active_reservation = load_active_reservation(&mut tx, account_id, project_id).await?;
    let kind = if active_reservation.is_some() {
        "rollout"
    } else {
        "initial"
    };
    let conflicting_hold: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM capacity_holds WHERE project_id=$1 AND deployment_id=$2 \
         AND kind=$3 AND ((kind='initial' AND state='active') OR \
                          (kind='rollout' AND state IN ('active','consumed'))))",
    )
    .bind(project_id)
    .bind(deployment_id)
    .bind(kind)
    .fetch_one(&mut *tx)
    .await?;
    if conflicting_hold {
        return Err(ApiError::conflict(
            "capacity_hold_exists",
            "an in-flight capacity hold already exists for this deployment",
        ));
    }
    ensure_capacity_available(&mut tx, account_id, &entitlement, kind).await?;

    let hold_id = Uuid::new_v4();
    let expires_at: DateTime<Utc> =
        sqlx::query_scalar("SELECT clock_timestamp() + ($1::bigint * interval '1 second')")
            .bind(request.ttl_seconds)
            .fetch_one(&mut *tx)
            .await?;
    sqlx::query(
        "INSERT INTO capacity_holds \
         (id,account_id,project_id,deployment_id,source_proof_id,entitlement_id,capacity_pool_key, \
          reservation_id,reservation_epoch,kind,state,expires_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',$11)",
    )
    .bind(hold_id)
    .bind(account_id)
    .bind(project_id)
    .bind(deployment_id)
    .bind(request.source_proof_id)
    .bind(entitlement.0)
    .bind(&entitlement.1)
    .bind(active_reservation.as_ref().map(|value| value.id))
    .bind(
        active_reservation
            .as_ref()
            .map(|value| value.reservation_epoch),
    )
    .bind(kind)
    .bind(expires_at)
    .execute(&mut *tx)
    .await?;
    let response = AdmissionResponse {
        hold: load_hold(&mut tx, account_id, project_id, hold_id).await?,
        reservation: active_reservation,
        admitted_for_later_execution: false,
        execution_enqueued: false,
    };
    intent::audit(
        &mut tx,
        account_id,
        authenticated.session_id(),
        "admission.hold.create",
        "capacity_hold",
        Some(hold_id),
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

async fn admit(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    Path((project_id, deployment_id)): Path<(String, String)>,
    headers: HeaderMap,
    SafeJson(request): SafeJson<AdmitRequest>,
) -> Result<(StatusCode, Json<AdmissionResponse>), ApiError> {
    let account_id = authenticated.account_id()?;
    let project_id = intent::path_uuid(&project_id)?;
    let deployment_id = intent::path_uuid(&deployment_id)?;
    let expected_revision = intent::if_match_revision(&headers)?;
    let key = intent::idempotency_key(&headers)?;
    let request_hash = intent::request_hash(&request)?;
    let operation = format!("admission.consume/{project_id}/{deployment_id}");
    let mut tx = state.pool.begin().await?;
    intent::acquire_operation_lock(&mut tx, account_id, &operation, key).await?;
    match intent::replay(&mut tx, account_id, &operation, key, &request_hash).await? {
        Replay::Match(response) => {
            let response = refresh_admission_response(&mut tx, account_id, response).await?;
            tx.commit().await?;
            return Ok((StatusCode::OK, Json(response)));
        }
        Replay::Changed => return Err(idempotency_conflict()),
        Replay::Miss => {}
    }

    let entitlement = lock_entitlement_and_pool(&mut tx, account_id).await?;
    expire_holds_for_scope(&mut tx, account_id, &entitlement.1).await?;
    ensure_entitlement_active(&mut tx, &entitlement).await?;
    ensure_build_allowance(&mut tx, account_id, &entitlement).await?;
    lock_project_revision(&mut tx, account_id, project_id, expected_revision).await?;
    let hold: Option<(String, String, Uuid, DateTime<Utc>)> = sqlx::query_as(
        "SELECT kind,state,source_proof_id,expires_at FROM capacity_holds \
         WHERE id=$1 AND account_id=$2 AND project_id=$3 AND deployment_id=$4 FOR UPDATE",
    )
    .bind(request.capacity_hold_id)
    .bind(account_id)
    .bind(project_id)
    .bind(deployment_id)
    .fetch_optional(&mut *tx)
    .await?;
    let (kind, hold_state, source_proof_id, expires_at) = hold.ok_or_else(ApiError::not_found)?;
    if hold_state != "active" || expires_at <= database_now(&mut tx).await? {
        tx.commit().await?;
        return Err(ApiError::conflict(
            "capacity_hold_expired",
            "the capacity hold is no longer active",
        ));
    }
    validate_source_proof(
        &mut tx,
        account_id,
        project_id,
        deployment_id,
        source_proof_id,
    )
    .await?;
    ensure_lifecycle_allows_hold(&mut tx, account_id, project_id, deployment_id).await?;

    let (reservation, status) = if kind == "initial" {
        let reservation_id = Uuid::new_v4();
        let epoch = Uuid::new_v4();
        sqlx::query(
            "UPDATE capacity_holds SET state='consumed',consumed_at=clock_timestamp() WHERE id=$1",
        )
        .bind(request.capacity_hold_id)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO slot_reservations \
             (id,account_id,project_id,first_deployment_id,entitlement_id,capacity_pool_key,initial_hold_id,reservation_epoch,state) \
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'reserved')",
        )
        .bind(reservation_id)
        .bind(account_id)
        .bind(project_id)
        .bind(deployment_id)
        .bind(entitlement.0)
        .bind(&entitlement.1)
        .bind(request.capacity_hold_id)
        .bind(epoch)
        .execute(&mut *tx)
        .await?;
        project_reserved(&mut tx, account_id, project_id, deployment_id).await?;
        (
            load_reservation(&mut tx, account_id, project_id, reservation_id).await?,
            StatusCode::CREATED,
        )
    } else {
        sqlx::query(
            "UPDATE capacity_holds SET state='consumed',consumed_at=clock_timestamp() WHERE id=$1",
        )
        .bind(request.capacity_hold_id)
        .execute(&mut *tx)
        .await?;
        let reservation = load_active_reservation(&mut tx, account_id, project_id)
            .await?
            .ok_or_else(|| {
                ApiError::conflict(
                    "slot_reservation_missing",
                    "rollout admission requires an active project slot",
                )
            })?;
        rollout_admitted(&mut tx, account_id, project_id, deployment_id).await?;
        (reservation, StatusCode::OK)
    };
    let response = AdmissionResponse {
        hold: load_hold(&mut tx, account_id, project_id, request.capacity_hold_id).await?,
        reservation: Some(reservation),
        admitted_for_later_execution: true,
        execution_enqueued: false,
    };
    intent::audit(
        &mut tx,
        account_id,
        authenticated.session_id(),
        "admission.consume",
        "slot_reservation",
        response.reservation.as_ref().map(|value| value.id),
        "succeeded",
    )
    .await?;
    intent::store_replay(
        &mut tx,
        account_id,
        &operation,
        key,
        &request_hash,
        status.as_u16() as i16,
        &response,
    )
    .await?;
    tx.commit().await?;
    Ok((status, Json(response)))
}

async fn get_hold(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    Path((project_id, deployment_id)): Path<(String, String)>,
) -> Result<Json<HoldRecord>, ApiError> {
    let account_id = authenticated.account_id()?;
    let project_id = intent::path_uuid(&project_id)?;
    let deployment_id = intent::path_uuid(&deployment_id)?;
    let mut tx = state.pool.begin().await?;
    let hold_id: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM capacity_holds WHERE account_id=$1 AND project_id=$2 AND deployment_id=$3 \
         ORDER BY created_at DESC,id DESC LIMIT 1",
    )
    .bind(account_id)
    .bind(project_id)
    .bind(deployment_id)
    .fetch_optional(&mut *tx)
    .await?;
    let response = load_hold(
        &mut tx,
        account_id,
        project_id,
        hold_id.ok_or_else(ApiError::not_found)?,
    )
    .await?;
    tx.commit().await?;
    Ok(Json(response))
}

async fn get_reservation(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    Path(project_id): Path<String>,
) -> Result<Json<ReservationRecord>, ApiError> {
    let account_id = authenticated.account_id()?;
    let project_id = intent::path_uuid(&project_id)?;
    let mut tx = state.pool.begin().await?;
    let response = load_active_reservation(&mut tx, account_id, project_id)
        .await?
        .ok_or_else(ApiError::not_found)?;
    tx.commit().await?;
    Ok(Json(response))
}

async fn get_entitlement(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
) -> Result<Json<EntitlementSummary>, ApiError> {
    let account_id = authenticated.account_id()?;
    let mut tx = state.pool.begin().await?;
    let response = entitlement_summary(&mut tx, account_id).await?;
    tx.commit().await?;
    Ok(Json(response))
}

async fn put_capacity_fixture(
    _worker: WorkerAuth,
    State(state): State<FoundationState>,
    SafeJson(request): SafeJson<CapacityFixtureRequest>,
) -> Result<Json<CapacityFixtureResponse>, ApiError> {
    validate_label(&request.pool_key, "invalid_pool_key")?;
    validate_label(&request.profile, "invalid_capacity_profile")?;
    if request.hosted_slot_limit < 0 || request.rollout_headroom_limit < 0 {
        return Err(ApiError::unprocessable(
            "invalid_capacity_limit",
            "capacity limits must be nonnegative",
        ));
    }
    let mut tx = state.pool.begin().await?;
    lock_fixture_event(&mut tx, request.event_id).await?;
    if let Some(response) = fixture_replay(&mut tx, "capacity", &request).await? {
        tx.commit().await?;
        return Ok(Json(response));
    }
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(&request.pool_key)
        .execute(&mut *tx)
        .await?;
    sqlx::query_scalar::<_, String>(
        "SELECT pool_key FROM admission_capacity_pools WHERE pool_key=$1 FOR UPDATE",
    )
    .bind(&request.pool_key)
    .fetch_optional(&mut *tx)
    .await?;
    let used_slots = pool_slot_use(&mut tx, &request.pool_key).await?;
    let used_headroom = pool_rollout_use(&mut tx, &request.pool_key).await?;
    if used_slots > i64::from(request.hosted_slot_limit)
        || used_headroom > i64::from(request.rollout_headroom_limit)
    {
        return Err(ApiError::conflict(
            "capacity_in_use",
            "capacity cannot be reduced below durable use",
        ));
    }
    let row: (String, String, i32, i32, i64) = sqlx::query_as(
        "INSERT INTO admission_capacity_pools \
         (pool_key,profile,hosted_slot_limit,rollout_headroom_limit) VALUES ($1,$2,$3,$4) \
         ON CONFLICT (pool_key) DO UPDATE SET profile=EXCLUDED.profile, \
         hosted_slot_limit=EXCLUDED.hosted_slot_limit,rollout_headroom_limit=EXCLUDED.rollout_headroom_limit, \
         revision=admission_capacity_pools.revision+1,updated_at=transaction_timestamp() \
         RETURNING pool_key,profile,hosted_slot_limit,rollout_headroom_limit,revision",
    )
    .bind(&request.pool_key)
    .bind(&request.profile)
    .bind(request.hosted_slot_limit)
    .bind(request.rollout_headroom_limit)
    .fetch_one(&mut *tx)
    .await?;
    let response = CapacityFixtureResponse {
        pool_key: row.0,
        profile: row.1,
        hosted_slot_limit: row.2,
        rollout_headroom_limit: row.3,
        revision: row.4,
    };
    store_fixture(&mut tx, request.event_id, "capacity", &request, &response).await?;
    tx.commit().await?;
    Ok(Json(response))
}

async fn put_entitlement_fixture(
    _worker: WorkerAuth,
    State(state): State<FoundationState>,
    SafeJson(request): SafeJson<EntitlementFixtureRequest>,
) -> Result<Json<EntitlementFixtureResponse>, ApiError> {
    if request.hosted_slot_limit < 0
        || request.build_seconds_limit < 0
        || request.period_ends_at <= request.period_starts_at
        || !matches!(request.state.as_str(), "active" | "expired" | "revoked")
    {
        return Err(ApiError::unprocessable(
            "invalid_entitlement_fixture",
            "the synthetic entitlement fixture is invalid",
        ));
    }
    let mut tx = state.pool.begin().await?;
    lock_fixture_event(&mut tx, request.event_id).await?;
    if let Some(response) = fixture_replay(&mut tx, "entitlement", &request).await? {
        tx.commit().await?;
        return Ok(Json(response));
    }
    let pool_exists: Option<String> = sqlx::query_scalar(
        "SELECT pool_key FROM admission_capacity_pools WHERE pool_key=$1 FOR UPDATE",
    )
    .bind(&request.capacity_pool_key)
    .fetch_optional(&mut *tx)
    .await?;
    if pool_exists.is_none() {
        return Err(ApiError::conflict(
            "capacity_pool_missing",
            "the synthetic capacity pool does not exist",
        ));
    }
    let existing: Option<(Uuid, String, DateTime<Utc>, DateTime<Utc>)> = sqlx::query_as(
        "SELECT id,capacity_pool_key,period_starts_at,period_ends_at \
         FROM admission_entitlements WHERE account_id=$1 FOR UPDATE",
    )
    .bind(request.account_id)
    .fetch_optional(&mut *tx)
    .await?;
    let used_slots = account_slot_use(&mut tx, request.account_id).await?;
    let (debited, credited) = usage_totals(&mut tx, request.account_id).await?;
    if used_slots > i64::from(request.hosted_slot_limit)
        || debited - credited > i64::from(request.build_seconds_limit)
    {
        return Err(ApiError::conflict(
            "entitlement_in_use",
            "entitlement cannot be reduced below durable use",
        ));
    }
    if let Some((_, pool_key, starts_at, ends_at)) = &existing
        && (pool_key != &request.capacity_pool_key
            || starts_at != &request.period_starts_at
            || ends_at != &request.period_ends_at)
    {
        return Err(ApiError::conflict(
            "entitlement_period_immutable",
            "the synthetic entitlement period and capacity pool cannot be replaced",
        ));
    }
    let entitlement_id = existing.map(|value| value.0).unwrap_or_else(Uuid::new_v4);
    let row: EntitlementFixtureRow = sqlx::query_as(
            "INSERT INTO admission_entitlements \
             (id,account_id,capacity_pool_key,source,hosted_slot_limit,build_seconds_limit,period_starts_at,period_ends_at,state) \
             VALUES ($1,$2,$3,'synthetic_internal',$4,$5,$6,$7,$8) \
             ON CONFLICT (account_id) DO UPDATE SET capacity_pool_key=EXCLUDED.capacity_pool_key, \
             hosted_slot_limit=EXCLUDED.hosted_slot_limit,build_seconds_limit=EXCLUDED.build_seconds_limit, \
             period_starts_at=EXCLUDED.period_starts_at,period_ends_at=EXCLUDED.period_ends_at,state=EXCLUDED.state, \
             revision=admission_entitlements.revision+1,updated_at=transaction_timestamp() \
             RETURNING id,account_id,capacity_pool_key,source,hosted_slot_limit,build_seconds_limit, \
             period_starts_at,period_ends_at,state,revision",
        )
        .bind(entitlement_id)
        .bind(request.account_id)
        .bind(&request.capacity_pool_key)
        .bind(request.hosted_slot_limit)
        .bind(request.build_seconds_limit)
        .bind(request.period_starts_at)
        .bind(request.period_ends_at)
        .bind(&request.state)
        .fetch_one(&mut *tx)
        .await?;
    let response = EntitlementFixtureResponse {
        id: row.id,
        account_id: row.account_id,
        capacity_pool_key: row.capacity_pool_key,
        source: row.source,
        hosted_slot_limit: row.hosted_slot_limit,
        build_seconds_limit: row.build_seconds_limit,
        period_starts_at: row.period_starts_at,
        period_ends_at: row.period_ends_at,
        state: row.state,
        revision: row.revision,
    };
    store_fixture(
        &mut tx,
        request.event_id,
        "entitlement",
        &request,
        &response,
    )
    .await?;
    tx.commit().await?;
    Ok(Json(response))
}

async fn put_source_proof(
    _worker: WorkerAuth,
    State(state): State<FoundationState>,
    SafeJson(request): SafeJson<SourceProofFixtureRequest>,
) -> Result<Json<SourceProofResponse>, ApiError> {
    if request.inventory_revision <= 0 {
        return Err(ApiError::unprocessable(
            "invalid_source_proof",
            "the source proof revision and expiry must be in the future",
        ));
    }
    let mut tx = state.pool.begin().await?;
    if request.expires_at <= database_now(&mut tx).await? {
        return Err(ApiError::unprocessable(
            "invalid_source_proof",
            "the source proof revision and expiry must be in the future",
        ));
    }
    lock_fixture_event(&mut tx, request.event_id).await?;
    if let Some(response) = fixture_replay(&mut tx, "source_proof", &request).await? {
        tx.commit().await?;
        return Ok(Json(response));
    }
    let project_locked: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM projects WHERE account_id=$1 AND id=$2 FOR UPDATE")
            .bind(request.account_id)
            .bind(request.project_id)
            .fetch_optional(&mut *tx)
            .await?;
    if project_locked.is_none() {
        return Err(ApiError::not_found());
    }
    let exact: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM deployments WHERE account_id=$1 AND project_id=$2 AND id=$3 \
         AND configuration_revision_id=$4 AND source_commit=$5 FOR UPDATE",
    )
    .bind(request.account_id)
    .bind(request.project_id)
    .bind(request.deployment_id)
    .bind(request.configuration_revision_id)
    .bind(&request.source_commit)
    .fetch_optional(&mut *tx)
    .await?;
    if exact.is_none() {
        return Err(ApiError::conflict(
            "admission_source_stale",
            "the exact source and current configuration were not verified",
        ));
    }
    ensure_source_context(
        &mut tx,
        request.account_id,
        request.project_id,
        request.deployment_id,
        request.configuration_revision_id,
        &request.source_commit,
    )
    .await?;
    let latest_inventory_revision: Option<i64> = sqlx::query_scalar(
        "SELECT max(inventory_revision) FROM admission_source_proofs WHERE account_id=$1 \
         AND project_id=$2 AND deployment_id=$3",
    )
    .bind(request.account_id)
    .bind(request.project_id)
    .bind(request.deployment_id)
    .fetch_one(&mut *tx)
    .await?;
    if latest_inventory_revision.is_some_and(|revision| request.inventory_revision <= revision) {
        return Err(ApiError::conflict(
            "source_inventory_revision_stale",
            "the source inventory revision must advance monotonically",
        ));
    }
    sqlx::query(
        "UPDATE admission_source_proofs SET state='superseded' \
         WHERE deployment_id=$1 AND state='valid'",
    )
    .bind(request.deployment_id)
    .execute(&mut *tx)
    .await?;
    let proof_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO admission_source_proofs \
         (id,account_id,project_id,deployment_id,configuration_revision_id,source_commit,inventory_revision,source,state,expires_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,'synthetic_internal','valid',$8)",
    )
    .bind(proof_id)
    .bind(request.account_id)
    .bind(request.project_id)
    .bind(request.deployment_id)
    .bind(request.configuration_revision_id)
    .bind(&request.source_commit)
    .bind(request.inventory_revision)
    .bind(request.expires_at)
    .execute(&mut *tx)
    .await?;
    let response = SourceProofResponse {
        id: proof_id,
        account_id: request.account_id,
        project_id: request.project_id,
        deployment_id: request.deployment_id,
        configuration_revision_id: request.configuration_revision_id,
        source_commit: request.source_commit.clone(),
        inventory_revision: request.inventory_revision,
        source: "synthetic_internal".into(),
        state: "valid".into(),
        expires_at: request.expires_at,
    };
    store_fixture(
        &mut tx,
        request.event_id,
        "source_proof",
        &request,
        &response,
    )
    .await?;
    tx.commit().await?;
    Ok(Json(response))
}

async fn record_resource_observation(
    _worker: WorkerAuth,
    State(state): State<FoundationState>,
    SafeJson(request): SafeJson<ResourceObservationRequest>,
) -> Result<Json<ResourceObservationResponse>, ApiError> {
    validate_observation(&request)?;
    let mut tx = state.pool.begin().await?;
    lock_fixture_event(&mut tx, request.event_id).await?;
    if let Some(response) = fixture_replay(&mut tx, "resource_observation", &request).await? {
        tx.commit().await?;
        return Ok(Json(response));
    }
    let project_locked: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM projects WHERE account_id=$1 AND id=$2 FOR UPDATE")
            .bind(request.account_id)
            .bind(request.project_id)
            .fetch_optional(&mut *tx)
            .await?;
    if project_locked.is_none() {
        return Err(ApiError::not_found());
    }
    let locked: Option<(Uuid, String, Uuid, String)> = sqlx::query_as(
        "SELECT reservation_epoch,state,first_deployment_id,capacity_pool_key FROM slot_reservations \
         WHERE id=$1 AND account_id=$2 AND project_id=$3 FOR UPDATE",
    )
    .bind(request.reservation_id)
    .bind(request.account_id)
    .bind(request.project_id)
    .fetch_optional(&mut *tx)
    .await?;
    let (epoch, reservation_state, first_deployment_id, capacity_pool_key) =
        locked.ok_or_else(ApiError::not_found)?;
    if epoch != request.reservation_epoch {
        return Err(ApiError::conflict(
            "reservation_epoch_stale",
            "the observation does not apply to the current reservation epoch",
        ));
    }
    if let Some(hold_id) = request.rollout_hold_id {
        let linked: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM capacity_holds WHERE id=$1 AND account_id=$2 \
             AND project_id=$3 AND deployment_id=$4 AND capacity_pool_key=$5 \
             AND reservation_id=$6 AND reservation_epoch=$7 AND kind='rollout' \
             AND state IN ('consumed','released'))",
        )
        .bind(hold_id)
        .bind(request.account_id)
        .bind(request.project_id)
        .bind(request.deployment_id)
        .bind(&capacity_pool_key)
        .bind(request.reservation_id)
        .bind(request.reservation_epoch)
        .fetch_one(&mut *tx)
        .await?;
        if !linked {
            return Err(ApiError::conflict(
                "observation_generation_mismatch",
                "the rollout hold does not belong to this reservation generation and deployment",
            ));
        }
    } else if request.deployment_id != first_deployment_id {
        return Err(ApiError::conflict(
            "observation_generation_mismatch",
            "the deployment is not linked to this reservation generation",
        ));
    }
    sqlx::query(
        "INSERT INTO admission_resource_observations \
         (id,account_id,project_id,deployment_id,reservation_id,reservation_epoch,rollout_hold_id,outcome,resource_inventory,proof_ref) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
    )
    .bind(request.event_id)
    .bind(request.account_id)
    .bind(request.project_id)
    .bind(request.deployment_id)
    .bind(request.reservation_id)
    .bind(request.reservation_epoch)
    .bind(request.rollout_hold_id)
    .bind(&request.outcome)
    .bind(&request.resource_inventory)
    .bind(&request.proof_ref)
    .execute(&mut *tx)
    .await?;
    let released_rollout_hold_id = match request.outcome.as_str() {
        "resources_retained" => {
            if reservation_state == "released" {
                return Err(ApiError::conflict(
                    "slot_reservation_released",
                    "a released slot cannot retain resources",
                ));
            }
            sqlx::query(
                "UPDATE slot_reservations SET state='resources_retained',retention_reason=$1, \
                 updated_at=transaction_timestamp() WHERE id=$2",
            )
            .bind(&request.resource_inventory)
            .bind(request.reservation_id)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "UPDATE projects SET hosted_slots=1,slot_state='resources_retained',revision=revision+1, \
                 updated_at=transaction_timestamp() WHERE account_id=$1 AND id=$2",
            )
            .bind(request.account_id)
            .bind(request.project_id)
            .execute(&mut *tx)
            .await?;
            None
        }
        "deployment_healthy" => {
            if reservation_state == "released" {
                return Err(ApiError::conflict(
                    "slot_reservation_released",
                    "a released slot cannot receive a healthy deployment observation",
                ));
            }
            sqlx::query(
                "UPDATE deployments SET lifecycle='healthy' \
                 WHERE account_id=$1 AND project_id=$2 AND id=$3",
            )
            .bind(request.account_id)
            .bind(request.project_id)
            .bind(request.deployment_id)
            .execute(&mut *tx)
            .await?;
            None
        }
        "cleanup_confirmed" => {
            if reservation_state != "released" {
                sqlx::query(
                    "UPDATE slot_reservations SET state='released',retention_reason=NULL,release_observation_id=$1, \
                     released_at=clock_timestamp(),updated_at=transaction_timestamp() WHERE id=$2",
                )
                .bind(request.event_id)
                .bind(request.reservation_id)
                .execute(&mut *tx)
                .await?;
                sqlx::query(
                    "UPDATE projects SET hosted_slots=0,slot_state='released',revision=revision+1, \
                     updated_at=transaction_timestamp() WHERE account_id=$1 AND id=$2",
                )
                .bind(request.account_id)
                .bind(request.project_id)
                .execute(&mut *tx)
                .await?;
                sqlx::query(
                    "UPDATE deployments SET lifecycle='failed_no_resources' \
                     WHERE account_id=$1 AND project_id=$2 AND id=$3 AND lifecycle IN ('admission_required','queued')",
                )
                .bind(request.account_id)
                .bind(request.project_id)
                .bind(request.deployment_id)
                .execute(&mut *tx)
                .await?;
            }
            None
        }
        "rollout_released" => {
            let hold_id = request.rollout_hold_id.ok_or_else(ApiError::internal)?;
            let changed = sqlx::query(
                "UPDATE capacity_holds SET state='released',released_at=clock_timestamp() \
                 WHERE id=$1 AND account_id=$2 AND project_id=$3 AND deployment_id=$4 \
                   AND capacity_pool_key=$5 AND reservation_id=$6 AND reservation_epoch=$7 \
                   AND kind='rollout' AND state='consumed'",
            )
            .bind(hold_id)
            .bind(request.account_id)
            .bind(request.project_id)
            .bind(request.deployment_id)
            .bind(&capacity_pool_key)
            .bind(request.reservation_id)
            .bind(request.reservation_epoch)
            .execute(&mut *tx)
            .await?;
            if changed.rows_affected() != 1 {
                return Err(ApiError::conflict(
                    "rollout_hold_not_active",
                    "the rollout hold is not active for this project",
                ));
            }
            Some(hold_id)
        }
        _ => return Err(ApiError::internal()),
    };
    let reservation = load_reservation(
        &mut tx,
        request.account_id,
        request.project_id,
        request.reservation_id,
    )
    .await?;
    let response = ResourceObservationResponse {
        id: request.event_id,
        outcome: request.outcome.clone(),
        reservation,
        released_rollout_hold_id,
    };
    store_fixture(
        &mut tx,
        request.event_id,
        "resource_observation",
        &request,
        &response,
    )
    .await?;
    tx.commit().await?;
    Ok(Json(response))
}

async fn record_build_usage(
    _worker: WorkerAuth,
    State(state): State<FoundationState>,
    SafeJson(request): SafeJson<BuildUsageRequest>,
) -> Result<Json<BuildUsageResponse>, ApiError> {
    validate_build_usage(&request)?;
    let mut tx = state.pool.begin().await?;
    lock_fixture_event(&mut tx, request.event_id).await?;
    let fixture_kind = if request.kind == "debit" {
        "build_debit"
    } else {
        "platform_fault_credit"
    };
    if let Some(response) = fixture_replay(&mut tx, fixture_kind, &request).await? {
        tx.commit().await?;
        return Ok(Json(response));
    }
    let entitlement = lock_entitlement_and_pool(&mut tx, request.account_id).await?;
    if request.kind == "debit" {
        ensure_entitlement_active(&mut tx, &entitlement).await?;
    }
    let deployment_owned: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM deployments WHERE account_id=$1 AND project_id=$2 AND id=$3)",
    )
    .bind(request.account_id)
    .bind(request.project_id)
    .bind(request.deployment_id)
    .fetch_one(&mut *tx)
    .await?;
    if !deployment_owned {
        return Err(ApiError::not_found());
    }
    let event_id = request.event_id;
    if request.kind == "debit" {
        let existing_attempt: Option<Uuid> = sqlx::query_scalar(
            "SELECT id FROM build_usage_events WHERE entitlement_id=$1 AND attempt_id=$2 \
             AND kind='debit' FOR UPDATE",
        )
        .bind(entitlement.0)
        .bind(request.attempt_id)
        .fetch_optional(&mut *tx)
        .await?;
        if existing_attempt.is_some() {
            return Err(ApiError::conflict(
                "build_attempt_already_debited",
                "the synthetic build attempt already has a debit",
            ));
        }
        let (debited, credited) = usage_totals(&mut tx, request.account_id).await?;
        if debited - credited + i64::from(request.seconds) > i64::from(entitlement.3) {
            return Err(ApiError::conflict(
                "build_allowance_exhausted",
                "the synthetic build allowance is exhausted",
            ));
        }
        sqlx::query(
            "INSERT INTO build_usage_events \
             (id,account_id,project_id,deployment_id,entitlement_id,attempt_id,kind,seconds) \
             VALUES ($1,$2,$3,$4,$5,$6,'debit',$7)",
        )
        .bind(event_id)
        .bind(request.account_id)
        .bind(request.project_id)
        .bind(request.deployment_id)
        .bind(entitlement.0)
        .bind(request.attempt_id)
        .bind(request.seconds)
        .execute(&mut *tx)
        .await?;
    } else {
        let debit_id = request.debit_event_id.ok_or_else(ApiError::internal)?;
        let debit: Option<(Uuid, Uuid, Uuid, Uuid, i32)> = sqlx::query_as(
            "SELECT account_id,project_id,deployment_id,attempt_id,seconds FROM build_usage_events \
             WHERE id=$1 AND kind='debit' FOR UPDATE",
        )
        .bind(debit_id)
        .fetch_optional(&mut *tx)
        .await?;
        let debit = debit.ok_or_else(ApiError::not_found)?;
        if debit
            != (
                request.account_id,
                request.project_id,
                request.deployment_id,
                request.attempt_id,
                request.seconds,
            )
        {
            return Err(ApiError::conflict(
                "platform_fault_credit_mismatch",
                "the platform-fault credit does not exactly match its debit",
            ));
        }
        let already_credited: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM build_usage_events WHERE debit_event_id=$1)",
        )
        .bind(debit_id)
        .fetch_one(&mut *tx)
        .await?;
        if already_credited {
            return Err(ApiError::conflict(
                "platform_fault_already_credited",
                "the build debit already has a platform-fault credit",
            ));
        }
        sqlx::query(
            "INSERT INTO build_usage_events \
             (id,account_id,project_id,deployment_id,entitlement_id,attempt_id,kind,seconds,debit_event_id,platform_fault_ref) \
             VALUES ($1,$2,$3,$4,$5,$6,'platform_fault_credit',$7,$8,$9)",
        )
        .bind(event_id)
        .bind(request.account_id)
        .bind(request.project_id)
        .bind(request.deployment_id)
        .bind(entitlement.0)
        .bind(request.attempt_id)
        .bind(request.seconds)
        .bind(debit_id)
        .bind(request.platform_fault_ref.as_deref())
        .execute(&mut *tx)
        .await?;
    }
    let (debited, credited) = usage_totals(&mut tx, request.account_id).await?;
    let response = BuildUsageResponse {
        id: event_id,
        kind: request.kind.clone(),
        attempt_id: request.attempt_id,
        seconds: request.seconds,
        debit_event_id: request.debit_event_id,
        build_seconds_remaining: i64::from(entitlement.3) - debited + credited,
        execution_enqueued: false,
    };
    store_fixture(&mut tx, event_id, fixture_kind, &request, &response).await?;
    tx.commit().await?;
    Ok(Json(response))
}

async fn run_reconcile(
    _worker: WorkerAuth,
    State(state): State<FoundationState>,
    SafeJson(_request): SafeJson<ReconcileRequest>,
) -> Result<Json<ReconcileResponse>, ApiError> {
    Ok(Json(ReconcileResponse {
        expired_holds: reconcile(&state.pool).await?,
    }))
}

pub async fn reconcile(pool: &PgPool) -> Result<u64, ApiError> {
    let expired: i64 = sqlx::query_scalar(
        "WITH expired AS ( \
           UPDATE capacity_holds SET state='expired',released_at=clock_timestamp() \
           WHERE state='active' AND consumed_at IS NULL AND expires_at <= clock_timestamp() \
           RETURNING id,account_id,project_id,deployment_id,kind \
         ), refund_intents AS ( \
           INSERT INTO admission_reconciliation_intents \
             (id,account_id,project_id,deployment_id,hold_id,kind,state,reason) \
           SELECT gen_random_uuid(),account_id,project_id,deployment_id,id, \
                  'refund_required','pending','hold_expired' FROM expired WHERE kind='initial' \
           ON CONFLICT (hold_id) DO NOTHING RETURNING 1 \
         ) SELECT count(*)::bigint FROM expired",
    )
    .fetch_one(pool)
    .await?;
    u64::try_from(expired).map_err(|_| ApiError::internal())
}

async fn lock_entitlement_and_pool(
    tx: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
) -> Result<EntitlementLockRow, ApiError> {
    let pool_key: Option<String> = sqlx::query_scalar(
        "SELECT capacity_pool_key FROM admission_entitlements WHERE account_id=$1",
    )
    .bind(account_id)
    .fetch_optional(&mut **tx)
    .await?;
    let pool_key = pool_key.ok_or_else(|| {
        ApiError::conflict(
            "entitlement_unavailable",
            "an active synthetic entitlement is required",
        )
    })?;
    let pool_locked: Option<String> = sqlx::query_scalar(
        "SELECT pool_key FROM admission_capacity_pools WHERE pool_key=$1 FOR UPDATE",
    )
    .bind(&pool_key)
    .fetch_optional(&mut **tx)
    .await?;
    if pool_locked.is_none() {
        return Err(ApiError::conflict(
            "entitlement_unavailable",
            "the synthetic entitlement capacity pool is unavailable",
        ));
    }
    sqlx::query_as(
        "SELECT e.id,e.capacity_pool_key,e.hosted_slot_limit,e.build_seconds_limit, \
         e.period_starts_at,e.period_ends_at,e.state FROM admission_entitlements e \
         WHERE e.account_id=$1 AND e.capacity_pool_key=$2 FOR UPDATE",
    )
    .bind(account_id)
    .bind(&pool_key)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| {
        ApiError::conflict(
            "entitlement_unavailable",
            "an active synthetic entitlement is required",
        )
    })
}

async fn ensure_entitlement_active(
    tx: &mut Transaction<'_, Postgres>,
    row: &EntitlementLockRow,
) -> Result<(), ApiError> {
    let now = database_now(tx).await?;
    if row.6 != "active" || row.4 > now || row.5 <= now {
        return Err(ApiError::conflict(
            "entitlement_unavailable",
            "an active synthetic entitlement is required",
        ));
    }
    Ok(())
}

async fn ensure_build_allowance(
    tx: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    entitlement: &EntitlementLockRow,
) -> Result<(), ApiError> {
    let (debited, credited) = usage_totals(tx, account_id).await?;
    if debited - credited >= i64::from(entitlement.3) {
        return Err(ApiError::conflict(
            "build_allowance_exhausted",
            "the synthetic build allowance is exhausted",
        ));
    }
    Ok(())
}

async fn lock_project_revision(
    tx: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    project_id: Uuid,
    expected_revision: i64,
) -> Result<(), ApiError> {
    let revision: Option<i64> = sqlx::query_scalar(
        "SELECT revision FROM projects WHERE account_id=$1 AND id=$2 FOR UPDATE",
    )
    .bind(account_id)
    .bind(project_id)
    .fetch_optional(&mut **tx)
    .await?;
    match revision {
        None => Err(ApiError::not_found()),
        Some(value) if value != expected_revision => Err(ApiError::stale_revision()),
        Some(_) => Ok(()),
    }
}

async fn validate_source_proof(
    tx: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    project_id: Uuid,
    deployment_id: Uuid,
    proof_id: Uuid,
) -> Result<(), ApiError> {
    let proof: Option<LockedSourceProofRow> = sqlx::query_as(
        "SELECT deployment_id,configuration_revision_id,source_commit,state,expires_at \
         FROM admission_source_proofs WHERE id=$1 AND account_id=$2 AND project_id=$3 \
         AND deployment_id=$4 FOR UPDATE",
    )
    .bind(proof_id)
    .bind(account_id)
    .bind(project_id)
    .bind(deployment_id)
    .fetch_optional(&mut **tx)
    .await?;
    let proof = proof.ok_or_else(|| {
        ApiError::conflict(
            "admission_source_stale",
            "the exact source and current configuration were not verified",
        )
    })?;
    let deployment: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT configuration_revision_id,source_commit FROM deployments \
         WHERE account_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE",
    )
    .bind(account_id)
    .bind(project_id)
    .bind(deployment_id)
    .fetch_optional(&mut **tx)
    .await?;
    let deployment = deployment.ok_or_else(ApiError::not_found)?;
    if proof.deployment_id != deployment_id
        || proof.configuration_revision_id != deployment.0
        || proof.state != "valid"
        || proof.expires_at <= database_now(tx).await?
    {
        return Err(ApiError::conflict(
            "admission_source_stale",
            "the exact source and current configuration were not verified",
        ));
    }
    ensure_source_context(
        tx,
        account_id,
        project_id,
        deployment_id,
        proof.configuration_revision_id,
        &proof.source_commit,
    )
    .await?;
    Ok(())
}

async fn ensure_source_context(
    tx: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    project_id: Uuid,
    deployment_id: Uuid,
    configuration_revision_id: Uuid,
    source_commit: &str,
) -> Result<(), ApiError> {
    let current_or_rollback: bool = sqlx::query_scalar(
        "SELECT EXISTS( \
           SELECT 1 FROM projects p WHERE p.account_id=$1 AND p.id=$2 \
             AND p.current_configuration_revision_id=$4 \
         ) OR EXISTS( \
           SELECT 1 FROM project_lifecycle_intents li JOIN deployments d \
             ON d.account_id=li.account_id AND d.project_id=li.project_id AND d.id=li.target_deployment_id \
           WHERE li.account_id=$1 AND li.project_id=$2 AND li.kind='rollback' AND li.state='requested' \
             AND li.target_deployment_id=$3 AND d.lifecycle='healthy' \
             AND d.configuration_revision_id=$4 AND d.source_commit=$5 \
         )",
    )
    .bind(account_id)
    .bind(project_id)
    .bind(deployment_id)
    .bind(configuration_revision_id)
    .bind(source_commit)
    .fetch_one(&mut **tx)
    .await?;
    if !current_or_rollback {
        return Err(ApiError::conflict(
            "admission_source_stale",
            "the exact source and configuration are not current or an eligible rollback target",
        ));
    }

    let binding_history: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM github_repository_bindings WHERE account_id=$1 AND project_id=$2)",
    )
    .bind(account_id)
    .bind(project_id)
    .fetch_one(&mut **tx)
    .await?;
    if binding_history {
        let user_authorized: Option<Uuid> = sqlx::query_scalar(
            "SELECT account_id FROM github_user_authorizations \
             WHERE account_id=$1 AND status='active' \
               AND (token_expires_at IS NULL OR token_expires_at > clock_timestamp()) FOR SHARE",
        )
        .bind(account_id)
        .fetch_optional(&mut **tx)
        .await?;
        if user_authorized.is_none() {
            return Err(ApiError::conflict(
                "github_source_not_authorized",
                "the project has binding history but its user authorization is unavailable",
            ));
        }

        // Discover the installation without locking the binding, then acquire the
        // authority locks in the same user -> installation -> binding order used
        // by the GitHub control path. Every status is rechecked under its lock.
        let candidate: Option<(Uuid, i64, Uuid)> = sqlx::query_as(
            "SELECT id,installation_id,repository_id FROM github_repository_bindings \
             WHERE account_id=$1 AND project_id=$2 AND status='active'",
        )
        .bind(account_id)
        .bind(project_id)
        .fetch_optional(&mut **tx)
        .await?;
        let (binding_id, installation_id, repository_id) = candidate.ok_or_else(|| {
            ApiError::conflict(
                "github_source_not_authorized",
                "the project has binding history but no active binding",
            )
        })?;
        let installation_active: Option<i64> = sqlx::query_scalar(
            "SELECT installation_id FROM github_installations \
             WHERE installation_id=$1 AND status='active' FOR SHARE",
        )
        .bind(installation_id)
        .fetch_optional(&mut **tx)
        .await?;
        if installation_active.is_none() {
            return Err(ApiError::conflict(
                "github_source_not_authorized",
                "the project installation is not active",
            ));
        }
        let binding_active: Option<Uuid> = sqlx::query_scalar(
            "SELECT id FROM github_repository_bindings WHERE id=$1 AND account_id=$2 \
             AND project_id=$3 AND repository_id=$4 AND installation_id=$5 AND status='active' FOR SHARE",
        )
        .bind(binding_id)
        .bind(account_id)
        .bind(project_id)
        .bind(repository_id)
        .bind(installation_id)
        .fetch_optional(&mut **tx)
        .await?;
        if binding_active.is_none() {
            return Err(ApiError::conflict(
                "github_source_not_authorized",
                "the project binding is not active",
            ));
        }
        let source_authorized: Option<Uuid> = sqlx::query_scalar(
            "SELECT id FROM github_source_revisions WHERE binding_id=$1 AND account_id=$2 \
             AND project_id=$3 AND repository_id=$4 AND source='owner_resolve' \
             AND configuration_revision_id=$5 AND commit_sha=$6 FOR SHARE",
        )
        .bind(binding_id)
        .bind(account_id)
        .bind(project_id)
        .bind(repository_id)
        .bind(configuration_revision_id)
        .bind(source_commit)
        .fetch_optional(&mut **tx)
        .await?;
        if source_authorized.is_none() {
            return Err(ApiError::conflict(
                "github_source_not_authorized",
                "the active binding has no exact owner-resolved source revision",
            ));
        }
    }
    Ok(())
}

async fn ensure_lifecycle_allows_hold(
    tx: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    project_id: Uuid,
    deployment_id: Uuid,
) -> Result<(), ApiError> {
    let lifecycle: Option<String> = sqlx::query_scalar(
        "SELECT lifecycle FROM deployments WHERE account_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE",
    )
    .bind(account_id)
    .bind(project_id)
    .bind(deployment_id)
    .fetch_optional(&mut **tx)
    .await?;
    let lifecycle = lifecycle.ok_or_else(ApiError::not_found)?;
    let pending: Option<(String, Option<Uuid>)> = sqlx::query_as(
        "SELECT kind,target_deployment_id FROM project_lifecycle_intents \
         WHERE account_id=$1 AND project_id=$2 AND state='requested' FOR UPDATE",
    )
    .bind(account_id)
    .bind(project_id)
    .fetch_optional(&mut **tx)
    .await?;
    match pending {
        None if lifecycle == "admission_required" => Ok(()),
        Some((kind, Some(target)))
            if kind == "rollback" && target == deployment_id && lifecycle == "healthy" =>
        {
            Ok(())
        }
        None => Err(ApiError::conflict(
            "deployment_not_admissible",
            "the deployment is not awaiting admission",
        )),
        Some(_) => Err(ApiError::conflict(
            "lifecycle_intent_pending",
            "a conflicting project lifecycle intent is pending",
        )),
    }
}

async fn ensure_capacity_available(
    tx: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    entitlement: &EntitlementLockRow,
    kind: &str,
) -> Result<(), ApiError> {
    if kind == "initial" {
        let account_use = account_slot_use(tx, account_id).await?;
        if account_use >= i64::from(entitlement.2) {
            return Err(ApiError::conflict(
                "entitlement_capacity_exhausted",
                "the synthetic hosted-slot entitlement is exhausted",
            ));
        }
        let pool: (i32,) = sqlx::query_as(
            "SELECT hosted_slot_limit FROM admission_capacity_pools WHERE pool_key=$1",
        )
        .bind(&entitlement.1)
        .fetch_one(&mut **tx)
        .await?;
        if pool_slot_use(tx, &entitlement.1).await? >= i64::from(pool.0) {
            return Err(ApiError::conflict(
                "platform_capacity_exhausted",
                "the synthetic hosted capacity pool is exhausted",
            ));
        }
    } else {
        let limit: i32 = sqlx::query_scalar(
            "SELECT rollout_headroom_limit FROM admission_capacity_pools WHERE pool_key=$1",
        )
        .bind(&entitlement.1)
        .fetch_one(&mut **tx)
        .await?;
        if pool_rollout_use(tx, &entitlement.1).await? >= i64::from(limit) {
            return Err(ApiError::conflict(
                "rollout_capacity_exhausted",
                "the synthetic rollout headroom is exhausted",
            ));
        }
    }
    Ok(())
}

async fn account_slot_use(
    tx: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
) -> Result<i64, ApiError> {
    sqlx::query_scalar(
        "SELECT \
         (SELECT count(*) FROM slot_reservations WHERE account_id=$1 AND state<>'released') + \
         (SELECT count(*) FROM capacity_holds WHERE account_id=$1 AND kind='initial' AND state='active')",
    )
    .bind(account_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(ApiError::from)
}

async fn pool_slot_use(
    tx: &mut Transaction<'_, Postgres>,
    pool_key: &str,
) -> Result<i64, ApiError> {
    sqlx::query_scalar(
        "SELECT \
         (SELECT count(*) FROM slot_reservations WHERE capacity_pool_key=$1 AND state<>'released') + \
         (SELECT count(*) FROM capacity_holds WHERE capacity_pool_key=$1 AND kind='initial' AND state='active')",
    )
    .bind(pool_key)
    .fetch_one(&mut **tx)
    .await
    .map_err(ApiError::from)
}

async fn pool_rollout_use(
    tx: &mut Transaction<'_, Postgres>,
    pool_key: &str,
) -> Result<i64, ApiError> {
    sqlx::query_scalar(
        "SELECT count(*) FROM capacity_holds WHERE capacity_pool_key=$1 AND kind='rollout' AND state IN ('active','consumed')",
    )
    .bind(pool_key)
    .fetch_one(&mut **tx)
    .await
    .map_err(ApiError::from)
}

async fn expire_holds_for_scope(
    tx: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    pool_key: &str,
) -> Result<(), ApiError> {
    sqlx::query(
        "WITH expired AS ( \
           UPDATE capacity_holds SET state='expired',released_at=clock_timestamp() \
           WHERE state='active' AND consumed_at IS NULL AND expires_at <= clock_timestamp() \
             AND (account_id=$1 OR capacity_pool_key=$2) \
           RETURNING id,account_id,project_id,deployment_id,kind \
         ) INSERT INTO admission_reconciliation_intents \
           (id,account_id,project_id,deployment_id,hold_id,kind,state,reason) \
         SELECT gen_random_uuid(),account_id,project_id,deployment_id,id, \
                'refund_required','pending','hold_expired' FROM expired WHERE kind='initial' \
         ON CONFLICT (hold_id) DO NOTHING",
    )
    .bind(account_id)
    .bind(pool_key)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn project_reserved(
    tx: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    project_id: Uuid,
    deployment_id: Uuid,
) -> Result<(), ApiError> {
    sqlx::query(
        "UPDATE deployments SET lifecycle='queued' WHERE account_id=$1 AND project_id=$2 AND id=$3 AND lifecycle='admission_required'",
    )
    .bind(account_id)
    .bind(project_id)
    .bind(deployment_id)
    .execute(&mut **tx)
    .await?;
    sqlx::query(
        "UPDATE projects SET hosted_slots=1,slot_state='reserved',revision=revision+1, \
         updated_at=transaction_timestamp() WHERE account_id=$1 AND id=$2",
    )
    .bind(account_id)
    .bind(project_id)
    .execute(&mut **tx)
    .await?;
    sqlx::query(
        "INSERT INTO hosting_state_events \
         (id,account_id,project_id,deployment_id,state,source,reason) \
         VALUES ($1,$2,$3,$4,'reserved','trusted_observation', \
         'M2 synthetic entitlement and capacity admission; no execution enqueued')",
    )
    .bind(Uuid::new_v4())
    .bind(account_id)
    .bind(project_id)
    .bind(deployment_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn rollout_admitted(
    tx: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    project_id: Uuid,
    deployment_id: Uuid,
) -> Result<(), ApiError> {
    let changed = sqlx::query(
        "UPDATE deployments SET lifecycle='queued' WHERE account_id=$1 AND project_id=$2 AND id=$3 AND lifecycle='admission_required'",
    )
    .bind(account_id)
    .bind(project_id)
    .bind(deployment_id)
    .execute(&mut **tx)
    .await?;
    if changed.rows_affected() != 1 {
        return Err(ApiError::internal());
    }
    sqlx::query(
        "UPDATE projects SET revision=revision+1,updated_at=transaction_timestamp() \
         WHERE account_id=$1 AND id=$2",
    )
    .bind(account_id)
    .bind(project_id)
    .execute(&mut **tx)
    .await?;
    sqlx::query(
        "INSERT INTO hosting_state_events \
         (id,account_id,project_id,deployment_id,state,source,reason) \
         VALUES ($1,$2,$3,$4,'reserved','trusted_observation', \
         'rollout capacity admission consumed under the existing project slot; no execution enqueued')",
    )
    .bind(Uuid::new_v4())
    .bind(account_id)
    .bind(project_id)
    .bind(deployment_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn load_hold(
    tx: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    project_id: Uuid,
    hold_id: Uuid,
) -> Result<HoldRecord, ApiError> {
    let row: Option<HoldRow> = sqlx::query_as(
        "SELECT id,kind,state,project_id,deployment_id,source_proof_id,expires_at \
         FROM capacity_holds WHERE id=$1 AND account_id=$2 AND project_id=$3",
    )
    .bind(hold_id)
    .bind(account_id)
    .bind(project_id)
    .fetch_optional(&mut **tx)
    .await?;
    let row = row.ok_or_else(ApiError::not_found)?;
    Ok(HoldRecord {
        id: row.id,
        kind: row.kind,
        state: row.state,
        project_id: row.project_id,
        deployment_id: row.deployment_id,
        source_proof_id: row.source_proof_id,
        expires_at: row.expires_at,
    })
}

async fn load_reservation(
    tx: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    project_id: Uuid,
    reservation_id: Uuid,
) -> Result<ReservationRecord, ApiError> {
    let row: Option<(Uuid, Uuid, Uuid, String, Uuid, Option<String>)> = sqlx::query_as(
        "SELECT id,project_id,first_deployment_id,state,reservation_epoch,retention_reason \
         FROM slot_reservations WHERE id=$1 AND account_id=$2 AND project_id=$3",
    )
    .bind(reservation_id)
    .bind(account_id)
    .bind(project_id)
    .fetch_optional(&mut **tx)
    .await?;
    let row = row.ok_or_else(ApiError::not_found)?;
    Ok(ReservationRecord {
        id: row.0,
        project_id: row.1,
        first_deployment_id: row.2,
        state: row.3,
        reservation_epoch: row.4,
        retention_reason: row.5,
    })
}

async fn load_active_reservation(
    tx: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    project_id: Uuid,
) -> Result<Option<ReservationRecord>, ApiError> {
    let id: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM slot_reservations WHERE account_id=$1 AND project_id=$2 AND state<>'released'",
    )
    .bind(account_id)
    .bind(project_id)
    .fetch_optional(&mut **tx)
    .await?;
    match id {
        Some(id) => load_reservation(tx, account_id, project_id, id)
            .await
            .map(Some),
        None => Ok(None),
    }
}

async fn refresh_admission_response(
    tx: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    mut response: AdmissionResponse,
) -> Result<AdmissionResponse, ApiError> {
    response.hold = load_hold(tx, account_id, response.hold.project_id, response.hold.id).await?;
    if let Some(reservation) = &response.reservation {
        response.reservation =
            load_reservation(tx, account_id, reservation.project_id, reservation.id)
                .await
                .map(Some)?;
    }
    Ok(response)
}

async fn entitlement_summary(
    tx: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
) -> Result<EntitlementSummary, ApiError> {
    let row: Option<EntitlementSummaryRow> = sqlx::query_as(
        "SELECT source,hosted_slot_limit,build_seconds_limit,period_starts_at,period_ends_at \
         FROM admission_entitlements WHERE account_id=$1",
    )
    .bind(account_id)
    .fetch_optional(&mut **tx)
    .await?;
    let row = row.ok_or_else(|| {
        ApiError::conflict(
            "entitlement_unavailable",
            "a synthetic entitlement has not been supplied",
        )
    })?;
    let slots: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM slot_reservations WHERE account_id=$1 AND state<>'released'",
    )
    .bind(account_id)
    .fetch_one(&mut **tx)
    .await?;
    let holds: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM capacity_holds WHERE account_id=$1 AND kind='initial' AND state='active'",
    )
    .bind(account_id)
    .fetch_one(&mut **tx)
    .await?;
    let (debited, credited) = usage_totals(tx, account_id).await?;
    Ok(EntitlementSummary {
        source: row.source,
        hosted_slot_limit: row.hosted_slot_limit,
        hosted_slots_used: slots,
        active_initial_holds: holds,
        build_seconds_limit: row.build_seconds_limit,
        build_seconds_debited: debited,
        build_seconds_credited: credited,
        build_seconds_remaining: (i64::from(row.build_seconds_limit) - debited + credited).max(0),
        period_starts_at: row.period_starts_at,
        period_ends_at: row.period_ends_at,
    })
}

async fn usage_totals(
    tx: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
) -> Result<(i64, i64), ApiError> {
    sqlx::query_as(
        "SELECT COALESCE(sum(seconds) FILTER (WHERE kind='debit'),0)::bigint, \
         COALESCE(sum(seconds) FILTER (WHERE kind='platform_fault_credit'),0)::bigint \
         FROM build_usage_events WHERE account_id=$1",
    )
    .bind(account_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(ApiError::from)
}

async fn lock_fixture_event(
    tx: &mut Transaction<'_, Postgres>,
    event_id: Uuid,
) -> Result<(), ApiError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(event_id.to_string())
        .execute(&mut **tx)
        .await?;
    Ok(())
}

async fn fixture_replay<T: DeserializeOwned, R: Serialize>(
    tx: &mut Transaction<'_, Postgres>,
    kind: &str,
    request: &R,
) -> Result<Option<T>, ApiError> {
    let request_value = serde_json::to_value(request).map_err(|_| ApiError::internal())?;
    let event_id = request_value
        .get("event_id")
        .and_then(Value::as_str)
        .and_then(|value| Uuid::parse_str(value).ok())
        .ok_or_else(ApiError::internal)?;
    let request_hash = intent::request_hash(request)?;
    let row: Option<(String, Vec<u8>, Value)> = sqlx::query_as(
        "SELECT kind,request_hash,response_body FROM admission_fixture_receipts WHERE event_id=$1",
    )
    .bind(event_id)
    .fetch_optional(&mut **tx)
    .await?;
    match row {
        None => Ok(None),
        Some((stored_kind, stored_hash, body))
            if stored_kind == kind && stored_hash == request_hash =>
        {
            serde_json::from_value(body)
                .map(Some)
                .map_err(|_| ApiError::internal())
        }
        Some(_) => Err(ApiError::conflict(
            "fixture_event_payload_changed",
            "the fixture event id was reused with a different operation or payload",
        )),
    }
}

async fn store_fixture<T: Serialize, R: Serialize>(
    tx: &mut Transaction<'_, Postgres>,
    event_id: Uuid,
    kind: &str,
    request: &R,
    response: &T,
) -> Result<(), ApiError> {
    sqlx::query(
        "INSERT INTO admission_fixture_receipts(event_id,kind,request_hash,response_body) VALUES ($1,$2,$3,$4)",
    )
    .bind(event_id)
    .bind(kind)
    .bind(intent::request_hash(request)?)
    .bind(serde_json::to_value(response).map_err(|_| ApiError::internal())?)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

fn validate_observation(request: &ResourceObservationRequest) -> Result<(), ApiError> {
    let valid = match request.outcome.as_str() {
        "cleanup_confirmed" => request.resource_inventory == "none",
        "resources_retained" => request.resource_inventory != "none",
        "deployment_healthy" => request.resource_inventory != "none",
        "rollout_released" => request.rollout_hold_id.is_some(),
        _ => false,
    };
    if !valid || request.proof_ref.is_empty() || request.proof_ref.len() > 256 {
        return Err(ApiError::unprocessable(
            "invalid_resource_observation",
            "the resource observation is invalid",
        ));
    }
    Ok(())
}

fn validate_build_usage(request: &BuildUsageRequest) -> Result<(), ApiError> {
    let valid = request.seconds > 0
        && match request.kind.as_str() {
            "debit" => request.debit_event_id.is_none() && request.platform_fault_ref.is_none(),
            "platform_fault_credit" => {
                request.debit_event_id.is_some()
                    && request
                        .platform_fault_ref
                        .as_ref()
                        .is_some_and(|value| !value.is_empty() && value.len() <= 256)
            }
            _ => false,
        };
    if !valid {
        return Err(ApiError::unprocessable(
            "invalid_build_usage_event",
            "the synthetic build usage event is invalid",
        ));
    }
    Ok(())
}

fn validate_label(value: &str, code: &'static str) -> Result<(), ApiError> {
    if value.is_empty() || value.len() > 64 || value.bytes().any(|byte| byte.is_ascii_control()) {
        return Err(ApiError::unprocessable(
            code,
            "the fixture label is invalid",
        ));
    }
    Ok(())
}

async fn database_now(tx: &mut Transaction<'_, Postgres>) -> Result<DateTime<Utc>, ApiError> {
    sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&mut **tx)
        .await
        .map_err(ApiError::from)
}

fn idempotency_conflict() -> ApiError {
    ApiError::conflict(
        "idempotency_payload_changed",
        "the idempotency key was already used with a different request",
    )
}
