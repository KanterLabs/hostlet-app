use std::{
    collections::HashSet,
    future::Future,
    net::IpAddr,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use chrono::{DateTime, TimeDelta, Utc};
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use url::Url;
use zeroize::{Zeroize, Zeroizing};

use crate::error::ApiError;

const API_VERSION: &str = "2026-03-10";
const REAL_WEB_ORIGIN: &str = "https://github.com";
const REAL_API_ORIGIN: &str = "https://api.github.com";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const OPERATION_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_JSON_RESPONSE: usize = 2 * 1024 * 1024;
const MAX_PAGES: usize = 5;
const PAGE_SIZE: usize = 100;
const MAX_TREE_ENTRIES: usize = 2_000;
const MAX_SOURCE_FILES: usize = 40;
const MAX_SOURCE_FILE_BYTES: usize = 64 * 1024;
const MAX_SOURCE_BYTES: usize = 512 * 1024;
const MAX_PATH_BYTES: usize = 1_024;
const MAX_USER_TOKEN_LIFETIME_SECONDS: i64 = 8 * 60 * 60;

pub(crate) struct GitHubProvider {
    client: reqwest::Client,
    web_origin: Url,
    api_origin: Url,
    app_id: i64,
    client_id: String,
    client_secret: SecretText,
    private_key_pem: SecretText,
    webhook_secret: SecretBytes,
    callback_url: Url,
}

struct SecretText(String);

impl Drop for SecretText {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

struct SecretBytes(Vec<u8>);

impl Drop for SecretBytes {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

pub(crate) struct GitHubRepositoryRequest<'a> {
    pub user_access_token: &'a str,
    pub expected_user_id: i64,
    pub installation_id: i64,
    pub repository_id: i64,
}

pub(crate) struct GitHubSourceRequest<'a> {
    pub membership: GitHubRepositoryRequest<'a>,
    pub authorized_ref: &'a str,
}

pub(crate) struct GitHubUserAuthorization {
    pub user: GitHubUser,
    pub access_token: String,
    pub expires_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Serialize)]
pub(crate) struct GitHubUser {
    pub id: i64,
    pub login: String,
}

#[derive(Clone, Serialize)]
pub(crate) struct GitHubInstallation {
    pub id: i64,
    pub app_id: i64,
    pub account_id: i64,
    pub account_login: String,
    pub account_type: String,
    pub repository_selection: String,
    pub contents_permission: Option<String>,
    pub suspended: bool,
}

#[derive(Clone, Serialize)]
pub(crate) struct GitHubRepository {
    pub id: i64,
    pub owner: String,
    pub name: String,
    pub private: bool,
    pub default_branch: String,
    pub readable: bool,
}

pub(crate) struct GitHubMembership {
    pub installation: GitHubInstallation,
    pub repository: GitHubRepository,
}

#[derive(Clone, Serialize)]
pub(crate) struct GitHubBranch {
    pub name: String,
    pub commit_sha: String,
}

pub(crate) struct ResolvedSource {
    pub repository: GitHubRepository,
    pub authorized_ref: String,
    pub commit_sha: String,
    pub tree_sha: String,
}

pub(crate) struct SourceSnapshot {
    pub repository: GitHubRepository,
    pub authorized_ref: String,
    pub commit_sha: String,
    pub tree_sha: String,
    pub entry_paths: Vec<String>,
    pub files: Vec<SourceFile>,
}

pub(crate) struct SourceFile {
    pub path: String,
    pub content: Vec<u8>,
}

#[derive(Deserialize)]
struct UserResponse {
    id: i64,
    login: String,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: Option<i64>,
}

impl Drop for TokenResponse {
    fn drop(&mut self) {
        self.access_token.zeroize();
    }
}

#[derive(Deserialize)]
struct InstallationsPage {
    installations: Vec<InstallationResponse>,
}

