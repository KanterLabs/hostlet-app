//! Minimal PID 1 used only inside the disposable build VM.

use std::{
    collections::HashSet,
    error::Error,
    fmt,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    os::unix::fs::PermissionsExt,
    path::{Component, Path, PathBuf},
    process::Command,
    thread,
    time::{Duration, Instant},
};

use crate::build_protocol::{
    BuildService, GUEST_INPUT_MAGIC, GUEST_OUTPUT_MAGIC, GuestReport, GuestRequest, SOURCE_MAGIC,
};

const INPUT_PORT_NAME: &str = "org.hostlet.input";
const OUTPUT_PORT_NAME: &str = "org.hostlet.output";
const MAX_INPUT_BYTES: u32 = 1024 * 1024;
const MAX_SOURCE_PATH: usize = 1024;
const MAX_SOURCE_PADDING: usize = 511;
const MAX_ENV_NAME: usize = 128;
const PORT_READY_TIMEOUT: Duration = Duration::from_secs(10);
const PORT_READY_POLL: Duration = Duration::from_millis(20);

#[derive(Debug)]
struct GuestError {
    phase: &'static str,
    kind: io::ErrorKind,
}

#[derive(Debug)]
struct WorkspaceLimit;

impl fmt::Display for WorkspaceLimit {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("workspace limit")
    }
}

impl Error for WorkspaceLimit {}

#[derive(Debug)]
struct OutputInvalid;

impl fmt::Display for OutputInvalid {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("output invalid")
    }
}

impl Error for OutputInvalid {}

impl GuestError {
    fn from_io(phase: &'static str, error: &io::Error) -> Self {
        Self {
            phase,
            kind: error.kind(),
        }
    }
}

/// Run as PID 1. Once booted, this process must hand control to poweroff and
/// must never return to the kernel, including after an initialization error.
pub fn run() -> ! {
    if let Err(error) = run_guest() {
        write_console_diagnostic(&error);
    }
    let _ = Command::new("/hostlet/bin/busybox").arg("sync").status();
    loop {
        let _ = Command::new("/hostlet/bin/busybox")
            .args(["poweroff", "-f"])
            .status();
        thread::sleep(Duration::from_secs(1));
    }
}

fn run_guest() -> Result<(), GuestError> {
    mount_guest_filesystems().map_err(|error| GuestError::from_io("mount", &error))?;
    let input_path =
        find_port(INPUT_PORT_NAME).map_err(|error| GuestError::from_io("input_port", &error))?;
    let output_path =
        find_port(OUTPUT_PORT_NAME).map_err(|error| GuestError::from_io("output_port", &error))?;
    let mut input =
        open_port(&input_path).map_err(|error| GuestError::from_io("input_open", &error))?;
    let mut output =
        open_port(&output_path).map_err(|error| GuestError::from_io("output_open", &error))?;
    let request = read_guest_request(&mut input).map_err(|error| {
        let guest_error = GuestError::from_io("input_read", &error);
        let _ = write_failure(
            &mut output,
            "platform_fault",
            "input",
            "guest input protocol failed",
        );
        guest_error
    })?;

    let mut output_started = false;
    execute_build(&request, &mut output, &mut output_started).map_err(|error| {
        let guest_error = GuestError::from_io("execute", &error);
        if !output_started {
            let _ = write_failure(
                &mut output,
                "platform_fault",
                "execute",
                "guest execution failed",
            );
        }
        guest_error
    })
}

fn write_console_diagnostic(error: &GuestError) {
    if let Ok(mut console) = OpenOptions::new().write(true).open("/dev/console") {
        let _ = writeln!(
            console,
            "hostlet-build-guest failure phase={} io_kind={:?}",
            error.phase, error.kind
        );
        let _ = console.flush();
    }
}

fn mount_guest_filesystems() -> io::Result<()> {
    for directory in ["/proc", "/sys", "/dev", "/tmp", "/workspace", "/cache"] {
        fs::create_dir_all(directory)?;
    }
    mount_if_needed("proc", "/proc", "proc", &[])?;
    mount_if_needed("sysfs", "/sys", "sysfs", &[])?;
    mount_if_needed("devtmpfs", "/dev", "devtmpfs", &[])?;
    mount_if_needed("tmpfs", "/tmp", "tmpfs", &["size=268435456", "mode=1777"])?;
    mount_if_needed("/dev/vdc", "/cache", "ext4", &["ro", "nodev", "nosuid"])?;
    mount_if_needed("/dev/vdd", "/workspace", "ext4", &["nodev", "nosuid"])?;
    Ok(())
}

