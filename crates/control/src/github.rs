use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post, put},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Duration, Utc};
use rand::{RngCore, rngs::OsRng};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

use crate::{
    auth::Authenticated,
    crypto::SecretKey,
    error::{ApiError, SafeJson},
    foundation::FoundationState,
    github_provider::{
        GitHubBranch, GitHubInstallation, GitHubProvider, GitHubRepository,
        GitHubRepositoryRequest, GitHubSourceRequest, GitHubUser, ResolvedSource, SourceSnapshot,
    },
    intent::{self, Replay},
};

const OAUTH_TTL_SECONDS: i64 = 600;
const OAUTH_STATE_BYTES: usize = 32;
const PKCE_VERIFIER_BYTES: usize = 48;
const MAX_OAUTH_VALUE_BYTES: usize = 1024;
const MAX_REF_BYTES: usize = 512;
const TOKEN_AAD_DOMAIN: &str = "hostlet/github-user-token/v1";
const PKCE_AAD_DOMAIN: &str = "hostlet/github-pkce/v1";

#[derive(Serialize)]
struct OAuthAttemptResponse {
    authorization_url: String,
    expires_at: DateTime<Utc>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OAuthCompletionRequest {
    code: String,
    state: String,
}

#[derive(Serialize)]
struct OAuthCompletionResponse {
    github_user: GitHubUser,
    expires_at: Option<DateTime<Utc>>,
    revision: u64,
}

#[derive(Serialize)]
struct ConnectionResponse {
    github_user: GitHubUser,
    expires_at: Option<DateTime<Utc>>,
    status: String,
    revision: u64,
}

#[derive(Serialize)]
struct InstallationsResponse {
    installations: Vec<GitHubInstallation>,
}

#[derive(Serialize)]
struct RepositoriesResponse {
    repositories: Vec<GitHubRepository>,
}

#[derive(Serialize)]
struct BranchResponse {
    name: String,
    r#ref: String,
    commit_sha: String,
}

#[derive(Serialize)]
struct BranchesResponse {
    branches: Vec<BranchResponse>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct BindSourceRequest {
    installation_id: i64,
    repository_id: i64,
    r#ref: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct RepositoryResponse {
    id: i64,
    owner: String,
    name: String,
    private: bool,
}

#[derive(Clone, Serialize, Deserialize)]
struct SourceRevisionResponse {
    id: Uuid,
    configuration_revision_id: Uuid,
    resolved_commit: String,
    tree_sha: Option<String>,
    source: String,
    observed_at: DateTime<Utc>,
}

#[derive(Clone, Serialize, Deserialize)]
struct GitHubSourceResponse {
    binding_id: Uuid,
    project_id: Uuid,
    repository: RepositoryResponse,
    r#ref: String,
    status: String,
    revision: u64,
    source_revision: SourceRevisionResponse,
    configuration_fresh: bool,
}

#[derive(sqlx::FromRow)]
struct AuthorizationRow {
    github_user_id: i64,
    github_login: String,
    token_key_version: Option<String>,
    token_nonce: Option<Vec<u8>>,
    token_ciphertext: Option<Vec<u8>>,
    token_auth_tag: Option<Vec<u8>>,
    token_expires_at: Option<DateTime<Utc>>,
    status: String,
    revision: i64,
}

#[derive(sqlx::FromRow)]
struct OAuthAttemptRow {
    id: Uuid,
    account_id: Uuid,
    session_id: Uuid,
    pkce_key_version: String,
    pkce_nonce: Vec<u8>,
    pkce_ciphertext: Vec<u8>,
    pkce_auth_tag: Vec<u8>,
    status: String,
    expires_at: DateTime<Utc>,
    created_at: DateTime<Utc>,
}

struct LiveAuthorization {
    github_user_id: i64,
    revision: i64,
    access_token: String,
}

impl Drop for LiveAuthorization {
    fn drop(&mut self) {
        self.access_token.zeroize();
    }
}

#[derive(sqlx::FromRow)]
struct BindingRow {
    id: Uuid,
    project_id: Uuid,
    repository_id: Uuid,
    installation_id: i64,
    github_repository_id: i64,
    canonical_owner: String,
    canonical_name: String,
    repository_private: bool,
    authorized_ref: String,
    status: String,
    revision: i64,
}

#[derive(sqlx::FromRow)]
struct SourceRow {
    id: Uuid,
    configuration_revision_id: Uuid,
    commit_sha: String,
    tree_sha: Option<String>,
    source: String,
    observed_at: DateTime<Utc>,
}

struct SourceResponseContext<'a> {
    binding_id: Uuid,
    project_id: Uuid,
    repository: &'a GitHubRepository,
    authorized_ref: &'a str,
    status: &'a str,
    revision: i64,
    configuration_fresh: bool,
}

#[derive(sqlx::FromRow)]
struct BindingSourceRow {
    binding_id: Uuid,
    project_id: Uuid,
    repository_id: Uuid,
    installation_id: i64,
    github_repository_id: i64,
    canonical_owner: String,
    canonical_name: String,
    repository_private: bool,
    authorized_ref: String,
    binding_status: String,
    binding_revision: i64,
    source_id: Uuid,
    source_configuration_revision_id: Uuid,
    commit_sha: String,
    tree_sha: Option<String>,
    source_kind: String,
    observed_at: DateTime<Utc>,
    project_revision: i64,
    current_configuration_revision_id: Option<Uuid>,
}

impl BindingSourceRow {
    fn into_parts(self) -> (BindingRow, SourceRow, i64, Option<Uuid>) {
        (
            BindingRow {
                id: self.binding_id,
                project_id: self.project_id,
                repository_id: self.repository_id,
                installation_id: self.installation_id,
                github_repository_id: self.github_repository_id,
                canonical_owner: self.canonical_owner,
                canonical_name: self.canonical_name,
                repository_private: self.repository_private,
                authorized_ref: self.authorized_ref,
                status: self.binding_status,
                revision: self.binding_revision,
            },
            SourceRow {
                id: self.source_id,
                configuration_revision_id: self.source_configuration_revision_id,
                commit_sha: self.commit_sha,
                tree_sha: self.tree_sha,
                source: self.source_kind,
                observed_at: self.observed_at,
            },
            self.project_revision,
            self.current_configuration_revision_id,
        )
    }
}

pub(crate) struct AuthorizedSourceSnapshot {
    pub account_id: Uuid,
    pub project_id: Uuid,
    pub configuration_revision_id: Uuid,
    pub project_revision: i64,
    pub snapshot: SourceSnapshot,
}

pub fn routes() -> Router<FoundationState> {
    Router::new()
        .route("/v1/github/oauth-attempts", post(create_oauth_attempt))
        .route("/v1/github/oauth-completions", post(complete_oauth))
        .route("/v1/github/connection", get(get_connection))
        .route("/v1/github/installations", get(list_installations))
        .route(
            "/v1/github/installations/{installation_id}/repositories",
            get(list_repositories),
        )
        .route(
            "/v1/github/installations/{installation_id}/repositories/{repository_id}/branches",
            get(list_branches),
        )
        .route(
            "/v1/projects/{project_id}/github-source",
            put(bind_source).get(get_source).delete(delete_source),
        )
        .route(
            "/v1/projects/{project_id}/github-source/resolve",
            post(resolve_source),
        )
}

fn provider(state: &FoundationState) -> Result<Arc<GitHubProvider>, ApiError> {
    state.github.clone().ok_or_else(|| {
        ApiError::unavailable("github_unavailable", "GitHub integration is not configured")
    })
}

fn key(state: &FoundationState) -> Result<&SecretKey, ApiError> {
    state
        .secret_key
        .as_deref()
        .ok_or_else(ApiError::foundation_unavailable)
}

fn random_urlsafe<const N: usize>() -> String {
    let mut bytes = [0_u8; N];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn oauth_ttl_seconds() -> i64 {
    if std::env::var("HOSTLET_GITHUB_PROVIDER").as_deref() != Ok("synthetic_loopback") {
        return OAUTH_TTL_SECONDS;
    }
    std::env::var("HOSTLET_GITHUB_OAUTH_ATTEMPT_TTL_SECONDS")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| (1..=OAUTH_TTL_SECONDS).contains(value))
        .unwrap_or(OAUTH_TTL_SECONDS)
}

fn state_digest(state: &str) -> [u8; 32] {
    Sha256::digest(state.as_bytes()).into()
}

fn pkce_aad(attempt_id: Uuid, account_id: Uuid, session_id: Uuid) -> Vec<u8> {
    format!("{PKCE_AAD_DOMAIN}\0{attempt_id}\0{account_id}\0{session_id}").into_bytes()
}

fn token_aad(account_id: Uuid, github_user_id: i64) -> Vec<u8> {
    format!("{TOKEN_AAD_DOMAIN}\0{account_id}\0{github_user_id}").into_bytes()
}

fn validate_oauth_value(value: &str, code: &'static str) -> Result<(), ApiError> {
    if value.is_empty()
        || value.len() > MAX_OAUTH_VALUE_BYTES
        || value.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err(ApiError::bad_request(code, "the OAuth value is invalid"));
    }
    Ok(())
}