#[derive(Deserialize)]
struct InstallationResponse {
    id: i64,
    app_id: i64,
    account: AccountResponse,
    repository_selection: String,
    permissions: InstallationPermissions,
    suspended_at: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct AccountResponse {
    id: i64,
    login: String,
    #[serde(rename = "type")]
    kind: String,
}

#[derive(Deserialize)]
struct InstallationPermissions {
    contents: Option<String>,
}

#[derive(Deserialize)]
struct RepositoriesPage {
    repositories: Vec<RepositoryResponse>,
}

#[derive(Deserialize)]
struct RepositoryResponse {
    id: i64,
    owner: OwnerResponse,
    name: String,
    private: bool,
    default_branch: String,
    permissions: Option<RepositoryPermissions>,
}

#[derive(Deserialize)]
struct OwnerResponse {
    login: String,
}

#[derive(Deserialize)]
struct RepositoryPermissions {
    pull: Option<bool>,
    admin: Option<bool>,
    maintain: Option<bool>,
    push: Option<bool>,
}

#[derive(Deserialize)]
struct BranchResponse {
    name: String,
    commit: ObjectSha,
}

#[derive(Deserialize)]
struct RefResponse {
    #[serde(rename = "ref")]
    full_ref: String,
    object: RefObject,
}

#[derive(Deserialize)]
struct RefObject {
    #[serde(rename = "type")]
    kind: String,
    sha: String,
}

#[derive(Deserialize)]
struct CommitResponse {
    sha: String,
    tree: ObjectSha,
}

#[derive(Deserialize)]
struct ObjectSha {
    sha: String,
}

#[derive(Deserialize)]
struct TreeResponse {
    sha: String,
    tree: Vec<TreeEntry>,
    truncated: bool,
}

#[derive(Deserialize)]
struct TreeEntry {
    path: String,
    mode: String,
    #[serde(rename = "type")]
    kind: String,
    sha: String,
    size: Option<u64>,
}

#[derive(Deserialize)]
struct BlobResponse {
    sha: String,
    content: String,
    encoding: String,
    size: u64,
}

impl Drop for BlobResponse {
    fn drop(&mut self) {
        self.content.zeroize();
    }
}

#[derive(Deserialize)]
struct InstallationTokenResponse {
    token: String,
}

impl Drop for InstallationTokenResponse {
    fn drop(&mut self) {
        self.token.zeroize();
    }
}

#[derive(Serialize)]
struct AppClaims<'a> {
    iat: u64,
    exp: u64,
    iss: &'a str,
}

#[derive(Serialize)]
struct InstallationTokenRequest {
    repository_ids: Vec<i64>,
    permissions: InstallationTokenPermissions,
}

#[derive(Serialize)]
struct InstallationTokenPermissions {
    contents: &'static str,
}

impl GitHubProvider {
    pub(crate) fn from_env() -> Result<Option<Self>, ApiError> {
        let mode = std::env::var("HOSTLET_GITHUB_PROVIDER")
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "disabled".to_owned());
        if mode == "disabled" {
            return Ok(None);
        }
        if mode != "github_com" && mode != "synthetic_loopback" {
            return Err(configuration_error());
        }

