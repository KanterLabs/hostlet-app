use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Component, Path, PathBuf},
    thread,
    time::Duration,
};

use reqwest::{
    StatusCode, Url,
    blocking::{Client, Response},
    redirect::Policy,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::render;

const IDLE_DELAY: Duration = Duration::from_millis(500);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

pub fn run(args: &[String]) -> Result<(), &'static str> {
    if std::env::var("HOSTLET_M3_MODE").as_deref() != Ok("owned_fixture") {
        return Err("publisher_owned_fixture_mode_required");
    }
    let options = Options::parse(args)?;
    let state = private_state_dir()?;
    let root = state.join("publisher");
    ensure_dir(&root)?;
    ensure_dir(&root.join("staging"))?;
    let client = ControlClient::new(&options.control_url)?;
    loop {
        let Some(lease) = client.lease(&options.worker_id)? else {
            if options.once {
                return Ok(());
            }
            thread::sleep(IDLE_DELAY);
            continue;
        };
        if lease.approved_revision_id.is_nil()
            || lease.lease_expires_at <= chrono::Utc::now()
            || !safe_slug(&lease.slug)
        {
            return Err("invalid_publisher_lease");
        }
        let expected = format!("staging/{}/{}", lease.publication_id, lease.attempt_id);
        if lease.staging_relative_path != expected {
            return Err("invalid_staging_contract");
        }
        let relative = safe_relative(&lease.staging_relative_path)?;
        let staging = root.join(relative);
        let outcome = match render::render(
            lease.document.clone(),
            lease.publication_id,
            &lease.document_digest,
            &staging,
        ) {
            Ok(artifact_digest) => Outcome::Succeeded { artifact_digest },
            Err(code) => {
                let code = if cleanup_owned_staging(&root, lease.publication_id, lease.attempt_id)
                    .is_err()
                {
                    "staging_cleanup_failed"
                } else {
                    code
                };
                Outcome::Failed {
                    code: code.to_owned(),
                }
            }
        };
        let event = match client.complete(&options.worker_id, &lease, outcome) {
            Ok(event) => event,
            Err(error) => {
                // Control may reject a stale completion after rendering has
                // finished. The exact lease-owned path is safe to remove here;
                // control owns immutable artifacts and any accepted promotion.
                let _ = cleanup_owned_staging(&root, lease.publication_id, lease.attempt_id);
                return Err(error);
            }
        };
        println!(
            "{}",
            serde_json::to_string(&event).map_err(|_| "publisher_output_failed")?
        );
        if options.once {
            return Ok(());
        }
    }
}

struct Options {
    control_url: String,
    worker_id: String,
    once: bool,
}

impl Options {
    fn parse(args: &[String]) -> Result<Self, &'static str> {
        let mut control_url = None;
        let mut worker_id = None;
        let mut once = false;
        let mut index = 0;
        while index < args.len() {
            match args[index].as_str() {
                "--control-url" if control_url.is_none() => {
                    index += 1;
                    control_url = args.get(index).cloned();
                }
                "--worker-id" if worker_id.is_none() => {
                    index += 1;
                    worker_id = args.get(index).cloned();
                }
                "--once" if !once => once = true,
                _ => return Err("publisher_worker_arguments_invalid"),
            }
            index += 1;
        }
        let control_url = control_url.ok_or("publisher_control_url_required")?;
        validate_control_url(&control_url)?;
        let worker_id = worker_id.ok_or("publisher_worker_id_required")?;
        if worker_id.is_empty()
            || worker_id.len() > 128
            || !worker_id.bytes().all(|byte| byte.is_ascii_graphic())
        {
            return Err("publisher_worker_id_invalid");
        }
        Ok(Self {
            control_url,
            worker_id,
            once,
        })
    }
}

struct ControlClient {
    client: Client,
    base: String,
    token: Zeroizing<String>,
}

impl ControlClient {
    fn new(base: &str) -> Result<Self, &'static str> {
        let token =
            std::env::var("HOSTLET_M3_PUBLISHER_TOKEN").map_err(|_| "publisher_token_required")?;
        if !(32..=256).contains(&token.len())
            || token
                .bytes()
                .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
        {
            return Err("publisher_token_invalid");
        }
        let client = Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(2))
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|_| "publisher_client_invalid")?;
        Ok(Self {
            client,
            base: base.trim_end_matches('/').to_owned(),
            token: Zeroizing::new(token),
        })
    }

    fn lease(&self, worker_id: &str) -> Result<Option<Lease>, &'static str> {
        let response = self
            .client
            .post(format!(
                "{}/internal/v1/portfolio-publications/lease",
                self.base
            ))
            .bearer_auth(self.token.as_str())
            .json(&json!({"worker_id":worker_id}))
            .send()
            .map_err(|_| "publisher_control_unavailable")?;
        match response.status() {
            StatusCode::NO_CONTENT => Ok(None),
            StatusCode::OK => read_json(response).map(Some),
            _ => Err("publisher_lease_rejected"),
        }
    }

    fn complete(
        &self,
        worker_id: &str,
        lease: &Lease,
        outcome: Outcome,
    ) -> Result<Value, &'static str> {
        let response = self
            .client
            .post(format!(
                "{}/internal/v1/portfolio-publications/{}/complete",
                self.base, lease.publication_id
            ))
            .bearer_auth(self.token.as_str())
            .json(&CompleteRequest {
                worker_id,
                attempt_id: lease.attempt_id,
                fence: lease.fence,
                outcome,
            })
            .send()
            .map_err(|_| "publisher_control_unavailable")?;
        match response.status() {
            StatusCode::OK => read_json(response),
            StatusCode::CONFLICT => Err("publisher_attempt_fenced"),
            _ => Err("publisher_completion_rejected"),
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Lease {
    publication_id: Uuid,
    approved_revision_id: Uuid,
    slug: String,
    document: Value,
    document_digest: String,
    staging_relative_path: String,
    attempt_id: Uuid,
    fence: i64,
    lease_expires_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Serialize)]
