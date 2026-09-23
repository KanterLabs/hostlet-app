use std::{
    collections::HashSet,
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Component, Path, PathBuf},
};

use axum::{
    Json, Router,
    extract::{Path as AxumPath, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, Postgres, Transaction};
use uuid::Uuid;

use crate::{
    auth::Authenticated,
    error::{ApiError, SafeJson},
    foundation::FoundationState,
    intent::{self, Replay},
    m3::{self, PublisherWorkerAuth},
    portfolio_approval::load_public_portfolio_document,
};

const CREATE_OPERATION: &str = "portfolio.publication.create";
const MANIFEST_FORMAT: &str = "hostlet.static-site-manifest/v1";
const MAX_MANIFEST_BYTES: u64 = 256 * 1024;
const MAX_FILES: usize = 256;
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_SITE_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CreatePublicationRequest {
    approved_revision_id: Uuid,
    slug: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PublicationResponse {
    pub id: Uuid,
    pub approved_revision_id: Uuid,
    pub slug: String,
    pub cause: String,
    pub state: String,
    pub document_digest: String,
    pub artifact_digest: Option<String>,
    pub pointer_generation: Option<i64>,
    pub failure_code: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub published_at: Option<DateTime<Utc>>,
}

#[derive(FromRow)]
struct PublicationRow {
    id: Uuid,
    approved_revision_id: Uuid,
    slug: String,
    cause: String,
    state: String,
    document_digest: String,
    artifact_digest: Option<String>,
    pointer_generation: Option<i64>,
    failure_code: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    published_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LeaseRequest {
    worker_id: String,
}

#[derive(Debug, Serialize)]
#[serde(deny_unknown_fields)]
struct LeaseResponse {
    publication_id: Uuid,
    approved_revision_id: Uuid,
    slug: String,
    document: serde_json::Value,
    document_digest: String,
    staging_relative_path: String,
    attempt_id: Uuid,
    fence: i64,
    lease_expires_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CompleteRequest {
    worker_id: String,
    attempt_id: Uuid,
    fence: i64,
    outcome: CompletionOutcome,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
enum CompletionOutcome {
    Succeeded { artifact_digest: String },
    Failed { code: String },
}

#[derive(Debug, Serialize)]
#[serde(deny_unknown_fields)]
struct CompleteResponse {
    publication: PublicationResponse,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SiteManifest {
    format: String,
    publication_id: Uuid,
    document_digest: String,
    files: Vec<ManifestFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ManifestFile {
    path: String,
    bytes: u64,
    sha256: String,
    content_type: String,
}

#[derive(FromRow)]
struct PromotionRow {
    account_id: Uuid,
    slug: String,
    promotion_publication_id: Uuid,
    promotion_artifact_digest: String,
    promotion_manifest: serde_json::Value,
    promotion_generation: i64,
}

pub(crate) fn routes() -> Router<FoundationState> {
    Router::new()
        .route("/v1/portfolio/publications", post(create_publication))
        .route(
            "/v1/portfolio/publications/latest",
            get(get_latest_publication),
        )
        .route(
            "/v1/portfolio/publications/{publication_id}",
            get(get_publication),
        )
}

pub(crate) fn internal_routes() -> Router<FoundationState> {
    Router::new()
        .route(
            "/internal/v1/portfolio-publications/lease",
            post(lease_publication),
        )
        .route(
            "/internal/v1/portfolio-publications/{publication_id}/complete",
            post(complete_publication),
        )
}

async fn create_publication(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    headers: HeaderMap,
    SafeJson(mut request): SafeJson<CreatePublicationRequest>,
) -> Result<(StatusCode, Json<PublicationResponse>), ApiError> {
    m3::require_enabled(&state)?;
    let account_id = authenticated.account_id()?;
    request.slug = normalize_slug(&request.slug)?;
    let key = intent::idempotency_key(&headers)?;
    let request_hash = intent::request_hash(&request)?;
    let now = m3::policy_now(&state).await?;
    let mut tx = state.pool.begin().await?;
    intent::acquire_operation_lock(&mut tx, account_id, CREATE_OPERATION, key).await?;
    match intent::replay(&mut tx, account_id, CREATE_OPERATION, key, &request_hash).await? {
        Replay::Match(response) => {
            tx.commit().await?;
            return Ok((StatusCode::CREATED, Json(response)));
        }
        Replay::Changed => {
            tx.rollback().await?;
            return Err(ApiError::conflict(
                "idempotency_payload_changed",
                "the idempotency key was already used with different publication input",
            ));
        }
        Replay::Miss => {}
    }
    lock_account(&mut tx, account_id).await?;
    let document =
        load_public_portfolio_document(&mut tx, account_id, request.approved_revision_id).await?;
    let document = serde_json::to_value(document).map_err(|_| ApiError::internal())?;
    let document_digest = json_digest(&document)?;
    let latest_approved_revision: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM portfolio_approved_revisions WHERE account_id=$1 \
         ORDER BY approval_sequence DESC LIMIT 1",
    )
    .bind(account_id)
    .fetch_optional(&mut *tx)
    .await?;
    if latest_approved_revision.is_some_and(|latest| latest != request.approved_revision_id) {
        return Err(ApiError::conflict(
            "stale_approved_revision",
            "only the current approved portfolio revision can be published",
        ));
    }
    claim_site(&mut tx, account_id, &request.slug, now).await?;
    let existing: Option<PublicationRow> = sqlx::query_as(
        "SELECT id,approved_revision_id,slug,cause,state,document_digest,artifact_digest, \
                pointer_generation,failure_code,created_at,updated_at,published_at \
         FROM portfolio_publications \
         WHERE account_id=$1 AND approved_revision_id=$2 AND document_digest=$3",
    )
    .bind(account_id)
    .bind(request.approved_revision_id)
    .bind(&document_digest)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(existing) = existing {
        let response = publication_response(existing);
        intent::store_replay(
            &mut tx,
            account_id,
            CREATE_OPERATION,
            key,
            &request_hash,
            201,
            &response,
        )
        .await?;
        tx.commit().await?;
        return Ok((StatusCode::CREATED, Json(response)));
    }
    supersede_unstarted(&mut tx, account_id, now).await?;
    let id = Uuid::new_v4();
    let audit_id = insert_audit(
        &mut tx,
        account_id,
        Some(authenticated.session_id()),
        "portfolio.publication.queued",
        id,
        now,
    )
    .await?;
    let row: PublicationRow = sqlx::query_as(
        "INSERT INTO portfolio_publications \
         (id,account_id,approved_revision_id,slug,document,document_digest,cause,state,audit_event_id,created_at,updated_at) \
         VALUES ($1,$2,$3,$4,$5,$6,'owner_request','queued',$7,$8,$8) \
         RETURNING id,approved_revision_id,slug,cause,state,document_digest,artifact_digest, \
                   pointer_generation,failure_code,created_at,updated_at,published_at",
    )
    .bind(id)
    .bind(account_id)
    .bind(request.approved_revision_id)
    .bind(&request.slug)
    .bind(document)
    .bind(&document_digest)
    .bind(audit_id)
    .bind(now)
    .fetch_one(&mut *tx)
    .await?;
    let response = publication_response(row);
    intent::store_replay(
        &mut tx,
        account_id,
        CREATE_OPERATION,
        key,
        &request_hash,
        201,
        &response,
    )
    .await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(response)))
}

async fn get_publication(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    AxumPath(publication_id): AxumPath<Uuid>,
) -> Result<Json<PublicationResponse>, ApiError> {
    m3::require_enabled(&state)?;
    let account_id = authenticated.account_id()?;
    load_publication(&state, account_id, Some(publication_id))
        .await
        .map(Json)
}

async fn get_latest_publication(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
) -> Result<Json<PublicationResponse>, ApiError> {
    m3::require_enabled(&state)?;
    let account_id = authenticated.account_id()?;
    load_publication(&state, account_id, None).await.map(Json)
}

async fn load_publication(
    state: &FoundationState,
    account_id: Uuid,
    id: Option<Uuid>,
) -> Result<PublicationResponse, ApiError> {
    let row = if let Some(id) = id {
        sqlx::query_as::<_, PublicationRow>(
            "SELECT id,approved_revision_id,slug,cause,state,document_digest,artifact_digest, \
                    pointer_generation,failure_code,created_at,updated_at,published_at \
             FROM portfolio_publications WHERE account_id=$1 AND id=$2",
        )
        .bind(account_id)
        .bind(id)
        .fetch_optional(&state.pool)
        .await?
    } else {
        sqlx::query_as::<_, PublicationRow>(
            "SELECT id,approved_revision_id,slug,cause,state,document_digest,artifact_digest, \
                    pointer_generation,failure_code,created_at,updated_at,published_at \
             FROM portfolio_publications WHERE account_id=$1 ORDER BY publication_sequence DESC LIMIT 1",
        )
        .bind(account_id)
        .fetch_optional(&state.pool)
        .await?
    };
    row.map(publication_response)
        .ok_or_else(ApiError::not_found)
}

async fn lease_publication(
    State(state): State<FoundationState>,
    _: PublisherWorkerAuth,
    SafeJson(request): SafeJson<LeaseRequest>,
) -> Result<impl axum::response::IntoResponse, ApiError> {
    validate_worker_id(&request.worker_id)?;
    let expires = Utc::now() + Duration::seconds(state.worker_lease_seconds);
    let root = publisher_root(&state)?;
    let mut tx = state.pool.begin().await?;
    let candidate: Option<(Uuid, Option<Uuid>)> = sqlx::query_as(
        "SELECT p.id,p.current_attempt_id FROM portfolio_publications p \
         JOIN portfolio_public_sites s ON s.account_id=p.account_id \
         WHERE (p.state='queued' OR (p.state='publishing' AND p.lease_expires_at < clock_timestamp())) \
           AND s.promotion_publication_id IS NULL \
           AND NOT EXISTS (SELECT 1 FROM portfolio_publications newer \
                           WHERE newer.account_id=p.account_id AND newer.publication_sequence>p.publication_sequence) \
         ORDER BY p.publication_sequence FOR UPDATE SKIP LOCKED LIMIT 1",
    )
    .fetch_optional(&mut *tx)
    .await?;
    let Some((id, previous_attempt_id)) = candidate else {
        tx.commit().await?;
        return Ok(StatusCode::NO_CONTENT.into_response());
    };
    sqlx::query(
        "UPDATE portfolio_publication_attempts SET state='expired',completed_at=clock_timestamp() \
         WHERE publication_id=$1 AND state='leased'",
    )
    .bind(id)
    .execute(&mut *tx)
    .await?;
    if let Some(previous_attempt_id) = previous_attempt_id {
        cleanup_owned_staging(&root, id, previous_attempt_id)?;
    }
    let attempt_id = Uuid::new_v4();
    let row: (Uuid, Uuid, String, serde_json::Value, String, i32, i64) = sqlx::query_as(
        "UPDATE portfolio_publications SET state='publishing',attempt_count=attempt_count+1, \
                current_attempt_id=$2,current_fence=current_fence+1,lease_expires_at=$3,updated_at=clock_timestamp() \
         WHERE id=$1 RETURNING id,approved_revision_id,slug,document,document_digest,attempt_count,current_fence",
    )
    .bind(id)
    .bind(attempt_id)
    .bind(expires)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO portfolio_publication_attempts \
         (id,publication_id,attempt_number,fence,worker_id,state,lease_expires_at) \
         VALUES ($1,$2,$3,$4,$5,'leased',$6)",
    )
    .bind(attempt_id)
    .bind(id)
    .bind(row.5)
    .bind(row.6)
    .bind(&request.worker_id)
    .bind(expires)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    let body = LeaseResponse {
        publication_id: row.0,
        approved_revision_id: row.1,
        slug: row.2,
        document: row.3,
        document_digest: row.4,
        staging_relative_path: format!("staging/{id}/{attempt_id}"),
        attempt_id,
        fence: row.6,
        lease_expires_at: expires,
    };
    Ok((StatusCode::OK, Json(body)).into_response())
}

async fn complete_publication(
    State(state): State<FoundationState>,
    _: PublisherWorkerAuth,
    AxumPath(publication_id): AxumPath<Uuid>,
    SafeJson(request): SafeJson<CompleteRequest>,
) -> Result<Json<CompleteResponse>, ApiError> {
    validate_worker_id(&request.worker_id)?;
    match &request.outcome {
        CompletionOutcome::Failed { code } => {
            validate_failure_code(code)?;
            let row = finish_failed(&state, publication_id, &request, code).await?;
            let root = publisher_root(&state)?;
            cleanup_owned_staging(&root, publication_id, request.attempt_id)?;
            Ok(Json(CompleteResponse { publication: row }))
        }
        CompletionOutcome::Succeeded { artifact_digest } => {
            ensure_active_attempt(&state, publication_id, &request).await?;
            validate_digest(artifact_digest)?;
            let root = publisher_root(&state)?;
            let staging =
                exact_staging_path(&root, publication_id, request.attempt_id, invalid_artifact)?
                    .ok_or_else(invalid_artifact)?;
            let expected = artifact_digest.clone();
            let validated = tokio::task::spawn_blocking(move || {
                validate_staged_site(&staging, publication_id, &expected)
            })
            .await
            .map_err(|_| ApiError::internal())??;
            install_artifact(&root, &validated)?;
            let slug = prepare_promotion(&state, publication_id, &request, &validated).await?;
            switch_pointer(&root, &slug, &validated.artifact_digest)?;
            finalize_promotion(&state, publication_id).await?;
            Ok(Json(CompleteResponse {
                publication: load_publication_by_id(&state, publication_id).await?,
            }))
        }
    }
}

async fn finish_failed(
    state: &FoundationState,
    publication_id: Uuid,
    request: &CompleteRequest,
    code: &str,
) -> Result<PublicationResponse, ApiError> {
    let mut tx = state.pool.begin().await?;
    let row: Option<PublicationRow> = sqlx::query_as(
        "UPDATE portfolio_publications SET state='failed',failure_code=$5,lease_expires_at=NULL,updated_at=clock_timestamp() \
         WHERE id=$1 AND state='publishing' AND current_attempt_id=$2 AND current_fence=$3 \
           AND lease_expires_at>=clock_timestamp() \
           AND EXISTS (SELECT 1 FROM portfolio_publication_attempts a WHERE a.id=$2 AND a.publication_id=$1 \
                       AND a.worker_id=$4 AND a.fence=$3 AND a.state='leased') \
         RETURNING id,approved_revision_id,slug,cause,state,document_digest,artifact_digest, \
                   pointer_generation,failure_code,created_at,updated_at,published_at",
    )
    .bind(publication_id)
    .bind(request.attempt_id)
    .bind(request.fence)
    .bind(&request.worker_id)
    .bind(code)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(row) = row else {
        return Err(stale_attempt());
    };
    sqlx::query(
        "UPDATE portfolio_publication_attempts SET state='failed',completion_code=$2,completed_at=clock_timestamp() WHERE id=$1",
    )
    .bind(request.attempt_id)
    .bind(code)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(publication_response(row))
}

async fn ensure_active_attempt(
    state: &FoundationState,
    publication_id: Uuid,
    request: &CompleteRequest,
) -> Result<(), ApiError> {
    let active: bool = sqlx::query_scalar(
        "SELECT EXISTS (\
         SELECT 1 FROM portfolio_publications p \
         WHERE p.id=$1 AND p.state='publishing' AND p.current_attempt_id=$2 AND p.current_fence=$3 \
           AND p.lease_expires_at>=clock_timestamp() \
           AND EXISTS (SELECT 1 FROM portfolio_publication_attempts a \
                       WHERE a.id=$2 AND a.publication_id=$1 \
                         AND a.worker_id=$4 AND a.fence=$3 AND a.state='leased')\
         )",
    )
    .bind(publication_id)
    .bind(request.attempt_id)
    .bind(request.fence)
    .bind(&request.worker_id)
    .fetch_one(&state.pool)
    .await?;
    if !active {
        return Err(stale_attempt());
    }
    Ok(())
}

async fn prepare_promotion(
    state: &FoundationState,
    publication_id: Uuid,
    request: &CompleteRequest,
    site: &ValidatedSite,
) -> Result<String, ApiError> {
    let mut tx = state.pool.begin().await?;
    let row: Option<(Uuid, String, i64, i64, String)> = sqlx::query_as(
        "SELECT p.account_id,p.slug,p.publication_sequence,s.pointer_generation,p.document_digest \
         FROM portfolio_publications p JOIN portfolio_public_sites s ON s.account_id=p.account_id \
         WHERE p.id=$1 AND p.state='publishing' AND p.current_attempt_id=$2 AND p.current_fence=$3 \
           AND s.promotion_publication_id IS NULL \
           AND p.lease_expires_at>=clock_timestamp() \
           AND EXISTS (SELECT 1 FROM portfolio_publication_attempts a WHERE a.id=$2 AND a.publication_id=$1 \
                       AND a.worker_id=$4 AND a.fence=$3 AND a.state='leased') \
         FOR UPDATE OF p,s",
    )
    .bind(publication_id)
    .bind(request.attempt_id)
    .bind(request.fence)
    .bind(&request.worker_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((account_id, slug, sequence, generation, document_digest)) = row else {
        return Err(stale_attempt());
    };
    if site.manifest.document_digest != document_digest {
        return Err(invalid_artifact());
    }
    let newest: i64 = sqlx::query_scalar(
        "SELECT max(publication_sequence) FROM portfolio_publications WHERE account_id=$1",
    )
    .bind(account_id)
    .fetch_one(&mut *tx)
    .await?;
    if newest != sequence {
        return Err(ApiError::conflict(
            "stale_publication",
            "a newer publication revision exists",
        ));
    }
    let next_generation = generation + 1;
    let manifest = serde_json::to_value(&site.manifest).map_err(|_| ApiError::internal())?;
    sqlx::query(
        "UPDATE portfolio_public_sites SET promotion_publication_id=$2,promotion_artifact_digest=$3, \
                promotion_manifest=$4,promotion_generation=$5,updated_at=clock_timestamp() WHERE account_id=$1",
    )
    .bind(account_id)
    .bind(publication_id)
    .bind(&site.artifact_digest)
    .bind(&manifest)
    .bind(next_generation)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE portfolio_publications SET state='promotion_pending',artifact_digest=$2,manifest=$3, \
                pointer_generation=$4,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=$1",
    )
    .bind(publication_id)
    .bind(&site.artifact_digest)
    .bind(&manifest)
    .bind(next_generation)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE portfolio_publication_attempts SET state='succeeded',completion_code='rendered', \
                completed_at=clock_timestamp() WHERE id=$1",
    )
    .bind(request.attempt_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(slug)
}

pub(crate) async fn reconcile_pending(state: &FoundationState) -> Result<(), ApiError> {
    if state.m3.is_none() {
        return Ok(());
    }
    let rows: Vec<PromotionRow> = sqlx::query_as(
        "SELECT account_id,slug,promotion_publication_id,promotion_artifact_digest, \
                promotion_manifest,promotion_generation FROM portfolio_public_sites \
         WHERE promotion_publication_id IS NOT NULL ORDER BY updated_at",
    )
    .fetch_all(&state.pool)
    .await?;
    let root = publisher_root(state)?;
    for row in rows {
        if row.promotion_generation <= 0 {
            return Err(ApiError::internal());
        }
        let manifest: SiteManifest = serde_json::from_value(row.promotion_manifest.clone())
            .map_err(|_| ApiError::internal())?;
        let validated = validate_immutable_site(
            &root,
            row.promotion_publication_id,
            &row.promotion_artifact_digest,
            manifest,
        )?;
        switch_pointer(&root, &row.slug, &validated.artifact_digest)?;
        finalize_promotion(state, row.promotion_publication_id).await?;
    }
    Ok(())
}

async fn finalize_promotion(state: &FoundationState, publication_id: Uuid) -> Result<(), ApiError> {
    let mut tx = state.pool.begin().await?;
    let row: Option<PromotionRow> = sqlx::query_as(
        "SELECT account_id,slug,promotion_publication_id,promotion_artifact_digest, \
                promotion_manifest,promotion_generation FROM portfolio_public_sites \
         WHERE promotion_publication_id=$1 FOR UPDATE",
    )
    .bind(publication_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(row) = row else {
        let published: Option<(String,)> =
            sqlx::query_as("SELECT state FROM portfolio_publications WHERE id=$1")
                .bind(publication_id)
                .fetch_optional(&mut *tx)
                .await?;
        tx.commit().await?;
        return match published {
            Some((state,)) if state == "published" => Ok(()),
            _ => Err(ApiError::conflict(
                "promotion_not_pending",
                "the publication has no pending promotion",
            )),
        };
    };
    let root = publisher_root(state)?;
    verify_current_pointer(&root, &row.slug, &row.promotion_artifact_digest)?;
    sqlx::query(
        "UPDATE portfolio_public_sites SET current_publication_id=promotion_publication_id, \
                current_artifact_digest=promotion_artifact_digest,pointer_generation=promotion_generation, \
                promotion_publication_id=NULL,promotion_artifact_digest=NULL,promotion_manifest=NULL, \
                promotion_generation=NULL,updated_at=clock_timestamp() WHERE account_id=$1",
    )
    .bind(row.account_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE portfolio_publications SET state='published',published_at=clock_timestamp(), \
                updated_at=clock_timestamp() WHERE id=$1 AND state='promotion_pending'",
    )
    .bind(publication_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

pub(crate) async fn enqueue_fact_refresh_publication(
    tx: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    approved_revision_id: Uuid,
    occurred_at: DateTime<Utc>,
) -> Result<Option<Uuid>, ApiError> {
    let site: Option<(String,)> =
        sqlx::query_as("SELECT slug FROM portfolio_public_sites WHERE account_id=$1 FOR UPDATE")
            .bind(account_id)
            .fetch_optional(&mut **tx)
            .await?;
    let Some((slug,)) = site else {
        return Ok(None);
    };
    let document = load_public_portfolio_document(tx, account_id, approved_revision_id).await?;
    let document = serde_json::to_value(document).map_err(|_| ApiError::internal())?;
    let digest = json_digest(&document)?;
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM portfolio_publications \
         WHERE account_id=$1 AND approved_revision_id=$2 AND document_digest=$3)",
    )
    .bind(account_id)
    .bind(approved_revision_id)
    .bind(&digest)
    .fetch_one(&mut **tx)
    .await?;
    if exists {
        return Ok(None);
    }
    supersede_unstarted(tx, account_id, occurred_at).await?;
    let id = Uuid::new_v4();
    let audit_id = insert_audit(
        tx,
        account_id,
        None,
        "portfolio.publication.fact_refresh_queued",
        id,
        occurred_at,
    )
    .await?;
    sqlx::query(
        "INSERT INTO portfolio_publications \
         (id,account_id,approved_revision_id,slug,document,document_digest,cause,state,audit_event_id,created_at,updated_at) \
         VALUES ($1,$2,$3,$4,$5,$6,'deployment_fact_refresh','queued',$7,$8,$8)",
    )
    .bind(id)
    .bind(account_id)
    .bind(approved_revision_id)
    .bind(slug)
    .bind(document)
    .bind(digest)
    .bind(audit_id)
    .bind(occurred_at)
    .execute(&mut **tx)
    .await?;
    Ok(Some(id))
}

async fn lock_account(
    tx: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
) -> Result<(), ApiError> {
    sqlx::query_scalar::<_, Uuid>("SELECT id FROM accounts WHERE id=$1 FOR UPDATE")
        .bind(account_id)
        .fetch_one(&mut **tx)
        .await?;
    Ok(())
}

async fn claim_site(
    tx: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    slug: &str,
    now: DateTime<Utc>,
) -> Result<(), ApiError> {
    let owner: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT account_id,slug FROM portfolio_public_sites WHERE account_id=$1 OR slug=$2 FOR UPDATE",
    )
    .bind(account_id)
    .bind(slug)
    .fetch_optional(&mut **tx)
    .await?;
    match owner {
        Some((owner, existing)) if owner == account_id && existing == slug => Ok(()),
        Some((owner, _)) if owner != account_id => Err(ApiError::conflict(
            "publication_slug_unavailable",
            "the public site slug is unavailable",
        )),
        Some(_) => Err(ApiError::conflict(
            "publication_slug_fixed",
            "the account already owns a different public site slug",
        )),
        None => {
            sqlx::query(
                "INSERT INTO portfolio_public_sites(account_id,slug,created_at,updated_at) VALUES ($1,$2,$3,$3)",
            )
            .bind(account_id)
            .bind(slug)
            .bind(now)
            .execute(&mut **tx)
            .await
            .map_err(|error| match &error {
                sqlx::Error::Database(database) if database.is_unique_violation() => ApiError::conflict(
                    "publication_slug_unavailable",
                    "the public site slug is unavailable",
                ),
                _ => ApiError::from(error),
            })?;
            Ok(())
        }
    }
}

async fn supersede_unstarted(
    tx: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    now: DateTime<Utc>,
) -> Result<(), ApiError> {
    sqlx::query(
        "UPDATE portfolio_publication_attempts SET state='fenced',completion_code='superseded',completed_at=$2 \
         WHERE state='leased' AND publication_id IN \
           (SELECT id FROM portfolio_publications WHERE account_id=$1 AND state IN ('queued','publishing'))",
    )
    .bind(account_id)
    .bind(now)
    .execute(&mut **tx)
    .await?;
    sqlx::query(
        "UPDATE portfolio_publications SET state='failed',failure_code='superseded',updated_at=$2 \
         WHERE account_id=$1 AND state IN ('queued','publishing')",
    )
    .bind(account_id)
    .bind(now)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn insert_audit(
    tx: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    session_id: Option<Uuid>,
    event_type: &str,
    target_id: Uuid,
    occurred_at: DateTime<Utc>,
) -> Result<Uuid, ApiError> {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO audit_events \
         (id,account_id,actor_account_id,session_id,event_type,target_type,target_id,outcome,created_at) \
         VALUES ($1,$2,$3,$4,$5,'portfolio_publication',$6,'succeeded',$7)",
    )
    .bind(id)
    .bind(account_id)
    .bind(session_id.map(|_| account_id))
    .bind(session_id)
    .bind(event_type)
    .bind(target_id)
    .bind(occurred_at)
    .execute(&mut **tx)
    .await?;
    Ok(id)
}

fn publication_response(row: PublicationRow) -> PublicationResponse {
    PublicationResponse {
        id: row.id,
        approved_revision_id: row.approved_revision_id,
        slug: row.slug,
        cause: row.cause,
        state: row.state,
        document_digest: row.document_digest,
        artifact_digest: row.artifact_digest,
        pointer_generation: row.pointer_generation,
        failure_code: row.failure_code,
        created_at: row.created_at,
        updated_at: row.updated_at,
        published_at: row.published_at,
    }
}

async fn load_publication_by_id(
    state: &FoundationState,
    id: Uuid,
) -> Result<PublicationResponse, ApiError> {
    let row = sqlx::query_as::<_, PublicationRow>(
        "SELECT id,approved_revision_id,slug,cause,state,document_digest,artifact_digest, \
                pointer_generation,failure_code,created_at,updated_at,published_at \
         FROM portfolio_publications WHERE id=$1",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await?;
    row.map(publication_response)
        .ok_or_else(ApiError::not_found)
}

fn normalize_slug(value: &str) -> Result<String, ApiError> {
    if value != value.trim() || value.len() > 63 || value.is_empty() {
        return Err(invalid_slug());
    }
    let slug = value.to_ascii_lowercase();
    if slug != value
        || !slug
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        || slug.starts_with('-')
        || slug.ends_with('-')
    {
        return Err(invalid_slug());
    }
    Ok(slug)
}

fn invalid_slug() -> ApiError {
    ApiError::bad_request(
        "invalid_publication_slug",
        "the public site slug must be lowercase ASCII letters, digits and interior hyphens",
    )
}

fn validate_worker_id(value: &str) -> Result<(), ApiError> {
    if value.is_empty() || value.len() > 128 || !value.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(ApiError::bad_request(
            "invalid_worker_id",
            "the worker id is invalid",
        ));
    }
    Ok(())
}

fn validate_failure_code(value: &str) -> Result<(), ApiError> {
    if value.is_empty()
        || value.len() > 96
        || !value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
    {
        return Err(ApiError::bad_request(
            "invalid_failure_code",
            "the failure code is invalid",
        ));
    }
    Ok(())
}

fn validate_digest(value: &str) -> Result<(), ApiError> {
    let valid = value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    });
    if !valid {
        return Err(ApiError::bad_request(
            "invalid_artifact_digest",
            "the artifact digest is invalid",
        ));
    }
    Ok(())
}

fn json_digest(value: &serde_json::Value) -> Result<String, ApiError> {
    let bytes = serde_json::to_vec(value).map_err(|_| ApiError::internal())?;
    Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
}

fn stale_attempt() -> ApiError {
    ApiError::conflict(
        "publisher_attempt_fenced",
        "the publisher attempt is stale, expired or does not own the current fence",
    )
}

fn publisher_root(state: &FoundationState) -> Result<PathBuf, ApiError> {
    let root = m3::require_enabled(state)?.state_dir.join("publisher");
    ensure_private_dir(&root)?;
    for child in ["staging", "artifacts", "sites"] {
        ensure_private_dir(&root.join(child))?;
    }
    Ok(root)
}

fn publisher_staging_cleanup_failed() -> ApiError {
    ApiError::unavailable(
        "publisher_staging_cleanup_failed",
        "the publisher staging tree could not be safely cleaned up",
    )
}

fn cleanup_owned_staging(
    root: &Path,
    publication_id: Uuid,
    attempt_id: Uuid,
) -> Result<(), ApiError> {
    let Some(staging) = exact_staging_path(
        root,
        publication_id,
        attempt_id,
        publisher_staging_cleanup_failed,
    )?
    else {
        return Ok(());
    };
    fs::remove_dir_all(staging).map_err(|_| publisher_staging_cleanup_failed())
}

fn exact_staging_path(
    root: &Path,
    publication_id: Uuid,
    attempt_id: Uuid,
    error: fn() -> ApiError,
) -> Result<Option<PathBuf>, ApiError> {
    let metadata = fs::symlink_metadata(root).map_err(|_| error())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(error());
    }
    let root = fs::canonicalize(root).map_err(|_| error())?;
    canonical_directory(&root, error)?;
    let staging_root = root.join("staging");
    canonical_directory(&staging_root, error)?;

    let publication_root = staging_root.join(publication_id.to_string());
    let publication_metadata = match fs::symlink_metadata(&publication_root) {
        Ok(metadata) => metadata,
        Err(error_value) if error_value.kind() == std::io::ErrorKind::NotFound => {
            return Ok(None);
        }
        Err(_) => return Err(error()),
    };
    if !publication_metadata.is_dir() || publication_metadata.file_type().is_symlink() {
        return Err(error());
    }
    if fs::canonicalize(&publication_root).map_err(|_| error())? != publication_root {
        return Err(error());
    }

    let attempt_path = publication_root.join(attempt_id.to_string());
    let attempt_metadata = match fs::symlink_metadata(&attempt_path) {
        Ok(metadata) => metadata,
        Err(error_value) if error_value.kind() == std::io::ErrorKind::NotFound => {
            return Ok(None);
        }
        Err(_) => return Err(error()),
    };
    if !attempt_metadata.is_dir() || attempt_metadata.file_type().is_symlink() {
        return Err(error());
    }
    if fs::canonicalize(&attempt_path).map_err(|_| error())? != attempt_path {
        return Err(error());
    }
    Ok(Some(attempt_path))
}