        let (web_origin, api_origin) = if mode == "github_com" {
            (
                parse_origin(REAL_WEB_ORIGIN, false)?,
                parse_origin(REAL_API_ORIGIN, false)?,
            )
        } else {
            let web = required_env("HOSTLET_GITHUB_WEB_ORIGIN")?;
            let api = required_env("HOSTLET_GITHUB_API_ORIGIN")?;
            (parse_origin(&web, true)?, parse_origin(&api, true)?)
        };
        let app_id = required_env("HOSTLET_GITHUB_APP_ID")?
            .parse::<i64>()
            .ok()
            .filter(|value| *value > 0)
            .ok_or_else(configuration_error)?;
        let client_id = bounded_env("HOSTLET_GITHUB_CLIENT_ID", 1, 256)?;
        let client_secret = bounded_env("HOSTLET_GITHUB_CLIENT_SECRET", 16, 1_024)?;
        let private_key_pem = bounded_env("HOSTLET_GITHUB_PRIVATE_KEY_PEM", 64, 65_536)?;
        if !private_key_pem.contains("-----BEGIN")
            || !private_key_pem.contains("PRIVATE KEY-----")
            || EncodingKey::from_rsa_pem(private_key_pem.as_bytes()).is_err()
        {
            return Err(configuration_error());
        }
        let webhook_secret = bounded_env("HOSTLET_GITHUB_WEBHOOK_SECRET", 32, 1_024)?;
        let callback_url = Url::parse(&bounded_env("HOSTLET_GITHUB_CALLBACK_URL", 1, 2_048)?)
            .map_err(|_| configuration_error())?;
        validate_callback(&callback_url, mode == "synthetic_loopback")?;

        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(3))
            .timeout(REQUEST_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("hostlet-control/0.1")
            .build()
            .map_err(|_| configuration_error())?;

        Ok(Some(Self {
            client,
            web_origin,
            api_origin,
            app_id,
            client_id,
            client_secret: SecretText(client_secret),
            private_key_pem: SecretText(private_key_pem),
            webhook_secret: SecretBytes(webhook_secret.into_bytes()),
            callback_url,
        }))
    }

    pub(crate) fn authorization_url(
        &self,
        state: &str,
        code_challenge: &str,
    ) -> Result<String, ApiError> {
        if !bounded_opaque(state, 32, 512) || !base64url_value(code_challenge, 43, 43) {
            return Err(ApiError::unprocessable(
                "invalid_github_authorization",
                "the GitHub authorization request is invalid",
            ));
        }
        let mut url = endpoint(&self.web_origin, &["login", "oauth", "authorize"])?;
        url.query_pairs_mut()
            .append_pair("client_id", &self.client_id)
            .append_pair("redirect_uri", self.callback_url.as_str())
            .append_pair("state", state)
            .append_pair("code_challenge", code_challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("prompt", "select_account");
        Ok(url.to_string())
    }

    pub(crate) async fn exchange_code(
        &self,
        code: &str,
        code_verifier: &str,
    ) -> Result<GitHubUserAuthorization, ApiError> {
        if !bounded_opaque(code, 1, 1_024) || !base64url_value(code_verifier, 43, 128) {
            return Err(ApiError::unprocessable(
                "invalid_github_authorization",
                "the GitHub authorization response is invalid",
            ));
        }
        self.with_operation_timeout(async {
            let url = endpoint(&self.web_origin, &["login", "oauth", "access_token"])?;
            let form = [
                ("client_id", self.client_id.as_str()),
                ("client_secret", self.client_secret.0.as_str()),
                ("code", code),
                ("redirect_uri", self.callback_url.as_str()),
                ("code_verifier", code_verifier),
            ];
            let mut token: TokenResponse = self
                .send_json(
                    self.client
                        .post(url)
                        .header(reqwest::header::ACCEPT, "application/json")
                        .form(&form),
                    64 * 1024,
                )
                .await?;
            validate_token(&token.access_token)?;
            let lifetime_seconds = match token.expires_in {
                Some(seconds) if seconds <= 0 => return Err(provider_error()),
                Some(seconds) => seconds.min(MAX_USER_TOKEN_LIFETIME_SECONDS),
                None => MAX_USER_TOKEN_LIFETIME_SECONDS,
            };
            let expires_at = Utc::now()
                .checked_add_signed(TimeDelta::seconds(lifetime_seconds))
                .ok_or_else(provider_error)?;
            let user = self.current_user_inner(&token.access_token).await?;
            let access_token = std::mem::take(&mut token.access_token);
            Ok(GitHubUserAuthorization {
                user,
                access_token,
                expires_at: Some(expires_at),
            })
        })
        .await
    }

    pub(crate) async fn current_user(
        &self,
        user_access_token: &str,
    ) -> Result<GitHubUser, ApiError> {
        self.with_operation_timeout(self.current_user_inner(user_access_token))
            .await
    }

    pub(crate) async fn list_installations(
        &self,
        user_access_token: &str,
    ) -> Result<Vec<GitHubInstallation>, ApiError> {
        self.with_operation_timeout(self.list_installations_inner(user_access_token))
            .await
    }

    pub(crate) async fn list_repositories(
        &self,
        user_access_token: &str,
        installation_id: i64,
    ) -> Result<Vec<GitHubRepository>, ApiError> {
        if installation_id <= 0 {
            return Err(access_denied());
        }
        self.with_operation_timeout(
            self.list_repositories_inner(user_access_token, installation_id),
        )
        .await
    }

    pub(crate) async fn current_membership(
        &self,
        user_access_token: &str,
        expected_user_id: i64,
        installation_id: i64,
        repository_id: i64,
    ) -> Result<GitHubMembership, ApiError> {
        let request = GitHubRepositoryRequest {
            user_access_token,
            expected_user_id,
            installation_id,
            repository_id,
        };
        self.with_operation_timeout(self.current_membership_inner(&request))
            .await
    }

    pub(crate) async fn list_branches(
        &self,
        request: GitHubRepositoryRequest<'_>,
    ) -> Result<Vec<GitHubBranch>, ApiError> {
        self.with_operation_timeout(async {
            let membership = self.current_membership_inner(&request).await?;
            let mut installation_token = self
                .installation_token(request.installation_id, request.repository_id)
                .await?;
            let result = self
                .list_branches_inner(&membership.repository, &installation_token)
                .await;
            installation_token.zeroize();
            result
        })
        .await
    }

    pub(crate) async fn resolve_source(
        &self,
        request: GitHubSourceRequest<'_>,
    ) -> Result<ResolvedSource, ApiError> {
        validate_full_ref(request.authorized_ref)?;
        self.with_operation_timeout(async {
            let membership = self.current_membership_inner(&request.membership).await?;
            let mut installation_token = self
                .installation_token(
                    request.membership.installation_id,
                    request.membership.repository_id,
                )
                .await?;
            let result = self
                .resolve_inner(
                    membership.repository,
                    request.authorized_ref,
                    &installation_token,
                )
                .await;
            installation_token.zeroize();
            result
        })
        .await
    }

    pub(crate) async fn read_source(
        &self,
        request: GitHubSourceRequest<'_>,
        commit_sha: &str,
        expected_tree_sha: &str,
    ) -> Result<SourceSnapshot, ApiError> {
        validate_full_ref(request.authorized_ref)?;
        validate_sha(commit_sha)?;
        validate_sha(expected_tree_sha)?;
        self.with_operation_timeout(async {
            let membership = self.current_membership_inner(&request.membership).await?;
            let mut installation_token = self
                .installation_token(
                    request.membership.installation_id,
                    request.membership.repository_id,
                )
                .await?;
            let result = self
                .read_source_inner(
                    membership.repository,
                    request.authorized_ref,
                    commit_sha,
                    expected_tree_sha,
                    &installation_token,
                )
                .await;
            installation_token.zeroize();
            result
        })
        .await
    }

    pub(crate) fn webhook_secret(&self) -> &[u8] {
        &self.webhook_secret.0
    }

    async fn current_user_inner(&self, token: &str) -> Result<GitHubUser, ApiError> {
        validate_token(token)?;
        let response: UserResponse = self
            .send_json(self.api_get(&["user"], token)?, 64 * 1024)
            .await?;
        if response.id <= 0 || !safe_github_name(&response.login) {
            return Err(provider_error());
        }
        Ok(GitHubUser {
            id: response.id,
            login: response.login,
        })
    }

    async fn list_installations_inner(
        &self,
        token: &str,
    ) -> Result<Vec<GitHubInstallation>, ApiError> {
        validate_token(token)?;
        let mut output = Vec::new();
        for page in 1..=MAX_PAGES {
            let mut url = endpoint(&self.api_origin, &["user", "installations"])?;
            page_query(&mut url, page);
            let response: InstallationsPage = self
                .send_json(self.api_get_url(url, token), MAX_JSON_RESPONSE)
                .await?;
            let count = response.installations.len();
            if count > PAGE_SIZE {
                return Err(provider_error());
            }
            for item in response.installations {
                if item.id <= 0
                    || item.app_id <= 0
                    || item.account.id <= 0
                    || !safe_github_name(&item.account.login)
                    || !matches!(item.repository_selection.as_str(), "all" | "selected")
                {
                    return Err(provider_error());
                }
                output.push(GitHubInstallation {
                    id: item.id,
                    app_id: item.app_id,
                    account_id: item.account.id,
                    account_login: item.account.login,
                    account_type: item.account.kind,
                    repository_selection: item.repository_selection,
                    contents_permission: item.permissions.contents,
                    suspended: item.suspended_at.is_some(),
                });
            }
            if count < PAGE_SIZE {
                return Ok(output);
            }
        }
        Err(provider_limit())
    }

    async fn list_repositories_inner(
        &self,
        token: &str,
        installation_id: i64,
    ) -> Result<Vec<GitHubRepository>, ApiError> {
        validate_token(token)?;
        if installation_id <= 0 {
            return Err(access_denied());
        }
        let mut output = Vec::new();
        for page in 1..=MAX_PAGES {
            let id = installation_id.to_string();
            let mut url = endpoint(
                &self.api_origin,
                &["user", "installations", &id, "repositories"],
            )?;
            page_query(&mut url, page);
            let response: RepositoriesPage = self
                .send_json(self.api_get_url(url, token), MAX_JSON_RESPONSE)
                .await?;
            let count = response.repositories.len();
            if count > PAGE_SIZE {
                return Err(provider_error());
            }
            for item in response.repositories {
                let repository = repository_from_response(item)?;
                output.push(repository);
            }
            if count < PAGE_SIZE {
                return Ok(output);
            }
        }
        Err(provider_limit())
    }

    async fn current_membership_inner(
        &self,
        request: &GitHubRepositoryRequest<'_>,
    ) -> Result<GitHubMembership, ApiError> {
        if request.expected_user_id <= 0
            || request.installation_id <= 0
            || request.repository_id <= 0
        {
            return Err(access_denied());
        }
        let user = self.current_user_inner(request.user_access_token).await?;
        if user.id != request.expected_user_id {
            return Err(access_denied());
        }
        let installation = self
            .list_installations_inner(request.user_access_token)
            .await?
            .into_iter()
            .find(|candidate| candidate.id == request.installation_id)
            .filter(|candidate| {
                candidate.app_id == self.app_id
                    && !candidate.suspended
                    && matches!(
                        candidate.contents_permission.as_deref(),
                        Some("read" | "write")
                    )
            })
            .ok_or_else(access_denied)?;
        let repository = self
            .list_repositories_inner(request.user_access_token, request.installation_id)
            .await?
            .into_iter()
            .find(|candidate| candidate.id == request.repository_id && candidate.readable)
            .ok_or_else(access_denied)?;
        Ok(GitHubMembership {
            installation,
            repository,
        })
    }

    async fn installation_token(
        &self,
        installation_id: i64,
        repository_id: i64,
    ) -> Result<String, ApiError> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| provider_error())?
            .as_secs();
        let claims = AppClaims {
            iat: now.saturating_sub(60),
            exp: now.saturating_add(9 * 60),
            iss: &self.client_id,
        };
        let key = EncodingKey::from_rsa_pem(self.private_key_pem.0.as_bytes())
            .map_err(|_| provider_error())?;
        let jwt = Zeroizing::new(
            jsonwebtoken::encode(&Header::new(Algorithm::RS256), &claims, &key)
                .map_err(|_| provider_error())?,
        );
        let id = installation_id.to_string();
        let url = endpoint(
            &self.api_origin,
            &["app", "installations", &id, "access_tokens"],
        )?;
        let request = InstallationTokenRequest {
            repository_ids: vec![repository_id],
            permissions: InstallationTokenPermissions { contents: "read" },
        };
        let mut response: InstallationTokenResponse = self
            .send_json(
                self.api_request(reqwest::Method::POST, url)
                    .bearer_auth(jwt.as_str())
                    .json(&request),
                64 * 1024,
            )
            .await?;
        validate_token(&response.token)?;
        Ok(std::mem::take(&mut response.token))
    }

    async fn list_branches_inner(
        &self,
        repository: &GitHubRepository,
        token: &str,
    ) -> Result<Vec<GitHubBranch>, ApiError> {
        let mut output = Vec::new();
        for page in 1..=MAX_PAGES {
            let mut url = endpoint(
                &self.api_origin,
                &["repos", &repository.owner, &repository.name, "branches"],
            )?;
            page_query(&mut url, page);
            let response: Vec<BranchResponse> = self
                .send_json(self.api_get_url(url, token), MAX_JSON_RESPONSE)
                .await?;
            let count = response.len();
            if count > PAGE_SIZE {
                return Err(provider_error());
            }
            for branch in response {
                validate_branch_name(&branch.name)?;
                validate_sha(&branch.commit.sha)?;
                output.push(GitHubBranch {
                    name: branch.name,
                    commit_sha: branch.commit.sha,
                });
            }
            if count < PAGE_SIZE {
                return Ok(output);
            }
        }
        Err(provider_limit())
    }

    async fn resolve_inner(
        &self,
        repository: GitHubRepository,
        authorized_ref: &str,
        token: &str,
    ) -> Result<ResolvedSource, ApiError> {
        let branch = authorized_ref
            .strip_prefix("refs/heads/")
            .ok_or_else(invalid_source)?;
        let mut segments = vec![
            "repos",
            &repository.owner,
            &repository.name,
            "git",
            "ref",
            "heads",
        ];
        segments.extend(branch.split('/'));
        let reference: RefResponse = self
            .send_exact_ref_json(self.api_get(&segments, token)?, 64 * 1024)
            .await?;
        if reference.full_ref != authorized_ref || reference.object.kind != "commit" {
            return Err(invalid_source());
        }
        validate_sha(&reference.object.sha)?;
        let commit = self
            .get_commit(&repository, &reference.object.sha, token)
            .await?;
        Ok(ResolvedSource {
            repository,
            authorized_ref: authorized_ref.to_owned(),
            commit_sha: commit.sha,
            tree_sha: commit.tree.sha,
        })
    }

    async fn read_source_inner(
        &self,
        repository: GitHubRepository,
        authorized_ref: &str,
        commit_sha: &str,
        expected_tree_sha: &str,
        token: &str,
    ) -> Result<SourceSnapshot, ApiError> {
        let commit = self.get_commit(&repository, commit_sha, token).await?;
        let tree_sha = commit.tree.sha;
        if tree_sha != expected_tree_sha {
            return Err(invalid_source());
        }
        let mut tree_url = endpoint(
            &self.api_origin,
            &[
                "repos",
                &repository.owner,
                &repository.name,
                "git",
                "trees",
                &tree_sha,
            ],
        )?;
        tree_url.query_pairs_mut().append_pair("recursive", "1");
        let tree: TreeResponse = self
            .send_json(self.api_get_url(tree_url, token), MAX_JSON_RESPONSE)
            .await?;
        if tree.truncated || tree.sha != tree_sha || tree.tree.len() > MAX_TREE_ENTRIES {
            return Err(provider_limit());
        }

        let mut selected = Vec::new();
        let mut entry_paths = Vec::with_capacity(tree.tree.len());
        let mut seen_paths = HashSet::with_capacity(tree.tree.len());
        for entry in tree.tree {
            validate_tree_entry(&entry)?;
            if !seen_paths.insert(entry.path.clone()) {
                return Err(provider_error());
            }
            entry_paths.push(entry.path.clone());
            if entry.kind == "blob" && allowed_source_path(&entry.path) {
                let size = entry.size.ok_or_else(provider_error)?;
                if size > MAX_SOURCE_FILE_BYTES as u64 {
                    return Err(provider_limit());
                }
                selected.push((entry.path, entry.sha));
                if selected.len() > MAX_SOURCE_FILES {
                    return Err(provider_limit());
                }
            }
        }
        entry_paths.sort_unstable();
        selected.sort_unstable_by(|left, right| left.0.cmp(&right.0));

        let mut files = Vec::with_capacity(selected.len());
        let mut total = 0_usize;
        for (path, blob_sha) in selected {
            let blob: BlobResponse = self
                .send_json(
                    self.api_get(
                        &[
                            "repos",
                            &repository.owner,
                            &repository.name,
                            "git",
                            "blobs",
                            &blob_sha,
                        ],
                        token,
                    )?,
                    128 * 1024,
                )
                .await?;
            if blob.sha != blob_sha
                || blob.encoding != "base64"
                || blob.size > MAX_SOURCE_FILE_BYTES as u64
            {
                return Err(provider_limit());
            }
            let mut compact = Zeroizing::new(blob.content.clone());
            compact.retain(|character| !character.is_ascii_whitespace());
            let content = STANDARD
                .decode(compact.as_bytes())
                .map_err(|_| provider_error())?;
            if content.len() != blob.size as usize || content.len() > MAX_SOURCE_FILE_BYTES {
                return Err(provider_error());
            }
            if std::str::from_utf8(&content).is_err() {
                return Err(ApiError::unprocessable(
                    "unsupported_github_source",
                    "the selected GitHub source contains non-text analysis files",
                ));
            }
            total = total
                .checked_add(content.len())
                .ok_or_else(provider_limit)?;
            if total > MAX_SOURCE_BYTES {
                return Err(provider_limit());
            }
            files.push(SourceFile { path, content });
        }
        Ok(SourceSnapshot {
            repository,
            authorized_ref: authorized_ref.to_owned(),
            commit_sha: commit.sha,
            tree_sha,
            entry_paths,
            files,
        })
    }

    async fn get_commit(
        &self,
        repository: &GitHubRepository,
        commit_sha: &str,
        token: &str,
    ) -> Result<CommitResponse, ApiError> {
        validate_sha(commit_sha)?;
        let commit: CommitResponse = self
            .send_json(
                self.api_get(
                    &[
                        "repos",
                        &repository.owner,
                        &repository.name,
                        "git",
                        "commits",
                        commit_sha,
                    ],
                    token,
                )?,
                128 * 1024,
            )
            .await?;
        if commit.sha != commit_sha {
            return Err(invalid_source());
        }
        validate_sha(&commit.tree.sha)?;
        Ok(commit)
    }

    fn api_get(&self, segments: &[&str], token: &str) -> Result<reqwest::RequestBuilder, ApiError> {
        let url = endpoint(&self.api_origin, segments)?;
        Ok(self.api_get_url(url, token))
    }

    fn api_get_url(&self, url: Url, token: &str) -> reqwest::RequestBuilder {
        self.api_request(reqwest::Method::GET, url)
            .bearer_auth(token)
    }

    fn api_request(&self, method: reqwest::Method, url: Url) -> reqwest::RequestBuilder {
        self.client
            .request(method, url)
            .header(reqwest::header::ACCEPT, "application/vnd.github+json")
            .header("X-GitHub-Api-Version", API_VERSION)
    }

    async fn send_json<T: DeserializeOwned>(
        &self,
        request: reqwest::RequestBuilder,
        maximum_bytes: usize,
    ) -> Result<T, ApiError> {
        let response = request.send().await.map_err(|_| provider_error())?;
        self.decode_json_response(response, maximum_bytes).await
    }

    async fn send_exact_ref_json<T: DeserializeOwned>(
        &self,
        request: reqwest::RequestBuilder,
        maximum_bytes: usize,
    ) -> Result<T, ApiError> {
        let response = request.send().await.map_err(|_| provider_error())?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Err(access_denied());
        }
        self.decode_json_response(response, maximum_bytes).await
    }

    async fn decode_json_response<T: DeserializeOwned>(
        &self,
        mut response: reqwest::Response,
        maximum_bytes: usize,
    ) -> Result<T, ApiError> {
        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err(ApiError::unprocessable(
                "github_credential_rejected",
                "GitHub rejected the request credential",
            ));
        }
        if response.status() == reqwest::StatusCode::FORBIDDEN {
            return Err(access_denied());
        }
        if !response.status().is_success() {
            return Err(provider_error());
        }
        if response
            .content_length()
            .is_some_and(|length| length > maximum_bytes as u64)
        {
            return Err(provider_limit());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| provider_error())? {
            if bytes.len().saturating_add(chunk.len()) > maximum_bytes {
                return Err(provider_limit());
            }
            bytes.extend_from_slice(&chunk);
        }
        let decoded = serde_json::from_slice(&bytes).map_err(|_| provider_error());
        bytes.zeroize();
        decoded
    }

    async fn with_operation_timeout<T>(
        &self,
        operation: impl Future<Output = Result<T, ApiError>>,
    ) -> Result<T, ApiError> {
        tokio::time::timeout(OPERATION_TIMEOUT, operation)
            .await
            .map_err(|_| provider_error())?
    }
}

