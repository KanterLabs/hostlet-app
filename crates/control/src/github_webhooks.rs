use axum::{
    Json, Router,
    body::to_bytes,
    extract::{Request, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
};
use hmac::{Hmac, Mac};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Transaction};
use subtle::ConstantTimeEq;
use uuid::Uuid;

use crate::{foundation::FoundationState, github::lock_installation};

const MAX_WEBHOOK_BODY_BYTES: usize = 2 * 1024 * 1024;
const SIGNATURE_HEADER: &str = "x-hub-signature-256";
const DELIVERY_HEADER: &str = "x-github-delivery";
const EVENT_HEADER: &str = "x-github-event";

type HmacSha256 = Hmac<Sha256>;

#[derive(Serialize)]
struct WebhookResponse {
    status: &'static str,
    delivery_id: String,
}

#[derive(Serialize)]
struct ErrorEnvelope {
    error: ErrorBody,
}

#[derive(Serialize)]
struct ErrorBody {
    code: &'static str,
    message: &'static str,
    request_id: Uuid,
}

struct WebhookError {
    status: StatusCode,
    code: &'static str,
    message: &'static str,
}

struct DeliveryMetadata {
    action: Option<String>,
    installation_id: Option<i64>,
    repository_id: Option<i64>,
}

enum DeliveryOutcome {
    Accepted,
    Rejected(&'static str),
}

type BindingRow = (
    Uuid,
    Uuid,
    Uuid,
    Uuid,
    Uuid,
    i64,
    i64,
    String,
    String,
    bool,
    String,
);

pub fn routes() -> Router<FoundationState> {
    Router::new().route("/v1/github/webhooks", post(receive_webhook))
}

impl WebhookError {
    fn new(status: StatusCode, code: &'static str, message: &'static str) -> Self {
        Self {
            status,
            code,
            message,
        }
    }

    fn bad_request(code: &'static str, message: &'static str) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code, message)
    }

    fn rejected(reason: &'static str) -> Self {
        Self::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            reason,
            "the signed webhook event was not accepted",
        )
    }

    fn database() -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "database_unavailable",
            "the durable database dependency is unavailable",
        )
    }
}

impl IntoResponse for WebhookError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ErrorEnvelope {
                error: ErrorBody {
                    code: self.code,
                    message: self.message,
                    request_id: Uuid::new_v4(),
                },
            }),
        )
            .into_response()
    }
}

impl From<sqlx::Error> for WebhookError {
    fn from(_: sqlx::Error) -> Self {
        Self::database()
    }
}