fn mount_if_needed(source: &str, target: &str, kind: &str, options: &[&str]) -> io::Result<()> {
    if is_mounted(target)? {
        return Ok(());
    }
    let mut command = Command::new("/hostlet/bin/busybox");
    command.args(["mount", "-t", kind]);
    if !options.is_empty() {
        command.args(["-o", &options.join(",")]);
    }
    let status = command.args([source, target]).status()?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other("guest mount failed"))
    }
}

fn is_mounted(target: &str) -> io::Result<bool> {
    let mounts = fs::read_to_string("/proc/mounts").unwrap_or_default();
    Ok(mounts
        .lines()
        .any(|line| line.split_ascii_whitespace().nth(1) == Some(target)))
}

fn find_port(expected_name: &str) -> io::Result<PathBuf> {
    let started = Instant::now();
    loop {
        let kind = match find_port_once(expected_name) {
            Ok(Some(path)) => return Ok(path),
            Ok(None) => io::ErrorKind::NotFound,
            Err(error) => error.kind(),
        };
        if started.elapsed() >= PORT_READY_TIMEOUT {
            return Err(io::Error::new(kind, "virtio port unavailable"));
        }
        thread::sleep(PORT_READY_POLL);
    }
}

fn find_port_once(expected_name: &str) -> io::Result<Option<PathBuf>> {
    for entry in fs::read_dir("/sys/class/virtio-ports")? {
        let entry = entry?;
        let name = fs::read_to_string(entry.path().join("name"))?;
        if name.trim() == expected_name {
            return Ok(Some(Path::new("/dev").join(entry.file_name())));
        }
    }
    Ok(None)
}

fn open_port(path: &Path) -> io::Result<File> {
    let started = Instant::now();
    loop {
        match OpenOptions::new().read(true).write(true).open(path) {
            Ok(file) => return Ok(file),
            Err(_) if started.elapsed() < PORT_READY_TIMEOUT => {
                thread::sleep(PORT_READY_POLL);
            }
            Err(error) => return Err(io::Error::new(error.kind(), "virtio port unavailable")),
        }
    }
}

fn read_guest_request(reader: &mut impl Read) -> io::Result<GuestRequest> {
    let mut magic = [0_u8; 4];
    reader.read_exact(&mut magic)?;
    if &magic != GUEST_INPUT_MAGIC {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "input magic"));
    }
    let length = read_u32(reader)?;
    if length == 0 || length > MAX_INPUT_BYTES {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "input length"));
    }
    let mut bytes = vec![0_u8; length as usize];
    reader.read_exact(&mut bytes)?;
    let request: GuestRequest = serde_json::from_slice(&bytes)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "input JSON"))?;
    if request.protocol != "hostlet.build-guest/v1"
        || !valid_uuid(&request.job_id)
        || !valid_uuid(&request.attempt_id)
        || request.fence == 0
        || !valid_digest(&request.input_manifest_digest)
        || !valid_git_sha(&request.source_commit)
        || !valid_git_sha(&request.source_tree_sha)
        || !valid_digest(&request.source_bundle_digest)
        || !valid_digest(&request.dependency_cache_digest)
        || request.services.is_empty()
        || request.services.len() > 2
        || request.credentials.len() > 32
    {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "input contract"));
    }
    let services: HashSet<&str> = request
        .services
        .iter()
        .map(|service| service.service_id.as_str())
        .collect();
    if services.len() != request.services.len()
        || request.services.iter().any(|service| {
            !valid_uuid(&service.service_id)
                || !matches!(service.node_major, 22 | 24)
                || service.framework.is_empty()
                || service.framework.len() > 64
                || service
                    .start_command
                    .as_ref()
                    .is_some_and(|value| value.len() > 1024)
                || service.health_path.as_ref().is_some_and(|value| {
                    value.len() > 256 || !value.starts_with('/') || value.contains(['\r', '\n'])
                })
        })
        || request.credentials.iter().any(|credential| {
            !services.contains(credential.service_id.as_str())
                || !valid_uuid(&credential.secret_version_id)
                || !valid_env_name(&credential.name)
                || credential.value.is_empty()
                || credential.value.len() > 16 * 1024
        })
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "input service contract",
        ));
    }
    Ok(request)
}