fn repository_from_response(item: RepositoryResponse) -> Result<GitHubRepository, ApiError> {
    if item.id <= 0
        || !safe_github_name(&item.owner.login)
        || !safe_github_name(&item.name)
        || !safe_branch_display(&item.default_branch)
    {
        return Err(provider_error());
    }
    let readable = item.permissions.is_some_and(|permissions| {
        permissions.pull.unwrap_or(false)
            || permissions.admin.unwrap_or(false)
            || permissions.maintain.unwrap_or(false)
            || permissions.push.unwrap_or(false)
    });
    Ok(GitHubRepository {
        id: item.id,
        owner: item.owner.login,
        name: item.name,
        private: item.private,
        default_branch: item.default_branch,
        readable,
    })
}

fn validate_tree_entry(entry: &TreeEntry) -> Result<(), ApiError> {
    validate_repo_path(&entry.path)?;
    validate_sha(&entry.sha)?;
    match (entry.mode.as_str(), entry.kind.as_str()) {
        ("100644" | "100755", "blob") | ("040000", "tree") => Ok(()),
        ("120000", "blob") | ("160000", "commit") => Err(ApiError::unprocessable(
            "unsupported_github_source",
            "the repository contains unsupported source entries",
        )),
        _ => Err(provider_error()),
    }
}