async fn receive_webhook(
    State(state): State<FoundationState>,
    request: Request,
) -> Result<Response, WebhookError> {
    let provider = state.github.as_deref().ok_or_else(|| {
        WebhookError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "github_unavailable",
            "GitHub integration is unavailable",
        )
    })?;
    let (parts, body) = request.into_parts();
    let signature = one_header(&parts.headers, SIGNATURE_HEADER).ok_or_else(|| {
        WebhookError::new(
            StatusCode::UNAUTHORIZED,
            "github_signature_invalid",
            "a valid webhook signature is required",
        )
    })?;
    let supplied_signature = parse_signature(signature).ok_or_else(|| {
        WebhookError::new(
            StatusCode::UNAUTHORIZED,
            "github_signature_invalid",
            "a valid webhook signature is required",
        )
    })?;
    let body = to_bytes(body, MAX_WEBHOOK_BODY_BYTES).await.map_err(|_| {
        WebhookError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "github_payload_too_large",
            "the webhook payload exceeds 2 MiB",
        )
    })?;
    verify_signature(provider.webhook_secret(), &body, &supplied_signature)?;

    // Delivery and event headers are deliberately read only after the HMAC has
    // authenticated the raw bytes. Invalid signatures never reach JSON or SQL.
    let delivery = one_header(&parts.headers, DELIVERY_HEADER)
        .and_then(parse_delivery_id)
        .ok_or_else(|| {
            WebhookError::bad_request(
                "github_delivery_invalid",
                "the webhook delivery id is invalid",
            )
        })?;
    let delivery_id = delivery.to_string();
    let event = one_header(&parts.headers, EVENT_HEADER)
        .filter(|value| valid_event_name(value))
        .ok_or_else(|| {
            WebhookError::bad_request("github_event_invalid", "the webhook event is invalid")
        })?;
    let payload: Value = serde_json::from_slice(&body).map_err(|_| {
        WebhookError::bad_request(
            "github_payload_invalid",
            "the signed webhook payload is invalid",
        )
    })?;
    if !payload.is_object() {
        return Err(WebhookError::bad_request(
            "github_payload_invalid",
            "the signed webhook payload is invalid",
        ));
    }
    let metadata = delivery_metadata(&payload)?;
    let payload_digest = Sha256::digest(&body).to_vec();

    let mut transaction = state.pool.begin().await?;
    let inserted = sqlx::query_scalar::<_, bool>(
        "INSERT INTO github_webhook_deliveries \
         (delivery_id,event,action,installation_id,github_repository_id,payload_digest,disposition,reason) \
         VALUES ($1,$2,$3,$4,$5,$6,'rejected','processing') \
         ON CONFLICT (delivery_id) DO NOTHING RETURNING true",
    )
    .bind(&delivery_id)
    .bind(event)
    .bind(metadata.action.as_deref())
    .bind(metadata.installation_id)
    .bind(metadata.repository_id)
    .bind(&payload_digest)
    .fetch_optional(&mut *transaction)
    .await?
    .unwrap_or(false);

    if !inserted {
        let existing: Option<(String, Vec<u8>)> = sqlx::query_as(
            "SELECT event,payload_digest FROM github_webhook_deliveries WHERE delivery_id=$1",
        )
        .bind(&delivery_id)
        .fetch_optional(&mut *transaction)
        .await?;
        transaction.commit().await?;
        if existing.is_some_and(|(stored_event, stored_digest)| {
            stored_event == event && stored_digest.ct_eq(&payload_digest).unwrap_u8() == 1
        }) {
            return Ok((
                StatusCode::OK,
                Json(WebhookResponse {
                    status: "duplicate",
                    delivery_id,
                }),
            )
                .into_response());
        }
        return Err(WebhookError::new(
            StatusCode::CONFLICT,
            "github_delivery_conflict",
            "the delivery id was already used for a different event",
        ));
    }

    let outcome = match event {
        "push" if metadata.action.is_none() => {
            process_push(&mut transaction, &delivery_id, &payload).await?
        }
        "installation" => {
            process_installation(
                &mut transaction,
                delivery,
                &payload,
                metadata.action.as_deref(),
            )
            .await?
        }
        "installation_repositories" => {
            process_installation_repositories(
                &mut transaction,
                delivery,
                &payload,
                metadata.action.as_deref(),
            )
            .await?
        }
        "github_app_authorization" => {
            process_authorization(&mut transaction, &payload, metadata.action.as_deref()).await?
        }
        _ => DeliveryOutcome::Rejected("github_event_unsupported"),
    };

    match outcome {
        DeliveryOutcome::Accepted => {
            finish_delivery(&mut transaction, &delivery_id, "accepted", "accepted").await?;
            transaction.commit().await?;
            Ok((
                StatusCode::ACCEPTED,
                Json(WebhookResponse {
                    status: "accepted",
                    delivery_id,
                }),
            )
                .into_response())
        }
        DeliveryOutcome::Rejected(reason) => {
            finish_delivery(&mut transaction, &delivery_id, "rejected", reason).await?;
            webhook_audit(&mut transaction, None, delivery, reason).await?;
            transaction.commit().await?;
            Err(WebhookError::rejected(reason))
        }
    }
}

fn one_header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    let mut values = headers.get_all(name).iter();
    let value = values.next()?.to_str().ok()?;
    if values.next().is_some() {
        return None;
    }
    Some(value)
}

fn parse_delivery_id(value: &str) -> Option<Uuid> {
    if value.len() != 36 || !value.is_ascii() {
        return None;
    }
    let parsed = Uuid::parse_str(value).ok()?;
    (parsed.to_string() == value.to_ascii_lowercase()).then_some(parsed)
}

fn valid_event_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

fn parse_signature(value: &str) -> Option<[u8; 32]> {
    let hex = value.strip_prefix("sha256=")?;
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return None;
    }
    let mut decoded = [0_u8; 32];
    for (index, pair) in hex.as_bytes().chunks_exact(2).enumerate() {
        decoded[index] = (hex_nibble(pair[0])? << 4) | hex_nibble(pair[1])?;
    }
    Some(decoded)
}

