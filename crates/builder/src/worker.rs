use std::{
    collections::HashSet,
    io::{Read, Write},
    net::IpAddr,
    thread,
    time::Duration,
};

use reqwest::{
    StatusCode, Url,
    blocking::{Client, Response},
    redirect::Policy,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use zeroize::{Zeroize, Zeroizing};

pub(crate) const USAGE: &str = "usage: hostlet-builder worker --control-url http://LOOPBACK:PORT --worker-id ID [--once] [--hold-after-claim-ms N]";

const JOB_KIND: &str = "foundation_bookkeeping";
const JOB_OPERATION: &str = "build";
const MAX_SECRET_REFS: usize = 32;
const MAX_RESPONSE_BYTES: u64 = 1024 * 1024;
const MAX_HOLD_AFTER_CLAIM_MS: u64 = 60_000;
const IDLE_POLL_DELAY: Duration = Duration::from_millis(500);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerOptions {
    control_url: String,
    worker_id: String,
    once: bool,
    hold_after_claim: Duration,
}

pub(crate) fn parse_options(args: &[String]) -> Result<WorkerOptions, ()> {
    let mut control_url = None;
    let mut worker_id = None;
    let mut once = false;
    let mut hold_after_claim_ms = None;
    let mut index = 0;

    while index < args.len() {
        match args[index].as_str() {
            "--control-url" if control_url.is_none() => {
                index += 1;
                control_url = args.get(index).cloned();
                if control_url.is_none() {
                    return Err(());
                }
            }
            "--worker-id" if worker_id.is_none() => {
                index += 1;
                worker_id = args.get(index).cloned();
                if worker_id.is_none() {
                    return Err(());
                }
            }
            "--once" if !once => once = true,
            "--hold-after-claim-ms" if hold_after_claim_ms.is_none() => {
                index += 1;
                let value = args.get(index).ok_or(())?;
                let value = value.parse::<u64>().map_err(|_| ())?;
                if value > MAX_HOLD_AFTER_CLAIM_MS {
                    return Err(());
                }
                hold_after_claim_ms = Some(value);
            }
            _ => return Err(()),
        }
        index += 1;
    }

    let control_url = control_url.ok_or(())?;
    validate_control_url(&control_url)?;
    let worker_id = worker_id.ok_or(())?;
    if !valid_worker_id(&worker_id) {
        return Err(());
    }

    Ok(WorkerOptions {
        control_url,
        worker_id,
        once,
        hold_after_claim: Duration::from_millis(hold_after_claim_ms.unwrap_or(0)),
    })
}

fn validate_control_url(value: &str) -> Result<(), ()> {
    let authority = value.strip_prefix("http://").ok_or(())?;
    if authority.is_empty()
        || authority
            .bytes()
            .any(|byte| matches!(byte, b'/' | b'?' | b'#'))
    {
        return Err(());
    }
    let (host, port) = if let Some(bracketed) = authority.strip_prefix('[') {
        bracketed.rsplit_once("]:")
    } else {
        authority.rsplit_once(':')
    }
    .ok_or(())?;
    let port = port.parse::<u16>().map_err(|_| ())?;
    if port == 0 {
        return Err(());
    }
    let url = Url::parse(value).map_err(|_| ())?;
    if url.scheme() != "http"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err(());
    }
    let address = host.parse::<IpAddr>().map_err(|_| ())?;
    if !address.is_loopback() {
        return Err(());
    }
    Ok(())
}

fn valid_worker_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && value.bytes().all(|byte| byte.is_ascii_graphic())
}

pub(crate) fn run<W: Write>(options: WorkerOptions, output: &mut W) -> Result<(), WorkerFailure> {
    let token = WorkerToken::from_environment()?;
    let client = ControlClient::new(&options.control_url, token)?;

    loop {
        match client.lease(&options.worker_id)? {
            Some(lease) => process_claim(&client, &options, lease, output)?,
            None if options.once => return Ok(()),
            None => thread::sleep(IDLE_POLL_DELAY),
        }
        if options.once {
            return Ok(());
        }
    }
}