fn allowed_source_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    let file = lower.rsplit('/').next().unwrap_or(&lower);
    if file.starts_with("readme")
        || lower
            .split('/')
            .any(|component| component == ".env" || component.starts_with(".env."))
    {
        return false;
    }
    matches!(
        file,
        "package.json"
            | "package-lock.json"
            | "npm-shrinkwrap.json"
            | "yarn.lock"
            | "pnpm-lock.yaml"
            | "bun.lock"
            | "bun.lockb"
            | "deno.json"
            | "deno.jsonc"
            | "tsconfig.json"
            | "jsconfig.json"
            | "hostlet.json"
            | "wrangler.toml"
    ) || file.starts_with("vite.config.")
        || file.starts_with("next.config.")
        || file.starts_with("astro.config.")
        || file.starts_with("svelte.config.")
        || file.starts_with("nuxt.config.")
        || matches!(
            lower.rsplit_once('.').map(|(_, extension)| extension),
            Some("js" | "jsx" | "ts" | "tsx" | "mjs" | "cjs" | "mts" | "cts")
        )
}

fn validate_repo_path(path: &str) -> Result<(), ApiError> {
    if path.is_empty()
        || path.len() > MAX_PATH_BYTES
        || path.starts_with('/')
        || path.contains('\\')
        || path.bytes().any(|byte| byte.is_ascii_control())
        || path
            .split('/')
            .any(|component| component.is_empty() || matches!(component, "." | ".."))
    {
        return Err(ApiError::unprocessable(
            "unsupported_github_source",
            "the repository contains unsafe source paths",
        ));
    }
    Ok(())
}

