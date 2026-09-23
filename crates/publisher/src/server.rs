use std::{
    collections::HashMap,
    fs,
    net::SocketAddr,
    os::unix::fs::PermissionsExt,
    path::{Component, Path, PathBuf},
    sync::Arc,
};

use axum::{
    Router,
    body::Body,
    extract::{OriginalUri, Path as AxumPath, State},
    http::{HeaderMap, HeaderValue, Response, StatusCode, Uri, header, uri::Authority},
    response::IntoResponse,
    routing::get,
};
use sha2::{Digest, Sha256};

use crate::render::Manifest;

const CSP: &str = "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

#[derive(Clone)]
struct ServerState {
    root: Arc<PathBuf>,
    expected_host: Arc<str>,
}

pub async fn run(args: &[String]) -> Result<(), String> {
    let (root, bind, expected_host) = parse(args)?;
    let root = validate_root(root)?;
    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .map_err(|_| "publisher_bind_failed".to_owned())?;
    let app = Router::new()
        .route("/{slug}", get(site_root))
        .route("/{slug}/", get(site_root))
        .route("/{slug}/{*path}", get(site_file))
        .with_state(ServerState {
            root: Arc::new(root),
            expected_host: Arc::from(expected_host),
        });
    axum::serve(listener, app)
        .await
        .map_err(|_| "publisher_server_failed".to_owned())
}

async fn site_root(
    State(state): State<ServerState>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    AxumPath(slug): AxumPath<String>,
) -> impl IntoResponse {
    serve_file(
        &state.root,
        state.expected_host.as_ref(),
        &headers,
        &uri,
        &slug,
        "index.html",
    )
}

async fn site_file(
    State(state): State<ServerState>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    AxumPath((slug, path)): AxumPath<(String, String)>,
) -> impl IntoResponse {
    let path = if path.ends_with('/') {
        format!("{path}index.html")
    } else {
        path
    };
    serve_file(
        &state.root,
        state.expected_host.as_ref(),
        &headers,
        &uri,
        &slug,
        &path,
    )
}

fn serve_file(
    root: &Path,
    expected_host: &str,
    headers: &HeaderMap,
    original_uri: &Uri,
    slug: &str,
    relative: &str,
) -> Response<Body> {
    match load_file(root, expected_host, headers, original_uri, slug, relative) {
        Ok((bytes, content_type, immutable)) => {
            let mut response = Response::new(Body::from(bytes));
            *response.status_mut() = StatusCode::OK;
            let headers = response.headers_mut();
            headers.insert(
                header::CONTENT_TYPE,
                HeaderValue::from_str(&content_type)
                    .unwrap_or(HeaderValue::from_static("application/octet-stream")),
            );
            headers.insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static(if immutable {
                    "public, max-age=31536000, immutable"
                } else {
                    "no-cache"
                }),
            );
            headers.insert("content-security-policy", HeaderValue::from_static(CSP));
            headers.insert(
                "x-content-type-options",
                HeaderValue::from_static("nosniff"),
            );
            headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
            headers.insert("x-frame-options", HeaderValue::from_static("DENY"));
            response
        }
        Err(status) => status.into_response(),
    }
}

fn load_file(
    root: &Path,
    expected_host: &str,
    headers: &HeaderMap,
    original_uri: &Uri,
    slug: &str,
    relative: &str,
) -> Result<(Vec<u8>, String, bool), StatusCode> {
    validate_request(expected_host, headers, original_uri)?;
    validate_slug(slug)?;
    validate_path(relative)?;
    let site = root.join("sites").join(slug);
    let pointer = fs::read_link(site.join("current")).map_err(|_| StatusCode::NOT_FOUND)?;
    let name = pointer
        .file_name()
        .and_then(|part| part.to_str())
        .ok_or(StatusCode::NOT_FOUND)?;
    if !name.starts_with("sha256-")
        || name.len() != 71
        || !name[7..]
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(StatusCode::NOT_FOUND);
    }
    let expected = PathBuf::from("../../artifacts").join(name);
    if pointer != expected {
        return Err(StatusCode::NOT_FOUND);
    }
    let artifact = root.join("artifacts").join(name);
    let artifact_metadata = fs::symlink_metadata(&artifact).map_err(|_| StatusCode::NOT_FOUND)?;
    if !artifact_metadata.is_dir() || artifact_metadata.file_type().is_symlink() {
        return Err(StatusCode::NOT_FOUND);
    }
    let manifest_bytes =
        fs::read(artifact.join("manifest.json")).map_err(|_| StatusCode::NOT_FOUND)?;
    if manifest_bytes.len() > 256 * 1024 {
        return Err(StatusCode::NOT_FOUND);
    }
    let digest = format!("sha256:{:x}", Sha256::digest(&manifest_bytes));
    if digest
        .strip_prefix("sha256:")
        .is_none_or(|hex| name != format!("sha256-{hex}"))
    {
        return Err(StatusCode::NOT_FOUND);
    }
    let manifest: Manifest =
        serde_json::from_slice(&manifest_bytes).map_err(|_| StatusCode::NOT_FOUND)?;
    if manifest.format != "hostlet.static-site-manifest/v1" {
        return Err(StatusCode::NOT_FOUND);
    }
    let declared: HashMap<_, _> = manifest
        .files
        .into_iter()
        .map(|entry| (entry.path.clone(), entry))
        .collect();
    let entry = declared.get(relative).ok_or(StatusCode::NOT_FOUND)?;
    let file = artifact.join(relative);
    let metadata = fs::symlink_metadata(&file).map_err(|_| StatusCode::NOT_FOUND)?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() != entry.bytes
        || entry.bytes > 8 * 1024 * 1024
    {
        return Err(StatusCode::NOT_FOUND);
    }
    let bytes = fs::read(file).map_err(|_| StatusCode::NOT_FOUND)?;
    if format!("sha256:{:x}", Sha256::digest(&bytes)) != entry.sha256 {
        return Err(StatusCode::NOT_FOUND);
    }
    let immutable = !entry.content_type.starts_with("text/html");
    Ok((bytes, entry.content_type.clone(), immutable))
}