fn execute_build(
    request: &GuestRequest,
    output: &mut impl Write,
    output_started: &mut bool,
) -> io::Result<()> {
    let source_root = Path::new("/workspace/source");
    if let Err(error) = fs::create_dir_all(source_root) {
        let error = normalize_workspace_error(error);
        if is_workspace_failure(&error) {
            return write_terminal_failure(
                output,
                output_started,
                "workspace_limit",
                "source",
                &error.to_string(),
            );
        }
        return Err(error);
    }
    if let Err(error) = extract_source(File::open("/dev/vdb")?, source_root) {
        let error = normalize_workspace_error(error);
        let code = if is_workspace_failure(&error) {
            "workspace_limit"
        } else {
            "source_bundle_invalid"
        };
        return write_terminal_failure(output, output_started, code, "source", &error.to_string());
    }
    let cache_status = match Command::new("/hostlet/bin/busybox")
        .args(["cp", "-a", "/cache/npm", "/workspace/npm-cache"])
        .status()
    {
        Ok(status) => status,
        Err(error) => {
            let error = normalize_workspace_error(error);
            if is_workspace_failure(&error) {
                return write_terminal_failure(
                    output,
                    output_started,
                    "workspace_limit",
                    "dependency",
                    &error.to_string(),
                );
            }
            return Err(error);
        }
    };
    if !cache_status.success() {
        if workspace_exhausted()? {
            return write_terminal_failure(
                output,
                output_started,
                "workspace_limit",
                "dependency",
                "the build workspace is full",
            );
        }
        return write_terminal_failure(
            output,
            output_started,
            "dependency_not_available_offline",
            "dependency",
            "the pinned dependency cache could not be prepared",
        );
    }

    for service in &request.services {
        if let Err(error) = run_service(request, service, source_root) {
            let error = normalize_workspace_error(error);
            let message = error.to_string();
            let code = if is_workspace_failure(&error) {
                "workspace_limit"
            } else if message == "locked offline dependency install failed" {
                "dependency_not_available_offline"
            } else {
                "build_command_failed"
            };
            return write_terminal_failure(output, output_started, code, "build", &message);
        }
    }
    match write_success(output, request, source_root, output_started) {
        Err(error) if !*output_started && is_workspace_failure(&error) => write_terminal_failure(
            output,
            output_started,
            "workspace_limit",
            "output",
            &error.to_string(),
        ),
        Err(error)
            if !*output_started
                && error
                    .get_ref()
                    .is_some_and(|cause| cause.is::<OutputInvalid>()) =>
        {
            write_terminal_failure(
                output,
                output_started,
                "output_invalid",
                "output",
                "the declared output is invalid",
            )
        }
        result => result,
    }
}

fn extract_source(mut reader: impl Read, destination: &Path) -> io::Result<()> {
    let mut magic = [0_u8; 4];
    reader.read_exact(&mut magic)?;
    if &magic != SOURCE_MAGIC {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "source magic"));
    }
    let entries = read_u32(&mut reader)?;
    if entries > 100_000 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "source entries"));
    }
    let mut previous = None::<String>;
    for _ in 0..entries {
        let path_length = read_u16(&mut reader)? as usize;
        if path_length == 0 || path_length > MAX_SOURCE_PATH {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "source path length",
            ));
        }
        let mut path_bytes = vec![0_u8; path_length];
        reader.read_exact(&mut path_bytes)?;
        let relative = String::from_utf8(path_bytes)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "source path UTF-8"))?;
        validate_relative_path(&relative)?;
        if previous.as_ref().is_some_and(|value| value >= &relative) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "source ordering",
            ));
        }
        previous = Some(relative.clone());
        let mode = read_u32(&mut reader)?;
        if !matches!(mode, 0o644 | 0o755) {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "source mode"));
        }
        let size = read_u64(&mut reader)?;
        let target = destination.join(&relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&target)?;
        io::copy(&mut reader.by_ref().take(size), &mut file).and_then(|copied| {
            if copied == size {
                Ok(copied)
            } else {
                Err(io::Error::new(io::ErrorKind::UnexpectedEof, "source bytes"))
            }
        })?;
        file.set_permissions(fs::Permissions::from_mode(mode))?;
    }
    let mut padding = [0_u8; MAX_SOURCE_PADDING];
    let mut length = 0;
    loop {
        let read = reader.read(&mut padding[length..])?;
        if read == 0 {
            return Ok(());
        }
        if padding[length..length + read].iter().any(|byte| *byte != 0) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "source trailing bytes",
            ));
        }
        length += read;
        if length == MAX_SOURCE_PADDING {
            let mut extra = [0_u8; 1];
            if reader.read(&mut extra)? != 0 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "source padding length",
                ));
            }
            return Ok(());
        }
    }
}