fn validate_full_ref(value: &str) -> Result<(), ApiError> {
    let branch = value
        .strip_prefix("refs/heads/")
        .ok_or_else(invalid_source)?;
    validate_branch_name(branch)
}

fn validate_branch_name(value: &str) -> Result<(), ApiError> {
    if !safe_branch_display(value)
        || value.starts_with('/')
        || value.ends_with('/')
        || value.ends_with('.')
        || value.contains("..")
        || value.contains("@{")
        || value.contains("//")
        || value
            .split('/')
            .any(|part| part.is_empty() || part.starts_with('.') || part.ends_with(".lock"))
        || value
            .bytes()
            .any(|byte| matches!(byte, b' ' | b'~' | b'^' | b':' | b'?' | b'*' | b'[' | b'\\'))
    {
        return Err(invalid_source());
    }
    Ok(())
}

fn safe_branch_display(value: &str) -> bool {
    !value.is_empty() && value.len() <= 255 && !value.bytes().any(|byte| byte.is_ascii_control())
}

fn validate_sha(value: &str) -> Result<(), ApiError> {
    if matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err(invalid_source())
    }
}

fn validate_token(value: &str) -> Result<(), ApiError> {
    if bounded_opaque(value, 16, 8_192) {
        Ok(())
    } else {
        Err(provider_error())
    }
}

