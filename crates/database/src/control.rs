use std::{collections::HashSet, io::Read, sync::Arc, time::Duration};

use chrono::{DateTime, Utc};
use reqwest::{
    StatusCode, Url,
    blocking::{Client, RequestBuilder, Response},
    redirect::Policy,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use uuid::Uuid;
use zeroize::Zeroize;

use crate::worker::Failure;

const MAX_RESPONSE_BYTES: u64 = 2 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone)]
pub struct ControlClient {
    client: Client,
    base_url: String,
    token: Arc<Token>,
}

struct Token(String);

impl Drop for Token {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl ControlClient {
    pub fn from_environment(base_url: &str) -> Result<Self, Failure> {
        validate_control_url(base_url)?;
        let token =
            std::env::var("HOSTLET_M3_DATABASE_TOKEN").map_err(|_| Failure::Configuration)?;
        if !(32..=256).contains(&token.len())
            || token
                .chars()
                .any(|character| character.is_whitespace() || character.is_control())
        {
            return Err(Failure::Configuration);
        }
        let client = Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|_| Failure::Configuration)?;
        Ok(Self {
            client,
            base_url: base_url.to_owned(),
            token: Arc::new(Token(token)),
        })
    }

    pub fn clock(&self) -> Result<PolicyTime, Failure> {
        let response = self
            .get("/internal/v1/m3/policy-clock")
            .send()
            .map_err(|_| Failure::Request)?;
        expect_json(response, StatusCode::OK)
    }

    pub fn scheduler_tick(&self) -> Result<SchedulerResult, Failure> {
        let response = self
            .post("/internal/v1/tenant-database-scheduler/tick")
            .json(&serde_json::json!({}))
            .send()
            .map_err(|_| Failure::Request)?;
        expect_json(response, StatusCode::OK)
    }

    pub fn lease(&self, worker_id: &str, kinds: &[String]) -> Result<Option<Lease>, Failure> {
        let response = self
            .post("/internal/v1/tenant-database-operations/lease")
            .json(&LeaseRequest { worker_id, kinds })
            .send()
            .map_err(|_| Failure::Request)?;
        match response.status() {
            StatusCode::NO_CONTENT => Ok(None),
            StatusCode::OK => read_json(response).map(Some),
            StatusCode::CONFLICT => Err(Failure::Fenced),
            _ => Err(Failure::Response),
        }
    }

    pub fn credentials(
        &self,
        identity: &Identity,
        worker_id: &str,
        ids: &[Uuid],
        database_id: Uuid,
    ) -> Result<Vec<Credential>, Failure> {
        let path = format!(
            "/internal/v1/tenant-database-operations/{}/credentials:resolve",
            identity.operation_id
        );
        let response = self
            .post(&path)
            .json(&CredentialRequest {
                worker_id,
                attempt_id: identity.attempt_id,
                fence: identity.fence,
                credential_ids: ids,
            })
            .send()
            .map_err(|_| Failure::Request)?;
        let mut payload: CredentialResponse = match response.status() {
            StatusCode::OK => read_json(response)?,
            StatusCode::CONFLICT => return Err(Failure::Fenced),
            _ => return Err(Failure::Response),
        };
        let expected: HashSet<Uuid> = ids.iter().copied().collect();
        let observed: HashSet<Uuid> = payload.credentials.iter().map(|item| item.id).collect();
        if observed != expected || payload.credentials.len() != ids.len() {
            return Err(Failure::Credential);
        }
        for credential in &mut payload.credentials {
            let envelope: CredentialEnvelope =
                serde_json::from_str(&credential.value.0).map_err(|_| Failure::Credential)?;
            if envelope.database_ref != database_id
                || envelope.role_ref != credential.role_ref
                || envelope.password.is_empty()
                || envelope.password.len() > 4096
                || envelope
                    .password
                    .chars()
                    .any(|item| matches!(item, '\n' | '\r' | '\0'))
            {
                return Err(Failure::Credential);
            }
            credential.value = envelope.password;
        }
        Ok(payload.credentials)
    }