fn canonical_directory(path: &Path, error: fn() -> ApiError) -> Result<(), ApiError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| error())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(error());
    }
    if fs::canonicalize(path).map_err(|_| error())? != path {
        return Err(error());
    }
    Ok(())
}

fn ensure_private_dir(path: &Path) -> Result<(), ApiError> {
    if !path.exists() {
        fs::create_dir(path).map_err(|_| ApiError::internal())?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| ApiError::internal())?;
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| ApiError::internal())?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.permissions().mode() & 0o077 != 0
    {
        return Err(ApiError::unavailable(
            "publisher_storage_invalid",
            "the publisher artifact storage is unavailable",
        ));
    }
    Ok(())
}

struct ValidatedSite {
    staging: Option<PathBuf>,
    artifact_digest: String,
    manifest: SiteManifest,
}

fn validate_staged_site(
    staging: &Path,
    publication_id: Uuid,
    expected_digest: &str,
) -> Result<ValidatedSite, ApiError> {
    let metadata = fs::symlink_metadata(staging).map_err(|_| invalid_artifact())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(invalid_artifact());
    }
    let manifest_path = staging.join("manifest.json");
    let manifest_metadata = fs::symlink_metadata(&manifest_path).map_err(|_| invalid_artifact())?;
    if !manifest_metadata.is_file()
        || manifest_metadata.file_type().is_symlink()
        || manifest_metadata.len() > MAX_MANIFEST_BYTES
    {
        return Err(invalid_artifact());
    }
    let bytes = fs::read(&manifest_path).map_err(|_| invalid_artifact())?;
    let digest = format!("sha256:{:x}", Sha256::digest(&bytes));
    if digest != expected_digest {
        return Err(invalid_artifact());
    }
    let manifest: SiteManifest = serde_json::from_slice(&bytes).map_err(|_| invalid_artifact())?;
    if manifest.format != MANIFEST_FORMAT || manifest.publication_id != publication_id {
        return Err(invalid_artifact());
    }
    validate_manifest_tree(staging, &manifest)?;
    Ok(ValidatedSite {
        staging: Some(staging.to_path_buf()),
        artifact_digest: digest,
        manifest,
    })
}