fn process_claim<W: Write>(
    client: &ControlClient,
    options: &WorkerOptions,
    lease: LeaseResponse,
    output: &mut W,
) -> Result<(), WorkerFailure> {
    let identity = ClaimIdentity::from_lease(&lease)?;

    if write_claim_log(output, &identity).is_err() {
        return finish_failed(
            client,
            &options.worker_id,
            &identity,
            WorkerFailure::Processing,
        );
    }

    if !options.hold_after_claim.is_zero() {
        thread::sleep(options.hold_after_claim);
    }

    if let Err(failure) = validate_claim(&lease, &identity, &options.worker_id) {
        return finish_failed(client, &options.worker_id, &identity, failure);
    }

    if !lease.job.secret_version_refs.is_empty() {
        let secret_version_ids: Vec<&str> = lease
            .job
            .secret_version_refs
            .iter()
            .map(|reference| reference.secret_version_id.as_str())
            .collect();
        let credentials =
            match client.resolve_credentials(&identity, &options.worker_id, &secret_version_ids) {
                Ok(credentials) => credentials,
                Err(WorkerFailure::Fenced) => return Err(WorkerFailure::Fenced),
                Err(failure) => {
                    return finish_failed(client, &options.worker_id, &identity, failure);
                }
            };
        if validate_credentials(&credentials, &secret_version_ids).is_err() {
            return finish_failed(
                client,
                &options.worker_id,
                &identity,
                WorkerFailure::Credential,
            );
        }
    }

    client.complete(
        &identity,
        &options.worker_id,
        CompletionOutcome {
            state: "succeeded",
            code: "bookkeeping_complete",
        },
    )
}

fn write_claim_log<W: Write>(output: &mut W, identity: &ClaimIdentity) -> Result<(), ()> {
    serde_json::to_writer(
        &mut *output,
        &ClaimLog {
            event: "job_claimed",
            job_id: &identity.job_id,
            attempt_id: &identity.attempt_id,
            fence: identity.fence,
        },
    )
    .map_err(|_| ())?;
    writeln!(output).map_err(|_| ())?;
    output.flush().map_err(|_| ())
}

fn finish_failed(
    client: &ControlClient,
    worker_id: &str,
    identity: &ClaimIdentity,
    original_failure: WorkerFailure,
) -> Result<(), WorkerFailure> {
    match client.complete(
        identity,
        worker_id,
        CompletionOutcome {
            state: "failed",
            code: "bookkeeping_failed",
        },
    ) {
        Err(WorkerFailure::Fenced) => Err(WorkerFailure::Fenced),
        _ => Err(original_failure),
    }
}

fn validate_claim(
    lease: &LeaseResponse,
    identity: &ClaimIdentity,
    expected_worker_id: &str,
) -> Result<(), WorkerFailure> {
    if lease.job.kind != JOB_KIND
        || lease.job.operation != JOB_OPERATION
        || lease.attempt.worker_id != expected_worker_id
        || !valid_uuid(&lease.job.id)
        || !valid_uuid(&lease.attempt.id)
        || lease.attempt.fence == 0
        || lease.attempt.fence > i64::MAX as u64
        || !valid_source_commit(&lease.job.source_commit)
        || !valid_uuid(&lease.job.service_id)
        || lease.job.secret_version_refs.len() > MAX_SECRET_REFS
    {
        return Err(WorkerFailure::Processing);
    }

    let mut version_ids = HashSet::new();
    for reference in &lease.job.secret_version_refs {
        if reference.service_id != lease.job.service_id
            || !valid_uuid(&reference.service_id)
            || !valid_uuid(&reference.secret_version_id)
            || !version_ids.insert(reference.secret_version_id.as_str())
        {
            return Err(WorkerFailure::Credential);
        }
    }
    if identity.job_id != lease.job.id || identity.attempt_id != lease.attempt.id {
        return Err(WorkerFailure::Processing);
    }
    Ok(())
}