fn bounded_opaque(value: &str, minimum: usize, maximum: usize) -> bool {
    (minimum..=maximum).contains(&value.len())
        && !value
            .bytes()
            .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
}

fn base64url_value(value: &str, minimum: usize, maximum: usize) -> bool {
    (minimum..=maximum).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn safe_github_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && !value
            .bytes()
            .any(|byte| byte.is_ascii_control() || matches!(byte, b'/' | b'\\'))
}

fn endpoint(origin: &Url, segments: &[&str]) -> Result<Url, ApiError> {
    let mut url = origin.clone();
    {
        let mut path = url.path_segments_mut().map_err(|_| provider_error())?;
        path.clear();
        for segment in segments {
            if segment.is_empty() || segment.bytes().any(|byte| byte.is_ascii_control()) {
                return Err(provider_error());
            }
            path.push(segment);
        }
    }
    Ok(url)
}

fn page_query(url: &mut Url, page: usize) {
    url.query_pairs_mut()
        .append_pair("per_page", &PAGE_SIZE.to_string())
        .append_pair("page", &page.to_string());
}

fn required_env(name: &str) -> Result<String, ApiError> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(configuration_error)
}

fn bounded_env(name: &str, minimum: usize, maximum: usize) -> Result<String, ApiError> {
    let value = required_env(name)?;
    if (minimum..=maximum).contains(&value.len()) && !value.bytes().any(|byte| byte == 0) {
        Ok(value)
    } else {
        Err(configuration_error())
    }
}