fn validate_immutable_site(
    root: &Path,
    publication_id: Uuid,
    digest: &str,
    manifest: SiteManifest,
) -> Result<ValidatedSite, ApiError> {
    validate_digest(digest)?;
    if manifest.publication_id != publication_id {
        return Err(invalid_artifact());
    }
    let directory = artifact_path(root, digest)?;
    let bytes = fs::read(directory.join("manifest.json")).map_err(|_| invalid_artifact())?;
    if format!("sha256:{:x}", Sha256::digest(&bytes)) != digest {
        return Err(invalid_artifact());
    }
    let stored: SiteManifest = serde_json::from_slice(&bytes).map_err(|_| invalid_artifact())?;
    if serde_json::to_value(&stored).ok() != serde_json::to_value(&manifest).ok() {
        return Err(invalid_artifact());
    }
    validate_manifest_tree(&directory, &manifest)?;
    Ok(ValidatedSite {
        staging: None,
        artifact_digest: digest.to_owned(),
        manifest,
    })
}

fn validate_manifest_tree(root: &Path, manifest: &SiteManifest) -> Result<(), ApiError> {
    if manifest.files.is_empty() || manifest.files.len() > MAX_FILES {
        return Err(invalid_artifact());
    }
    let mut declared = HashSet::new();
    let mut last = None::<&str>;
    let mut total = 0_u64;
    for entry in &manifest.files {
        validate_relative_path(&entry.path)?;
        if last.is_some_and(|previous| previous >= entry.path.as_str())
            || !declared.insert(entry.path.clone())
        {
            return Err(invalid_artifact());
        }
        last = Some(&entry.path);
        if entry.bytes > MAX_FILE_BYTES {
            return Err(invalid_artifact());
        }
        total = total
            .checked_add(entry.bytes)
            .ok_or_else(invalid_artifact)?;
        if total > MAX_SITE_BYTES {
            return Err(invalid_artifact());
        }
        validate_digest(&entry.sha256).map_err(|_| invalid_artifact())?;
        if !matches!(
            entry.content_type.as_str(),
            "text/html; charset=utf-8"
                | "text/css; charset=utf-8"
                | "image/png"
                | "image/jpeg"
                | "image/webp"
        ) {
            return Err(invalid_artifact());
        }
        let path = root.join(&entry.path);
        let metadata = fs::symlink_metadata(&path).map_err(|_| invalid_artifact())?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() != entry.bytes
        {
            return Err(invalid_artifact());
        }
        let bytes = fs::read(path).map_err(|_| invalid_artifact())?;
        if format!("sha256:{:x}", Sha256::digest(bytes)) != entry.sha256 {
            return Err(invalid_artifact());
        }
    }
    if !declared.contains("index.html") || !declared.contains("assets/site.css") {
        return Err(invalid_artifact());
    }
    let mut observed = HashSet::new();
    collect_files(root, root, &mut observed)?;
    observed.remove("manifest.json");
    if observed != declared {
        return Err(invalid_artifact());
    }
    Ok(())
}