fn run_service(
    request: &GuestRequest,
    service: &BuildService,
    source_root: &Path,
) -> io::Result<()> {
    if service.root != "." {
        validate_relative_path(&service.root)?;
    }
    validate_relative_path(&service.lockfile_path)?;
    validate_relative_path(&service.output_directory)?;
    let root = if service.root == "." {
        source_root.to_path_buf()
    } else {
        source_root.join(&service.root)
    };
    if !root.is_dir() || !root.join(&service.lockfile_path).is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "service root or lockfile",
        ));
    }
    let mut environment = Vec::new();
    let mut names = HashSet::new();
    for credential in request
        .credentials
        .iter()
        .filter(|credential| credential.service_id == service.service_id)
    {
        if !valid_env_name(&credential.name) || !names.insert(credential.name.as_str()) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "credential name",
            ));
        }
        environment.push((credential.name.as_str(), credential.value.as_str()));
    }
    let home = Path::new("/workspace/home").join(&service.service_id);
    fs::create_dir_all(&home)?;
    let common = |command: &mut Command| {
        command
            .current_dir(&root)
            .env_clear()
            .env("PATH", "/usr/local/bin:/usr/bin:/bin")
            .env("HOME", &home)
            .env("npm_config_cache", "/workspace/npm-cache")
            .env("npm_config_audit", "false")
            .env("npm_config_fund", "false");
        for (name, value) in &environment {
            command.env(name, value);
        }
    };
    let mut install = Command::new("/usr/local/bin/npm");
    common(&mut install);
    let status = install
        .args(["ci", "--offline", "--no-audit", "--no-fund"])
        .status()?;
    if !status.success() {
        if workspace_exhausted()? {
            return Err(workspace_limit());
        }
        return Err(io::Error::other("locked offline dependency install failed"));
    }
    let mut build = Command::new("/bin/sh");
    common(&mut build);
    build.env("NODE_ENV", "production");
    let status = build.args(["-lc", &service.build_command]).status()?;
    if !status.success() {
        if workspace_exhausted()? {
            return Err(workspace_limit());
        }
        return Err(io::Error::other("declared build command failed"));
    }
    if service.kind == "application" && service.framework == "node_http" {
        let mut prune = Command::new("/usr/local/bin/npm");
        common(&mut prune);
        let status = prune
            .args([
                "prune",
                "--omit=dev",
                "--offline",
                "--no-audit",
                "--no-fund",
            ])
            .status()?;
        if !status.success() {
            if workspace_exhausted()? {
                return Err(workspace_limit());
            }
            return Err(io::Error::other("locked offline dependency install failed"));
        }
    }
    Ok(())
}

fn workspace_exhausted() -> io::Result<bool> {
    let output = Command::new("/hostlet/bin/busybox")
        // `%a` is usable capacity; `%f` includes ext4-reserved blocks that
        // cannot satisfy the build's allocation and would misclassify ENOSPC.
        .args(["stat", "-f", "-c", "%a %S", "/workspace"])
        .output()?;
    if !output.status.success() || output.stdout.len() > 128 {
        return Err(io::Error::other("workspace capacity probe failed"));
    }
    let text = std::str::from_utf8(&output.stdout)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "workspace capacity"))?;
    let mut fields = text.split_ascii_whitespace();
    let available_blocks = fields
        .next()
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "workspace capacity"))?;
    let block_size = fields
        .next()
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "workspace capacity"))?;
    if fields.next().is_some() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "workspace capacity",
        ));
    }
    Ok(available_blocks.saturating_mul(block_size) <= 1024 * 1024)
}

fn workspace_limit() -> io::Error {
    io::Error::new(io::ErrorKind::StorageFull, WorkspaceLimit)
}

fn write_failure(
    output: &mut impl Write,
    code: &str,
    phase: &str,
    message: &str,
) -> io::Result<()> {
    write_output_header(
        output,
        &GuestReport {
            state: "failed".to_owned(),
            code: code.to_owned(),
            phase: phase.to_owned(),
            message: bounded_message(message),
        },
        0,
    )
}