fn hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    }
}

fn verify_signature(secret: &[u8], body: &[u8], supplied: &[u8; 32]) -> Result<(), WebhookError> {
    let mut mac = HmacSha256::new_from_slice(secret).map_err(|_| {
        WebhookError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "github_unavailable",
            "GitHub integration is unavailable",
        )
    })?;
    mac.update(body);
    let expected = mac.finalize().into_bytes();
    if expected.as_slice().ct_eq(supplied).unwrap_u8() != 1 {
        return Err(WebhookError::new(
            StatusCode::UNAUTHORIZED,
            "github_signature_invalid",
            "a valid webhook signature is required",
        ));
    }
    Ok(())
}

fn delivery_metadata(payload: &Value) -> Result<DeliveryMetadata, WebhookError> {
    let action = match payload.get("action") {
        None | Some(Value::Null) => None,
        Some(Value::String(action))
            if !action.is_empty()
                && action.len() <= 64
                && action
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte == b'_') =>
        {
            Some(action.clone())
        }
        _ => {
            return Err(WebhookError::bad_request(
                "github_payload_invalid",
                "the signed webhook payload is invalid",
            ));
        }
    };
    Ok(DeliveryMetadata {
        action,
        installation_id: positive_id(payload.pointer("/installation/id")),
        repository_id: positive_id(payload.pointer("/repository/id")),
    })
}

fn positive_id(value: Option<&Value>) -> Option<i64> {
    value.and_then(Value::as_i64).filter(|value| *value > 0)
}

fn required_id(payload: &Value, pointer: &str) -> Result<i64, DeliveryOutcome> {
    positive_id(payload.pointer(pointer)).ok_or(DeliveryOutcome::Rejected("github_payload_invalid"))
}

fn valid_commit(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        && value.bytes().any(|byte| byte != b'0')
}

async fn process_push(
    transaction: &mut Transaction<'_, Postgres>,
    delivery_id: &str,
    payload: &Value,
) -> Result<DeliveryOutcome, WebhookError> {
    let installation_id = match required_id(payload, "/installation/id") {
        Ok(value) => value,
        Err(outcome) => return Ok(outcome),
    };
    let repository_id = match required_id(payload, "/repository/id") {
        Ok(value) => value,
        Err(outcome) => return Ok(outcome),
    };
    let Some(reference) = payload.get("ref").and_then(Value::as_str) else {
        return Ok(DeliveryOutcome::Rejected("github_payload_invalid"));
    };
    let Some(commit_sha) = payload.get("after").and_then(Value::as_str) else {
        return Ok(DeliveryOutcome::Rejected("github_payload_invalid"));
    };
    if reference.len() > 512 || !reference.starts_with("refs/heads/") || !valid_commit(commit_sha) {
        return Ok(DeliveryOutcome::Rejected("github_push_rejected"));
    }
    lock_installation(transaction, installation_id)
        .await
        .map_err(|_| WebhookError::database())?;

    let bindings: Vec<BindingRow> = sqlx::query_as(
        "SELECT b.id,b.account_id,b.project_id,b.repository_id,p.current_configuration_revision_id, \
                b.installation_id,b.github_repository_id,b.canonical_owner,b.canonical_name, \
                b.repository_private,b.authorized_ref \
         FROM github_repository_bindings b \
         JOIN github_installations i ON i.installation_id=b.installation_id \
         JOIN projects p ON p.account_id=b.account_id AND p.id=b.project_id \
         WHERE b.status='active' AND i.status='active' AND b.installation_id=$1 \
           AND b.github_repository_id=$2 AND b.authorized_ref=$3 \
         ORDER BY b.id FOR UPDATE OF b",
    )
    .bind(installation_id)
    .bind(repository_id)
    .bind(reference)
    .fetch_all(&mut **transaction)
    .await?;
    if bindings.is_empty() {
        return Ok(DeliveryOutcome::Rejected("github_push_rejected"));
    }

    for binding in bindings {
        sqlx::query(
            "INSERT INTO github_source_revisions \
             (id,binding_id,account_id,project_id,repository_id,configuration_revision_id, \
              installation_id,github_repository_id,canonical_owner,canonical_name,repository_private, \
              authorized_ref,commit_sha,tree_sha,source,webhook_delivery_id) \
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NULL,'signed_push',$14)",
        )
        .bind(Uuid::new_v4())
        .bind(binding.0)
        .bind(binding.1)
        .bind(binding.2)
        .bind(binding.3)
        .bind(binding.4)
        .bind(binding.5)
        .bind(binding.6)
        .bind(&binding.7)
        .bind(&binding.8)
        .bind(binding.9)
        .bind(&binding.10)
        .bind(commit_sha)
        .bind(delivery_id)
        .execute(&mut **transaction)
        .await?;
        binding_audit(
            transaction,
            binding.1,
            binding.0,
            "github.webhook.push",
            "accepted",
        )
        .await?;
    }
    Ok(DeliveryOutcome::Accepted)
}