fn validate_credentials(
    response: &ResolveCredentialsResponse,
    expected_ids: &[&str],
) -> Result<(), ()> {
    if response.credentials.len() != expected_ids.len() {
        return Err(());
    }
    let expected: HashSet<&str> = expected_ids.iter().copied().collect();
    let mut observed = HashSet::new();
    for credential in &response.credentials {
        if !valid_uuid(&credential.secret_version_id)
            || credential.name.is_empty()
            || credential.name.len() > 128
            || !(1..=16 * 1024).contains(&credential.value.byte_len())
            || !expected.contains(credential.secret_version_id.as_str())
            || !observed.insert(credential.secret_version_id.as_str())
        {
            return Err(());
        }
    }
    Ok(())
}

fn valid_source_commit(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

pub(crate) enum WorkerFailure {
    Configuration,
    Request,
    Response,
    Fenced,
    Processing,
    Credential,
}

impl WorkerFailure {
    pub(crate) fn safe_message(&self) -> &'static str {
        match self {
            Self::Configuration => "worker configuration is invalid",
            Self::Request => "worker control request failed",
            Self::Response => "worker control response was invalid",
            Self::Fenced => "worker lease is no longer valid",
            Self::Processing => "foundation bookkeeping failed",
            Self::Credential => "foundation credential resolution failed",
        }
    }

    pub(crate) fn exit_code(&self) -> i32 {
        match self {
            Self::Configuration => 2,
            _ => 1,
        }
    }
}

struct WorkerToken(String);

impl WorkerToken {
    fn from_environment() -> Result<Self, WorkerFailure> {
        let value =
            std::env::var("HOSTLET_WORKER_TOKEN").map_err(|_| WorkerFailure::Configuration)?;
        if !(32..=256).contains(&value.len())
            || value
                .chars()
                .any(|character| character.is_whitespace() || character.is_control())
        {
            return Err(WorkerFailure::Configuration);
        }
        Ok(Self(value))
    }
}

impl Drop for WorkerToken {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

struct ControlClient {
    client: Client,
    base_url: String,
    token: WorkerToken,
}

impl ControlClient {
    fn new(base_url: &str, token: WorkerToken) -> Result<Self, WorkerFailure> {
        let client = Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|_| WorkerFailure::Configuration)?;
        Ok(Self {
            client,
            base_url: base_url.to_owned(),
            token,
        })
    }

    fn lease(&self, worker_id: &str) -> Result<Option<LeaseResponse>, WorkerFailure> {
        let response = self
            .post("/internal/v1/jobs/lease")
            .json(&LeaseRequest {
                worker_id,
                kinds: [JOB_KIND],
            })
            .send()
            .map_err(|_| WorkerFailure::Request)?;
        match response.status() {
            StatusCode::NO_CONTENT => Ok(None),
            StatusCode::OK => read_json(response).map(Some),
            StatusCode::CONFLICT => Err(WorkerFailure::Fenced),
            _ => Err(WorkerFailure::Response),
        }
    }

    fn resolve_credentials(
        &self,
        identity: &ClaimIdentity,
        worker_id: &str,
        secret_version_ids: &[&str],
    ) -> Result<ResolveCredentialsResponse, WorkerFailure> {
        let path = format!("/internal/v1/jobs/{}/credentials:resolve", identity.job_id);
        let response = self
            .post(&path)
            .json(&ResolveCredentialsRequest {
                worker_id,
                attempt_id: &identity.attempt_id,
                fence: identity.fence,
                secret_version_ids,
            })
            .send()
            .map_err(|_| WorkerFailure::Request)?;
        match response.status() {
            StatusCode::OK => read_json(response),
            StatusCode::CONFLICT => Err(WorkerFailure::Fenced),
            _ => Err(WorkerFailure::Credential),
        }
    }