fn write_terminal_failure(
    output: &mut impl Write,
    output_started: &mut bool,
    code: &str,
    phase: &str,
    message: &str,
) -> io::Result<()> {
    *output_started = true;
    write_failure(output, code, phase, message)
}

struct PlannedArtifact<'a> {
    service_id: &'a str,
    kind: u8,
    entries: Vec<PlannedEntry>,
    entry_count: u32,
    total: u64,
}

struct PlannedEntry {
    relative: String,
    path: PathBuf,
    mode: u32,
    size: u64,
}

fn write_success(
    output: &mut impl Write,
    request: &GuestRequest,
    source_root: &Path,
    output_started: &mut bool,
) -> io::Result<()> {
    let mut artifacts = Vec::with_capacity(request.services.len());
    for service in &request.services {
        let root = if service.root == "." {
            source_root.to_path_buf()
        } else {
            source_root.join(&service.root)
        };
        let mut entries = Vec::new();
        let artifact_root = root.join(&service.output_directory);
        if service.kind == "application" && service.framework == "node_http" {
            collect_files(
                &artifact_root,
                &artifact_root,
                &service.output_directory,
                &mut entries,
            )?;
            for file in ["package.json", service.lockfile_path.as_str()] {
                let path = root.join(file);
                collect_one_file(&path, file, &mut entries)?;
            }
            let modules = root.join("node_modules");
            match fs::symlink_metadata(&modules) {
                Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                    collect_files(&modules, &modules, "node_modules", &mut entries)?;
                }
                Ok(_) => {
                    return Err(output_invalid());
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        } else {
            collect_files(&artifact_root, &artifact_root, "", &mut entries)?;
        }
        entries.sort_by(|left, right| left.0.cmp(&right.0));
        if entries
            .windows(2)
            .any(|pair| pair[0].0.as_str() >= pair[1].0.as_str())
        {
            return Err(output_invalid());
        }
        let entries: Vec<PlannedEntry> = entries
            .into_iter()
            .map(|(relative, path, mode)| {
                let metadata = fs::symlink_metadata(&path).map_err(|error| {
                    if error.kind() == io::ErrorKind::NotFound {
                        output_invalid()
                    } else {
                        error
                    }
                })?;
                if !metadata.is_file() || metadata.file_type().is_symlink() {
                    return Err(output_invalid());
                }
                let size = metadata.len();
                Ok(PlannedEntry {
                    relative,
                    path,
                    mode,
                    size,
                })
            })
            .collect::<io::Result<_>>()?;
        let total = entries.iter().try_fold(0_u64, |sum, entry| {
            sum.checked_add(entry.size).ok_or_else(output_invalid)
        })?;
        let (kind, byte_limit, limit_code) = match service.kind.as_str() {
            "static_frontend" => (
                1_u8,
                request.limits.static_output_bytes,
                "static_output_too_large",
            ),
            "application" => (
                2_u8,
                request.limits.runtime_output_bytes,
                "runtime_output_too_large",
            ),
            _ => return Err(io::Error::new(io::ErrorKind::InvalidData, "service kind")),
        };
        if total > byte_limit {
            return write_terminal_failure(
                output,
                output_started,
                limit_code,
                "output",
                "the declared output exceeds its byte limit",
            );
        }
        let entry_count = u32::try_from(entries.len()).map_err(|_| output_invalid())?;
        if entry_count == 0 || entry_count > request.limits.max_entries {
            return Err(output_invalid());
        }
        artifacts.push(PlannedArtifact {
            service_id: &service.service_id,
            kind,
            entries,
            entry_count,
            total,
        });
    }

    let artifact_count = u8::try_from(artifacts.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "artifact count"))?;
    *output_started = true;
    write_output_header(
        output,
        &GuestReport {
            state: "succeeded".to_owned(),
            code: "build_succeeded".to_owned(),
            phase: "complete".to_owned(),
            message: "the declared outputs were produced".to_owned(),
        },
        artifact_count,
    )?;
    for artifact in artifacts {
        output.write_all(&[artifact.kind])?;
        write_string(output, artifact.service_id)?;
        output.write_all(&artifact.entry_count.to_be_bytes())?;
        output.write_all(&artifact.total.to_be_bytes())?;
        for entry in artifact.entries {
            write_string(output, &entry.relative)?;
            output.write_all(&entry.mode.to_be_bytes())?;
            output.write_all(&entry.size.to_be_bytes())?;
            io::copy(&mut File::open(entry.path)?.take(entry.size), &mut *output)?;
        }
    }
    output.flush()
}