async fn process_installation(
    transaction: &mut Transaction<'_, Postgres>,
    delivery_uuid: Uuid,
    payload: &Value,
    action: Option<&str>,
) -> Result<DeliveryOutcome, WebhookError> {
    let installation_id = match required_id(payload, "/installation/id") {
        Ok(value) => value,
        Err(outcome) => return Ok(outcome),
    };
    lock_installation(transaction, installation_id)
        .await
        .map_err(|_| WebhookError::database())?;
    let Some(action @ ("deleted" | "suspend" | "unsuspend" | "new_permissions_accepted")) = action
    else {
        return Ok(DeliveryOutcome::Rejected("github_event_unsupported"));
    };
    let current: Option<String> = sqlx::query_scalar(
        "SELECT status FROM github_installations WHERE installation_id=$1 FOR UPDATE",
    )
    .bind(installation_id)
    .fetch_optional(&mut **transaction)
    .await?;
    let Some(current) = current else {
        return Ok(DeliveryOutcome::Rejected("github_installation_rejected"));
    };
    let installation_status = match (current.as_str(), action) {
        ("deleted", _) | (_, "deleted") => "deleted",
        (_, "suspend") => "suspended",
        ("suspended", "new_permissions_accepted") => "suspended",
        (_, "unsuspend" | "new_permissions_accepted") => "revalidation_required",
        _ => unreachable!(),
    };
    sqlx::query(
        "UPDATE github_installations SET status=$2,updated_at=transaction_timestamp() \
         WHERE installation_id=$1",
    )
    .bind(installation_id)
    .bind(installation_status)
    .execute(&mut **transaction)
    .await?;

    let binding_status = match action {
        "deleted" => "installation_deleted",
        "suspend" => "installation_suspended",
        "unsuspend" | "new_permissions_accepted" => "revalidation_required",
        _ => unreachable!(),
    };
    let affected: Vec<(Uuid, Uuid)> = if current == "deleted" || action == "deleted" {
        sqlx::query_as(
            "UPDATE github_repository_bindings SET status='installation_deleted',revision=revision+1, \
                    updated_at=transaction_timestamp() WHERE installation_id=$1 \
             RETURNING id,account_id",
        )
        .bind(installation_id)
        .fetch_all(&mut **transaction)
        .await?
    } else {
        sqlx::query_as(
            "UPDATE github_repository_bindings SET status=$2,revision=revision+1, \
                    updated_at=transaction_timestamp() \
             WHERE installation_id=$1 AND status IN ('active','installation_suspended','revalidation_required') \
               AND NOT ($3='new_permissions_accepted' AND status='installation_suspended') \
             RETURNING id,account_id",
        )
        .bind(installation_id)
        .bind(binding_status)
        .bind(action)
        .fetch_all(&mut **transaction)
        .await?
    };
    audit_bindings(
        transaction,
        &affected,
        "github.webhook.installation",
        action,
    )
    .await?;
    if affected.is_empty() {
        webhook_audit(transaction, None, delivery_uuid, action).await?;
    }
    Ok(DeliveryOutcome::Accepted)
}

