use std::collections::{HashMap, HashSet};

use axum::{
    Json, Router,
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use hostlet_contracts::portfolio::{
    ApprovalTarget, AvailabilityLabel, ContactLink, NarrativeField, PortfolioDraft,
    ProjectEvidence, ProjectLink, ProjectLinkKind, ProjectReferenceKind, PublicLink,
    RefreshableDeploymentFact, StatusField, TechnicalDecision, Visibility,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, Postgres, Transaction};
use uuid::Uuid;

use crate::{
    auth::Authenticated,
    error::{ApiError, SafeJson},
    foundation::FoundationState,
    intent::{self, Replay},
    m3::{self, RuntimeWorkerAuth},
};

const APPROVE_OPERATION: &str = "portfolio.approved_revision.create";
const READINESS_OPERATION: &str = "portfolio.readiness.attest";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReviewQuery {
    draft_revision_id: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ApprovalRequirementResponse {
    pub target: ApprovalTarget,
    pub value: Value,
    pub value_digest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ReviewDeploymentFact {
    pub project_reference_id: String,
    pub hosted_project_id: Uuid,
    pub source_release_id: Uuid,
    pub source_deployment_id: Uuid,
    pub managed_demo_url: String,
    pub deployed_at: DateTime<Utc>,
    pub availability: AvailabilityLabel,
    pub status_label: String,
    pub availability_observed_at: DateTime<Utc>,
    pub demo_access_revision: i64,
    pub public_source_commit: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublicationReviewResponse {
    pub draft_revision_id: Uuid,
    pub draft_revision: u64,
    pub review_digest: String,
    pub snapshot: PortfolioDraft,
    pub preview_context: Value,
    pub requirements: Vec<ApprovalRequirementResponse>,
    pub deployment_facts: Vec<ReviewDeploymentFact>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApprovalAcknowledgement {
    pub target: ApprovalTarget,
    pub value_digest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ApprovalEvidence {
    EntireRevision {
        review_digest: String,
    },
    IndividualFields {
        fields: Vec<ApprovalAcknowledgement>,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum RefreshField {
    ManagedDemoDestination,
    DeploymentTimestamp,
    AvailabilityLabel,
}

impl RefreshField {
    fn contract_value(self) -> RefreshableDeploymentFact {
        match self {
            Self::ManagedDemoDestination => RefreshableDeploymentFact::ManagedDemoDestination,
            Self::DeploymentTimestamp => RefreshableDeploymentFact::DeploymentTimestamp,
            Self::AvailabilityLabel => RefreshableDeploymentFact::AvailabilityLabel,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RefreshAuthorizationRequest {
    pub project_reference_id: String,
    pub fields: Vec<RefreshField>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateApprovedRevisionRequest {
    draft_revision_id: Uuid,
    review_digest: String,
    approval: ApprovalEvidence,
    refresh_authorizations: Vec<RefreshAuthorizationRequest>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuthorizedFactRevisionResponse {
    pub id: Uuid,
    pub project_reference_id: String,
    pub revision: u64,
    pub revision_kind: String,
    pub source_release_id: Uuid,
    pub source_deployment_id: Uuid,
    pub facts: Value,
    pub refresh_scope: Vec<RefreshField>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadinessResponse {
    pub id: Uuid,
    pub event_sequence: u64,
    pub project_reference_id: String,
    pub fact_revision_id: Uuid,
    pub state: String,
    pub reason: Option<String>,
    pub attestation: Option<Value>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApprovedRevisionResponse {
    pub id: Uuid,
    pub approval_sequence: u64,
    pub source_draft_revision_id: Uuid,
    pub source_draft_revision: u64,
    pub previous_approved_revision_id: Option<Uuid>,
    pub review_digest: String,
    pub snapshot: PortfolioDraft,
    pub preview_context: Value,
    pub requirements: Vec<ApprovalRequirementResponse>,
    pub approvals: Vec<ApprovalAcknowledgement>,
    pub deployment_facts: Vec<AuthorizedFactRevisionResponse>,
    pub readiness: Vec<ReadinessResponse>,
    pub approved_at: DateTime<Utc>,
}

/// Public-only immutable input for HOST-229. The publisher boundary must never
/// receive a `PortfolioDraft` or private onboarding/source context.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PublicPortfolioDocument {
    pub contract_version: String,
    pub approved_revision_id: Uuid,
    pub display_name: String,
    pub headline: Option<String>,
    pub introduction: Option<String>,
    pub target_role: Option<String>,
    pub skills: Vec<String>,
    pub resume: Option<PublicLink>,
    pub contacts: Vec<ContactLink>,
    pub projects: Vec<PublicProject>,
    pub appearance: PublicAppearance,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PublicAppearance {
    pub layout: String,
    pub typography: String,
    pub accent: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PublicProject {
    pub project_reference_id: String,
    pub order: u16,
    pub title: String,
    pub purpose: String,
    pub contribution: String,
    pub technical_decisions: Vec<TechnicalDecision>,
    pub links: Vec<ProjectLink>,
    pub evidence: Vec<ProjectEvidence>,
    pub deployment: Option<PublicDeploymentFacts>,
    pub readiness: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PublicDeploymentFacts {
    pub fact_revision_id: Uuid,
    pub managed_demo_url: Option<String>,
    pub deployed_at: Option<DateTime<Utc>>,
    pub availability: Option<AvailabilityLabel>,
    pub status_label: Option<String>,
    pub release_identifier: Option<String>,
    pub source_commit: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FactRefreshRequest {
    source_release_id: Uuid,
}

#[derive(Debug, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct FactRefreshResponse {
    source_release_id: Uuid,
    revisions: Vec<AuthorizedFactRevisionResponse>,
    readiness: Vec<ReadinessResponse>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadinessAttestationRequest {
    approved_revision_id: Uuid,
    project_reference_id: String,
    fact_revision_id: Uuid,
    demo_page_verified: bool,
    synthetic_example_data_verified: bool,
    restricted_access_verified: bool,
    visitor_instructions_verified: bool,
    visitor_instructions: String,
}

#[derive(Debug, FromRow)]
struct TrustedReleaseRow {
    release_id: Uuid,
    project_id: Uuid,
    deployment_id: Uuid,
    source_commit: String,
    promoted_at: Option<DateTime<Utc>>,
    managed_demo_url: Option<String>,
    availability: String,
    availability_observed_at: DateTime<Utc>,
    demo_access_revision: i64,
}

#[derive(Debug, FromRow)]
struct ApprovedRow {
    id: Uuid,
    approval_sequence: i64,
    source_draft_revision_id: Uuid,
    source_draft_revision_number: i64,
    previous_approved_revision_id: Option<Uuid>,
    review_digest: Vec<u8>,
    snapshot: Value,
    preview_context: Value,
    approval_requirements: Value,
    approvals: Value,
    approved_at: DateTime<Utc>,
}

#[derive(Debug, FromRow)]
struct FactRow {
    id: Uuid,
    approved_revision_id: Uuid,
    project_reference_id: String,
    hosted_project_id: Uuid,
    revision_number: i64,
    source_release_id: Uuid,
    source_deployment_id: Uuid,
    facts: Value,
    refresh_scope: Value,
    created_at: DateTime<Utc>,
}

#[derive(Debug, FromRow)]
struct ReadinessRow {
    id: Uuid,
    event_sequence: i64,
    project_reference_id: String,
    fact_revision_id: Uuid,
    state: String,
    reason: Option<String>,
    attestation: Option<Value>,
    created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredFacts {
    managed_demo_url: String,
    deployed_at: DateTime<Utc>,
    availability: AvailabilityLabel,
    status_label: String,
    availability_observed_at: DateTime<Utc>,
    demo_access_revision: i64,
    displayed_release_identifier: String,
    public_source_commit: Option<String>,
    managed_demo_link_id: Option<String>,
    managed_demo_link_digest: Option<String>,
}

#[derive(Serialize)]
struct ReviewDigestMaterial<'a> {
    version: &'static str,
    draft_revision_id: Uuid,
    draft_revision: i64,
    snapshot: &'a PortfolioDraft,
    preview_context: &'a Value,
    requirements: &'a [ApprovalRequirementResponse],
    deployment_facts: &'a [ReviewDeploymentFact],
}

pub fn routes() -> Router<FoundationState> {
    Router::new()
        .route(
            "/v1/portfolio/publication-review",
            get(get_publication_review),
        )
        .route(
            "/v1/portfolio/approved-revisions",
            post(create_approved_revision),
        )
        .route(
            "/v1/portfolio/approved-revisions/latest",
            get(get_latest_approved_revision),
        )
        .route(
            "/v1/portfolio/readiness-attestations",
            post(create_readiness_attestation),
        )
}

pub fn internal_routes() -> Router<FoundationState> {
    Router::new().route(
        "/internal/v1/portfolio/deployment-fact-refreshes",
        post(refresh_deployment_facts),
    )
}

async fn get_publication_review(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    Query(query): Query<ReviewQuery>,
) -> Result<Json<PublicationReviewResponse>, ApiError> {
    m3::require_enabled(&state)?;
    let account_id = authenticated.account_id()?;
    let mut transaction = state.pool.begin().await?;
    let review = build_review(&mut transaction, account_id, query.draft_revision_id).await?;
    transaction.commit().await?;
    Ok(Json(review))
}

async fn build_review(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    draft_revision_id: Uuid,
) -> Result<PublicationReviewResponse, ApiError> {
    let row: Option<(i64, Value)> = sqlx::query_as(
        "SELECT revision_number, draft FROM portfolio_draft_revisions \
         WHERE account_id = $1 AND id = $2",
    )
    .bind(account_id)
    .bind(draft_revision_id)
    .fetch_optional(&mut **transaction)
    .await?;
    let Some((draft_revision, draft_json)) = row else {
        return Err(ApiError::not_found());
    };
    let draft: PortfolioDraft =
        serde_json::from_value(draft_json).map_err(|_| ApiError::internal())?;
    draft.validate().map_err(|_| {
        ApiError::unprocessable(
            "invalid_portfolio_draft",
            "the stored portfolio draft is not valid for publication",
        )
    })?;
    let preview_context: Value = sqlx::query_scalar(
        "SELECT jsonb_build_object('layout',context.layout,'typography',context.typography,'accent',context.accent) \
         FROM portfolio_preview_contexts context \
         JOIN portfolio_draft_revisions context_draft \
           ON context_draft.account_id=context.account_id \
          AND context_draft.id=context.portfolio_revision_id \
         WHERE context.account_id=$1 AND context_draft.revision_number <= $2 \
         ORDER BY context_draft.revision_number DESC LIMIT 1",
    )
    .bind(account_id)
    .bind(draft_revision)
    .fetch_optional(&mut **transaction)
    .await?
    .unwrap_or_else(|| json!({"layout":"layout_1","typography":"system_sans","accent":"coral"}));

    let hosted: Vec<(String, Uuid)> = draft
        .projects
        .iter()
        .filter(|project| project.visibility == Visibility::Shown)
        .filter_map(|project| match &project.kind {
            ProjectReferenceKind::HostedProject { project_id } => Uuid::parse_str(project_id)
                .ok()
                .map(|id| (project.project_reference_id.clone(), id)),
            ProjectReferenceKind::ExternalCaseStudy { .. } => None,
        })
        .collect();
    let project_ids = hosted.iter().map(|(_, id)| *id).collect::<Vec<_>>();
    let releases: Vec<TrustedReleaseRow> = if project_ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as(
            "SELECT r.id AS release_id, r.project_id, r.deployment_id, r.source_commit, \
                    r.promoted_at, r.managed_demo_url, route.availability, \
                    route.availability_observed_at, route.demo_access_revision \
             FROM project_release_routes route \
             JOIN application_releases r \
               ON r.account_id = route.account_id AND r.project_id = route.project_id \
              AND r.id = route.release_id \
             WHERE route.account_id = $1 AND route.project_id = ANY($2) AND r.state = 'healthy' \
             FOR SHARE OF route,r",
        )
        .bind(account_id)
        .bind(&project_ids)
        .fetch_all(&mut **transaction)
        .await?
    };
    let by_project = releases
        .into_iter()
        .map(|row| (row.project_id, row))
        .collect::<HashMap<_, _>>();
    let mut deployment_facts = Vec::new();
    for (reference_id, project_id) in &hosted {
        let project = draft
            .projects
            .iter()
            .find(|project| project.project_reference_id == *reference_id)
            .ok_or_else(ApiError::internal)?;
        if !uses_deployment_facts(project) {
            continue;
        }
        let release = by_project.get(project_id).ok_or_else(|| {
            ApiError::conflict(
                "deployment_facts_unavailable",
                "a displayed deployment fact has no current healthy promoted release",
            )
        })?;
        let deployed_at = release.promoted_at.ok_or_else(|| {
            ApiError::conflict(
                "deployment_facts_unavailable",
                "the current release has no promotion time",
            )
        })?;
        let managed_demo_url = release.managed_demo_url.clone().ok_or_else(|| {
            ApiError::conflict(
                "deployment_facts_unavailable",
                "the current release has no managed demo destination",
            )
        })?;
        let availability = parse_availability(&release.availability)?;
        deployment_facts.push(ReviewDeploymentFact {
            project_reference_id: reference_id.clone(),
            hosted_project_id: *project_id,
            source_release_id: release.release_id,
            source_deployment_id: release.deployment_id,
            managed_demo_url,
            deployed_at,
            availability,
            status_label: availability_status(availability).to_owned(),
            availability_observed_at: release.availability_observed_at,
            demo_access_revision: release.demo_access_revision,
            public_source_commit: project
                .displayed_status
                .source_commit
                .then(|| release.source_commit.clone()),
        });
    }

    let fact_map = deployment_facts
        .iter()
        .map(|fact| (fact.project_reference_id.as_str(), fact))
        .collect::<HashMap<_, _>>();
    let mut requirements = Vec::new();
    for target in draft.required_approval_targets() {
        let value = approval_value(&draft, &fact_map, &target)?;
        let value_digest = digest_json(
            "hostlet.portfolio-approval-target/v1",
            &json!({
                "target": &target,
                "value": &value,
            }),
        )?;
        requirements.push(ApprovalRequirementResponse {
            target,
            value,
            value_digest,
        });
    }
    let material = ReviewDigestMaterial {
        version: "hostlet.portfolio-publication-review/v1",
        draft_revision_id,
        draft_revision,
        snapshot: &draft,
        preview_context: &preview_context,
        requirements: &requirements,
        deployment_facts: &deployment_facts,
    };
    let review_digest = digest_json("hostlet.portfolio-publication-review/v1", &material)?;
    Ok(PublicationReviewResponse {
        draft_revision_id,
        draft_revision: to_u64(draft_revision)?,
        review_digest,
        snapshot: draft,
        preview_context,
        requirements,
        deployment_facts,
    })
}

async fn create_approved_revision(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    headers: HeaderMap,
    SafeJson(request): SafeJson<CreateApprovedRevisionRequest>,
) -> Result<(StatusCode, Json<ApprovedRevisionResponse>), ApiError> {
    m3::require_enabled(&state)?;
    let policy_now = m3::policy_now(&state).await?;
    let account_id = authenticated.account_id()?;
    let key = intent::idempotency_key(&headers)?;
    let request_hash = intent::request_hash(&request)?;
    let mut transaction = state.pool.begin().await?;
    intent::acquire_operation_lock(&mut transaction, account_id, APPROVE_OPERATION, key).await?;
    match intent::replay(
        &mut transaction,
        account_id,
        APPROVE_OPERATION,
        key,
        &request_hash,
    )
    .await?
    {
        Replay::Match(response) => {
            transaction.commit().await?;
            return Ok((StatusCode::CREATED, Json(response)));
        }
        Replay::Changed => {
            return Err(ApiError::conflict(
                "idempotency_payload_changed",
                "the idempotency key was already used with different approval input",
            ));
        }
        Replay::Miss => {}
    }
    sqlx::query_scalar::<_, Uuid>("SELECT id FROM accounts WHERE id = $1 FOR UPDATE")
        .bind(account_id)
        .fetch_one(&mut *transaction)
        .await?;
    let latest_draft_id: Uuid = sqlx::query_scalar(
        "SELECT id FROM portfolio_draft_revisions WHERE account_id=$1 \
         ORDER BY revision_number DESC LIMIT 1",
    )
    .bind(account_id)
    .fetch_optional(&mut *transaction)
    .await?
    .ok_or_else(ApiError::not_found)?;
    if latest_draft_id != request.draft_revision_id {
        return Err(ApiError::conflict(
            "stale_portfolio_draft",
            "only the current portfolio draft revision can be approved",
        ));
    }
    let review = build_review(&mut transaction, account_id, request.draft_revision_id).await?;
    if request.review_digest != review.review_digest {
        return Err(ApiError::conflict(
            "stale_publication_review",
            "the draft or trusted deployment facts changed after review",
        ));
    }
    let approvals = validate_approval(&review, &request.approval)?;
    let refresh = validate_refresh_authorizations(&review, &request.refresh_authorizations)?;
    let existing: Option<ApprovedRow> = sqlx::query_as(
        "SELECT id,approval_sequence,source_draft_revision_id,source_draft_revision_number, \
                previous_approved_revision_id,review_digest,snapshot,preview_context, \
                approval_requirements,approvals,approved_at \
         FROM portfolio_approved_revisions \
         WHERE account_id=$1 AND source_draft_revision_id=$2 AND review_digest=$3",
    )
    .bind(account_id)
    .bind(request.draft_revision_id)
    .bind(parse_digest(&review.review_digest)?)
    .fetch_optional(&mut *transaction)
    .await?;
    if let Some(existing) = existing {
        let response = load_approved_response(&mut transaction, account_id, existing).await?;
        intent::store_replay(
            &mut transaction,
            account_id,
            APPROVE_OPERATION,
            key,
            &request_hash,
            201,
            &response,
        )
        .await?;
        transaction.commit().await?;
        return Ok((StatusCode::CREATED, Json(response)));
    }
    let previous_id: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM portfolio_approved_revisions WHERE account_id = $1 \
         ORDER BY approval_sequence DESC LIMIT 1",
    )
    .bind(account_id)
    .fetch_optional(&mut *transaction)
    .await?;
    let approval_sequence: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(approval_sequence),0)+1 \
         FROM portfolio_approved_revisions WHERE account_id=$1",
    )
    .bind(account_id)
    .fetch_one(&mut *transaction)
    .await?;
    let approved_id = Uuid::new_v4();
    let audit_id = insert_audit(
        &mut transaction,
        account_id,
        Some(authenticated.session_id()),
        "portfolio.revision_approved",
        "portfolio_approved_revision",
        approved_id,
        json!({"draft_revision_id": request.draft_revision_id, "review_digest": review.review_digest}),
        policy_now,
    )
    .await?;
    let requirements_json =
        serde_json::to_value(&review.requirements).map_err(|_| ApiError::internal())?;
    let approvals_json = serde_json::to_value(&approvals).map_err(|_| ApiError::internal())?;
    let refresh_json = serde_json::to_value(&refresh).map_err(|_| ApiError::internal())?;
    let snapshot_json = serde_json::to_value(&review.snapshot).map_err(|_| ApiError::internal())?;
    let approved_at: DateTime<Utc> = sqlx::query_scalar(
        "INSERT INTO portfolio_approved_revisions \
         (id,account_id,approval_sequence,source_draft_revision_id,source_draft_revision_number, \
          previous_approved_revision_id,review_digest,snapshot,preview_context, \
          approval_requirements,approvals,refresh_authorizations,audit_event_id,approved_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING approved_at",
    )
    .bind(approved_id)
    .bind(account_id)
    .bind(approval_sequence)
    .bind(request.draft_revision_id)
    .bind(i64::try_from(review.draft_revision).map_err(|_| ApiError::internal())?)
    .bind(previous_id)
    .bind(parse_digest(&review.review_digest)?)
    .bind(snapshot_json)
    .bind(&review.preview_context)
    .bind(requirements_json)
    .bind(approvals_json)
    .bind(refresh_json)
    .bind(audit_id)
    .bind(policy_now)
    .fetch_one(&mut *transaction)
    .await?;

    let mut deployment_facts = Vec::new();
    let mut readiness = Vec::new();
    for fact in &review.deployment_facts {
        let scope = refresh
            .iter()
            .find(|item| item.project_reference_id == fact.project_reference_id)
            .map_or_else(Vec::new, |item| item.fields.clone());
        let (managed_link_id, managed_link_digest) = managed_demo_link(&review.snapshot, fact);
        let stored = StoredFacts {
            managed_demo_url: fact.managed_demo_url.clone(),
            deployed_at: fact.deployed_at,
            availability: fact.availability,
            status_label: fact.status_label.clone(),
            availability_observed_at: fact.availability_observed_at,
            demo_access_revision: fact.demo_access_revision,
            displayed_release_identifier: fact.source_release_id.to_string(),
            public_source_commit: fact.public_source_commit.clone(),
            managed_demo_link_id: managed_link_id,
            managed_demo_link_digest: managed_link_digest,
        };
        let fact_response = insert_fact_revision(
            &mut transaction,
            account_id,
            approved_id,
            fact,
            None,
            1,
            "owner_authorized",
            &stored,
            &scope,
            Some(authenticated.session_id()),
            policy_now,
        )
        .await?;
        let readiness_response = insert_readiness_event(
            &mut transaction,
            account_id,
            approved_id,
            &fact.project_reference_id,
            fact_response.id,
            None,
            "needs_recheck",
            Some("never_checked"),
            None,
            Some(authenticated.session_id()),
            policy_now,
        )
        .await?;
        deployment_facts.push(fact_response);
        readiness.push(readiness_response);
    }
    let response = ApprovedRevisionResponse {
        id: approved_id,
        approval_sequence: to_u64(approval_sequence)?,
        source_draft_revision_id: request.draft_revision_id,
        source_draft_revision: review.draft_revision,
        previous_approved_revision_id: previous_id,
        review_digest: review.review_digest,
        snapshot: review.snapshot,
        preview_context: review.preview_context,
        requirements: review.requirements,
        approvals,
        deployment_facts,
        readiness,
        approved_at,
    };
    intent::store_replay(
        &mut transaction,
        account_id,
        APPROVE_OPERATION,
        key,
        &request_hash,
        201,
        &response,
    )
    .await?;
    transaction.commit().await?;
    Ok((StatusCode::CREATED, Json(response)))
}

fn validate_approval(
    review: &PublicationReviewResponse,
    evidence: &ApprovalEvidence,
) -> Result<Vec<ApprovalAcknowledgement>, ApiError> {
    let expected = review
        .requirements
        .iter()
        .map(|item| ApprovalAcknowledgement {
            target: item.target.clone(),
            value_digest: item.value_digest.clone(),
        })
        .collect::<Vec<_>>();
    match evidence {
        ApprovalEvidence::EntireRevision { review_digest }
            if review_digest == &review.review_digest =>
        {
            Ok(expected)
        }
        ApprovalEvidence::EntireRevision { .. } => Err(ApiError::conflict(
            "stale_publication_review",
            "the recorded revision approval does not match this exact review",
        )),
        ApprovalEvidence::IndividualFields { fields } => {
            if fields.len() != expected.len() {
                return Err(incomplete_approval());
            }
            let mut seen = HashSet::new();
            for expected_item in &expected {
                let expected_key = serde_json::to_string(&expected_item.target)
                    .map_err(|_| ApiError::internal())?;
                let matches = fields
                    .iter()
                    .filter(|item| item.target == expected_item.target)
                    .collect::<Vec<_>>();
                if matches.len() != 1
                    || matches[0].value_digest != expected_item.value_digest
                    || !seen.insert(expected_key)
                {
                    return Err(incomplete_approval());
                }
            }
            Ok(expected)
        }
    }
}

fn incomplete_approval() -> ApiError {
    ApiError::unprocessable(
        "incomplete_publication_approval",
        "every server-derived public field must be approved exactly once at its reviewed value",
    )
}

fn validate_refresh_authorizations(
    review: &PublicationReviewResponse,
    requested: &[RefreshAuthorizationRequest],
) -> Result<Vec<RefreshAuthorizationRequest>, ApiError> {
    let mut projects = HashSet::new();
    for authorization in requested {
        if !projects.insert(authorization.project_reference_id.as_str())
            || authorization.fields.is_empty()
            || authorization.fields.len() > 3
            || authorization.fields.iter().collect::<HashSet<_>>().len()
                != authorization.fields.len()
        {
            return Err(invalid_refresh_scope());
        }
        let fact = review
            .deployment_facts
            .iter()
            .find(|fact| fact.project_reference_id == authorization.project_reference_id)
            .ok_or_else(invalid_refresh_scope)?;
        let project = review
            .snapshot
            .projects
            .iter()
            .find(|project| project.project_reference_id == authorization.project_reference_id)
            .ok_or_else(invalid_refresh_scope)?;
        for field in &authorization.fields {
            let allowed = match field.contract_value() {
                RefreshableDeploymentFact::ManagedDemoDestination => {
                    managed_demo_link(&review.snapshot, fact).0.is_some()
                }
                RefreshableDeploymentFact::DeploymentTimestamp => {
                    project.displayed_status.deployment_timestamp
                }
                RefreshableDeploymentFact::AvailabilityLabel => {
                    project.displayed_status.availability
                }
            };
            if !allowed {
                return Err(invalid_refresh_scope());
            }
        }
    }
    Ok(requested.to_vec())
}

fn invalid_refresh_scope() -> ApiError {
    ApiError::unprocessable(
        "invalid_fact_refresh_scope",
        "fact refresh may cover only an approved managed demo destination, deployment time, or availability field",
    )
}

async fn get_latest_approved_revision(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
) -> Result<Json<ApprovedRevisionResponse>, ApiError> {
    m3::require_enabled(&state)?;
    let account_id = authenticated.account_id()?;
    let mut transaction = state.pool.begin().await?;
    let row: ApprovedRow = sqlx::query_as(
        "SELECT id,approval_sequence,source_draft_revision_id,source_draft_revision_number, \
                previous_approved_revision_id,review_digest,snapshot,preview_context, \
                approval_requirements,approvals,approved_at \
         FROM portfolio_approved_revisions WHERE account_id = $1 \
         ORDER BY approval_sequence DESC LIMIT 1",
    )
    .bind(account_id)
    .fetch_optional(&mut *transaction)
    .await?
    .ok_or_else(ApiError::not_found)?;
    let response = load_approved_response(&mut transaction, account_id, row).await?;
    transaction.commit().await?;
    Ok(Json(response))
}

async fn load_approved_response(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    row: ApprovedRow,
) -> Result<ApprovedRevisionResponse, ApiError> {
    let facts: Vec<FactRow> = sqlx::query_as(
        "SELECT DISTINCT ON (project_reference_id) id,approved_revision_id, \
                project_reference_id,hosted_project_id,revision_number,source_release_id, \
                source_deployment_id,facts,refresh_scope,created_at \
         FROM portfolio_deployment_fact_revisions \
         WHERE account_id = $1 AND approved_revision_id = $2 \
         ORDER BY project_reference_id,revision_number DESC,id DESC",
    )
    .bind(account_id)
    .bind(row.id)
    .fetch_all(&mut **transaction)
    .await?;
    let readiness_rows: Vec<ReadinessRow> = sqlx::query_as(
        "SELECT DISTINCT ON (project_reference_id) id,event_sequence,project_reference_id,fact_revision_id, \
                state,reason,attestation,created_at FROM portfolio_readiness_events \
         WHERE account_id = $1 AND approved_revision_id = $2 \
         ORDER BY project_reference_id,event_sequence DESC",
    )
    .bind(account_id)
    .bind(row.id)
    .fetch_all(&mut **transaction)
    .await?;
    Ok(ApprovedRevisionResponse {
        id: row.id,
        approval_sequence: to_u64(row.approval_sequence)?,
        source_draft_revision_id: row.source_draft_revision_id,
        source_draft_revision: to_u64(row.source_draft_revision_number)?,
        previous_approved_revision_id: row.previous_approved_revision_id,
        review_digest: format_digest(&row.review_digest),
        snapshot: serde_json::from_value(row.snapshot).map_err(|_| ApiError::internal())?,
        preview_context: row.preview_context,
        requirements: serde_json::from_value(row.approval_requirements)
            .map_err(|_| ApiError::internal())?,
        approvals: serde_json::from_value(row.approvals).map_err(|_| ApiError::internal())?,
        deployment_facts: facts
            .into_iter()
            .map(fact_response)
            .collect::<Result<Vec<_>, _>>()?,
        readiness: readiness_rows
            .into_iter()
            .map(readiness_response)
            .collect::<Result<Vec<_>, _>>()?,
        approved_at: row.approved_at,
    })
}

pub(crate) async fn load_public_portfolio_document(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    approved_revision_id: Uuid,
) -> Result<PublicPortfolioDocument, ApiError> {
    let row: Option<(Value, Value)> = sqlx::query_as(
        "SELECT snapshot,preview_context FROM portfolio_approved_revisions \
         WHERE account_id=$1 AND id=$2",
    )
    .bind(account_id)
    .bind(approved_revision_id)
    .fetch_optional(&mut **transaction)
    .await?;
    let Some((snapshot, preview_context)) = row else {
        return Err(ApiError::not_found());
    };
    let draft: PortfolioDraft =
        serde_json::from_value(snapshot).map_err(|_| ApiError::internal())?;
    let appearance: PublicAppearance =
        serde_json::from_value(preview_context).map_err(|_| ApiError::internal())?;
    if appearance.layout != "layout_1"
        || !matches!(
            appearance.typography.as_str(),
            "system_sans" | "editorial_serif"
        )
        || !matches!(appearance.accent.as_str(), "coral" | "indigo" | "forest")
    {
        return Err(ApiError::internal());
    }
    let fact_rows: Vec<FactRow> = sqlx::query_as(
        "SELECT DISTINCT ON (project_reference_id) id,approved_revision_id, \
                project_reference_id,hosted_project_id,revision_number,source_release_id, \
                source_deployment_id,facts,refresh_scope,created_at \
         FROM portfolio_deployment_fact_revisions \
         WHERE account_id=$1 AND approved_revision_id=$2 \
         ORDER BY project_reference_id,revision_number DESC,id DESC",
    )
    .bind(account_id)
    .bind(approved_revision_id)
    .fetch_all(&mut **transaction)
    .await?;
    let facts = fact_rows
        .into_iter()
        .map(|row| {
            let stored = serde_json::from_value::<StoredFacts>(row.facts.clone())
                .map_err(|_| ApiError::internal())?;
            Ok((row.project_reference_id.clone(), (row, stored)))
        })
        .collect::<Result<HashMap<_, _>, ApiError>>()?;
    let readiness_rows: Vec<ReadinessRow> = sqlx::query_as(
        "SELECT DISTINCT ON (project_reference_id) id,event_sequence,project_reference_id,fact_revision_id, \
                state,reason,attestation,created_at FROM portfolio_readiness_events \
         WHERE account_id=$1 AND approved_revision_id=$2 \
         ORDER BY project_reference_id,event_sequence DESC",
    )
    .bind(account_id)
    .bind(approved_revision_id)
    .fetch_all(&mut **transaction)
    .await?;
    let readiness = readiness_rows
        .into_iter()
        .map(|row| (row.project_reference_id.clone(), row))
        .collect::<HashMap<_, _>>();
    let mut projects = if draft.section_visibility.projects == Visibility::Shown {
        draft
            .projects
            .iter()
            .filter(|project| project.visibility == Visibility::Shown)
            .map(|project| {
                let mut links = project.links.clone();
                let deployment = facts
                    .get(&project.project_reference_id)
                    .map(|(row, stored)| {
                        if let Some(link_id) = stored.managed_demo_link_id.as_deref()
                            && let Some(link) =
                                links.iter_mut().find(|link| link.link.id == link_id)
                        {
                            link.link.url.clone_from(&stored.managed_demo_url);
                        }
                        PublicDeploymentFacts {
                            fact_revision_id: row.id,
                            managed_demo_url: stored
                                .managed_demo_link_id
                                .as_ref()
                                .map(|_| stored.managed_demo_url.clone()),
                            deployed_at: project
                                .displayed_status
                                .deployment_timestamp
                                .then_some(stored.deployed_at),
                            availability: project
                                .displayed_status
                                .availability
                                .then_some(stored.availability),
                            status_label: project
                                .displayed_status
                                .availability
                                .then(|| stored.status_label.clone()),
                            release_identifier: project
                                .displayed_status
                                .release_identifier
                                .then(|| stored.displayed_release_identifier.clone()),
                            source_commit: project
                                .displayed_status
                                .source_commit
                                .then(|| stored.public_source_commit.clone())
                                .flatten(),
                        }
                    });
                let readiness = project.displayed_status.demo_readiness.then(|| {
                    readiness
                        .get(&project.project_reference_id)
                        .map(|row| {
                            json!({
                                "state": row.state.clone(),
                                "reason": row.reason.clone(),
                                "attestation": row.attestation.clone(),
                            })
                        })
                        .unwrap_or_else(
                            || json!({"state":"needs_recheck","reason":"never_checked"}),
                        )
                });
                PublicProject {
                    project_reference_id: project.project_reference_id.clone(),
                    order: project.order,
                    title: project.title.clone(),
                    purpose: project.purpose.clone(),
                    contribution: project.contribution.clone(),
                    technical_decisions: project.technical_decisions.clone(),
                    links,
                    evidence: project.evidence.clone(),
                    deployment,
                    readiness,
                }
            })
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    projects.sort_by_key(|project| project.order);
    Ok(PublicPortfolioDocument {
        contract_version: "hostlet.public-portfolio/v1".to_owned(),
        approved_revision_id,
        display_name: draft.profile.display_name,
        headline: (draft.section_visibility.headline == Visibility::Shown)
            .then_some(draft.profile.headline)
            .flatten(),
        introduction: (draft.section_visibility.introduction == Visibility::Shown)
            .then_some(draft.profile.introduction),
        target_role: (draft.section_visibility.target_role == Visibility::Shown)
            .then_some(draft.profile.target_role),
        skills: if draft.section_visibility.skills == Visibility::Shown {
            draft.skills
        } else {
            Vec::new()
        },
        resume: if draft.section_visibility.resume == Visibility::Shown {
            draft.resume
        } else {
            None
        },
        contacts: if draft.section_visibility.contacts == Visibility::Shown {
            draft.contacts
        } else {
            Vec::new()
        },
        projects,
        appearance,
    })
}

async fn refresh_deployment_facts(
    _worker: RuntimeWorkerAuth,
    State(state): State<FoundationState>,
    SafeJson(request): SafeJson<FactRefreshRequest>,
) -> Result<Json<FactRefreshResponse>, ApiError> {
    m3::require_enabled(&state)?;
    let policy_now = m3::policy_now(&state).await?;
    let mut transaction = state.pool.begin().await?;
    let response = refresh_deployment_facts_in_transaction(
        &mut transaction,
        request.source_release_id,
        policy_now,
    )
    .await?;
    transaction.commit().await?;
    Ok(Json(response))
}

pub(crate) async fn refresh_deployment_facts_in_transaction(
    transaction: &mut Transaction<'_, Postgres>,
    source_release_id: Uuid,
    policy_now: DateTime<Utc>,
) -> Result<FactRefreshResponse, ApiError> {
    let account_id: Uuid =
        sqlx::query_scalar("SELECT account_id FROM application_releases WHERE id=$1")
            .bind(source_release_id)
            .fetch_optional(&mut **transaction)
            .await?
            .ok_or_else(|| {
                ApiError::unprocessable(
                    "untrusted_deployment_facts",
                    "the release is not the current healthy trusted route",
                )
            })?;
    lock_account(transaction, account_id).await?;
    let release: TrustedReleaseRow = sqlx::query_as(
        "SELECT r.id AS release_id,r.project_id,r.deployment_id,r.source_commit, \
                r.promoted_at,r.managed_demo_url,route.availability, \
                route.availability_observed_at,route.demo_access_revision \
         FROM project_release_routes route JOIN application_releases r \
           ON r.account_id=route.account_id AND r.project_id=route.project_id \
          AND r.id=route.release_id \
         WHERE r.account_id=$2 AND r.id=$1 AND r.state='healthy' FOR UPDATE OF route",
    )
    .bind(source_release_id)
    .bind(account_id)
    .fetch_optional(&mut **transaction)
    .await?
    .ok_or_else(|| {
        ApiError::unprocessable(
            "untrusted_deployment_facts",
            "the release is not the current healthy trusted route",
        )
    })?;
    intent::acquire_operation_lock(
        transaction,
        account_id,
        "portfolio.deployment_facts.refresh",
        &release.release_id.to_string(),
    )
    .await?;
    let heads: Vec<FactRow> = sqlx::query_as(
        "SELECT DISTINCT ON (facts.approved_revision_id,facts.project_reference_id) \
                facts.id,facts.approved_revision_id,facts.project_reference_id, \
                facts.hosted_project_id,facts.revision_number,facts.source_release_id, \
                facts.source_deployment_id,facts.facts,facts.refresh_scope,facts.created_at \
         FROM portfolio_deployment_fact_revisions facts \
         JOIN portfolio_approved_revisions approved ON approved.id=facts.approved_revision_id \
         WHERE facts.account_id=$1 AND facts.hosted_project_id=$2 \
           AND approved.id=(SELECT id FROM portfolio_approved_revisions \
                            WHERE account_id=$1 ORDER BY approval_sequence DESC LIMIT 1) \
         ORDER BY facts.approved_revision_id,facts.project_reference_id, \
                  facts.revision_number DESC,facts.id DESC",
    )
    .bind(account_id)
    .bind(release.project_id)
    .fetch_all(&mut **transaction)
    .await?;
    let mut revisions = Vec::new();
    let mut readiness = Vec::new();
    let mut changed_approved_revisions = HashSet::new();
    for head in heads {
        let old: StoredFacts =
            serde_json::from_value(head.facts.clone()).map_err(|_| ApiError::internal())?;
        let scope: Vec<RefreshField> =
            serde_json::from_value(head.refresh_scope.clone()).map_err(|_| ApiError::internal())?;
        let latest_draft: Option<Value> = sqlx::query_scalar(
            "SELECT draft FROM portfolio_draft_revisions WHERE account_id=$1 \
             ORDER BY revision_number DESC LIMIT 1",
        )
        .bind(account_id)
        .fetch_optional(&mut **transaction)
        .await?;
        let destination_still_owner_approved = latest_draft
            .and_then(|value| serde_json::from_value::<PortfolioDraft>(value).ok())
            .is_some_and(|draft| managed_link_unchanged(&draft, &head.project_reference_id, &old));
        let mut next = old.clone();
        let mut changed = Vec::new();
        for field in &scope {
            match field {
                RefreshField::ManagedDemoDestination if destination_still_owner_approved => {
                    if let Some(url) = &release.managed_demo_url
                        && next.managed_demo_url != *url
                    {
                        next.managed_demo_url = url.clone();
                        changed.push("managed_demo_destination");
                    }
                }
                RefreshField::DeploymentTimestamp => {
                    if let Some(promoted_at) = release.promoted_at
                        && next.deployed_at != promoted_at
                    {
                        next.deployed_at = promoted_at;
                        changed.push("deployment_timestamp");
                    }
                }
                RefreshField::AvailabilityLabel => {
                    let availability = parse_availability(&release.availability)?;
                    if next.availability != availability
                        || next.availability_observed_at != release.availability_observed_at
                    {
                        next.availability = availability;
                        next.status_label = availability_status(availability).to_owned();
                        next.availability_observed_at = release.availability_observed_at;
                        changed.push("availability_label");
                    }
                }
                RefreshField::ManagedDemoDestination => {}
            }
        }
        let release_changed = head.source_release_id != release.release_id;
        let access_changed = old.demo_access_revision != release.demo_access_revision;
        next.demo_access_revision = release.demo_access_revision;
        if changed.is_empty() && !release_changed && !access_changed {
            continue;
        }
        let source_fact = ReviewDeploymentFact {
            project_reference_id: head.project_reference_id.clone(),
            hosted_project_id: head.hosted_project_id,
            source_release_id: release.release_id,
            source_deployment_id: release.deployment_id,
            managed_demo_url: next.managed_demo_url.clone(),
            deployed_at: next.deployed_at,
            availability: next.availability,
            status_label: next.status_label.clone(),
            availability_observed_at: next.availability_observed_at,
            demo_access_revision: next.demo_access_revision,
            public_source_commit: next.public_source_commit.clone(),
        };
        let revision = insert_fact_revision(
            transaction,
            account_id,
            head.approved_revision_id,
            &source_fact,
            Some(head.id),
            head.revision_number + 1,
            "fact_refresh",
            &next,
            &scope,
            None,
            policy_now,
        )
        .await?;
        if release_changed || access_changed {
            let previous: Option<ReadinessRow> = sqlx::query_as(
                "SELECT id,event_sequence,project_reference_id,fact_revision_id,state,reason,attestation,created_at \
                 FROM portfolio_readiness_events WHERE account_id=$1 AND approved_revision_id=$2 \
                   AND project_reference_id=$3 ORDER BY event_sequence DESC LIMIT 1",
            )
            .bind(account_id)
            .bind(head.approved_revision_id)
            .bind(&head.project_reference_id)
            .fetch_optional(&mut **transaction)
            .await?;
            let prior_attestation = previous.as_ref().and_then(|row| row.attestation.clone());
            let event = insert_readiness_event(
                transaction,
                account_id,
                head.approved_revision_id,
                &head.project_reference_id,
                revision.id,
                previous.as_ref().map(|row| row.id),
                "needs_recheck",
                Some(if access_changed {
                    "demo_access_changed"
                } else {
                    "new_release"
                }),
                prior_attestation,
                None,
                policy_now,
            )
            .await?;
            readiness.push(event);
        }
        changed_approved_revisions.insert(head.approved_revision_id);
        revisions.push(revision);
    }
    let mut changed_approved_revisions = changed_approved_revisions.into_iter().collect::<Vec<_>>();
    changed_approved_revisions.sort_unstable();
    for approved_revision_id in changed_approved_revisions {
        crate::portfolio_publish::enqueue_fact_refresh_publication(
            transaction,
            account_id,
            approved_revision_id,
            policy_now,
        )
        .await?;
    }
    Ok(FactRefreshResponse {
        source_release_id,
        revisions,
        readiness,
    })
}

async fn create_readiness_attestation(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    headers: HeaderMap,
    SafeJson(request): SafeJson<ReadinessAttestationRequest>,
) -> Result<(StatusCode, Json<ReadinessResponse>), ApiError> {
    m3::require_enabled(&state)?;
    let policy_now = m3::policy_now(&state).await?;
    if !(request.demo_page_verified
        && request.synthetic_example_data_verified
        && request.restricted_access_verified
        && request.visitor_instructions_verified)
        || request.visitor_instructions.trim().is_empty()
        || request.visitor_instructions.chars().count() > 2_000
    {
        return Err(ApiError::unprocessable(
            "readiness_checks_incomplete",
            "all demo readiness checks and bounded visitor instructions are required",
        ));
    }
    let account_id = authenticated.account_id()?;
    let key = intent::idempotency_key(&headers)?;
    let hash = intent::request_hash(&request)?;
    let mut transaction = state.pool.begin().await?;
    intent::acquire_operation_lock(&mut transaction, account_id, READINESS_OPERATION, key).await?;
    match intent::replay(
        &mut transaction,
        account_id,
        READINESS_OPERATION,
        key,
        &hash,
    )
    .await?
    {
        Replay::Match(response) => {
            transaction.commit().await?;
            return Ok((StatusCode::CREATED, Json(response)));
        }
        Replay::Changed => {
            return Err(ApiError::conflict(
                "idempotency_payload_changed",
                "the idempotency key was already used with a different readiness attestation",
            ));
        }
        Replay::Miss => {}
    }
    // Automatic refresh holds the account before the fact/readiness graph.
    // Keep owner attestations in the same order so concurrent activation cannot
    // deadlock on the fact row and the account foreign-key lock.
    lock_account(&mut transaction, account_id).await?;
    let fact: FactRow = sqlx::query_as(
        "SELECT id,approved_revision_id,project_reference_id,hosted_project_id,revision_number, \
                source_release_id,source_deployment_id,facts,refresh_scope,created_at \
         FROM portfolio_deployment_fact_revisions WHERE account_id=$1 AND id=$2 \
           AND approved_revision_id=$3 AND project_reference_id=$4 FOR UPDATE",
    )
    .bind(account_id)
    .bind(request.fact_revision_id)
    .bind(request.approved_revision_id)
    .bind(&request.project_reference_id)
    .fetch_optional(&mut *transaction)
    .await?
    .ok_or_else(ApiError::not_found)?;
    let newer: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM portfolio_deployment_fact_revisions \
         WHERE account_id=$1 AND approved_revision_id=$2 AND project_reference_id=$3 \
           AND revision_number>$4)",
    )
    .bind(account_id)
    .bind(request.approved_revision_id)
    .bind(&request.project_reference_id)
    .bind(fact.revision_number)
    .fetch_one(&mut *transaction)
    .await?;
    if newer {
        return Err(ApiError::conflict(
            "stale_readiness_target",
            "readiness must attest the current deployment fact revision",
        ));
    }
    let previous: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM portfolio_readiness_events WHERE account_id=$1 \
         AND approved_revision_id=$2 AND project_reference_id=$3 \
         ORDER BY event_sequence DESC LIMIT 1",
    )
    .bind(account_id)
    .bind(request.approved_revision_id)
    .bind(&request.project_reference_id)
    .fetch_optional(&mut *transaction)
    .await?;
    let attestation = json!({
        "release_id": fact.source_release_id,
        "fact_revision_id": fact.id,
        "checked_at": policy_now,
        "demo_page_verified": true,
        "synthetic_example_data_verified": true,
        "restricted_access_verified": true,
        "visitor_instructions_verified": true,
        "visitor_instructions": request.visitor_instructions,
    });
    let response = insert_readiness_event(
        &mut transaction,
        account_id,
        request.approved_revision_id,
        &request.project_reference_id,
        fact.id,
        previous,
        "ready_to_share",
        None,
        Some(attestation),
        Some(authenticated.session_id()),
        policy_now,
    )
    .await?;
    intent::store_replay(
        &mut transaction,
        account_id,
        READINESS_OPERATION,
        key,
        &hash,
        201,
        &response,
    )
    .await?;
    transaction.commit().await?;
    Ok((StatusCode::CREATED, Json(response)))
}

#[allow(clippy::too_many_arguments)]
async fn insert_fact_revision(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    approved_revision_id: Uuid,
    source: &ReviewDeploymentFact,
    previous_id: Option<Uuid>,
    revision_number: i64,
    revision_kind: &str,
    facts: &StoredFacts,
    refresh_scope: &[RefreshField],
    session_id: Option<Uuid>,
    occurred_at: DateTime<Utc>,
) -> Result<AuthorizedFactRevisionResponse, ApiError> {
    let id = Uuid::new_v4();
    let facts_json = serde_json::to_value(facts).map_err(|_| ApiError::internal())?;
    let scope_json = serde_json::to_value(refresh_scope).map_err(|_| ApiError::internal())?;
    let digest = digest_bytes("hostlet.portfolio-deployment-facts/v1", &facts_json)?;
    let audit_id = insert_audit(
        transaction,
        account_id,
        session_id,
        if revision_kind == "fact_refresh" {
            "portfolio.deployment_facts_refreshed"
        } else {
            "portfolio.deployment_facts_authorized"
        },
        "portfolio_deployment_fact_revision",
        id,
        json!({"source_release_id": source.source_release_id, "source_deployment_id": source.source_deployment_id}),
        occurred_at,
    )
    .await?;
    let created_at: DateTime<Utc> = sqlx::query_scalar(
        "INSERT INTO portfolio_deployment_fact_revisions \
         (id,account_id,approved_revision_id,project_reference_id,hosted_project_id, \
          revision_number,previous_fact_revision_id,revision_kind,source_release_id, \
          source_deployment_id,facts,refresh_scope,facts_digest,audit_event_id,created_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING created_at",
    )
    .bind(id)
    .bind(account_id)
    .bind(approved_revision_id)
    .bind(&source.project_reference_id)
    .bind(source.hosted_project_id)
    .bind(revision_number)
    .bind(previous_id)
    .bind(revision_kind)
    .bind(source.source_release_id)
    .bind(source.source_deployment_id)
    .bind(&facts_json)
    .bind(&scope_json)
    .bind(digest)
    .bind(audit_id)
    .bind(occurred_at)
    .fetch_one(&mut **transaction)
    .await?;
    Ok(AuthorizedFactRevisionResponse {
        id,
        project_reference_id: source.project_reference_id.clone(),
        revision: to_u64(revision_number)?,
        revision_kind: revision_kind.to_owned(),
        source_release_id: source.source_release_id,
        source_deployment_id: source.source_deployment_id,
        facts: facts_json,
        refresh_scope: refresh_scope.to_vec(),
        created_at,
    })
}

#[allow(clippy::too_many_arguments)]
async fn insert_readiness_event(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    approved_revision_id: Uuid,
    project_reference_id: &str,
    fact_revision_id: Uuid,
    previous_id: Option<Uuid>,
    state: &str,
    reason: Option<&str>,
    attestation: Option<Value>,
    session_id: Option<Uuid>,
    occurred_at: DateTime<Utc>,
) -> Result<ReadinessResponse, ApiError> {
    sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM portfolio_approved_revisions \
         WHERE account_id=$1 AND id=$2 FOR UPDATE",
    )
    .bind(account_id)
    .bind(approved_revision_id)
    .fetch_one(&mut **transaction)
    .await?;
    let latest: Option<(Uuid, i64)> = sqlx::query_as(
        "SELECT id,event_sequence FROM portfolio_readiness_events \
         WHERE account_id=$1 AND approved_revision_id=$2 AND project_reference_id=$3 \
         ORDER BY event_sequence DESC LIMIT 1",
    )
    .bind(account_id)
    .bind(approved_revision_id)
    .bind(project_reference_id)
    .fetch_optional(&mut **transaction)
    .await?;
    if latest.as_ref().map(|(id, _)| *id) != previous_id {
        return Err(ApiError::conflict(
            "stale_readiness_state",
            "the readiness state changed concurrently",
        ));
    }
    let event_sequence = latest.map_or(1, |(_, sequence)| sequence + 1);
    let id = Uuid::new_v4();
    let audit_id = insert_audit(
        transaction,
        account_id,
        session_id,
        if state == "ready_to_share" {
            "portfolio.readiness_attested"
        } else {
            "portfolio.readiness_recheck_required"
        },
        "portfolio_readiness_event",
        id,
        json!({"project_reference_id": project_reference_id, "fact_revision_id": fact_revision_id, "reason": reason}),
        occurred_at,
    )
    .await?;
    let created_at: DateTime<Utc> = sqlx::query_scalar(
        "INSERT INTO portfolio_readiness_events \
         (id,account_id,approved_revision_id,project_reference_id,event_sequence,fact_revision_id, \
          previous_event_id,state,reason,attestation,audit_event_id,created_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING created_at",
    )
    .bind(id)
    .bind(account_id)
    .bind(approved_revision_id)
    .bind(project_reference_id)
    .bind(event_sequence)
    .bind(fact_revision_id)
    .bind(previous_id)
    .bind(state)
    .bind(reason)
    .bind(&attestation)
    .bind(audit_id)
    .bind(occurred_at)
    .fetch_one(&mut **transaction)
    .await?;
    Ok(ReadinessResponse {
        id,
        event_sequence: to_u64(event_sequence)?,
        project_reference_id: project_reference_id.to_owned(),
        fact_revision_id,
        state: state.to_owned(),
        reason: reason.map(str::to_owned),
        attestation,
        created_at,
    })
}

#[allow(clippy::too_many_arguments)]
async fn insert_audit(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    session_id: Option<Uuid>,
    event_type: &str,
    target_type: &str,
    target_id: Uuid,
    metadata: Value,
    occurred_at: DateTime<Utc>,
) -> Result<Uuid, ApiError> {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO audit_events \
         (id,account_id,actor_account_id,session_id,event_type,target_type,target_id,outcome,metadata,created_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,'succeeded',$8,$9)",
    )
    .bind(id)
    .bind(account_id)
    .bind(session_id.map(|_| account_id))
    .bind(session_id)
    .bind(event_type)
    .bind(target_type)
    .bind(target_id)
    .bind(metadata)
    .bind(occurred_at)
    .execute(&mut **transaction)
    .await?;
    Ok(id)
}

pub(crate) async fn lock_account(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
) -> Result<(), ApiError> {
    sqlx::query_scalar::<_, Uuid>("SELECT id FROM accounts WHERE id=$1 FOR UPDATE")
        .bind(account_id)
        .fetch_one(&mut **transaction)
        .await?;
    Ok(())
}

fn uses_deployment_facts(project: &hostlet_contracts::portfolio::ProjectReference) -> bool {
    project.displayed_status.deployment_timestamp
        || project.displayed_status.availability
        || project.displayed_status.release_identifier
        || project.displayed_status.source_commit
        || project.displayed_status.demo_readiness
}

fn approval_value(
    draft: &PortfolioDraft,
    facts: &HashMap<&str, &ReviewDeploymentFact>,
    target: &ApprovalTarget,
) -> Result<Value, ApiError> {
    let project = |reference: &str| {
        draft
            .projects
            .iter()
            .find(|project| project.project_reference_id == reference)
            .ok_or_else(ApiError::internal)
    };
    match target {
        ApprovalTarget::Narrative {
            field,
            project_reference_id,
        } => match (field, project_reference_id.as_deref()) {
            (NarrativeField::DisplayName, None) => Ok(json!(draft.profile.display_name)),
            (NarrativeField::Headline, None) => Ok(json!(draft.profile.headline)),
            (NarrativeField::Introduction, None) => Ok(json!(draft.profile.introduction)),
            (NarrativeField::TargetRole, None) => Ok(json!(draft.profile.target_role)),
            (NarrativeField::Skills, None) => Ok(json!(draft.skills)),
            (NarrativeField::ProjectTitle, Some(reference)) => Ok(json!(project(reference)?.title)),
            (NarrativeField::ProjectPurpose, Some(reference)) => {
                Ok(json!(project(reference)?.purpose))
            }
            _ => Err(ApiError::internal()),
        },
        ApprovalTarget::Contact { contact_id } => draft
            .contacts
            .iter()
            .find(|contact| &contact.id == contact_id)
            .map(|contact| json!(contact))
            .ok_or_else(ApiError::internal),
        ApprovalTarget::Link {
            link_id,
            project_reference_id: None,
        } => draft
            .resume
            .as_ref()
            .filter(|link| &link.id == link_id)
            .map(|link| json!(link))
            .ok_or_else(ApiError::internal),
        ApprovalTarget::Link {
            link_id,
            project_reference_id: Some(reference),
        } => {
            let item = project(reference)?;
            if let Some(link) = item.links.iter().find(|link| &link.link.id == link_id) {
                return Ok(json!(link));
            }
            item.evidence
                .iter()
                .find(|evidence| &evidence.id == link_id)
                .map(|evidence| json!(evidence))
                .ok_or_else(ApiError::internal)
        }
        ApprovalTarget::Screenshot {
            project_reference_id,
            evidence_id,
        } => project(project_reference_id)?
            .evidence
            .iter()
            .find(|evidence| &evidence.id == evidence_id)
            .map(|evidence| json!(evidence))
            .ok_or_else(ApiError::internal),
        ApprovalTarget::Contribution {
            project_reference_id,
        } => Ok(json!(project(project_reference_id)?.contribution)),
        ApprovalTarget::TechnicalDecision {
            project_reference_id,
            decision_id,
        } => project(project_reference_id)?
            .technical_decisions
            .iter()
            .find(|decision| &decision.id == decision_id)
            .map(|decision| json!(decision))
            .ok_or_else(ApiError::internal),
        ApprovalTarget::Status {
            project_reference_id,
            field,
        } => {
            let fact = facts
                .get(project_reference_id.as_str())
                .ok_or_else(ApiError::internal)?;
            match field {
                StatusField::DeploymentTimestamp => Ok(json!(fact.deployed_at)),
                StatusField::Availability => Ok(json!({
                    "availability": fact.availability,
                    "status_label": fact.status_label,
                })),
                StatusField::ReleaseIdentifier => Ok(json!(fact.source_release_id)),
                StatusField::SourceCommit => Ok(json!(fact.public_source_commit)),
                StatusField::DemoReadiness => {
                    Ok(json!({"state":"needs_recheck","reason":"never_checked"}))
                }
            }
        }
    }
}

fn managed_demo_link(
    draft: &PortfolioDraft,
    fact: &ReviewDeploymentFact,
) -> (Option<String>, Option<String>) {
    let link = draft
        .projects
        .iter()
        .find(|project| project.project_reference_id == fact.project_reference_id)
        .and_then(|project| {
            project.links.iter().find(|link| {
                link.kind == ProjectLinkKind::Demo && link.link.url == fact.managed_demo_url
            })
        });
    link.map_or((None, None), |link| {
        let value = json!(link);
        (
            Some(link.link.id.clone()),
            digest_json("hostlet.portfolio-managed-demo-link/v1", &value).ok(),
        )
    })
}

fn managed_link_unchanged(
    draft: &PortfolioDraft,
    project_reference_id: &str,
    old: &StoredFacts,
) -> bool {
    let (Some(link_id), Some(expected)) = (
        old.managed_demo_link_id.as_deref(),
        old.managed_demo_link_digest.as_deref(),
    ) else {
        return false;
    };
    draft
        .projects
        .iter()
        .find(|project| project.project_reference_id == project_reference_id)
        .and_then(|project| project.links.iter().find(|link| link.link.id == link_id))
        .and_then(|link| digest_json("hostlet.portfolio-managed-demo-link/v1", &json!(link)).ok())
        .is_some_and(|actual| actual == expected)
}

fn parse_availability(value: &str) -> Result<AvailabilityLabel, ApiError> {
    match value {
        "available" => Ok(AvailabilityLabel::Available),
        "degraded" => Ok(AvailabilityLabel::Degraded),
        "demo_offline" => Ok(AvailabilityLabel::DemoOffline),
        _ => Err(ApiError::internal()),
    }
}

fn availability_status(value: AvailabilityLabel) -> &'static str {
    match value {
        AvailabilityLabel::Available => "Available",
        AvailabilityLabel::Degraded => "Degraded",
        AvailabilityLabel::DemoOffline => "Demo offline",
    }
}

fn digest_json<T: Serialize>(domain: &str, value: &T) -> Result<String, ApiError> {
    let json = serde_json::to_value(value).map_err(|_| ApiError::internal())?;
    digest_bytes(domain, &json).map(|digest| format_digest(&digest))
}

fn digest_bytes(domain: &str, value: &Value) -> Result<Vec<u8>, ApiError> {
    let bytes = serde_json::to_vec(value).map_err(|_| ApiError::internal())?;
    let mut digest = Sha256::new();
    digest.update(domain.as_bytes());
    digest.update([0]);
    digest.update(bytes);
    Ok(digest.finalize().to_vec())
}

fn format_digest(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(7 + bytes.len() * 2);
    output.push_str("sha256:");
    for byte in bytes {
        use std::fmt::Write;
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn parse_digest(value: &str) -> Result<Vec<u8>, ApiError> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return Err(ApiError::bad_request(
            "invalid_digest",
            "the review digest is invalid",
        ));
    };
    if hex.len() != 64 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(ApiError::bad_request(
            "invalid_digest",
            "the review digest is invalid",
        ));
    }
    (0..64)
        .step_by(2)
        .map(|index| u8::from_str_radix(&hex[index..index + 2], 16))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| ApiError::bad_request("invalid_digest", "the review digest is invalid"))
}

fn fact_response(row: FactRow) -> Result<AuthorizedFactRevisionResponse, ApiError> {
    Ok(AuthorizedFactRevisionResponse {
        id: row.id,
        project_reference_id: row.project_reference_id,
        revision: to_u64(row.revision_number)?,
        revision_kind: if row.revision_number == 1 {
            "owner_authorized".to_owned()
        } else {
            "fact_refresh".to_owned()
        },
        source_release_id: row.source_release_id,
        source_deployment_id: row.source_deployment_id,
        facts: row.facts,
        refresh_scope: serde_json::from_value(row.refresh_scope)
            .map_err(|_| ApiError::internal())?,
        created_at: row.created_at,
    })
}

fn readiness_response(row: ReadinessRow) -> Result<ReadinessResponse, ApiError> {
    Ok(ReadinessResponse {
        id: row.id,
        event_sequence: to_u64(row.event_sequence)?,
        project_reference_id: row.project_reference_id,
        fact_revision_id: row.fact_revision_id,
        state: row.state,
        reason: row.reason,
        attestation: row.attestation,
        created_at: row.created_at,
    })
}

fn to_u64(value: i64) -> Result<u64, ApiError> {
    u64::try_from(value).map_err(|_| ApiError::internal())
}
