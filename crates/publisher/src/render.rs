use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use url::Url;
use uuid::Uuid;

const CSS: &str = r#":root{--accent:#e15f41;--ink:#17202a;--muted:#5d6d7e;--paper:#fffaf5;--card:#fff;--line:#eadfd5;font-family:ui-sans-serif,system-ui,sans-serif}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);line-height:1.6}main{width:min(72rem,calc(100% - 2rem));margin:auto;padding:4rem 0}header{max-width:52rem;margin-bottom:4rem}h1{font-size:clamp(2.7rem,8vw,6rem);line-height:.95;margin:.2rem 0 1.4rem}h2{margin-top:3rem}h3{margin:.2rem 0}.eyebrow,.meta{color:var(--muted);font-size:.92rem}.accent{color:var(--accent)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(17rem,1fr));gap:1rem}.card{display:block;background:var(--card);border:1px solid var(--line);border-radius:1rem;padding:1.4rem;color:inherit;text-decoration:none}.card:hover{border-color:var(--accent)}.tags,.links{display:flex;flex-wrap:wrap;gap:.6rem;list-style:none;padding:0}.tags li{background:var(--card);border:1px solid var(--line);border-radius:999px;padding:.25rem .7rem}a{color:var(--accent);text-underline-offset:.18em}.evidence{max-width:100%;border-radius:.7rem;border:1px solid var(--line)}.decision{border-left:.2rem solid var(--accent);padding-left:1rem}.back{display:inline-block;margin-bottom:2rem}@media(prefers-color-scheme:dark){:root{--ink:#f5eee8;--muted:#b9aaa0;--paper:#171411;--card:#221d19;--line:#40352e}}"#;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublicDocument {
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
    pub appearance: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublicLink {
    pub id: String,
    pub label: String,
    pub url: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContactLink {
    pub id: String,
    pub kind: ContactKind,
    pub label: String,
    pub url: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContactKind {
    Email,
    Website,
    Social,
    Other,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublicProject {
    pub project_reference_id: String,
    pub order: u16,
    pub title: String,
    pub purpose: String,
    pub contribution: String,
    pub technical_decisions: Vec<TechnicalDecision>,
    pub links: Vec<ProjectLink>,
    pub evidence: Vec<ProjectEvidence>,
    pub deployment: Option<Deployment>,
    pub readiness: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TechnicalDecision {
    pub id: String,
    pub summary: String,
    pub rationale: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectLink {
    pub kind: LinkKind,
    pub link: PublicLink,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkKind {
    Source,
    Demo,
    Other,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectEvidence {
    pub id: String,
    pub kind: EvidenceKind,
    pub title: String,
    pub url: String,
    pub caption: Option<String>,
    pub alt_text: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceKind {
    Screenshot,
    Document,
    DemoRecording,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Deployment {
    pub fact_revision_id: Uuid,
    pub managed_demo_url: Option<String>,
    pub deployed_at: Option<DateTime<Utc>>,
    pub availability: Option<Availability>,
    pub status_label: Option<String>,
    pub release_identifier: Option<String>,
    pub source_commit: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Availability {
    Available,
    Degraded,
    DemoOffline,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub format: String,
    pub publication_id: Uuid,
    pub document_digest: String,
    pub files: Vec<ManifestFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManifestFile {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
    pub content_type: String,
}

pub fn render(
    document_value: Value,
    publication_id: Uuid,
    document_digest: &str,
    staging: &Path,
) -> Result<String, &'static str> {
    let encoded_document =
        serde_json::to_vec(&document_value).map_err(|_| "invalid_public_document")?;
    if format!("sha256:{:x}", Sha256::digest(encoded_document)) != document_digest {
        return Err("public_document_digest_mismatch");
    }
    let document: PublicDocument =
        serde_json::from_value(document_value).map_err(|_| "invalid_public_document")?;
    if document.contract_version != "hostlet.public-portfolio/v1" || !valid_digest(document_digest)
    {
        return Err("invalid_public_document");
    }
    validate_document(&document)?;
    if staging.exists() {
        return Err("staging_path_exists");
    }
    fs::create_dir_all(staging).map_err(|_| "staging_create_failed")?;
    fs::set_permissions(staging, fs::Permissions::from_mode(0o700))
        .map_err(|_| "staging_create_failed")?;
    let mut outputs = BTreeMap::<String, (Vec<u8>, &'static str)>::new();
    outputs.insert(
        "assets/site.css".to_owned(),
        (
            themed_css(&document.appearance).into_bytes(),
            "text/css; charset=utf-8",
        ),
    );
    outputs.insert(
        "index.html".to_owned(),
        (
            index_html(&document)?.into_bytes(),
            "text/html; charset=utf-8",
        ),
    );
    for project in &document.projects {
        let path = format!(
            "projects/{}/index.html",
            project_path(&project.project_reference_id)
        );
        outputs.insert(
            path,
            (
                project_html(&document, project)?.into_bytes(),
                "text/html; charset=utf-8",
            ),
        );
    }
    let mut files = Vec::with_capacity(outputs.len());
    for (relative, (bytes, content_type)) in outputs {
        let path = staging.join(&relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|_| "staging_write_failed")?;
        }
        write_new(&path, &bytes)?;
        files.push(ManifestFile {
            path: relative,
            bytes: bytes.len() as u64,
            sha256: format!("sha256:{:x}", Sha256::digest(&bytes)),
            content_type: content_type.to_owned(),
        });
    }
    let manifest = Manifest {
        format: "hostlet.static-site-manifest/v1".to_owned(),
        publication_id,
        document_digest: document_digest.to_owned(),
        files,
    };
    let bytes = serde_json::to_vec(&manifest).map_err(|_| "manifest_encode_failed")?;
    let digest = format!("sha256:{:x}", Sha256::digest(&bytes));
    write_new(&staging.join("manifest.json"), &bytes)?;
    Ok(digest)
}

fn validate_document(document: &PublicDocument) -> Result<(), &'static str> {
    if document.approved_revision_id.is_nil() {
        return Err("invalid_public_document");
    }
    if document
        .projects
        .windows(2)
        .any(|pair| pair[0].order >= pair[1].order)
    {
        return Err("invalid_project_order");
    }
    if let Some(link) = &document.resume {
        validate_id(&link.id)?;
        validate_https(&link.url)?;
    }
    for contact in &document.contacts {
        validate_id(&contact.id)?;
        match contact.kind {
            ContactKind::Email => validate_mailto(&contact.url)?,
            ContactKind::Website | ContactKind::Social | ContactKind::Other => {
                validate_https(&contact.url)?
            }
        }
    }
    for project in &document.projects {
        validate_id(&project.project_reference_id)?;
        for decision in &project.technical_decisions {
            validate_id(&decision.id)?;
        }
        for link in &project.links {
            validate_id(&link.link.id)?;
            match link.kind {
                LinkKind::Source | LinkKind::Demo | LinkKind::Other => {}
            }
            validate_https(&link.link.url)?;
        }
        for evidence in &project.evidence {
            validate_id(&evidence.id)?;
            if matches!(evidence.kind, EvidenceKind::Screenshot) {
                // The public document carries only a remote URL, not immutable
                // image bytes. Fetching it here would make publication depend on
                // an arbitrary network destination, so refuse the image until
                // the materialization contract grows a local asset form.
                return Err("unsupported_external_image");
            }
            validate_https(&evidence.url)?;
        }
        if let Some(url) = project
            .deployment
            .as_ref()
            .and_then(|deployment| deployment.managed_demo_url.as_deref())
        {
            validate_https(url)?;
        }
        if let Some(deployment) = &project.deployment
            && deployment.fact_revision_id.is_nil()
        {
            return Err("invalid_public_document");
        }
    }
    Ok(())
}

fn index_html(document: &PublicDocument) -> Result<String, &'static str> {
    let mut body = String::new();
    body.push_str("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"color-scheme\" content=\"light dark\"><link rel=\"stylesheet\" href=\"assets/site.css\"><title>");
    body.push_str(&escape(&document.display_name));
    body.push_str("</title></head><body><main><header><p class=\"eyebrow\">Portfolio</p><h1>");
    body.push_str(&escape(&document.display_name));
    body.push_str("</h1>");
    if let Some(headline) = &document.headline {
        body.push_str("<h2 class=\"accent\">");
        body.push_str(&escape(headline));
        body.push_str("</h2>");
    }
    if let Some(introduction) = &document.introduction {
        body.push_str("<p>");
        body.push_str(&escape(introduction));
        body.push_str("</p>");
    }
    if let Some(role) = &document.target_role {
        body.push_str("<p class=\"meta\">Target role: ");
        body.push_str(&escape(role));
        body.push_str("</p>");
    }
    body.push_str("</header>");
    if !document.projects.is_empty() {
        body.push_str("<section><h2>Featured projects</h2><div class=\"grid\">");
        for project in &document.projects {
            body.push_str("<a class=\"card\" href=\"projects/");
            body.push_str(&project_path(&project.project_reference_id));
            body.push_str("/\"><h3>");
            body.push_str(&escape(&project.title));
            body.push_str("</h3><p>");
            body.push_str(&escape(&project.purpose));
            body.push_str("</p></a>");
        }
        body.push_str("</div></section>");
    }
    if !document.skills.is_empty() {
        body.push_str("<section><h2>Skills</h2><ul class=\"tags\">");
        for skill in &document.skills {
            body.push_str("<li>");
            body.push_str(&escape(skill));
            body.push_str("</li>");
        }
        body.push_str("</ul></section>");
    }
    let mut links = Vec::new();
    if let Some(resume) = &document.resume {
        links.push((&resume.label, &resume.url));
    }
    links.extend(
        document
            .contacts
            .iter()
            .map(|contact| (&contact.label, &contact.url)),
    );
    if !links.is_empty() {
        body.push_str("<section><h2>Resume &amp; contact</h2><ul class=\"links\">");
        for (label, url) in links {
            body.push_str("<li><a rel=\"noopener noreferrer\" href=\"");
            body.push_str(&escape_attr(url));
            body.push_str("\">");
            body.push_str(&escape(label));
            body.push_str("</a></li>");
        }
        body.push_str("</ul></section>");
    }
    body.push_str("</main></body></html>");
    Ok(body)
}

fn project_html(
    document: &PublicDocument,
    project: &PublicProject,
) -> Result<String, &'static str> {
    let mut body = String::new();
    body.push_str("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><link rel=\"stylesheet\" href=\"../../assets/site.css\"><title>");
    body.push_str(&escape(&project.title));
    body.push_str(" — ");
    body.push_str(&escape(&document.display_name));
    body.push_str("</title></head><body><main><a class=\"back\" href=\"../../\">← Portfolio</a><p class=\"eyebrow\">Case study</p><h1>");
    body.push_str(&escape(&project.title));
    body.push_str("</h1><h2>Purpose</h2><p>");
    body.push_str(&escape(&project.purpose));
    body.push_str("</p><h2>My contribution</h2><p>");
    body.push_str(&escape(&project.contribution));
    body.push_str("</p>");
    if !project.technical_decisions.is_empty() {
        body.push_str("<h2>Technical decisions</h2>");
        for decision in &project.technical_decisions {
            body.push_str("<article class=\"decision\"><h3>");
            body.push_str(&escape(&decision.summary));
            body.push_str("</h3><p>");
            body.push_str(&escape(&decision.rationale));
            body.push_str("</p></article>");
        }
    }
    if !project.links.is_empty() {
        body.push_str("<h2>Links</h2><ul class=\"links\">");
        for item in &project.links {
            body.push_str("<li><a rel=\"noopener noreferrer\" href=\"");
            body.push_str(&escape_attr(&item.link.url));
            body.push_str("\">");
            body.push_str(&escape(&item.link.label));
            body.push_str("</a></li>");
        }
        body.push_str("</ul>");
    }
    if let Some(deployment) = &project.deployment {
        body.push_str("<h2>Deployment</h2><dl>");
        if let Some(url) = &deployment.managed_demo_url {
            body.push_str("<dt>Live demo</dt><dd><a rel=\"noopener noreferrer\" href=\"");
            body.push_str(&escape_attr(url));
            body.push_str("\">Open demo</a></dd>");
        }
        if let Some(time) = deployment.deployed_at {
            let approved_time = time.to_rfc3339_opts(SecondsFormat::AutoSi, true);
            body.push_str("<dt>Deployed</dt><dd><time datetime=\"");
            body.push_str(&escape_attr(&approved_time));
            body.push_str("\">");
            body.push_str(&escape(&approved_time));
            body.push_str("</time></dd>");
        }
        if let Some(status) = deployment.status_label.clone().or_else(|| {
            deployment
                .availability
                .as_ref()
                .map(|availability| match availability {
                    Availability::Available => "Available".to_owned(),
                    Availability::Degraded => "Degraded".to_owned(),
                    Availability::DemoOffline => "Demo offline".to_owned(),
                })
        }) {
            body.push_str("<dt>Availability</dt><dd>");
            body.push_str(&escape(&status));
            body.push_str("</dd>");
        }
        if let Some(release) = &deployment.release_identifier {
            body.push_str("<dt>Release</dt><dd>");
            body.push_str(&escape(release));
            body.push_str("</dd>");
        }
        if let Some(commit) = &deployment.source_commit {
            body.push_str("<dt>Source commit</dt><dd><code>");
            body.push_str(&escape(commit));
            body.push_str("</code></dd>");
        }
        body.push_str("</dl>");
    }
    if let Some(readiness) = &project.readiness {
        body.push_str("<h2>Demo readiness</h2>");
        render_readiness(&mut body, readiness);
    }
    if !project.evidence.is_empty() {
        body.push_str("<h2>Evidence</h2><div class=\"grid\">");
        for evidence in &project.evidence {
            body.push_str("<figure class=\"card\">");
            if matches!(evidence.kind, EvidenceKind::Screenshot) {
                body.push_str("<img class=\"evidence\" loading=\"lazy\" src=\"");
                body.push_str(&escape_attr(&evidence.url));
                body.push_str("\" alt=\"");
                body.push_str(&escape_attr(
                    evidence.alt_text.as_deref().unwrap_or(&evidence.title),
                ));
                body.push_str("\">");
            } else {
                body.push_str("<a rel=\"noopener noreferrer\" href=\"");
                body.push_str(&escape_attr(&evidence.url));
                body.push_str("\">");
                body.push_str(&escape(&evidence.title));
                body.push_str("</a>");
            }
            body.push_str("<figcaption>");
            if matches!(evidence.kind, EvidenceKind::Screenshot) {
                body.push_str("<strong>");
                body.push_str(&escape(&evidence.title));
                body.push_str("</strong>");
            }
            if let Some(caption) = &evidence.caption {
                body.push(' ');
                body.push_str(&escape(caption));
            }
            body.push_str("</figcaption>");
            body.push_str("</figure>");
        }
        body.push_str("</div>");
    }
    body.push_str("</main></body></html>");
    Ok(body)
}

fn render_readiness(body: &mut String, value: &Value) {
    let state = value
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or("needs_recheck");
    body.push_str("<p>");
    body.push_str(&escape(&state.replace('_', " ")));
    body.push_str("</p>");
    if let Some(reason) = value.get("reason").and_then(Value::as_str) {
        body.push_str("<p class=\"meta\">Reason: ");
        body.push_str(&escape(&reason.replace('_', " ")));
        body.push_str("</p>");
    }
    if let Some(attestation) = value.get("attestation").and_then(Value::as_object) {
        if let Some(release) = attestation.get("release_id").and_then(Value::as_str) {
            body.push_str("<p class=\"meta\">Checked release: ");
            body.push_str(&escape(release));
            body.push_str("</p>");
        }
        if let Some(checked_at) = attestation.get("checked_at").and_then(Value::as_str) {
            body.push_str("<p class=\"meta\">Checked at: ");
            body.push_str(&escape(checked_at));
            body.push_str("</p>");
        }
        if let Some(instructions) = attestation
            .get("visitor_instructions")
            .and_then(Value::as_str)
        {
            body.push_str("<p>");
            body.push_str(&escape(instructions));
            body.push_str("</p>");
        }
        body.push_str("<ul>");
        for (key, label) in [
            ("demo_page_verified", "Demo page verified"),
            ("synthetic_example_data_verified", "Example data verified"),
            ("restricted_access_verified", "Restricted access verified"),
            (
                "visitor_instructions_verified",
                "Visitor instructions verified",
            ),
        ] {
            if let Some(checked) = attestation.get(key).and_then(Value::as_bool) {
                body.push_str("<li>");
                body.push_str(label);
                body.push_str(if checked { ": yes" } else { ": no" });
                body.push_str("</li>");
            }
        }
        body.push_str("</ul>");
    }
}

fn themed_css(appearance: &Value) -> String {
    let accent = match appearance.get("accent").and_then(Value::as_str) {
        Some("coral") => "#e15f41",
        Some("indigo") => "#4f46a5",
        Some("forest") => "#27845c",
        _ => "#e15f41",
    };
    let font = match appearance.get("typography").and_then(Value::as_str) {
        Some("serif") | Some("editorial_serif") => "ui-serif,Georgia,serif",
        _ => "ui-sans-serif,system-ui,sans-serif",
    };
    format!("{CSS}\n:root{{--accent:{accent};font-family:{font}}}\n")
}

fn validate_https(value: &str) -> Result<(), &'static str> {
    let url = Url::parse(value).map_err(|_| "unsafe_public_url")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("unsafe_public_url");
    }
    Ok(())
}

fn validate_mailto(value: &str) -> Result<(), &'static str> {
    let url = Url::parse(value).map_err(|_| "unsafe_public_url")?;
    if url.scheme() != "mailto"
        || !url.cannot_be_a_base()
        || url.path().is_empty()
        || url.path().contains(['\r', '\n'])
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("unsafe_public_url");
    }
    Ok(())
}

fn validate_id(value: &str) -> Result<(), &'static str> {
    if value.is_empty() || value.len() > 128 || value.chars().any(char::is_control) {
        return Err("invalid_public_document");
    }
    Ok(())
}

fn project_path(reference: &str) -> String {
    if !reference.is_empty()
        && reference.len() <= 80
        && reference
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        reference.to_owned()
    } else {
        format!("project-{:x}", Sha256::digest(reference.as_bytes()))[..24].to_owned()
    }
}

fn escape(value: &str) -> String {
    value.chars().fold(String::new(), |mut out, c| {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        };
        out
    })
}
fn escape_attr(value: &str) -> String {
    escape(value)
}
fn valid_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    })
}

fn write_new(path: &PathBuf, bytes: &[u8]) -> Result<(), &'static str> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o644)
        .open(path)
        .map_err(|_| "staging_write_failed")?;
    file.write_all(bytes).map_err(|_| "staging_write_failed")?;
    file.sync_all().map_err(|_| "staging_write_failed")
}