async fn process_installation_repositories(
    transaction: &mut Transaction<'_, Postgres>,
    delivery_uuid: Uuid,
    payload: &Value,
    action: Option<&str>,
) -> Result<DeliveryOutcome, WebhookError> {
    let installation_id = match required_id(payload, "/installation/id") {
        Ok(value) => value,
        Err(outcome) => return Ok(outcome),
    };
    lock_installation(transaction, installation_id)
        .await
        .map_err(|_| WebhookError::database())?;
    let Some(action @ ("added" | "removed")) = action else {
        return Ok(DeliveryOutcome::Rejected("github_event_unsupported"));
    };
    let installation: Option<(String, String)> = sqlx::query_as(
        "SELECT status,repository_selection FROM github_installations \
         WHERE installation_id=$1 FOR UPDATE",
    )
    .bind(installation_id)
    .fetch_optional(&mut **transaction)
    .await?;
    let Some((status, previous_selection)) = installation else {
        return Ok(DeliveryOutcome::Rejected("github_installation_rejected"));
    };
    if status == "deleted" {
        return Ok(DeliveryOutcome::Rejected("github_installation_rejected"));
    }
    let selection = match payload.pointer("/installation/repository_selection") {
        None => None,
        Some(Value::String(value)) if matches!(value.as_str(), "all" | "selected") => {
            Some(value.as_str())
        }
        _ => return Ok(DeliveryOutcome::Rejected("github_payload_invalid")),
    };
    let ambiguous_selection = previous_selection == "all" && selection == Some("selected");
    let repository_ids = repository_ids(
        payload,
        if action == "removed" {
            "repositories_removed"
        } else {
            "repositories_added"
        },
    )?;
    let revalidate_all = ambiguous_selection || (action == "removed" && repository_ids.is_empty());

    sqlx::query(
        "UPDATE github_installations SET repository_selection=COALESCE($2,repository_selection), \
                status=CASE WHEN $3 AND status='active' THEN 'revalidation_required' ELSE status END, \
                updated_at=transaction_timestamp() WHERE installation_id=$1",
    )
    .bind(installation_id)
    .bind(selection)
    .bind(revalidate_all)
    .execute(&mut **transaction)
    .await?;

    let mut affected: Vec<(Uuid, Uuid)> = if action == "removed" && !repository_ids.is_empty() {
        sqlx::query_as(
            "UPDATE github_repository_bindings SET status='access_removed',revision=revision+1, \
                    updated_at=transaction_timestamp() \
             WHERE installation_id=$1 AND github_repository_id=ANY($2) \
               AND status IN ('active','installation_suspended','revalidation_required') \
             RETURNING id,account_id",
        )
        .bind(installation_id)
        .bind(&repository_ids)
        .fetch_all(&mut **transaction)
        .await?
    } else {
        Vec::new()
    };
    if revalidate_all {
        // An empty removal can accompany an all-to-selected transition. Deny every
        // remaining active binding until a user-scoped repository-list check.
        let revalidated: Vec<(Uuid, Uuid)> = sqlx::query_as(
            "UPDATE github_repository_bindings SET status='revalidation_required',revision=revision+1, \
                    updated_at=transaction_timestamp() \
             WHERE installation_id=$1 AND status='active' RETURNING id,account_id",
        )
        .bind(installation_id)
        .fetch_all(&mut **transaction)
        .await?;
        affected.extend(revalidated);
    }
    audit_bindings(
        transaction,
        &affected,
        "github.webhook.installation_repositories",
        action,
    )
    .await?;
    if affected.is_empty() {
        webhook_audit(transaction, None, delivery_uuid, action).await?;
    }
    Ok(DeliveryOutcome::Accepted)
}

fn repository_ids(payload: &Value, field: &str) -> Result<Vec<i64>, WebhookError> {
    let Some(value) = payload.get(field) else {
        return Err(WebhookError::bad_request(
            "github_payload_invalid",
            "the signed webhook payload is invalid",
        ));
    };
    let Some(repositories) = value.as_array() else {
        return Err(WebhookError::bad_request(
            "github_payload_invalid",
            "the signed webhook payload is invalid",
        ));
    };
    if repositories.len() > 10_000 {
        return Err(WebhookError::bad_request(
            "github_payload_invalid",
            "the signed webhook payload is invalid",
        ));
    }
    repositories
        .iter()
        .map(|repository| {
            positive_id(repository.get("id")).ok_or_else(|| {
                WebhookError::bad_request(
                    "github_payload_invalid",
                    "the signed webhook payload is invalid",
                )
            })
        })
        .collect()
}

