use std::str::FromStr;

use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use axum::{
    Json,
    extract::{FromRequestParts, Path, State},
    http::{HeaderMap, StatusCode, header, request::Parts},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Duration, Utc};
use hostlet_contracts::project::{AccountId, AccountRecord};
use rand::{RngCore, rngs::OsRng};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::error::ApiError;
use crate::{error::SafeJson, foundation::FoundationState};

const MAX_EMAIL_BYTES: usize = 320;
const MAX_DISPLAY_NAME_BYTES: usize = 100;
const MIN_PASSWORD_BYTES: usize = 12;
const MAX_PASSWORD_BYTES: usize = 256;
const MAX_IDEMPOTENCY_KEY_BYTES: usize = 128;

type SessionLookupRow = (
    Uuid,
    Uuid,
    DateTime<Utc>,
    Option<DateTime<Utc>>,
    String,
    String,
    i64,
);
type AuditRow = (Uuid, String, String, Option<Uuid>, String, DateTime<Utc>);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateAccountRequest {
    email: String,
    password: String,
    display_name: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateSessionRequest {
    email: String,
    password: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateAccountRequest {
    display_name: String,
}

#[derive(Serialize)]
pub struct SessionResponse {
    token: String,
    expires_at: DateTime<Utc>,
    account_id: AccountId,
}

#[derive(Serialize)]
pub struct CurrentAccountResponse {
    account: AccountRecord,
    session: CurrentSession,
}

#[derive(Serialize)]
pub struct CurrentSession {
    id: Uuid,
    expires_at: DateTime<Utc>,
}

#[derive(Serialize)]
pub struct AuditResponse {
    events: Vec<AuditEvent>,
}

#[derive(Serialize)]
pub struct AuditEvent {
    id: Uuid,
    event_type: String,
    target_type: String,
    target_id: Option<Uuid>,
    outcome: String,
    created_at: DateTime<Utc>,
}

pub struct Authenticated {
    account: AccountRecord,
    session_id: Uuid,
    expires_at: DateTime<Utc>,
}

impl Authenticated {
    pub fn account(&self) -> &AccountRecord {
        &self.account
    }

    pub fn account_id(&self) -> Result<Uuid, ApiError> {
        account_uuid(&self.account)
    }

    pub fn session_id(&self) -> Uuid {
        self.session_id
    }
}

impl FromRequestParts<FoundationState> for Authenticated {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &FoundationState,
    ) -> Result<Self, Self::Rejection> {
        let Some(token) = bearer_token(&parts.headers) else {
            audit_pool(
                &state.pool,
                None,
                None,
                "session.authentication",
                "session",
                None,
                "denied",
            )
            .await;
            return Err(ApiError::unauthorized());
        };
        let token_hash = token_hash(token);
        let row: Option<SessionLookupRow> = sqlx::query_as(
            "SELECT s.id, s.account_id, s.expires_at, s.revoked_at, \
                    a.email, a.display_name, a.revision \
             FROM sessions s JOIN accounts a ON a.id = s.account_id \
             WHERE s.token_hash = $1",
        )
        .bind(token_hash.as_slice())
        .fetch_optional(&state.pool)
        .await
        .map_err(ApiError::from)?;

        let Some((session_id, account_id, expires_at, revoked_at, email, display_name, revision)) =
            row
        else {
            audit_pool(
                &state.pool,
                None,
                None,
                "session.authentication",
                "session",
                None,
                "denied",
            )
            .await;
            return Err(ApiError::unauthorized());
        };
        if revoked_at.is_some() || expires_at <= Utc::now() {
            audit_pool(
                &state.pool,
                Some(account_id),
                Some(session_id),
                "session.authentication",
                "session",
                Some(session_id),
                "denied",
            )
            .await;
            return Err(ApiError::unauthorized());
        }
        Ok(Self {
            account: account_record(account_id, email, display_name, revision),
            session_id,
            expires_at,
        })
    }
}

pub async fn create_account(
    State(state): State<FoundationState>,
    SafeJson(request): SafeJson<CreateAccountRequest>,
) -> Result<(StatusCode, Json<AccountRecord>), ApiError> {
    let email = normalize_email(&request.email)?;
    let display_name = normalize_display_name(&request.display_name)?;
    validate_password(&request.password)?;
    let password_hash = hash_password(request.password).await?;
    let account_id = Uuid::new_v4();
    let identity_id = Uuid::new_v4();
    let mut transaction = state.pool.begin().await.map_err(ApiError::from)?;

    let inserted = sqlx::query(
        "INSERT INTO accounts \
            (id, email, email_normalized, display_name, revision) \
         VALUES ($1, $2, $2, $3, 1)",
    )
    .bind(account_id)
    .bind(&email)
    .bind(&display_name)
    .execute(&mut *transaction)
    .await;
    if let Err(error) = inserted {
        return if is_unique_violation(&error) {
            Err(ApiError::conflict(
                "email_already_exists",
                "an account with that email already exists",
            ))
        } else {
            Err(ApiError::from(error))
        };
    }
    sqlx::query(
        "INSERT INTO password_identities (id, account_id, password_hash) VALUES ($1, $2, $3)",
    )
    .bind(identity_id)
    .bind(account_id)
    .bind(password_hash)
    .execute(&mut *transaction)
    .await
    .map_err(ApiError::from)?;
    audit_tx(
        &mut transaction,
        Some(account_id),
        Some(account_id),
        None,
        "account.created",
        "account",
        Some(account_id),
        "success",
    )
    .await?;
    transaction.commit().await.map_err(ApiError::from)?;

    Ok((
        StatusCode::CREATED,
        Json(account_record(account_id, email, display_name, 1)),
    ))
}

pub async fn create_session(
    State(state): State<FoundationState>,
    SafeJson(request): SafeJson<CreateSessionRequest>,
) -> Result<(StatusCode, Json<SessionResponse>), ApiError> {
    let email = normalize_email(&request.email)?;
    if request.password.len() > MAX_PASSWORD_BYTES {
        return Err(ApiError::unauthorized());
    }
    let row: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT a.id, p.password_hash \
         FROM accounts a JOIN password_identities p ON p.account_id = a.id \
         WHERE a.email_normalized = $1",
    )
    .bind(&email)
    .fetch_optional(&state.pool)
    .await
    .map_err(ApiError::from)?;

    let (account_id, verified) = match row {
        Some((account_id, stored_hash)) => (
            Some(account_id),
            verify_password(request.password, stored_hash).await?,
        ),
        None => {
            consume_password_work(request.password).await?;
            (None, false)
        }
    };
    if !verified {
        audit_pool(
            &state.pool,
            account_id,
            None,
            "session.create",
            "session",
            None,
            "denied",
        )
        .await;
        return Err(ApiError::unauthorized());
    }
    let account_id = account_id.expect("verified credentials have an account");
    let session_id = Uuid::new_v4();
    let mut token_bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut token_bytes);
    let token = URL_SAFE_NO_PAD.encode(token_bytes);
    let token_hash = token_hash(&token);
    let expires_at = Utc::now() + Duration::hours(24);
    let mut transaction = state.pool.begin().await.map_err(ApiError::from)?;
    sqlx::query(
        "INSERT INTO sessions (id, account_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)",
    )
    .bind(session_id)
    .bind(account_id)
    .bind(token_hash.as_slice())
    .bind(expires_at)
    .execute(&mut *transaction)
    .await
    .map_err(ApiError::from)?;
    audit_tx(
        &mut transaction,
        Some(account_id),
        Some(account_id),
        Some(session_id),
        "session.create",
        "session",
        Some(session_id),
        "success",
    )
    .await?;
    transaction.commit().await.map_err(ApiError::from)?;

    Ok((
        StatusCode::CREATED,
        Json(SessionResponse {
            token,
            expires_at,
            account_id: AccountId(account_id.to_string()),
        }),
    ))
}

