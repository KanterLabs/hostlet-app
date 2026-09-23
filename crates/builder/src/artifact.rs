use std::{
    collections::HashSet,
    error::Error,
    fmt,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    os::unix::fs::OpenOptionsExt,
    path::{Component, Path, PathBuf},
};

use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::{
    build_protocol::{BuildLimits, CANONICAL_ARTIFACT_MAGIC, GUEST_OUTPUT_MAGIC, GuestReport},
    digest::{cas_path, monotonic_suffix, valid_digest, verify_cas_file},
};

#[derive(Debug, Clone)]
pub(crate) struct ReceivedArtifact {
    pub service_id: String,
    pub kind: String,
    pub archive_digest: String,
    pub packed_bytes: u64,
    pub unpacked_bytes: u64,
    pub entry_count: u32,
    pub paths: HashSet<String>,
    pub package_json: Option<Vec<u8>>,
}

pub(crate) struct GuestOutput {
    pub report: GuestReport,
    pub artifacts: Vec<ReceivedArtifact>,
}

#[derive(Debug)]
struct OutputLimitExceeded {
    code: &'static str,
}

impl fmt::Display for OutputLimitExceeded {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

impl Error for OutputLimitExceeded {}

struct TemporaryArtifact {
    path: PathBuf,
}

impl TemporaryArtifact {
    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TemporaryArtifact {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

pub(crate) fn output_limit_code(error: &io::Error) -> Option<&'static str> {
    error
        .get_ref()?
        .downcast_ref::<OutputLimitExceeded>()
        .map(|limit| limit.code)
}

pub(crate) fn receive(
    mut reader: impl Read,
    cas_root: &Path,
    quarantine: &Path,
    limits: &BuildLimits,
    forbidden_values: &[Zeroizing<Vec<u8>>],
) -> io::Result<GuestOutput> {
    let mut magic = [0_u8; 4];
    reader.read_exact(&mut magic)?;
    if &magic != GUEST_OUTPUT_MAGIC {
        return Err(invalid("guest output magic"));
    }
    let report_length = read_u32(&mut reader)?;
    if report_length == 0 || report_length as u64 > limits.report_bytes {
        return Err(invalid("guest report length"));
    }
    let mut report = vec![0_u8; report_length as usize];
    reader.read_exact(&mut report)?;
    let report: GuestReport =
        serde_json::from_slice(&report).map_err(|_| invalid("guest report"))?;
    if !matches!(report.state.as_str(), "succeeded" | "failed")
        || report.code.is_empty()
        || report.code.len() > 64
        || report.phase.is_empty()
        || report.phase.len() > 64
        || report.message.len() > 512
    {
        return Err(invalid("guest report fields"));
    }
    let mut count = [0_u8; 1];
    reader.read_exact(&mut count)?;
    if count[0] > 2 || (report.state == "failed" && count[0] != 0) {
        return Err(invalid("guest artifact count"));
    }
    let mut artifacts = Vec::with_capacity(count[0] as usize);
    let mut kinds = std::collections::HashSet::new();
    for index in 0..count[0] {
        let mut kind = [0_u8; 1];
        reader.read_exact(&mut kind)?;
        let (kind, byte_limit, limit_code) = match kind[0] {
            1 => (
                "static",
                limits.static_output_bytes,
                "static_output_too_large",
            ),
            2 => (
                "application",
                limits.runtime_output_bytes,
                "runtime_output_too_large",
            ),
            _ => return Err(invalid("guest artifact kind")),
        };
        if !kinds.insert(kind) {
            return Err(invalid("duplicate guest artifact kind"));
        }
        let service_id = read_string(&mut reader, 128)?;
        if !valid_uuid(&service_id) {
            return Err(invalid("artifact service id"));
        }
        let entry_count = read_u32(&mut reader)?;
        let claimed_bytes = read_u64(&mut reader)?;
        if entry_count == 0 {
            return Err(invalid("artifact entry count"));
        }
        if entry_count > limits.max_entries {
            return Err(io::Error::new(
                io::ErrorKind::FileTooLarge,
                "artifact entry limit",
            ));
        }
        if claimed_bytes > byte_limit {
            return Err(output_limit(limit_code));
        }
        fs::create_dir_all(quarantine)?;
        let temporary_path =
            quarantine.join(format!("artifact-{index}-{}.tmp", monotonic_suffix()));
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&temporary_path)?;
        // Ownership begins only after create_new succeeds. From this point all
        // parse, read, write, validation, sync, and CAS errors unlink exactly
        // this worker-created quarantine file.
        let temporary = TemporaryArtifact {
            path: temporary_path,
        };
        let mut hasher = Sha256::new();
        write_hashed(&mut file, &mut hasher, CANONICAL_ARTIFACT_MAGIC)?;
        write_hashed(&mut file, &mut hasher, &[kind_byte(kind)])?;
        write_hashed_string(&mut file, &mut hasher, &service_id)?;
        write_hashed(&mut file, &mut hasher, &entry_count.to_be_bytes())?;
        write_hashed(&mut file, &mut hasher, &claimed_bytes.to_be_bytes())?;
        let mut actual_bytes = 0_u64;
        let mut previous = None::<String>;
        let mut paths = HashSet::with_capacity(entry_count as usize);
        let mut package_json = None;
        for _ in 0..entry_count {
            let path = read_string(&mut reader, 1024)?;
            validate_path(&path)?;
            if previous.as_ref().is_some_and(|value| value >= &path) {
                return Err(invalid("artifact path ordering"));
            }
            previous = Some(path.clone());
            paths.insert(path.clone());
            let mode = read_u32(&mut reader)?;
            if !matches!(mode, 0o644 | 0o755) {
                return Err(invalid("artifact mode"));
            }
            let size = read_u64(&mut reader)?;
            actual_bytes = actual_bytes
                .checked_add(size)
                .filter(|total| *total <= byte_limit)
                .ok_or_else(|| output_limit(limit_code))?;
            write_hashed_string(&mut file, &mut hasher, &path)?;
            write_hashed(&mut file, &mut hasher, &mode.to_be_bytes())?;
            write_hashed(&mut file, &mut hasher, &size.to_be_bytes())?;
            let mut captured = (path == "package.json" && size <= 64 * 1024).then(Vec::new);
            copy_hashed(
                &mut reader,
                &mut file,
                &mut hasher,
                size,
                forbidden_values,
                captured.as_mut(),
            )?;
            if captured.is_some() {
                package_json = captured;
            }
        }
        if actual_bytes != claimed_bytes {
            return Err(invalid("artifact byte total"));
        }
        file.sync_all()?;
        let packed_bytes = file.metadata()?.len();
        drop(file);
        let archive_digest = format!("sha256:{:x}", hasher.finalize());
        install_cas(cas_root, temporary.path(), &archive_digest)?;
        artifacts.push(ReceivedArtifact {
            service_id,
            kind: kind.to_owned(),
            archive_digest,
            packed_bytes,
            unpacked_bytes: actual_bytes,
            entry_count,
            paths,
            package_json,
        });
    }
    let mut extra = [0_u8; 1];
    match reader.read(&mut extra) {
        Ok(0) => {}
        Ok(_) => return Err(invalid("trailing guest output")),
        Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
        Err(error) => return Err(error),
    }
    Ok(GuestOutput { report, artifacts })
}

fn install_cas(root: &Path, temporary: &Path, digest: &str) -> io::Result<()> {
    if !valid_digest(digest) {
        return Err(invalid("CAS digest"));
    }
    let destination = cas_path(root, digest)?;
    let directory = destination
        .parent()
        .ok_or_else(|| io::Error::other("CAS parent"))?;
    fs::create_dir_all(directory)?;
    match fs::hard_link(temporary, &destination) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            verify_cas_file(&destination, digest).map(|_| ())?
        }
        Err(error) => return Err(error),
    }
    File::open(directory)?.sync_all()
}