    fn complete(
        &self,
        identity: &ClaimIdentity,
        worker_id: &str,
        outcome: CompletionOutcome,
    ) -> Result<(), WorkerFailure> {
        let path = format!("/internal/v1/jobs/{}/complete", identity.job_id);
        let expected_state = outcome.state;
        let response = self
            .post(&path)
            .json(&CompleteRequest {
                worker_id,
                attempt_id: &identity.attempt_id,
                fence: identity.fence,
                outcome,
            })
            .send()
            .map_err(|_| WorkerFailure::Request)?;
        match response.status() {
            StatusCode::OK => {
                let completed: CompleteResponse = read_json(response)?;
                if completed.job.id == identity.job_id && completed.job.state == expected_state {
                    Ok(())
                } else {
                    Err(WorkerFailure::Response)
                }
            }
            StatusCode::CONFLICT => Err(WorkerFailure::Fenced),
            _ => Err(WorkerFailure::Response),
        }
    }

    fn post(&self, path: &str) -> reqwest::blocking::RequestBuilder {
        self.client
            .post(format!("{}{}", self.base_url, path))
            .bearer_auth(&self.token.0)
    }
}

fn read_json<T: DeserializeOwned>(mut response: Response) -> Result<T, WorkerFailure> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES)
    {
        return Err(WorkerFailure::Response);
    }
    let mut bytes = Zeroizing::new(Vec::new());
    response
        .by_ref()
        .take(MAX_RESPONSE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| WorkerFailure::Response)?;
    if bytes.len() as u64 > MAX_RESPONSE_BYTES {
        return Err(WorkerFailure::Response);
    }
    serde_json::from_slice(&bytes).map_err(|_| WorkerFailure::Response)
}

#[derive(Serialize)]
struct LeaseRequest<'a> {
    worker_id: &'a str,
    kinds: [&'static str; 1],
}

#[derive(Deserialize)]
struct LeaseResponse {
    job: LeasedJob,
    attempt: AttemptLease,
}

#[derive(Deserialize)]
struct LeasedJob {
    id: String,
    service_id: String,
    kind: String,
    operation: String,
    source_commit: String,
    secret_version_refs: Vec<SecretVersionReference>,
}

#[derive(Deserialize)]
struct SecretVersionReference {
    service_id: String,
    secret_version_id: String,
}

#[derive(Deserialize)]
struct AttemptLease {
    id: String,
    fence: u64,
    worker_id: String,
}

struct ClaimIdentity {
    job_id: String,
    attempt_id: String,
    fence: u64,
}

impl ClaimIdentity {
    fn from_lease(lease: &LeaseResponse) -> Result<Self, WorkerFailure> {
        if !valid_uuid(&lease.job.id)
            || !valid_uuid(&lease.attempt.id)
            || lease.attempt.fence == 0
            || lease.attempt.fence > i64::MAX as u64
        {
            return Err(WorkerFailure::Response);
        }
        Ok(Self {
            job_id: lease.job.id.clone(),
            attempt_id: lease.attempt.id.clone(),
            fence: lease.attempt.fence,
        })
    }
}

#[derive(Serialize)]
struct ClaimLog<'a> {
    event: &'static str,
    job_id: &'a str,
    attempt_id: &'a str,
    fence: u64,
}

#[derive(Serialize)]
struct ResolveCredentialsRequest<'a> {
    worker_id: &'a str,
    attempt_id: &'a str,
    fence: u64,
    secret_version_ids: &'a [&'a str],
}

#[derive(Deserialize)]
struct ResolveCredentialsResponse {
    credentials: Vec<ResolvedCredential>,
}

#[derive(Deserialize)]
struct ResolvedCredential {
    secret_version_id: String,
    name: String,
    value: CredentialValue,
}

#[derive(Deserialize)]
#[serde(transparent)]
struct CredentialValue(String);

impl CredentialValue {
    fn byte_len(&self) -> usize {
        self.0.len()
    }
}

impl Drop for CredentialValue {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

#[derive(Serialize)]
struct CompleteRequest<'a> {
    worker_id: &'a str,
    attempt_id: &'a str,
    fence: u64,
    outcome: CompletionOutcome,
}

#[derive(Clone, Copy, Serialize)]
struct CompletionOutcome {
    state: &'static str,
    code: &'static str,
}

#[derive(Deserialize)]
struct CompleteResponse {
    job: CompletedJob,
}

#[derive(Deserialize)]
struct CompletedJob {
    id: String,
    state: String,
}
