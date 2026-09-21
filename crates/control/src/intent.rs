use axum::http::{HeaderMap, header};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use crate::error::ApiError;

const MAX_IDEMPOTENCY_KEY_BYTES: usize = 128;

pub(crate) enum Replay<T> {
    Miss,
    Match(T),
    Changed,
}

pub(crate) fn path_uuid(value: &str) -> Result<Uuid, ApiError> {
    Uuid::parse_str(value)
        .map_err(|_| ApiError::bad_request("invalid_id", "the resource id is invalid"))
}

pub(crate) fn idempotency_key(headers: &HeaderMap) -> Result<&str, ApiError> {
    let key = headers
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| {
            ApiError::bad_request(
                "idempotency_key_required",
                "a valid Idempotency-Key header is required",
            )
        })?;
    if key.is_empty()
        || key.len() > MAX_IDEMPOTENCY_KEY_BYTES
        || key.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err(ApiError::bad_request(
            "invalid_idempotency_key",
            "Idempotency-Key must contain between 1 and 128 non-control bytes",
        ));
    }
    Ok(key)
}

pub(crate) fn if_match_revision(headers: &HeaderMap) -> Result<i64, ApiError> {
    let value = headers
        .get(header::IF_MATCH)
        .ok_or_else(ApiError::precondition_required)?
        .to_str()
        .map_err(|_| {
            ApiError::bad_request(
                "malformed_if_match",
                "If-Match must contain one quoted positive revision",
            )
        })?;
    let Some(unquoted) = value.strip_prefix('"').and_then(|v| v.strip_suffix('"')) else {
        return Err(ApiError::bad_request(
            "malformed_if_match",
            "If-Match must contain one quoted positive revision",
        ));
    };
    unquoted
        .parse::<i64>()
        .ok()
        .filter(|v| *v > 0)
        .ok_or_else(|| {
            ApiError::bad_request(
                "malformed_if_match",
                "If-Match must contain one quoted positive revision",
            )
        })
}

pub(crate) fn request_hash<T: Serialize>(request: &T) -> Result<Vec<u8>, ApiError> {
    serde_json::to_vec(request)
        .map(|bytes| Sha256::digest(bytes).to_vec())
        .map_err(|_| ApiError::internal())
}

pub(crate) async fn acquire_operation_lock(
    transaction: &mut Transaction<'_, Postgres>,
    actor_id: Uuid,
    operation: &str,
    key: &str,
) -> Result<(), ApiError> {
    let mut digest = Sha256::new();
    digest.update(actor_id.as_bytes());
    digest.update(operation.as_bytes());
    digest.update(key.as_bytes());
    let bytes = digest.finalize();
    let lock_key = i64::from_be_bytes(bytes[..8].try_into().map_err(|_| ApiError::internal())?);
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(lock_key)
        .execute(&mut **transaction)
        .await
        .map_err(ApiError::from)?;
    Ok(())
}

pub(crate) async fn replay<T: DeserializeOwned>(
    transaction: &mut Transaction<'_, Postgres>,
    actor_id: Uuid,
    operation: &str,
    key: &str,
    request_hash: &[u8],
) -> Result<Replay<T>, ApiError> {
    let row: Option<(Vec<u8>, Value)> = sqlx::query_as(
        "SELECT request_hash, response_body FROM idempotency_records \
         WHERE actor_account_id = $1 AND operation = $2 AND key = $3",
    )
    .bind(actor_id)
    .bind(operation)
    .bind(key)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(ApiError::from)?;
    match row {
        None => Ok(Replay::Miss),
        Some((stored, _)) if stored != request_hash => Ok(Replay::Changed),
        Some((_, body)) => serde_json::from_value(body)
            .map(Replay::Match)
            .map_err(|_| ApiError::internal()),
    }
}

pub(crate) async fn store_replay<T: Serialize>(
    transaction: &mut Transaction<'_, Postgres>,
    actor_id: Uuid,
    operation: &str,
    key: &str,
    request_hash: &[u8],
    response_status: i16,
    response: &T,
) -> Result<(), ApiError> {
    let body = serde_json::to_value(response).map_err(|_| ApiError::internal())?;
    sqlx::query(
        "INSERT INTO idempotency_records \
         (actor_account_id, operation, key, request_hash, response_status, response_body) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(actor_id)
    .bind(operation)
    .bind(key)
    .bind(request_hash)
    .bind(response_status)
    .bind(body)
    .execute(&mut **transaction)
    .await
    .map_err(ApiError::from)?;
    Ok(())
}

pub(crate) async fn audit(
    transaction: &mut Transaction<'_, Postgres>,
    actor_id: Uuid,
    session_id: Uuid,
    event_type: &str,
    target_type: &str,
    target_id: Option<Uuid>,
    outcome: &str,
) -> Result<(), ApiError> {
    sqlx::query(
        "INSERT INTO audit_events \
         (id, account_id, actor_account_id, session_id, event_type, target_type, target_id, outcome) \
         VALUES ($1, $2, $2, $3, $4, $5, $6, $7)",
    )
    .bind(Uuid::new_v4())
    .bind(actor_id)
    .bind(session_id)
    .bind(event_type)
    .bind(target_type)
    .bind(target_id)
    .bind(outcome)
    .execute(&mut **transaction)
    .await
    .map_err(ApiError::from)?;
    Ok(())
}
