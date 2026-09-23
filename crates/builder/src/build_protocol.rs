use serde::{Deserialize, Serialize};

pub(crate) const SOURCE_MAGIC: &[u8; 4] = b"HBS1";
pub(crate) const GUEST_INPUT_MAGIC: &[u8; 4] = b"HBI1";
pub(crate) const GUEST_OUTPUT_MAGIC: &[u8; 4] = b"HBO1";
pub(crate) const CANONICAL_ARTIFACT_MAGIC: &[u8; 4] = b"HCA1";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct BuildLimits {
    pub cpu_millis: u64,
    pub memory_bytes: u64,
    pub timeout_seconds: u64,
    pub workspace_bytes: u64,
    pub static_output_bytes: u64,
    pub runtime_output_bytes: u64,
    pub max_entries: u32,
    pub console_bytes: u64,
    pub report_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct BuildService {
    pub service_id: String,
    pub kind: String,
    pub root: String,
    pub node_major: u16,
    pub framework: String,
    pub lockfile_path: String,
    pub build_command: String,
    pub output_directory: String,
    pub start_command: Option<String>,
    pub health_path: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct GuestCredential {
    pub service_id: String,
    pub secret_version_id: String,
    pub name: String,
    pub value: String,
}

impl Drop for GuestCredential {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.value.zeroize();
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct GuestRequest {
    pub protocol: String,
    pub job_id: String,
    pub attempt_id: String,
    pub fence: u64,
    pub input_manifest_digest: String,
    pub source_commit: String,
    pub source_tree_sha: String,
    pub source_bundle_digest: String,
    pub dependency_cache_digest: String,
    pub services: Vec<BuildService>,
    pub credentials: Vec<GuestCredential>,
    pub limits: BuildLimits,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct GuestReport {
    pub state: String,
    pub code: String,
    pub phase: String,
    pub message: String,
}