async fn process_authorization(
    transaction: &mut Transaction<'_, Postgres>,
    payload: &Value,
    action: Option<&str>,
) -> Result<DeliveryOutcome, WebhookError> {
    if action != Some("revoked") {
        return Ok(DeliveryOutcome::Rejected("github_event_unsupported"));
    }
    let user_id = match required_id(payload, "/sender/id") {
        Ok(value) => value,
        Err(outcome) => return Ok(outcome),
    };
    let account_id: Option<Uuid> = sqlx::query_scalar(
        "UPDATE github_user_authorizations SET token_key_version=NULL,token_nonce=NULL, \
                token_ciphertext=NULL,token_auth_tag=NULL,token_expires_at=NULL,status='revoked', \
                revision=revision+1,updated_at=transaction_timestamp() \
         WHERE github_user_id=$1 RETURNING account_id",
    )
    .bind(user_id)
    .fetch_optional(&mut **transaction)
    .await?;
    let Some(account_id) = account_id else {
        return Ok(DeliveryOutcome::Rejected("github_authorization_rejected"));
    };
    let installation_ids: Vec<i64> = sqlx::query_scalar(
        "SELECT DISTINCT installation_id FROM github_repository_bindings \
         WHERE account_id=$1 ORDER BY installation_id",
    )
    .bind(account_id)
    .fetch_all(&mut **transaction)
    .await?;
    for installation_id in installation_ids {
        lock_installation(transaction, installation_id)
            .await
            .map_err(|_| WebhookError::database())?;
    }
    let affected: Vec<(Uuid, Uuid)> = sqlx::query_as(
        "UPDATE github_repository_bindings SET status='user_revalidation_required',revision=revision+1, \
                updated_at=transaction_timestamp() \
         WHERE account_id=$1 AND status IN ('active','revalidation_required','user_revalidation_required') \
         RETURNING id,account_id",
    )
    .bind(account_id)
    .fetch_all(&mut **transaction)
    .await?;
    audit_bindings(
        transaction,
        &affected,
        "github.webhook.authorization",
        "revoked",
    )
    .await?;
    sqlx::query(
        "INSERT INTO audit_events \
         (id,account_id,event_type,target_type,target_id,outcome) \
         VALUES ($1,$2,'github.webhook.authorization','github_authorization',$2,'revoked')",
    )
    .bind(Uuid::new_v4())
    .bind(account_id)
    .execute(&mut **transaction)
    .await?;
    Ok(DeliveryOutcome::Accepted)
}

async fn finish_delivery(
    transaction: &mut Transaction<'_, Postgres>,
    delivery_id: &str,
    disposition: &str,
    reason: &str,
) -> Result<(), WebhookError> {
    sqlx::query(
        "UPDATE github_webhook_deliveries SET disposition=$2,reason=$3 WHERE delivery_id=$1",
    )
    .bind(delivery_id)
    .bind(disposition)
    .bind(reason)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

async fn audit_bindings(
    transaction: &mut Transaction<'_, Postgres>,
    affected: &[(Uuid, Uuid)],
    event_type: &str,
    outcome: &str,
) -> Result<(), WebhookError> {
    for (binding_id, account_id) in affected {
        binding_audit(transaction, *account_id, *binding_id, event_type, outcome).await?;
    }
    Ok(())
}

async fn binding_audit(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    binding_id: Uuid,
    event_type: &str,
    outcome: &str,
) -> Result<(), WebhookError> {
    sqlx::query(
        "INSERT INTO audit_events \
         (id,account_id,event_type,target_type,target_id,outcome) \
         VALUES ($1,$2,$3,'github_binding',$4,$5)",
    )
    .bind(Uuid::new_v4())
    .bind(account_id)
    .bind(event_type)
    .bind(binding_id)
    .bind(outcome)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

async fn webhook_audit(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: Option<Uuid>,
    delivery_id: Uuid,
    outcome: &str,
) -> Result<(), WebhookError> {
    sqlx::query(
        "INSERT INTO audit_events \
         (id,account_id,event_type,target_type,target_id,outcome) \
         VALUES ($1,$2,'github.webhook.delivery','github_webhook_delivery',$3,$4)",
    )
    .bind(Uuid::new_v4())
    .bind(account_id)
    .bind(delivery_id)
    .bind(outcome)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}