fn validate_ref(value: &str) -> Result<(), ApiError> {
    let branch = value.strip_prefix("refs/heads/").unwrap_or_default();
    if branch.is_empty()
        || value.len() > MAX_REF_BYTES
        || value.chars().any(char::is_control)
        || branch.starts_with('/')
        || branch.ends_with('/')
        || branch.contains("..")
        || branch.contains("//")
    {
        return Err(ApiError::unprocessable(
            "github_ref_invalid",
            "the selected ref must be a valid full branch ref",
        ));
    }
    Ok(())
}

fn as_u64(value: i64) -> Result<u64, ApiError> {
    u64::try_from(value).map_err(|_| ApiError::internal())
}

async fn create_oauth_attempt(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
) -> Result<(StatusCode, Json<OAuthAttemptResponse>), ApiError> {
    let provider = provider(&state)?;
    let account_id = authenticated.account_id()?;
    let attempt_id = Uuid::new_v4();
    let raw_state = random_urlsafe::<OAUTH_STATE_BYTES>();
    let mut verifier = random_urlsafe::<PKCE_VERIFIER_BYTES>();
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let authorization_url = provider.authorization_url(&raw_state, &challenge)?;
    let encrypted = key(&state)?
        .encrypt(
            &pkce_aad(attempt_id, account_id, authenticated.session_id()),
            verifier.as_bytes(),
        )
        .map_err(|_| ApiError::internal())?;
    verifier.zeroize();
    let expires_at = Utc::now() + Duration::seconds(oauth_ttl_seconds());
    let mut transaction = state.pool.begin().await?;
    sqlx::query(
        "INSERT INTO github_oauth_attempts \
         (id, account_id, session_id, state_digest, pkce_key_version, pkce_nonce, \
          pkce_ciphertext, pkce_auth_tag, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    )
    .bind(attempt_id)
    .bind(account_id)
    .bind(authenticated.session_id())
    .bind(state_digest(&raw_state).as_slice())
    .bind(key(&state)?.key_version())
    .bind(encrypted.nonce.as_slice())
    .bind(encrypted.ciphertext)
    .bind(encrypted.auth_tag.as_slice())
    .bind(expires_at)
    .execute(&mut *transaction)
    .await?;
    intent::audit(
        &mut transaction,
        account_id,
        authenticated.session_id(),
        "github.oauth.begin",
        "github_oauth_attempt",
        Some(attempt_id),
        "succeeded",
    )
    .await?;
    transaction.commit().await?;
    Ok((
        StatusCode::CREATED,
        Json(OAuthAttemptResponse {
            authorization_url,
            expires_at,
        }),
    ))
}

async fn complete_oauth(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    SafeJson(request): SafeJson<OAuthCompletionRequest>,
) -> Result<Json<OAuthCompletionResponse>, ApiError> {
    validate_oauth_value(&request.code, "github_oauth_code_invalid")?;
    validate_oauth_value(&request.state, "github_oauth_state_invalid")?;
    let provider = provider(&state)?;
    let account_id = authenticated.account_id()?;
    let digest = state_digest(&request.state);
    let mut transaction = state.pool.begin().await?;
    let attempt: Option<OAuthAttemptRow> = sqlx::query_as(
        "SELECT id, account_id, session_id, pkce_key_version, pkce_nonce, \
                pkce_ciphertext, pkce_auth_tag, status, expires_at, created_at \
         FROM github_oauth_attempts WHERE state_digest = $1 FOR UPDATE",
    )
    .bind(digest.as_slice())
    .fetch_optional(&mut *transaction)
    .await?;
    let Some(attempt) = attempt else {
        return Err(ApiError::bad_request(
            "github_oauth_state_invalid",
            "the OAuth state is invalid",
        ));
    };
    if attempt.account_id != account_id || attempt.session_id != authenticated.session_id() {
        return Err(ApiError::bad_request(
            "github_oauth_state_invalid",
            "the OAuth state is invalid",
        ));
    }
    if attempt.status != "pending" {
        return Err(ApiError::conflict(
            "github_oauth_state_replayed",
            "the OAuth state was already used",
        ));
    }
    if attempt.expires_at <= Utc::now() {
        sqlx::query("UPDATE github_oauth_attempts SET status = 'expired' WHERE id = $1")
            .bind(attempt.id)
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        return Err(ApiError::bad_request(
            "github_oauth_state_expired",
            "the OAuth state has expired",
        ));
    }
    if attempt.pkce_key_version != key(&state)?.key_version() {
        return Err(ApiError::foundation_unavailable());
    }
    let verifier = Zeroizing::new(
        key(&state)?
            .decrypt(
                &pkce_aad(attempt.id, account_id, authenticated.session_id()),
                &attempt.pkce_nonce,
                &attempt.pkce_ciphertext,
                &attempt.pkce_auth_tag,
            )
            .map_err(|_| ApiError::foundation_unavailable())?,
    );
    let verifier_text = std::str::from_utf8(&verifier).map_err(|_| ApiError::internal())?;
    let authorization = provider.exchange_code(&request.code, verifier_text).await?;
    let maximum_expiry = Utc::now() + Duration::hours(8);
    let effective_expiry = authorization.expires_at.unwrap_or(maximum_expiry);
    let effective_expiry = effective_expiry.min(maximum_expiry);
    if effective_expiry <= Utc::now() {
        return Err(ApiError::conflict(
            "github_connection_expired",
            "the GitHub connection must be renewed",
        ));
    }
    let encrypted = key(&state)?
        .encrypt(
            &token_aad(account_id, authorization.user.id),
            authorization.access_token.as_bytes(),
        )
        .map_err(|_| ApiError::internal())?;

    let existing: Option<(i64, i64, String, DateTime<Utc>)> = sqlx::query_as(
        "SELECT github_user_id, revision, status, updated_at FROM github_user_authorizations \
         WHERE account_id = $1 FOR UPDATE",
    )
    .bind(account_id)
    .fetch_optional(&mut *transaction)
    .await?;
    if existing
        .as_ref()
        .is_some_and(|(github_user_id, _, _, _)| *github_user_id != authorization.user.id)
    {
        return Err(ApiError::conflict(
            "github_identity_changed",
            "the account is already linked to a different GitHub identity",
        ));
    }
    if existing.as_ref().is_some_and(|(_, _, status, updated_at)| {
        status == "revoked" && *updated_at >= attempt.created_at
    }) {
        return Err(ApiError::conflict(
            "github_connection_revoked",
            "start a new GitHub connection after revocation",
        ));
    }
    let revision = existing.map_or(1, |(_, revision, _, _)| revision + 1);
    sqlx::query(
        "INSERT INTO github_user_authorizations \
         (account_id, github_user_id, github_login, token_key_version, token_nonce, \
          token_ciphertext, token_auth_tag, token_expires_at, status, revision) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9) \
         ON CONFLICT (account_id) DO UPDATE SET \
          github_login = EXCLUDED.github_login, token_key_version = EXCLUDED.token_key_version, \
          token_nonce = EXCLUDED.token_nonce, token_ciphertext = EXCLUDED.token_ciphertext, \
          token_auth_tag = EXCLUDED.token_auth_tag, token_expires_at = EXCLUDED.token_expires_at, \
          status = 'active', revision = EXCLUDED.revision, updated_at = transaction_timestamp()",
    )
    .bind(account_id)
    .bind(authorization.user.id)
    .bind(&authorization.user.login)
    .bind(key(&state)?.key_version())
    .bind(encrypted.nonce.as_slice())
    .bind(encrypted.ciphertext)
    .bind(encrypted.auth_tag.as_slice())
    .bind(effective_expiry)
    .bind(revision)
    .execute(&mut *transaction)
    .await
    .map_err(|error| {
        if error
            .as_database_error()
            .is_some_and(sqlx::error::DatabaseError::is_unique_violation)
        {
            ApiError::conflict(
                "github_identity_in_use",
                "the GitHub identity is already connected to another account",
            )
        } else {
            ApiError::from(error)
        }
    })?;
    sqlx::query(
        "UPDATE github_oauth_attempts SET status = 'consumed', consumed_at = transaction_timestamp() \
         WHERE id = $1 AND status = 'pending'",
    )
    .bind(attempt.id)
    .execute(&mut *transaction)
    .await?;
    intent::audit(
        &mut transaction,
        account_id,
        authenticated.session_id(),
        "github.oauth.complete",
        "github_user_authorization",
        None,
        "succeeded",
    )
    .await?;
    transaction.commit().await?;
    Ok(Json(OAuthCompletionResponse {
        github_user: authorization.user.clone(),
        expires_at: Some(effective_expiry),
        revision: as_u64(revision)?,
    }))
}

async fn get_connection(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
) -> Result<Json<ConnectionResponse>, ApiError> {
    provider(&state)?;
    let account_id = authenticated.account_id()?;
    let row = authorization_row(&state.pool, account_id).await?;
    Ok(Json(ConnectionResponse {
        github_user: GitHubUser {
            id: row.github_user_id,
            login: row.github_login,
        },
        expires_at: row.token_expires_at,
        status: row.status,
        revision: as_u64(row.revision)?,
    }))
}

async fn list_installations(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
) -> Result<Json<InstallationsResponse>, ApiError> {
    let provider = provider(&state)?;
    let account_id = authenticated.account_id()?;
    let authorization = live_authorization(&state, account_id).await?;
    provider
        .current_user(&authorization.access_token)
        .await
        .and_then(|user| verify_user(user, authorization.github_user_id))?;
    let installations = provider
        .list_installations(&authorization.access_token)
        .await?;
    persist_installations(&state.pool, &installations).await?;
    Ok(Json(InstallationsResponse { installations }))
}

async fn list_repositories(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    Path(installation_id): Path<i64>,
) -> Result<Json<RepositoriesResponse>, ApiError> {
    let provider = provider(&state)?;
    let account_id = authenticated.account_id()?;
    let authorization = live_authorization(&state, account_id).await?;
    provider
        .current_user(&authorization.access_token)
        .await
        .and_then(|user| verify_user(user, authorization.github_user_id))?;
    let installations = provider
        .list_installations(&authorization.access_token)
        .await?;
    let installation = installations
        .iter()
        .find(|installation| installation.id == installation_id && !installation.suspended)
        .ok_or_else(github_access_denied)?;
    persist_installations(&state.pool, std::slice::from_ref(installation)).await?;
    let repositories = provider
        .list_repositories(&authorization.access_token, installation_id)
        .await?;
    Ok(Json(RepositoriesResponse { repositories }))
}

async fn list_branches(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    Path((installation_id, repository_id)): Path<(i64, i64)>,
) -> Result<Json<BranchesResponse>, ApiError> {
    let provider = provider(&state)?;
    let authorization = live_authorization(&state, authenticated.account_id()?).await?;
    let branches = provider
        .list_branches(GitHubRepositoryRequest {
            user_access_token: &authorization.access_token,
            expected_user_id: authorization.github_user_id,
            installation_id,
            repository_id,
        })
        .await?;
    Ok(Json(BranchesResponse {
        branches: branches.into_iter().map(branch_response).collect(),
    }))
}

fn branch_response(branch: GitHubBranch) -> BranchResponse {
    BranchResponse {
        r#ref: format!("refs/heads/{}", branch.name),
        name: branch.name,
        commit_sha: branch.commit_sha,
    }
}

async fn bind_source(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    SafeJson(request): SafeJson<BindSourceRequest>,
) -> Result<Json<GitHubSourceResponse>, ApiError> {
    let provider = provider(&state)?;
    let project_id = intent::path_uuid(&project_id)?;
    let account_id = authenticated.account_id()?;
    let expected_project_revision = intent::if_match_revision(&headers)?;
    let idempotency_key = intent::idempotency_key(&headers)?;
    validate_ref(&request.r#ref)?;
    if request.installation_id <= 0 || request.repository_id <= 0 {
        return Err(github_access_denied());
    }
    let operation = format!("github.source.bind/{project_id}");
    let request_hash = intent::request_hash(&request)?;
    let mut transaction = state.pool.begin().await?;
    intent::acquire_operation_lock(&mut transaction, account_id, &operation, idempotency_key)
        .await?;
    match intent::replay(
        &mut transaction,
        account_id,
        &operation,
        idempotency_key,
        &request_hash,
    )
    .await?
    {
        Replay::Match(response) => {
            transaction.commit().await?;
            return Ok(Json(response));
        }
        Replay::Changed => return Err(idempotency_changed()),
        Replay::Miss => {}
    }
    let project: Option<(i64, Option<Uuid>, Uuid)> = sqlx::query_as(
        "SELECT p.revision, p.current_configuration_revision_id, r.id \
         FROM projects p JOIN repositories r ON r.account_id = p.account_id AND r.project_id = p.id \
         WHERE p.account_id = $1 AND p.id = $2 FOR UPDATE OF p",
    )
    .bind(account_id)
    .bind(project_id)
    .fetch_optional(&mut *transaction)
    .await?;
    let Some((project_revision, configuration_revision_id, repository_id)) = project else {
        return Err(ApiError::not_found());
    };
    if project_revision != expected_project_revision {
        return Err(ApiError::stale_revision());
    }
    let configuration_revision_id = configuration_revision_id.ok_or_else(|| {
        ApiError::conflict(
            "configuration_required",
            "the project requires a current configuration revision",
        )
    })?;
    let authorization = live_authorization(&state, account_id).await?;
    lock_current_authorization(&mut transaction, account_id, &authorization).await?;
    lock_installation(&mut transaction, request.installation_id).await?;
    let membership = provider
        .current_membership(
            &authorization.access_token,
            authorization.github_user_id,
            request.installation_id,
            request.repository_id,
        )
        .await?;
    if membership.installation.suspended || !membership.repository.readable {
        return Err(github_access_denied());
    }
    let snapshot = provider
        .resolve_source(GitHubSourceRequest {
            membership: GitHubRepositoryRequest {
                user_access_token: &authorization.access_token,
                expected_user_id: authorization.github_user_id,
                installation_id: request.installation_id,
                repository_id: request.repository_id,
            },
            authorized_ref: &request.r#ref,
        })
        .await?;
    if snapshot.repository.id != membership.repository.id {
        return Err(github_access_denied());
    }

    upsert_installation(&mut transaction, &membership.installation).await?;
    sqlx::query(
        "UPDATE github_installations SET status = 'active', updated_at = transaction_timestamp() \
         WHERE installation_id = $1 AND status IN ('suspended', 'revalidation_required')",
    )
    .bind(request.installation_id)
    .execute(&mut *transaction)
    .await?;
    let installation_active: bool = sqlx::query_scalar(
        "SELECT status = 'active' FROM github_installations \
         WHERE installation_id = $1 FOR SHARE",
    )
    .bind(request.installation_id)
    .fetch_one(&mut *transaction)
    .await?;
    if !installation_active {
        return Err(github_access_denied());
    }
    sqlx::query(
        "UPDATE github_repository_bindings SET status = 'disabled', revision = revision + 1, \
                updated_at = transaction_timestamp() \
         WHERE account_id = $1 AND project_id = $2 AND status = 'active'",
    )
    .bind(account_id)
    .bind(project_id)
    .execute(&mut *transaction)
    .await?;
    let binding_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO github_repository_bindings \
         (id, account_id, project_id, repository_id, installation_id, github_repository_id, \
          canonical_owner, canonical_name, repository_private, authorized_ref, selection_revision) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
    )
    .bind(binding_id)
    .bind(account_id)
    .bind(project_id)
    .bind(repository_id)
    .bind(request.installation_id)
    .bind(snapshot.repository.id)
    .bind(&snapshot.repository.owner)
    .bind(&snapshot.repository.name)
    .bind(snapshot.repository.private)
    .bind(&snapshot.authorized_ref)
    .bind(project_revision + 1)
    .execute(&mut *transaction)
    .await?;
    let source = insert_owner_source(
        &mut transaction,
        binding_id,
        account_id,
        project_id,
        repository_id,
        configuration_revision_id,
        request.installation_id,
        &snapshot,
    )
    .await?;
    sqlx::query(
        "UPDATE projects SET revision = revision + 1, updated_at = transaction_timestamp() \
         WHERE account_id = $1 AND id = $2",
    )
    .bind(account_id)
    .bind(project_id)
    .execute(&mut *transaction)
    .await?;
    let response = source_response(
        SourceResponseContext {
            binding_id,
            project_id,
            repository: &snapshot.repository,
            authorized_ref: &snapshot.authorized_ref,
            status: "active",
            revision: 1,
            configuration_fresh: true,
        },
        source,
    )?;
    intent::audit(
        &mut transaction,
        account_id,
        authenticated.session_id(),
        "github.source.bind",
        "github_repository_binding",
        Some(binding_id),
        "succeeded",
    )
    .await?;
    intent::store_replay(
        &mut transaction,
        account_id,
        &operation,
        idempotency_key,
        &request_hash,
        200,
        &response,
    )
    .await?;
    transaction.commit().await?;
    Ok(Json(response))
}

async fn get_source(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    Path(project_id): Path<String>,
) -> Result<Json<GitHubSourceResponse>, ApiError> {
    provider(&state)?;
    let project_id = intent::path_uuid(&project_id)?;
    let account_id = authenticated.account_id()?;
    let row: Option<BindingSourceRow> = sqlx::query_as(
        "SELECT b.id AS binding_id, b.project_id, b.repository_id, b.installation_id, \
                b.github_repository_id, b.canonical_owner, b.canonical_name, \
                b.repository_private, b.authorized_ref, b.status AS binding_status, \
                b.revision AS binding_revision, s.id AS source_id, \
                s.configuration_revision_id AS source_configuration_revision_id, \
                s.commit_sha, s.tree_sha, s.source AS source_kind, s.observed_at, \
                p.revision AS project_revision, \
                p.current_configuration_revision_id \
         FROM github_repository_bindings b \
         JOIN projects p ON p.account_id = b.account_id AND p.id = b.project_id \
         JOIN LATERAL (SELECT id, configuration_revision_id, commit_sha, tree_sha, source, observed_at \
                       FROM github_source_revisions WHERE binding_id = b.id AND source = 'owner_resolve' \
                       ORDER BY observed_at DESC, id DESC LIMIT 1) s ON true \
         WHERE b.account_id = $1 AND b.project_id = $2 \
         ORDER BY b.selection_revision DESC LIMIT 1",
    )
    .bind(account_id)
    .bind(project_id)
    .fetch_optional(&state.pool)
    .await?;
    let Some(row) = row else {
        return Err(ApiError::not_found());
    };
    let (binding, source, _, current_configuration) = row.into_parts();
    Ok(Json(response_from_rows(
        &binding,
        source,
        current_configuration,
    )?))
}

async fn resolve_source(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    Path(project_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<GitHubSourceResponse>, ApiError> {
    let provider = provider(&state)?;
    let project_id = intent::path_uuid(&project_id)?;
    let account_id = authenticated.account_id()?;
    let expected_revision = intent::if_match_revision(&headers)?;
    let idempotency_key = intent::idempotency_key(&headers)?;
    let operation = format!("github.source.resolve/{project_id}");
    let request_hash = intent::request_hash(&serde_json::json!({
        "binding_revision": expected_revision
    }))?;
    let mut transaction = state.pool.begin().await?;
    intent::acquire_operation_lock(&mut transaction, account_id, &operation, idempotency_key)
        .await?;
    match intent::replay(
        &mut transaction,
        account_id,
        &operation,
        idempotency_key,
        &request_hash,
    )
    .await?
    {
        Replay::Match(response) => {
            transaction.commit().await?;
            return Ok(Json(response));
        }
        Replay::Changed => return Err(idempotency_changed()),
        Replay::Miss => {}
    }
    let binding = active_binding(&state.pool, account_id, project_id).await?;
    let authorization = live_authorization(&state, account_id).await?;
    lock_current_authorization(&mut transaction, account_id, &authorization).await?;
    let snapshot = provider
        .resolve_source(GitHubSourceRequest {
            membership: GitHubRepositoryRequest {
                user_access_token: &authorization.access_token,
                expected_user_id: authorization.github_user_id,
                installation_id: binding.installation_id,
                repository_id: binding.github_repository_id,
            },
            authorized_ref: &binding.authorized_ref,
        })
        .await?;
    if snapshot.repository.id != binding.github_repository_id
        || snapshot.authorized_ref != binding.authorized_ref
    {
        return Err(github_access_denied());
    }
    let locked: Option<(i64, Option<Uuid>)> = sqlx::query_as(
        "SELECT b.revision, p.current_configuration_revision_id \
         FROM github_repository_bindings b \
         JOIN projects p ON p.account_id = b.account_id AND p.id = b.project_id \
         WHERE b.id = $1 AND b.account_id = $2 AND b.project_id = $3 AND b.status = 'active' \
         FOR UPDATE OF b",
    )
    .bind(binding.id)
    .bind(account_id)
    .bind(project_id)
    .fetch_optional(&mut *transaction)
    .await?;
    let Some((revision, configuration_revision_id)) = locked else {
        return Err(ApiError::not_found());
    };
    if revision != expected_revision {
        return Err(ApiError::stale_revision());
    }
    let configuration_revision_id = configuration_revision_id.ok_or_else(|| {
        ApiError::conflict(
            "configuration_required",
            "the project requires a current configuration revision",
        )
    })?;
    let source = insert_owner_source(
        &mut transaction,
        binding.id,
        account_id,
        project_id,
        binding.repository_id,
        configuration_revision_id,
        binding.installation_id,
        &snapshot,
    )
    .await?;
    let next_revision: i64 = sqlx::query_scalar(
        "UPDATE github_repository_bindings SET revision = revision + 1, \
                updated_at = transaction_timestamp() \
         WHERE id = $1 RETURNING revision",
    )
    .bind(binding.id)
    .fetch_one(&mut *transaction)
    .await?;
    let response = source_response(
        SourceResponseContext {
            binding_id: binding.id,
            project_id,
            repository: &snapshot.repository,
            authorized_ref: &snapshot.authorized_ref,
            status: "active",
            revision: next_revision,
            configuration_fresh: true,
        },
        source,
    )?;
    intent::audit(
        &mut transaction,
        account_id,
        authenticated.session_id(),
        "github.source.resolve",
        "github_source_revision",
        Some(response.source_revision.id),
        "succeeded",
    )
    .await?;
    intent::store_replay(
        &mut transaction,
        account_id,
        &operation,
        idempotency_key,
        &request_hash,
        200,
        &response,
    )
    .await?;
    transaction.commit().await?;
    Ok(Json(response))
}

async fn delete_source(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    Path(project_id): Path<String>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    provider(&state)?;
    let project_id = intent::path_uuid(&project_id)?;
    let account_id = authenticated.account_id()?;
    let expected_revision = intent::if_match_revision(&headers)?;
    let mut transaction = state.pool.begin().await?;
    let binding: Option<(Uuid, i64)> = sqlx::query_as(
        "SELECT id, revision FROM github_repository_bindings \
         WHERE account_id = $1 AND project_id = $2 AND status = 'active' FOR UPDATE",
    )
    .bind(account_id)
    .bind(project_id)
    .fetch_optional(&mut *transaction)
    .await?;
    let Some((binding_id, revision)) = binding else {
        return Err(ApiError::not_found());
    };
    if revision != expected_revision {
        return Err(ApiError::stale_revision());
    }
    sqlx::query(
        "UPDATE github_repository_bindings SET status = 'disabled', revision = revision + 1, \
                updated_at = transaction_timestamp() WHERE id = $1",
    )
    .bind(binding_id)
    .execute(&mut *transaction)
    .await?;
    intent::audit(
        &mut transaction,
        account_id,
        authenticated.session_id(),
        "github.source.disable",
        "github_repository_binding",
        Some(binding_id),
        "succeeded",
    )
    .await?;
    transaction.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn authorization_row(pool: &PgPool, account_id: Uuid) -> Result<AuthorizationRow, ApiError> {
    sqlx::query_as(
        "SELECT github_user_id, github_login, token_key_version, token_nonce, token_ciphertext, \
                token_auth_tag, token_expires_at, status, revision \
         FROM github_user_authorizations WHERE account_id = $1",
    )
    .bind(account_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| {
        ApiError::conflict(
            "github_connection_required",
            "a GitHub connection is required",
        )
    })
}

async fn live_authorization(
    state: &FoundationState,
    account_id: Uuid,
) -> Result<LiveAuthorization, ApiError> {
    let row = authorization_row(&state.pool, account_id).await?;
    if row.status != "active"
        || row
            .token_expires_at
            .is_some_and(|expiry| expiry <= Utc::now())
    {
        if row.status == "active" {
            sqlx::query(
                "UPDATE github_user_authorizations SET status = 'expired', revision = revision + 1, \
                        updated_at = transaction_timestamp() \
                 WHERE account_id = $1 AND status = 'active'",
            )
            .bind(account_id)
            .execute(&state.pool)
            .await?;
        }
        return Err(ApiError::conflict(
            "github_connection_expired",
            "the GitHub connection must be renewed",
        ));
    }
    let (Some(key_version), Some(nonce), Some(ciphertext), Some(tag)) = (
        row.token_key_version,
        row.token_nonce,
        row.token_ciphertext,
        row.token_auth_tag,
    ) else {
        return Err(ApiError::foundation_unavailable());
    };
    if key_version != key(state)?.key_version() {
        return Err(ApiError::foundation_unavailable());
    }
    let plaintext = Zeroizing::new(
        key(state)?
            .decrypt(
                &token_aad(account_id, row.github_user_id),
                &nonce,
                &ciphertext,
                &tag,
            )
            .map_err(|_| ApiError::foundation_unavailable())?,
    );
    let access_token = String::from_utf8(plaintext.to_vec()).map_err(|_| ApiError::internal())?;
    Ok(LiveAuthorization {
        github_user_id: row.github_user_id,
        revision: row.revision,
        access_token,
    })
}

async fn lock_current_authorization(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    authorization: &LiveAuthorization,
) -> Result<(), ApiError> {
    let current: Option<i64> = sqlx::query_scalar(
        "SELECT revision FROM github_user_authorizations \
         WHERE account_id = $1 AND github_user_id = $2 AND revision = $3 \
           AND status = 'active' AND (token_expires_at IS NULL OR token_expires_at > transaction_timestamp()) \
         FOR SHARE",
    )
    .bind(account_id)
    .bind(authorization.github_user_id)
    .bind(authorization.revision)
    .fetch_optional(&mut **transaction)
    .await?;
    if current.is_none() {
        Err(ApiError::conflict(
            "github_connection_expired",
            "the GitHub connection must be renewed",
        ))
    } else {
        Ok(())
    }
}

fn verify_user(user: GitHubUser, expected: i64) -> Result<(), ApiError> {
    if user.id == expected {
        Ok(())
    } else {
        Err(github_access_denied())
    }
}

fn github_access_denied() -> ApiError {
    ApiError::unprocessable(
        "github_access_denied",
        "current GitHub access does not authorize the selected resource",
    )
}

fn idempotency_changed() -> ApiError {
    ApiError::conflict(
        "idempotency_payload_changed",
        "the idempotency key was already used with a different request",
    )
}

async fn persist_installations(
    pool: &PgPool,
    installations: &[GitHubInstallation],
) -> Result<(), ApiError> {
    let mut transaction = pool.begin().await?;
    let mut ordered: Vec<_> = installations.iter().collect();
    ordered.sort_unstable_by_key(|installation| installation.id);
    for installation in ordered {
        upsert_installation(&mut transaction, installation).await?;
    }
    transaction.commit().await?;
    Ok(())
}

async fn upsert_installation(
    transaction: &mut Transaction<'_, Postgres>,
    installation: &GitHubInstallation,
) -> Result<(), ApiError> {
    lock_installation(transaction, installation.id).await?;
    let status = if installation.suspended {
        "suspended"
    } else {
        "active"
    };
    sqlx::query(
        "INSERT INTO github_installations \
         (installation_id, app_id, target_id, target_type, target_login, repository_selection, \
          status, last_verified_at) VALUES ($1,$2,$3,$4,$5,$6,$7,transaction_timestamp()) \
         ON CONFLICT (installation_id) DO UPDATE SET app_id = EXCLUDED.app_id, \
          target_id = EXCLUDED.target_id, target_type = EXCLUDED.target_type, \
          target_login = EXCLUDED.target_login, repository_selection = EXCLUDED.repository_selection, \
          status = CASE \
            WHEN github_installations.status IN ('deleted', 'suspended', 'revalidation_required') \
              THEN github_installations.status \
            ELSE EXCLUDED.status \
          END, last_verified_at = transaction_timestamp(), \
          updated_at = transaction_timestamp()",
    )
    .bind(installation.id)
    .bind(installation.app_id)
    .bind(installation.account_id)
    .bind(&installation.account_type)
    .bind(&installation.account_login)
    .bind(&installation.repository_selection)
    .bind(status)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

pub(crate) async fn lock_installation(
    transaction: &mut Transaction<'_, Postgres>,
    installation_id: i64,
) -> Result<(), ApiError> {
    let mut digest = Sha256::new();
    digest.update(b"hostlet/github-installation-lock/v1\0");
    digest.update(installation_id.to_be_bytes());
    let digest = digest.finalize();
    let lock_key = i64::from_be_bytes(digest[..8].try_into().map_err(|_| ApiError::internal())?);
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(lock_key)
        .execute(&mut **transaction)
        .await?;
    Ok(())
}

async fn active_binding(
    pool: &PgPool,
    account_id: Uuid,
    project_id: Uuid,
) -> Result<BindingRow, ApiError> {
    sqlx::query_as(
        "SELECT id, project_id, repository_id, installation_id, \
                github_repository_id, canonical_owner, canonical_name, repository_private, \
                authorized_ref, status, revision \
         FROM github_repository_bindings \
         WHERE account_id = $1 AND project_id = $2 AND status = 'active'",
    )
    .bind(account_id)
    .bind(project_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(ApiError::not_found)
}

#[allow(clippy::too_many_arguments)]
async fn insert_owner_source(
    transaction: &mut Transaction<'_, Postgres>,
    binding_id: Uuid,
    account_id: Uuid,
    project_id: Uuid,
    repository_id: Uuid,
    configuration_revision_id: Uuid,
    installation_id: i64,
    snapshot: &ResolvedSource,
) -> Result<SourceRow, ApiError> {
    let id = Uuid::new_v4();
    sqlx::query_as(
        "INSERT INTO github_source_revisions \
         (id, binding_id, account_id, project_id, repository_id, configuration_revision_id, \
          installation_id, github_repository_id, canonical_owner, canonical_name, \
          repository_private, authorized_ref, commit_sha, tree_sha, source) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'owner_resolve') \
         RETURNING id, configuration_revision_id, commit_sha, tree_sha, source, observed_at",
    )
    .bind(id)
    .bind(binding_id)
    .bind(account_id)
    .bind(project_id)
    .bind(repository_id)
    .bind(configuration_revision_id)
    .bind(installation_id)
    .bind(snapshot.repository.id)
    .bind(&snapshot.repository.owner)
    .bind(&snapshot.repository.name)
    .bind(snapshot.repository.private)
    .bind(&snapshot.authorized_ref)
    .bind(&snapshot.commit_sha)
    .bind(&snapshot.tree_sha)
    .fetch_one(&mut **transaction)
    .await
    .map_err(ApiError::from)
}

fn source_response(
    context: SourceResponseContext<'_>,
    source: SourceRow,
) -> Result<GitHubSourceResponse, ApiError> {
    Ok(GitHubSourceResponse {
        binding_id: context.binding_id,
        project_id: context.project_id,
        repository: RepositoryResponse {
            id: context.repository.id,
            owner: context.repository.owner.clone(),
            name: context.repository.name.clone(),
            private: context.repository.private,
        },
        r#ref: context.authorized_ref.to_owned(),
        status: context.status.to_owned(),
        revision: as_u64(context.revision)?,
        source_revision: SourceRevisionResponse {
            id: source.id,
            configuration_revision_id: source.configuration_revision_id,
            resolved_commit: source.commit_sha,
            tree_sha: source.tree_sha,
            source: source.source,
            observed_at: source.observed_at,
        },
        configuration_fresh: context.configuration_fresh,
    })
}

fn response_from_rows(
    binding: &BindingRow,
    source: SourceRow,
    current_configuration: Option<Uuid>,
) -> Result<GitHubSourceResponse, ApiError> {
    let repository = GitHubRepository {
        id: binding.github_repository_id,
        owner: binding.canonical_owner.clone(),
        name: binding.canonical_name.clone(),
        private: binding.repository_private,
        default_branch: String::new(),
        readable: binding.status == "active",
    };
    let fresh = current_configuration == Some(source.configuration_revision_id);
    source_response(
        SourceResponseContext {
            binding_id: binding.id,
            project_id: binding.project_id,
            repository: &repository,
            authorized_ref: &binding.authorized_ref,
            status: &binding.status,
            revision: binding.revision,
            configuration_fresh: fresh,
        },
        source,
    )
}

pub(crate) async fn check_keyring(pool: &PgPool, key: &SecretKey) -> Result<(), ApiError> {
    let invalid: bool = sqlx::query_scalar(
        "SELECT EXISTS ( \
             SELECT 1 FROM github_oauth_attempts \
             WHERE status = 'pending' AND pkce_key_version <> $1 \
             UNION ALL \
             SELECT 1 FROM github_user_authorizations \
             WHERE status = 'active' AND token_key_version <> $1 \
         )",
    )
    .bind(key.key_version())
    .fetch_one(pool)
    .await?;
    if invalid {
        Err(ApiError::foundation_unavailable())
    } else {
        Ok(())
    }
}

pub(crate) async fn authorized_source_snapshot(
    state: &FoundationState,
    authenticated: &Authenticated,
    transaction: &mut Transaction<'_, Postgres>,
    project_id: Uuid,
    source_revision_id: Uuid,
) -> Result<AuthorizedSourceSnapshot, ApiError> {
    let provider = provider(state)?;
    let account_id = authenticated.account_id()?;
    let row: Option<BindingSourceRow> = sqlx::query_as(
        "SELECT b.id AS binding_id, b.project_id, b.repository_id, b.installation_id, \
                b.github_repository_id, b.canonical_owner, b.canonical_name, \
                b.repository_private, b.authorized_ref, b.status AS binding_status, \
                b.revision AS binding_revision, s.id AS source_id, \
                s.configuration_revision_id AS source_configuration_revision_id, \
                s.commit_sha, s.tree_sha, s.source AS source_kind, s.observed_at, \
                p.revision AS project_revision, \
                p.current_configuration_revision_id \
         FROM github_source_revisions s \
         JOIN github_repository_bindings b ON b.id = s.binding_id AND b.account_id = s.account_id \
                                          AND b.project_id = s.project_id \
         JOIN projects p ON p.account_id = s.account_id AND p.id = s.project_id \
         WHERE s.account_id = $1 AND s.project_id = $2 AND s.id = $3 AND b.status = 'active'",
    )
    .bind(account_id)
    .bind(project_id)
    .bind(source_revision_id)
    .fetch_optional(&mut **transaction)
    .await?;
    let Some(row) = row else {
        return Err(ApiError::not_found());
    };
    let (binding, source, project_revision, current_configuration) = row.into_parts();
    if current_configuration != Some(source.configuration_revision_id) {
        return Err(ApiError::conflict(
            "github_source_configuration_stale",
            "the source must be resolved against the current project configuration",
        ));
    }
    let tree_sha = source.tree_sha.as_deref().ok_or_else(|| {
        ApiError::conflict(
            "github_source_unverified",
            "the source candidate must be explicitly resolved before analysis",
        )
    })?;
    let authorization = live_authorization(state, account_id).await?;
    let snapshot = provider
        .read_source(
            GitHubSourceRequest {
                membership: GitHubRepositoryRequest {
                    user_access_token: &authorization.access_token,
                    expected_user_id: authorization.github_user_id,
                    installation_id: binding.installation_id,
                    repository_id: binding.github_repository_id,
                },
                authorized_ref: &binding.authorized_ref,
            },
            &source.commit_sha,
            tree_sha,
        )
        .await?;
    if snapshot.repository.id != binding.github_repository_id
        || snapshot.authorized_ref != binding.authorized_ref
        || snapshot.commit_sha != source.commit_sha
        || snapshot.tree_sha != tree_sha
    {
        return Err(github_access_denied());
    }
    let locked_project: Option<(i64, Option<Uuid>)> = sqlx::query_as(
        "SELECT revision, current_configuration_revision_id FROM projects \
         WHERE account_id = $1 AND id = $2 FOR SHARE",
    )
    .bind(account_id)
    .bind(project_id)
    .fetch_optional(&mut **transaction)
    .await?;
    let Some((locked_project_revision, locked_configuration_revision)) = locked_project else {
        return Err(ApiError::not_found());
    };
    if locked_project_revision != project_revision
        || locked_configuration_revision != Some(source.configuration_revision_id)
    {
        return Err(ApiError::conflict(
            "github_source_configuration_stale",
            "the source must be resolved against the current project configuration",
        ));
    }
    lock_current_authorization(transaction, account_id, &authorization).await?;
    lock_installation(transaction, binding.installation_id).await?;
    let installation_active: bool = sqlx::query_scalar(
        "SELECT status = 'active' FROM github_installations \
         WHERE installation_id = $1 FOR SHARE",
    )
    .bind(binding.installation_id)
    .fetch_optional(&mut **transaction)
    .await?
    .unwrap_or(false);
    if !installation_active {
        return Err(github_access_denied());
    }
    let locked_binding: Option<(i64, String)> = sqlx::query_as(
        "SELECT revision, status FROM github_repository_bindings \
         WHERE id = $1 AND account_id = $2 AND project_id = $3 FOR SHARE",
    )
    .bind(binding.id)
    .bind(account_id)
    .bind(project_id)
    .fetch_optional(&mut **transaction)
    .await?;
    if !locked_binding
        .is_some_and(|(revision, status)| revision == binding.revision && status == "active")
    {
        return Err(github_access_denied());
    }
    Ok(AuthorizedSourceSnapshot {
        account_id,
        project_id,
        configuration_revision_id: source.configuration_revision_id,
        project_revision,
        snapshot,
    })
}