pub async fn revoke_session(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
) -> Result<StatusCode, ApiError> {
    let account_id = authenticated.account_id()?;
    let mut transaction = state.pool.begin().await.map_err(ApiError::from)?;
    sqlx::query(
        "UPDATE sessions SET revoked_at = transaction_timestamp() \
         WHERE id = $1 AND account_id = $2 AND revoked_at IS NULL",
    )
    .bind(authenticated.session_id())
    .bind(account_id)
    .execute(&mut *transaction)
    .await
    .map_err(ApiError::from)?;
    audit_tx(
        &mut transaction,
        Some(account_id),
        Some(account_id),
        Some(authenticated.session_id()),
        "session.revoke",
        "session",
        Some(authenticated.session_id()),
        "success",
    )
    .await?;
    transaction.commit().await.map_err(ApiError::from)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn me(authenticated: Authenticated) -> Result<Json<CurrentAccountResponse>, ApiError> {
    Ok(Json(CurrentAccountResponse {
        account: authenticated.account().clone(),
        session: CurrentSession {
            id: authenticated.session_id(),
            expires_at: authenticated.expires_at,
        },
    }))
}

pub async fn get_account(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    Path(account_id): Path<String>,
) -> Result<Json<AccountRecord>, ApiError> {
    let requested_id = parse_uuid(&account_id)?;
    let actor_id = authenticated.account_id()?;
    if requested_id != actor_id {
        audit_pool(
            &state.pool,
            Some(actor_id),
            Some(authenticated.session_id()),
            "account.read",
            "account",
            Some(requested_id),
            "denied",
        )
        .await;
        return Err(ApiError::not_found());
    }
    let row: Option<(Uuid, String, String, i64)> = sqlx::query_as(
        "SELECT id, email, display_name, revision FROM accounts WHERE id = $1 AND id = $2",
    )
    .bind(requested_id)
    .bind(actor_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(ApiError::from)?;
    let Some((id, email, display_name, revision)) = row else {
        return Err(ApiError::not_found());
    };
    audit_required(
        &state.pool,
        Some(actor_id),
        Some(authenticated.session_id()),
        "account.read",
        "account",
        Some(actor_id),
        "success",
    )
    .await?;
    Ok(Json(account_record(id, email, display_name, revision)))
}

pub async fn update_account(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
    Path(account_id): Path<String>,
    headers: HeaderMap,
    SafeJson(request): SafeJson<UpdateAccountRequest>,
) -> Result<Json<AccountRecord>, ApiError> {
    let requested_id = parse_uuid(&account_id)?;
    let actor_id = authenticated.account_id()?;
    let idempotency_key = idempotency_key(&headers)?;
    let expected_revision = if_match_revision(&headers)?;
    let display_name = normalize_display_name(&request.display_name)?;
    let operation = format!("account.profile.update/{requested_id}");
    let request_hash: [u8; 32] = Sha256::digest(display_name.as_bytes()).into();
    let advisory_key = advisory_key(actor_id, &operation, &idempotency_key);
    let mut transaction = state.pool.begin().await.map_err(ApiError::from)?;
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(advisory_key)
        .execute(&mut *transaction)
        .await
        .map_err(ApiError::from)?;

    let replay: Option<(Vec<u8>, i32, serde_json::Value)> = sqlx::query_as(
        "SELECT request_hash, response_status, response_body \
         FROM idempotency_records \
         WHERE actor_account_id = $1 AND operation = $2 AND key = $3",
    )
    .bind(actor_id)
    .bind(&operation)
    .bind(&idempotency_key)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(ApiError::from)?;
    if let Some((stored_hash, _, response_body)) = replay {
        if stored_hash.as_slice() != request_hash {
            audit_tx(
                &mut transaction,
                Some(actor_id),
                Some(actor_id),
                Some(authenticated.session_id()),
                "account.update",
                "account",
                Some(requested_id),
                "idempotency_conflict",
            )
            .await?;
            transaction.commit().await.map_err(ApiError::from)?;
            return Err(ApiError::conflict(
                "idempotency_payload_changed",
                "the idempotency key was already used with a different payload",
            ));
        }
        let response = serde_json::from_value(response_body).map_err(|_| ApiError::internal())?;
        transaction.commit().await.map_err(ApiError::from)?;
        return Ok(Json(response));
    }

    if requested_id != actor_id {
        audit_tx(
            &mut transaction,
            Some(actor_id),
            Some(actor_id),
            Some(authenticated.session_id()),
            "account.update",
            "account",
            Some(requested_id),
            "denied",
        )
        .await?;
        transaction.commit().await.map_err(ApiError::from)?;
        return Err(ApiError::not_found());
    }

    let current: Option<(String, String, i64)> = sqlx::query_as(
        "SELECT email, display_name, revision FROM accounts \
         WHERE id = $1 AND id = $2 FOR UPDATE",
    )
    .bind(requested_id)
    .bind(actor_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(ApiError::from)?;
    let Some((email, _, current_revision)) = current else {
        transaction.rollback().await.map_err(ApiError::from)?;
        return Err(ApiError::not_found());
    };
    if current_revision != expected_revision {
        audit_tx(
            &mut transaction,
            Some(actor_id),
            Some(actor_id),
            Some(authenticated.session_id()),
            "account.update",
            "account",
            Some(actor_id),
            "stale_revision",
        )
        .await?;
        transaction.commit().await.map_err(ApiError::from)?;
        return Err(ApiError::stale_revision());
    }

    let revision = current_revision + 1;
    sqlx::query(
        "UPDATE accounts SET display_name = $1, revision = $2, \
                updated_at = transaction_timestamp() \
         WHERE id = $3 AND id = $4",
    )
    .bind(&display_name)
    .bind(revision)
    .bind(requested_id)
    .bind(actor_id)
    .execute(&mut *transaction)
    .await
    .map_err(ApiError::from)?;
    let response = account_record(actor_id, email, display_name, revision);
    let response_body = serde_json::to_value(&response).map_err(|_| ApiError::internal())?;
    audit_tx(
        &mut transaction,
        Some(actor_id),
        Some(actor_id),
        Some(authenticated.session_id()),
        "account.update",
        "account",
        Some(actor_id),
        "success",
    )
    .await?;
    sqlx::query(
        "INSERT INTO idempotency_records \
            (actor_account_id, operation, key, request_hash, response_status, response_body) \
         VALUES ($1, $2, $3, $4, 200, $5)",
    )
    .bind(actor_id)
    .bind(&operation)
    .bind(&idempotency_key)
    .bind(request_hash.as_slice())
    .bind(response_body)
    .execute(&mut *transaction)
    .await
    .map_err(ApiError::from)?;
    transaction.commit().await.map_err(ApiError::from)?;
    Ok(Json(response))
}

pub async fn audit(
    State(state): State<FoundationState>,
    authenticated: Authenticated,
) -> Result<Json<AuditResponse>, ApiError> {
    let account_id = authenticated.account_id()?;
    let rows: Vec<AuditRow> = sqlx::query_as(
        "SELECT id, event_type, target_type, target_id, outcome, created_at \
         FROM audit_events WHERE account_id = $1 \
         ORDER BY created_at DESC, id DESC LIMIT 200",
    )
    .bind(account_id)
    .fetch_all(&state.pool)
    .await
    .map_err(ApiError::from)?;
    Ok(Json(AuditResponse {
        events: rows
            .into_iter()
            .map(
                |(id, event_type, target_type, target_id, outcome, created_at)| AuditEvent {
                    id,
                    event_type,
                    target_type,
                    target_id,
                    outcome,
                    created_at,
                },
            )
            .collect(),
    }))
}

fn normalize_email(value: &str) -> Result<String, ApiError> {
    let normalized = value.trim().to_lowercase();
    let Some((local, domain)) = normalized.split_once('@') else {
        return Err(invalid_input("email must contain one @ separator"));
    };
    if local.is_empty()
        || domain.is_empty()
        || domain.contains('@')
        || normalized.len() > MAX_EMAIL_BYTES
        || normalized.chars().any(char::is_whitespace)
        || normalized.chars().any(char::is_control)
    {
        return Err(invalid_input("email is invalid or too long"));
    }
    Ok(normalized)
}

fn normalize_display_name(value: &str) -> Result<String, ApiError> {
    let normalized = value.trim();
    if normalized.is_empty()
        || normalized.len() > MAX_DISPLAY_NAME_BYTES
        || normalized.chars().any(char::is_control)
    {
        return Err(invalid_input(
            "display_name must contain 1 to 100 non-control bytes",
        ));
    }
    Ok(normalized.to_owned())
}

fn validate_password(value: &str) -> Result<(), ApiError> {
    if !(MIN_PASSWORD_BYTES..=MAX_PASSWORD_BYTES).contains(&value.len()) {
        return Err(invalid_input("password must contain 12 to 256 bytes"));
    }
    Ok(())
}

fn invalid_input(message: &'static str) -> ApiError {
    ApiError::bad_request("invalid_input", message)
}

async fn hash_password(password: String) -> Result<String, ApiError> {
    tokio::task::spawn_blocking(move || {
        let salt = SaltString::generate(&mut OsRng);
        Argon2::default()
            .hash_password(password.as_bytes(), &salt)
            .map(|hash| hash.to_string())
            .map_err(|_| ApiError::internal())
    })
    .await
    .map_err(|_| ApiError::internal())?
}

async fn verify_password(password: String, stored_hash: String) -> Result<bool, ApiError> {
    tokio::task::spawn_blocking(move || {
        let Ok(parsed) = PasswordHash::new(&stored_hash) else {
            return false;
        };
        Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok()
    })
    .await
    .map_err(|_| ApiError::internal())
}

async fn consume_password_work(password: String) -> Result<(), ApiError> {
    hash_password(password).await.map(|_| ())
}

fn token_hash(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let token = value.strip_prefix("Bearer ")?;
    if token.is_empty() || token.bytes().any(|byte| byte.is_ascii_whitespace()) {
        return None;
    }
    Some(token)
}

fn parse_uuid(value: &str) -> Result<Uuid, ApiError> {
    Uuid::from_str(value)
        .map_err(|_| ApiError::bad_request("invalid_path_id", "the path UUID is malformed"))
}

fn account_uuid(account: &AccountRecord) -> Result<Uuid, ApiError> {
    Uuid::from_str(&account.id.0).map_err(|_| ApiError::internal())
}

fn idempotency_key(headers: &HeaderMap) -> Result<String, ApiError> {
    let value = headers
        .get("Idempotency-Key")
        .ok_or_else(|| {
            ApiError::bad_request(
                "idempotency_key_required",
                "an Idempotency-Key header is required",
            )
        })?
        .to_str()
        .map_err(|_| {
            ApiError::bad_request("invalid_idempotency_key", "the idempotency key is invalid")
        })?;
    if value.is_empty()
        || value.len() > MAX_IDEMPOTENCY_KEY_BYTES
        || !value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
    {
        return Err(ApiError::bad_request(
            "invalid_idempotency_key",
            "the idempotency key must contain 1 to 128 visible ASCII bytes",
        ));
    }
    Ok(value.to_owned())
}

fn if_match_revision(headers: &HeaderMap) -> Result<i64, ApiError> {
    let value = headers
        .get(header::IF_MATCH)
        .ok_or_else(ApiError::precondition_required)?
        .to_str()
        .map_err(|_| malformed_if_match())?;
    let Some(inner) = value
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
    else {
        return Err(malformed_if_match());
    };
    inner
        .parse::<i64>()
        .ok()
        .filter(|revision| *revision > 0)
        .ok_or_else(malformed_if_match)
}

fn malformed_if_match() -> ApiError {
    ApiError::bad_request(
        "malformed_if_match",
        "If-Match must contain one quoted positive revision",
    )
}

fn advisory_key(account_id: Uuid, operation: &str, idempotency_key: &str) -> i64 {
    let mut digest = Sha256::new();
    digest.update(account_id.as_bytes());
    digest.update([0]);
    digest.update(operation.as_bytes());
    digest.update([0]);
    digest.update(idempotency_key.as_bytes());
    let bytes: [u8; 32] = digest.finalize().into();
    i64::from_be_bytes(bytes[..8].try_into().expect("eight-byte digest prefix"))
}

fn account_record(id: Uuid, email: String, display_name: String, revision: i64) -> AccountRecord {
    AccountRecord {
        id: AccountId(id.to_string()),
        email,
        display_name,
        revision: revision as u64,
    }
}

fn is_unique_violation(error: &sqlx::Error) -> bool {
    error
        .as_database_error()
        .is_some_and(sqlx::error::DatabaseError::is_unique_violation)
}

async fn audit_required(
    pool: &PgPool,
    account_id: Option<Uuid>,
    session_id: Option<Uuid>,
    event_type: &'static str,
    target_type: &'static str,
    target_id: Option<Uuid>,
    outcome: &'static str,
) -> Result<(), ApiError> {
    insert_audit(
        pool,
        account_id,
        account_id,
        session_id,
        event_type,
        target_type,
        target_id,
        outcome,
    )
    .await
    .map_err(ApiError::from)
}

async fn audit_pool(
    pool: &PgPool,
    account_id: Option<Uuid>,
    session_id: Option<Uuid>,
    event_type: &'static str,
    target_type: &'static str,
    target_id: Option<Uuid>,
    outcome: &'static str,
) {
    let _ = insert_audit(
        pool,
        account_id,
        account_id,
        session_id,
        event_type,
        target_type,
        target_id,
        outcome,
    )
    .await;
}

#[allow(clippy::too_many_arguments)]
async fn insert_audit(
    pool: &PgPool,
    account_id: Option<Uuid>,
    actor_account_id: Option<Uuid>,
    session_id: Option<Uuid>,
    event_type: &'static str,
    target_type: &'static str,
    target_id: Option<Uuid>,
    outcome: &'static str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO audit_events \
            (id, account_id, actor_account_id, session_id, event_type, target_type, target_id, outcome) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(Uuid::new_v4())
    .bind(account_id)
    .bind(actor_account_id)
    .bind(session_id)
    .bind(event_type)
    .bind(target_type)
    .bind(target_id)
    .bind(outcome)
    .execute(pool)
    .await
    .map(|_| ())
}

#[allow(clippy::too_many_arguments)]
async fn audit_tx(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: Option<Uuid>,
    actor_account_id: Option<Uuid>,
    session_id: Option<Uuid>,
    event_type: &'static str,
    target_type: &'static str,
    target_id: Option<Uuid>,
    outcome: &'static str,
) -> Result<(), ApiError> {
    sqlx::query(
        "INSERT INTO audit_events \
            (id, account_id, actor_account_id, session_id, event_type, target_type, target_id, outcome) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(Uuid::new_v4())
    .bind(account_id)
    .bind(actor_account_id)
    .bind(session_id)
    .bind(event_type)
    .bind(target_type)
    .bind(target_id)
    .bind(outcome)
    .execute(&mut **transaction)
    .await
    .map(|_| ())
    .map_err(ApiError::from)
}