fn collect_files(
    base: &Path,
    directory: &Path,
    output: &mut HashSet<String>,
) -> Result<(), ApiError> {
    for item in fs::read_dir(directory).map_err(|_| invalid_artifact())? {
        let item = item.map_err(|_| invalid_artifact())?;
        let path = item.path();
        let metadata = fs::symlink_metadata(&path).map_err(|_| invalid_artifact())?;
        if metadata.file_type().is_symlink() {
            return Err(invalid_artifact());
        }
        if metadata.is_dir() {
            collect_files(base, &path, output)?;
        } else if metadata.is_file() {
            let relative = path.strip_prefix(base).map_err(|_| invalid_artifact())?;
            let relative = relative
                .to_str()
                .ok_or_else(invalid_artifact)?
                .replace('\\', "/");
            validate_relative_path(&relative)?;
            output.insert(relative);
        } else {
            return Err(invalid_artifact());
        }
        if output.len() > MAX_FILES + 1 {
            return Err(invalid_artifact());
        }
    }
    Ok(())
}

fn validate_relative_path(value: &str) -> Result<(), ApiError> {
    if value.is_empty() || value.len() > 512 || value.contains('\\') || !value.is_ascii() {
        return Err(invalid_artifact());
    }
    let path = Path::new(value);
    if path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
        || value
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(invalid_artifact());
    }
    Ok(())
}