    pub fn renew(&self, identity: &Identity, worker_id: &str) -> Result<(), Failure> {
        let path = format!(
            "/internal/v1/tenant-database-operations/{}/renew",
            identity.operation_id
        );
        let response = self
            .post(&path)
            .json(&LeaseIdentityRequest {
                worker_id,
                attempt_id: identity.attempt_id,
                fence: identity.fence,
            })
            .send()
            .map_err(|_| Failure::Request)?;
        let renewed: RenewResponse = match response.status() {
            StatusCode::OK => read_json(response)?,
            StatusCode::CONFLICT => return Err(Failure::Fenced),
            _ => return Err(Failure::Response),
        };
        if renewed.operation_id != identity.operation_id
            || renewed.attempt_id != identity.attempt_id
            || renewed.fence != identity.fence as u64
            || renewed.lease_expires_at <= Utc::now()
        {
            return Err(Failure::Response);
        }
        Ok(())
    }

    pub fn complete(
        &self,
        identity: &Identity,
        worker_id: &str,
        outcome: CompletionOutcome,
    ) -> Result<CompletionResponse, Failure> {
        let path = format!(
            "/internal/v1/tenant-database-operations/{}/complete",
            identity.operation_id
        );
        let response = self
            .post(&path)
            .json(&CompletionRequest {
                worker_id,
                attempt_id: identity.attempt_id,
                fence: identity.fence,
                outcome,
            })
            .send()
            .map_err(|_| Failure::Request)?;
        match response.status() {
            StatusCode::OK => read_json(response),
            StatusCode::CONFLICT => Err(Failure::Fenced),
            _ => Err(Failure::Response),
        }
    }

    fn get(&self, path: &str) -> RequestBuilder {
        self.client
            .get(format!("{}{path}", self.base_url))
            .bearer_auth(&self.token.0)
    }
    fn post(&self, path: &str) -> RequestBuilder {
        self.client
            .post(format!("{}{path}", self.base_url))
            .bearer_auth(&self.token.0)
    }
}

fn validate_control_url(value: &str) -> Result<(), Failure> {
    let url = Url::parse(value).map_err(|_| Failure::Configuration)?;
    let host = url.host_str().ok_or(Failure::Configuration)?;
    if url.scheme() != "http"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
        || url.port().is_none()
        || !host
            .parse::<std::net::IpAddr>()
            .map_err(|_| Failure::Configuration)?
            .is_loopback()
    {
        return Err(Failure::Configuration);
    }
    Ok(())
}

fn expect_json<T: DeserializeOwned>(
    response: Response,
    expected: StatusCode,
) -> Result<T, Failure> {
    if response.status() != expected {
        return Err(Failure::Response);
    }
    read_json(response)
}

fn read_json<T: DeserializeOwned>(response: Response) -> Result<T, Failure> {
    let mut bytes = Vec::new();
    response
        .take(MAX_RESPONSE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Failure::Response)?;
    if bytes.len() as u64 > MAX_RESPONSE_BYTES {
        return Err(Failure::Response);
    }
    serde_json::from_slice(&bytes).map_err(|_| Failure::Response)
}

pub const OPERATION_KINDS: [&str; 9] = [
    "provision",
    "backup_daily",
    "backup_pre_migration",
    "export",
    "restore_drill",
    "observe_storage",
    "migration_trial",
    "migration_live_apply",
    "archive_expire",
];