fn parse_origin(value: &str, loopback_required: bool) -> Result<Url, ApiError> {
    let url = Url::parse(value).map_err(|_| configuration_error())?;
    let clean_path = url.path().is_empty() || url.path() == "/";
    if !clean_path
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
    {
        return Err(configuration_error());
    }
    if loopback_required {
        if url.scheme() != "http"
            || !url
                .host_str()
                .and_then(|host| host.parse::<IpAddr>().ok())
                .is_some_and(|address| address.is_loopback())
        {
            return Err(configuration_error());
        }
    } else if url.scheme() != "https" {
        return Err(configuration_error());
    }
    Ok(url)
}

fn validate_callback(url: &Url, loopback_mode: bool) -> Result<(), ApiError> {
    if url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
        || url.query().is_some()
    {
        return Err(configuration_error());
    }
    if url.scheme() == "https" {
        return Ok(());
    }
    if loopback_mode
        && url.scheme() == "http"
        && url
            .host_str()
            .and_then(|host| host.parse::<IpAddr>().ok())
            .is_some_and(|address| address.is_loopback())
    {
        return Ok(());
    }
    Err(configuration_error())
}

fn configuration_error() -> ApiError {
    ApiError::unavailable(
        "github_configuration_invalid",
        "the GitHub provider configuration is invalid",
    )
}

fn provider_error() -> ApiError {
    ApiError::unavailable(
        "github_provider_unavailable",
        "the GitHub provider could not complete the request",
    )
}

fn provider_limit() -> ApiError {
    ApiError::unprocessable(
        "github_provider_limit_exceeded",
        "the GitHub response exceeds Hostlet limits",
    )
}

fn access_denied() -> ApiError {
    ApiError::unprocessable(
        "github_access_denied",
        "the GitHub user cannot access the selected repository",
    )
}

fn invalid_source() -> ApiError {
    ApiError::unprocessable(
        "invalid_github_source",
        "the selected GitHub source is invalid",
    )
}