fn write_output_header(output: &mut impl Write, report: &GuestReport, count: u8) -> io::Result<()> {
    let report = serde_json::to_vec(report).map_err(|_| io::Error::other("report JSON"))?;
    output.write_all(GUEST_OUTPUT_MAGIC)?;
    output.write_all(&(report.len() as u32).to_be_bytes())?;
    output.write_all(&report)?;
    output.write_all(&[count])?;
    output.flush()
}

fn collect_files(
    root: &Path,
    current: &Path,
    prefix: &str,
    output: &mut Vec<(String, PathBuf, u32)>,
) -> io::Result<()> {
    let root_metadata = fs::symlink_metadata(root).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            output_invalid()
        } else {
            error
        }
    })?;
    if !root_metadata.is_dir() || root_metadata.file_type().is_symlink() {
        return Err(output_invalid());
    }
    let current_metadata = fs::symlink_metadata(current).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            output_invalid()
        } else {
            error
        }
    })?;
    if !current_metadata.is_dir() || current_metadata.file_type().is_symlink() {
        return Err(output_invalid());
    }
    for entry in fs::read_dir(current)? {
        let entry = entry?;
        let metadata = fs::symlink_metadata(entry.path())?;
        if metadata.file_type().is_symlink() || !(metadata.is_file() || metadata.is_dir()) {
            return Err(output_invalid());
        }
        if metadata.is_dir() {
            collect_files(root, &entry.path(), prefix, output)?;
        } else {
            let relative = entry
                .path()
                .strip_prefix(root)
                .map_err(|_| io::Error::other("artifact path"))?
                .to_str()
                .ok_or_else(output_invalid)?
                .to_owned();
            let relative = if prefix.is_empty() {
                relative
            } else {
                format!("{prefix}/{relative}")
            };
            validate_relative_path(&relative).map_err(|_| output_invalid())?;
            let mode = if metadata.permissions().mode() & 0o111 != 0 {
                0o755
            } else {
                0o644
            };
            output.push((relative, entry.path(), mode));
        }
    }
    Ok(())
}

fn collect_one_file(
    path: &Path,
    relative: &str,
    output: &mut Vec<(String, PathBuf, u32)>,
) -> io::Result<()> {
    validate_relative_path(relative).map_err(|_| output_invalid())?;
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            output_invalid()
        } else {
            error
        }
    })?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(output_invalid());
    }
    let mode = if metadata.permissions().mode() & 0o111 != 0 {
        0o755
    } else {
        0o644
    };
    output.push((relative.to_owned(), path.to_path_buf(), mode));
    Ok(())
}

fn validate_relative_path(value: &str) -> io::Result<()> {
    if value.is_empty() || value.len() > MAX_SOURCE_PATH || value.contains(['\\', '\0', '\r', '\n'])
    {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "unsafe path"));
    }
    let path = Path::new(value);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "unsafe path"));
    }
    Ok(())
}

fn valid_env_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ENV_NAME
        && value.bytes().enumerate().all(|(index, byte)| {
            byte == b'_' || byte.is_ascii_alphabetic() || (index > 0 && byte.is_ascii_digit())
        })
}

fn valid_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

fn valid_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_git_sha(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn bounded_message(value: &str) -> String {
    value.chars().take(256).collect()
}

fn output_invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, OutputInvalid)
}

fn is_workspace_failure(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::StorageFull
        // Linux ENOSPC is stable across the supported build guest images,
        // while the raw errno check also catches older stdlib mappings.
        || error.raw_os_error() == Some(28)
        || error
            .get_ref()
            .is_some_and(|cause| cause.is::<WorkspaceLimit>())
}

fn normalize_workspace_error(error: io::Error) -> io::Error {
    if is_workspace_failure(&error) {
        workspace_limit()
    } else {
        error
    }
}

fn write_string(writer: &mut impl Write, value: &str) -> io::Result<()> {
    let length = u16::try_from(value.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "string length"))?;
    writer.write_all(&length.to_be_bytes())?;
    writer.write_all(value.as_bytes())
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