#[derive(Serialize)]
struct LeaseRequest<'a> {
    worker_id: &'a str,
    kinds: &'a [String],
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Lease {
    pub operation: Operation,
    pub attempt: Attempt,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Operation {
    pub id: Uuid,
    pub account_id: Uuid,
    pub project_id: Uuid,
    pub tenant_database_id: Uuid,
    pub database_generation: Uuid,
    pub kind: String,
    pub state: String,
    pub spec: Value,
    pub credential_ids: Vec<Uuid>,
    pub attempt_count: u32,
    pub current_attempt_id: Option<Uuid>,
    pub current_fence: u64,
    pub lease_expires_at: Option<DateTime<Utc>>,
    pub policy_time: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Attempt {
    pub id: Uuid,
    pub attempt_number: u32,
    pub fence: u64,
    pub worker_id: String,
    pub lease_expires_at: DateTime<Utc>,
}

#[derive(Clone, Copy)]
pub struct Identity {
    pub operation_id: Uuid,
    pub attempt_id: Uuid,
    pub fence: i64,
}

impl Identity {
    pub fn from_lease(lease: &Lease, expected_worker: &str) -> Result<Self, Failure> {
        if lease.attempt.worker_id != expected_worker
            || lease.attempt.attempt_number < 1
            || lease.attempt.fence < 1
            || lease.attempt.fence > i64::MAX as u64
            || lease.attempt.lease_expires_at <= Utc::now()
            || !OPERATION_KINDS.contains(&lease.operation.kind.as_str())
            || lease.operation.credential_ids.len() > 4
            || lease.operation.state != "running"
            || lease.operation.attempt_count != lease.attempt.attempt_number
            || lease.operation.current_attempt_id != Some(lease.attempt.id)
            || lease.operation.current_fence != lease.attempt.fence
            || lease.operation.lease_expires_at != Some(lease.attempt.lease_expires_at)
            || lease.operation.created_at > lease.operation.updated_at
            || lease.operation.account_id.is_nil()
            || lease.operation.project_id.is_nil()
            || lease.operation.tenant_database_id.is_nil()
            || lease.operation.database_generation.is_nil()
        {
            return Err(Failure::Processing("invalid_operation"));
        }
        Ok(Self {
            operation_id: lease.operation.id,
            attempt_id: lease.attempt.id,
            fence: lease.attempt.fence as i64,
        })
    }
}

#[derive(Serialize)]
struct CredentialRequest<'a> {
    worker_id: &'a str,
    attempt_id: Uuid,
    fence: i64,
    credential_ids: &'a [Uuid],
}

#[derive(Serialize)]
struct LeaseIdentityRequest<'a> {
    worker_id: &'a str,
    attempt_id: Uuid,
    fence: i64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RenewResponse {
    operation_id: Uuid,
    attempt_id: Uuid,
    fence: u64,
    lease_expires_at: DateTime<Utc>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CredentialResponse {
    credentials: Vec<Credential>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Credential {
    pub id: Uuid,
    pub purpose: String,
    pub role_ref: Uuid,
    pub value: Secret,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CredentialEnvelope {
    database_ref: Uuid,
    role_ref: Uuid,
    password: Secret,
}

#[derive(Deserialize)]
#[serde(transparent)]
pub struct Secret(String);

impl std::ops::Deref for Secret {
    type Target = str;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("[REDACTED]")
    }
}

impl Drop for Secret {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

#[derive(Serialize)]
struct CompletionRequest<'a> {
    worker_id: &'a str,
    attempt_id: Uuid,
    fence: i64,
    outcome: CompletionOutcome,
}

#[derive(Serialize)]
pub struct CompletionOutcome {
    pub state: &'static str,
    pub code: &'static str,
    pub proof: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompletionResponse {
    pub operation: Value,
    pub effect: CompletionEffect,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompletionEffect {
    pub id: Uuid,
    pub kind: String,
    pub created: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PolicyTime {
    pub schema_version: u32,
    pub generation: i64,
    pub now: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SchedulerResult {
    pub policy_time: DateTime<Utc>,
    pub daily_enqueued: u64,
    pub storage_observations_enqueued: u64,
    pub drills_enqueued: u64,
    pub expired_archives: u64,
}