fn parse(args: &[String]) -> Result<(PathBuf, SocketAddr, String), String> {
    let mut root = None;
    let mut bind = None;
    let mut expected_host = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--root" if root.is_none() => {
                index += 1;
                root = args.get(index).map(PathBuf::from);
            }
            "--bind" if bind.is_none() => {
                index += 1;
                bind = args.get(index).and_then(|value| value.parse().ok());
            }
            "--expected-host" if expected_host.is_none() => {
                index += 1;
                expected_host = args.get(index).cloned();
            }
            _ => return Err("publisher_server_arguments_invalid".to_owned()),
        }
        index += 1;
    }
    let bind = bind.ok_or_else(|| "publisher_bind_required".to_owned())?;
    let expected_host =
        expected_host.ok_or_else(|| "publisher_expected_host_required".to_owned())?;
    validate_expected_host(&expected_host)?;
    Ok((
        root.ok_or_else(|| "publisher_root_required".to_owned())?,
        bind,
        expected_host,
    ))
}

fn validate_expected_host(value: &str) -> Result<(), String> {
    if value.is_empty()
        || !value.is_ascii()
        || value
            .bytes()
            .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
        || value.contains(['/', '?', '#', '@'])
    {
        return Err("publisher_expected_host_invalid".to_owned());
    }
    let authority = value
        .parse::<Authority>()
        .map_err(|_| "publisher_expected_host_invalid".to_owned())?;
    if authority.host().is_empty() || authority.as_str() != value {
        return Err("publisher_expected_host_invalid".to_owned());
    }
    Ok(())
}

fn validate_root(root: PathBuf) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(&root).map_err(|_| "publisher_root_invalid".to_owned())?;
    if !root.is_absolute()
        || !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.permissions().mode() & 0o077 != 0
    {
        return Err("publisher_root_invalid".to_owned());
    }
    fs::canonicalize(root).map_err(|_| "publisher_root_invalid".to_owned())
}

fn validate_slug(value: &str) -> Result<(), StatusCode> {
    if value.is_empty()
        || value.len() > 63
        || value.starts_with('-')
        || value.ends_with('-')
        || !value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err(StatusCode::NOT_FOUND);
    }
    Ok(())
}

fn validate_path(value: &str) -> Result<(), StatusCode> {
    if value.is_empty() || value.len() > 512 || !value.is_ascii() || value.contains(['\\', '%']) {
        return Err(StatusCode::NOT_FOUND);
    }
    let path = Path::new(value);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || value
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(StatusCode::NOT_FOUND);
    }
    Ok(())
}

fn validate_request(
    expected_host: &str,
    headers: &HeaderMap,
    original_uri: &Uri,
) -> Result<(), StatusCode> {
    if headers.get_all(header::HOST).iter().count() != 1
        || headers
            .get(header::HOST)
            .and_then(|value| value.to_str().ok())
            != Some(expected_host)
    {
        return Err(StatusCode::NOT_FOUND);
    }
    validate_raw_uri(original_uri)
}

fn validate_raw_uri(uri: &Uri) -> Result<(), StatusCode> {
    let raw = uri
        .path_and_query()
        .map_or_else(|| uri.path(), |path_and_query| path_and_query.as_str());
    let bytes = raw.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len()
                || !bytes[index + 1].is_ascii_hexdigit()
                || !bytes[index + 2].is_ascii_hexdigit()
            {
                return Err(StatusCode::NOT_FOUND);
            }
            let first = bytes[index + 1].to_ascii_lowercase();
            let second = bytes[index + 2].to_ascii_lowercase();
            if (first == b'2' && second == b'f') || (first == b'5' && second == b'c') {
                return Err(StatusCode::NOT_FOUND);
            }
            index += 3;
        } else {
            index += 1;
        }
    }
    Ok(())
}