struct CompleteRequest<'a> {
    worker_id: &'a str,
    attempt_id: Uuid,
    fence: i64,
    outcome: Outcome,
}

#[derive(Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
enum Outcome {
    Succeeded { artifact_digest: String },
    Failed { code: String },
}

fn read_json<T: DeserializeOwned>(response: Response) -> Result<T, &'static str> {
    if response
        .content_length()
        .is_some_and(|length| length > 2 * 1024 * 1024)
    {
        return Err("publisher_response_too_large");
    }
    response.json().map_err(|_| "publisher_response_invalid")
}

fn validate_control_url(value: &str) -> Result<(), &'static str> {
    let url = Url::parse(value).map_err(|_| "publisher_control_url_invalid")?;
    if url.scheme() != "http"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
        || !matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "::1"))
    {
        return Err("publisher_control_url_invalid");
    }
    Ok(())
}

fn private_state_dir() -> Result<PathBuf, &'static str> {
    let path = PathBuf::from(
        std::env::var_os("HOSTLET_M3_STATE_DIR").ok_or("publisher_state_dir_required")?,
    );
    let metadata = fs::symlink_metadata(&path).map_err(|_| "publisher_state_dir_invalid")?;
    if !path.is_absolute()
        || !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.permissions().mode() & 0o077 != 0
        || fs::canonicalize(&path).ok().as_ref() != Some(&path)
    {
        return Err("publisher_state_dir_invalid");
    }
    Ok(path)
}

fn ensure_dir(path: &Path) -> Result<(), &'static str> {
    if !path.exists() {
        fs::create_dir(path).map_err(|_| "publisher_storage_invalid")?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| "publisher_storage_invalid")?;
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| "publisher_storage_invalid")?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.permissions().mode() & 0o077 != 0
    {
        return Err("publisher_storage_invalid");
    }
    Ok(())
}

fn cleanup_owned_staging(
    root: &Path,
    publication_id: Uuid,
    attempt_id: Uuid,
) -> Result<(), &'static str> {
    let staging_root = root.join("staging");
    let staging_metadata =
        fs::symlink_metadata(&staging_root).map_err(|_| "publisher_staging_cleanup_failed")?;
    if !staging_metadata.is_dir() || staging_metadata.file_type().is_symlink() {
        return Err("publisher_staging_cleanup_failed");
    }
    if fs::canonicalize(&staging_root).ok().as_deref() != Some(staging_root.as_path()) {
        return Err("publisher_staging_cleanup_failed");
    }

    let publication = staging_root.join(publication_id.to_string());
    match fs::symlink_metadata(&publication) {
        Ok(metadata) => {
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err("publisher_staging_cleanup_failed");
            }
            if fs::canonicalize(&publication).ok().as_deref() != Some(publication.as_path()) {
                return Err("publisher_staging_cleanup_failed");
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("publisher_staging_cleanup_failed"),
    }

    let staging = publication.join(attempt_id.to_string());
    let metadata = match fs::symlink_metadata(&staging) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("publisher_staging_cleanup_failed"),
    };
    if metadata.file_type().is_symlink() {
        fs::remove_file(&staging).map_err(|_| "publisher_staging_cleanup_failed")?;
    } else if metadata.is_dir() {
        if fs::canonicalize(&staging).ok().as_deref() != Some(staging.as_path()) {
            return Err("publisher_staging_cleanup_failed");
        }
        fs::remove_dir_all(&staging).map_err(|_| "publisher_staging_cleanup_failed")?;
    } else {
        fs::remove_file(&staging).map_err(|_| "publisher_staging_cleanup_failed")?;
    }
    Ok(())
}

fn safe_relative(value: &str) -> Result<&Path, &'static str> {
    if value.is_empty() || value.contains('\\') || !value.is_ascii() {
        return Err("invalid_staging_contract");
    }
    let path = Path::new(value);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("invalid_staging_contract");
    }
    Ok(path)
}

fn safe_slug(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 63
        && !value.starts_with('-')
        && !value.ends_with('-')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}