fn copy_hashed(
    reader: &mut impl Read,
    writer: &mut impl Write,
    hasher: &mut Sha256,
    mut remaining: u64,
    forbidden_values: &[Zeroizing<Vec<u8>>],
    mut capture: Option<&mut Vec<u8>>,
) -> io::Result<()> {
    let mut buffer = [0_u8; 64 * 1024];
    let maximum = forbidden_values
        .iter()
        .map(|value| value.len())
        .max()
        .unwrap_or(0);
    let mut tail = Vec::new();
    while remaining > 0 {
        let wanted = usize::try_from(remaining.min(buffer.len() as u64)).unwrap_or(buffer.len());
        let read = reader.read(&mut buffer[..wanted])?;
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "artifact bytes",
            ));
        }
        if maximum > 0 {
            let mut scan = Vec::with_capacity(tail.len() + read);
            scan.extend_from_slice(&tail);
            scan.extend_from_slice(&buffer[..read]);
            if forbidden_values
                .iter()
                .any(|value| !value.is_empty() && contains_bytes(&scan, value))
            {
                return Err(invalid("artifact contains a build credential"));
            }
            let retain = maximum.saturating_sub(1).min(scan.len());
            tail.clear();
            tail.extend_from_slice(&scan[scan.len() - retain..]);
        }
        if let Some(captured) = capture.as_deref_mut() {
            captured.extend_from_slice(&buffer[..read]);
        }
        write_hashed(writer, hasher, &buffer[..read])?;
        remaining -= read as u64;
    }
    Ok(())
}

fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    needle.len() <= haystack.len()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

fn write_hashed(writer: &mut impl Write, hasher: &mut Sha256, bytes: &[u8]) -> io::Result<()> {
    writer.write_all(bytes)?;
    hasher.update(bytes);
    Ok(())
}

fn write_hashed_string(
    writer: &mut impl Write,
    hasher: &mut Sha256,
    value: &str,
) -> io::Result<()> {
    let length = u16::try_from(value.len()).map_err(|_| invalid("artifact string length"))?;
    write_hashed(writer, hasher, &length.to_be_bytes())?;
    write_hashed(writer, hasher, value.as_bytes())
}

fn read_string(reader: &mut impl Read, maximum: usize) -> io::Result<String> {
    let length = read_u16(reader)? as usize;
    if length == 0 || length > maximum {
        return Err(invalid("string length"));
    }
    let mut bytes = vec![0_u8; length];
    reader.read_exact(&mut bytes)?;
    String::from_utf8(bytes).map_err(|_| invalid("string UTF-8"))
}

fn validate_path(value: &str) -> io::Result<()> {
    if value.is_empty() || value.contains(['\\', '\0', '\r', '\n']) {
        return Err(invalid("artifact path"));
    }
    let path = Path::new(value);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(invalid("artifact path"));
    }
    Ok(())
}

fn valid_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

fn kind_byte(kind: &str) -> u8 {
    if kind == "static" { 1 } else { 2 }
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn output_limit(code: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::FileTooLarge, OutputLimitExceeded { code })
}

fn read_u16(reader: &mut impl Read) -> io::Result<u16> {
    let mut bytes = [0_u8; 2];
    reader.read_exact(&mut bytes)?;
    Ok(u16::from_be_bytes(bytes))
}

fn read_u32(reader: &mut impl Read) -> io::Result<u32> {
    let mut bytes = [0_u8; 4];
    reader.read_exact(&mut bytes)?;
    Ok(u32::from_be_bytes(bytes))
}

fn read_u64(reader: &mut impl Read) -> io::Result<u64> {
    let mut bytes = [0_u8; 8];
    reader.read_exact(&mut bytes)?;
    Ok(u64::from_be_bytes(bytes))
}