fn invalid_artifact() -> ApiError {
    ApiError::unprocessable(
        "invalid_static_artifact",
        "the staged static artifact failed integrity validation",
    )
}

fn install_artifact(root: &Path, site: &ValidatedSite) -> Result<(), ApiError> {
    let artifact = artifact_path(root, &site.artifact_digest)?;
    if !artifact.exists() {
        let staging = site.staging.as_ref().ok_or_else(ApiError::internal)?;
        fs::rename(staging, &artifact).map_err(|_| ApiError::internal())?;
        fs::File::open(root.join("artifacts"))
            .and_then(|directory| directory.sync_all())
            .map_err(|_| ApiError::internal())?;
    } else {
        validate_immutable_site(
            root,
            site.manifest.publication_id,
            &site.artifact_digest,
            site.manifest.clone(),
        )?;
        if let Some(staging) = &site.staging {
            fs::remove_dir_all(staging).map_err(|_| ApiError::internal())?;
        }
    }
    Ok(())
}

fn switch_pointer(root: &Path, slug: &str, digest: &str) -> Result<(), ApiError> {
    let site = root.join("sites").join(slug);
    ensure_private_dir(&site)?;
    let hex = digest
        .strip_prefix("sha256:")
        .ok_or_else(invalid_artifact)?;
    let target = PathBuf::from("../../artifacts").join(format!("sha256-{hex}"));
    let temporary = site.join(format!(".current-{}", Uuid::new_v4()));
    symlink(&target, &temporary).map_err(|_| ApiError::internal())?;
    fs::rename(&temporary, site.join("current")).map_err(|_| ApiError::internal())?;
    fs::File::open(&site)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| ApiError::internal())?;
    Ok(())
}

fn verify_current_pointer(root: &Path, slug: &str, digest: &str) -> Result<(), ApiError> {
    let hex = digest
        .strip_prefix("sha256:")
        .ok_or_else(invalid_artifact)?;
    let expected = PathBuf::from("../../artifacts").join(format!("sha256-{hex}"));
    let actual = fs::read_link(root.join("sites").join(slug).join("current")).map_err(|_| {
        ApiError::unavailable(
            "publisher_pointer_missing",
            "the public site pointer is not installed",
        )
    })?;
    if actual != expected {
        return Err(ApiError::conflict(
            "publisher_pointer_mismatch",
            "the public site pointer does not match the pending promotion",
        ));
    }
    Ok(())
}

fn artifact_path(root: &Path, digest: &str) -> Result<PathBuf, ApiError> {
    validate_digest(digest)?;
    Ok(root.join("artifacts").join(format!(
        "sha256-{}",
        digest
            .strip_prefix("sha256:")
            .ok_or_else(invalid_artifact)?
    )))
}
