use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    net::Shutdown,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
    os::unix::net::{UnixListener, UnixStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

use serde::Deserialize;
use zeroize::Zeroizing;

use crate::{
    artifact::{self, GuestOutput},
    build_protocol::{GUEST_INPUT_MAGIC, GuestRequest},
    digest::verify_file,
};

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct BuildProfile {
    pub schema: String,
    pub id: String,
    pub qemu_binary: PathBuf,
    pub qemu_digest: String,
    pub kernel: PinnedFile,
    pub initrd: PinnedFile,
    pub rootfs: PinnedFile,
    pub dependency_cache: PinnedFile,
    pub mkfs_ext4: PathBuf,
    pub sudo: PathBuf,
    pub systemd_run: PathBuf,
    pub systemctl: PathBuf,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PinnedFile {
    pub path: PathBuf,
    pub digest: String,
}

pub(crate) struct CleanupEvidence {
    pub qemu_exited: bool,
    pub killed_for_timeout: bool,
    pub killed_for_fence: bool,
    pub sockets_removed: bool,
    pub workspace_removed: bool,
    pub console_truncated: bool,
}

pub(crate) struct VmResult {
    pub output: Result<GuestOutput, io::Error>,
    /// Wall-clock duration supplied to the worker's billing clamp before the
    /// completion request is sent.
    pub elapsed_seconds: u64,
    /// Full wall-clock supervisor duration, including guest termination and
    /// filesystem/socket cleanup. This is evidence only and is never billed.
    pub actual_elapsed_seconds: u64,
    pub cleanup: CleanupEvidence,
    pub launch_diagnostic: Vec<u8>,
    pub guest_console: Vec<u8>,
}

pub(crate) fn verify_profile(profile: &BuildProfile) -> io::Result<()> {
    if profile.schema != "hostlet.build-profile/v1"
        || profile.id.is_empty()
        || profile.id.len() > 64
        || !profile
            .id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(invalid("profile identity"));
    }
    for path in [
        &profile.qemu_binary,
        &profile.kernel.path,
        &profile.initrd.path,
        &profile.rootfs.path,
        &profile.dependency_cache.path,
        &profile.mkfs_ext4,
        &profile.sudo,
        &profile.systemd_run,
        &profile.systemctl,
    ] {
        if !path.is_absolute() || !path.is_file() {
            return Err(invalid("profile path"));
        }
    }
    verify_file(&profile.qemu_binary, &profile.qemu_digest)?;
    for pinned in [
        &profile.kernel,
        &profile.initrd,
        &profile.rootfs,
        &profile.dependency_cache,
    ] {
        verify_file(&pinned.path, &pinned.digest)?;
    }
    Ok(())
}

pub(crate) fn run(
    profile: &BuildProfile,
    request: &GuestRequest,
    source_bundle: &Path,
    attempt_dir: &Path,
    cas_root: &Path,
    fenced: Arc<AtomicBool>,
) -> io::Result<VmResult> {
    verify_profile(profile)?;
    fs::create_dir_all(attempt_dir)?;
    let socket_dir = create_socket_directory(request)?;
    let source_device = attempt_dir.join("source.raw");
    make_padded_source(source_bundle, &source_device)?;
    let workspace = attempt_dir.join("workspace.ext4");
    make_workspace(profile, &workspace, request.limits.workspace_bytes)?;

    let input_socket = socket_dir.join("input.sock");
    let output_socket = socket_dir.join("output.sock");
    let console_socket = socket_dir.join("console.sock");
    let input_listener = listener(&input_socket)?;
    let output_listener = listener(&output_socket)?;
    let console_listener = listener(&console_socket)?;
    let request_bytes =
        Zeroizing::new(serde_json::to_vec(request).map_err(|_| invalid("guest input JSON"))?);
    if request_bytes.len() > 1024 * 1024 {
        return Err(invalid("guest input limit"));
    }
    let stop = Arc::new(AtomicBool::new(false));
    let input_stop = Arc::clone(&stop);
    let input_thread = thread::spawn(move || send_input(input_listener, request_bytes, input_stop));
    // Keep uncommitted artifact bytes on the CAS filesystem so the final
    // no-replace hard link is atomic and cannot fail across mount points.
    let quarantine = cas_root.join("sha256");
    let output_stop = Arc::clone(&stop);
    let output_cas = cas_root.to_path_buf();
    let output_limits = request.limits.clone();
    let forbidden_values: Vec<Zeroizing<Vec<u8>>> = request
        .credentials
        .iter()
        .map(|credential| Zeroizing::new(credential.value.as_bytes().to_vec()))
        .collect();
    let (output_sender, output_receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let result = accept(&output_listener, &output_stop).and_then(|stream| {
            artifact::receive(
                stream,
                &output_cas,
                &quarantine,
                &output_limits,
                &forbidden_values,
            )
        });
        let _ = output_sender.send(result);
    });
    let console_stop = Arc::clone(&stop);
    let console_path = attempt_dir.join("console.log");
    let console_capture_path = console_path.clone();
    let console_limit = request.limits.console_bytes;
    let (console_sender, console_receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let truncated = capture_console(
            console_listener,
            &console_capture_path,
            console_limit,
            console_stop,
        )
        .unwrap_or(false);
        let _ = console_sender.send(truncated);
    });

    let unit = unit_name(&request.job_id, &request.attempt_id)?;
    let (mut process, launch_captures, launch_log) = match launch(
        profile,
        request,
        &unit,
        &source_device,
        &workspace,
        &input_socket,
        &output_socket,
        &console_socket,
        attempt_dir,
        &socket_dir,
    ) {
        Ok(process) => process,
        Err(error) => {
            stop.store(true, Ordering::SeqCst);
            let _ = input_thread.join();
            let _ = output_receiver.recv_timeout(Duration::from_secs(1));
            let _ = console_receiver.recv_timeout(Duration::from_secs(1));
            let _ = remove_owned_socket_directory(request);
            let _ = remove_paths([&workspace, &source_device]);
            return Err(error);
        }
    };
    let mut unit_guard = UnitGuard::new(profile, &unit);
    let started = Instant::now();
    let deadline = Duration::from_secs(request.limits.timeout_seconds);
    let mut killed_for_timeout = false;
    let mut killed_for_fence = false;
    let mut observed_output = None;
    let status = loop {
        if let Some(status) = process.try_wait()? {
            break status;
        }
        if fenced.load(Ordering::SeqCst) {
            killed_for_fence = true;
            terminate(profile, &unit, &mut process);
        } else if started.elapsed() >= deadline {
            killed_for_timeout = true;
            terminate(profile, &unit, &mut process);
        }
        if killed_for_fence || killed_for_timeout {
            break process.wait()?;
        }
        if observed_output.is_none() {
            match output_receiver.try_recv() {
                Ok(result) => {
                    let failed = result.is_err();
                    observed_output = Some(result);
                    if failed {
                        terminate(profile, &unit, &mut process);
                        break process.wait()?;
                    }
                }
                Err(mpsc::TryRecvError::Empty) => {}
                Err(mpsc::TryRecvError::Disconnected) => {
                    observed_output = Some(Err(io::Error::new(
                        io::ErrorKind::BrokenPipe,
                        "guest output receiver disconnected",
                    )));
                    terminate(profile, &unit, &mut process);
                    break process.wait()?;
                }
            }
        }
        thread::sleep(Duration::from_millis(100));
    };
    unit_guard.disarm();
    for capture in launch_captures {
        let _ = capture.join();
    }
    let launch_diagnostic = fs::read(&launch_log).unwrap_or_default();
    stop.store(true, Ordering::SeqCst);
    let _ = input_thread.join();
    let output = if killed_for_timeout {
        Err(io::Error::new(io::ErrorKind::TimedOut, "build timeout"))
    } else if killed_for_fence {
        Err(io::Error::new(io::ErrorKind::Interrupted, "build fenced"))
    } else {
        match observed_output {
            Some(Err(error)) => Err(error),
            Some(Ok(_)) | None if !status.success() => {
                Err(io::Error::other("QEMU build guest failed"))
            }
            Some(Ok(output)) => Ok(output),
            None => output_receiver
                .recv_timeout(Duration::from_secs(5))
                .unwrap_or_else(|_| {
                    Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "guest output close",
                    ))
                }),
        }
    };
    let console_truncated = console_receiver
        .recv_timeout(Duration::from_secs(2))
        .unwrap_or(false);
    let guest_console = fs::read(&console_path).unwrap_or_default();
    let sockets_removed = remove_owned_socket_directory(request);
    let workspace_removed = remove_paths([&workspace, &source_device, &launch_log]);
    let _ = fs::remove_file(attempt_dir.join("console.log"));
    let _ = Command::new(&profile.sudo)
        .args(["-n"])
        .arg(&profile.systemctl)
        .args(["reset-failed", &unit])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let actual_elapsed_seconds = started.elapsed().as_secs().max(1);
    Ok(VmResult {
        output,
        elapsed_seconds: actual_elapsed_seconds,
        actual_elapsed_seconds,
        cleanup: CleanupEvidence {
            qemu_exited: true,
            killed_for_timeout,
            killed_for_fence,
            sockets_removed,
            workspace_removed,
            console_truncated,
        },
        launch_diagnostic,
        guest_console,
    })
}

// QEMU receives only explicit verified paths and identities; grouping these
// into a mutable launch bag would weaken the reviewable trust boundary.
#[allow(clippy::too_many_arguments)]
fn launch(
    profile: &BuildProfile,
    request: &GuestRequest,
    unit: &str,
    source: &Path,
    workspace: &Path,
    input: &Path,
    output: &Path,
    console: &Path,
    attempt_dir: &Path,
    socket_dir: &Path,
) -> io::Result<(Child, Vec<thread::JoinHandle<()>>, PathBuf)> {
    let uid = numeric_uid()?;
    let quota = format!("CPUQuota={}%", request.limits.cpu_millis / 10);
    let memory_max = request
        .limits
        .memory_bytes
        .checked_add(512 * 1024 * 1024)
        .ok_or_else(|| invalid("memory limit"))?;
    let runtime_max = request
        .limits
        .timeout_seconds
        .checked_add(15)
        .ok_or_else(|| invalid("runtime limit"))?;
    let description = format!(
        "Description=Hostlet build job {} attempt {}",
        request.job_id, request.attempt_id
    );
    let mut command = Command::new(&profile.sudo);
    command
        .args(["-n"])
        .arg(&profile.systemd_run)
        .args(["--wait", "--collect", "--quiet", "--pipe", "--unit", unit])
        .arg(format!("--uid={uid}"))
        .args(["--property", "SupplementaryGroups=kvm"])
        .args(["--property", "NoNewPrivileges=yes"])
        .args(["--property", "PrivateTmp=yes"])
        .args(["--property", "ProtectSystem=strict"])
        .args(["--property", "ProtectHome=tmpfs"])
        .args(["--property", "RestrictAddressFamilies=AF_UNIX"])
        .args(["--property", "DevicePolicy=closed"])
        .args(["--property", "DeviceAllow=/dev/kvm rw"])
        .args(["--property", "DeviceAllow=/dev/null rw"])
        .args(["--property", "DeviceAllow=/dev/urandom r"])
        .args(["--property", "DeviceAllow=/dev/random r"])
        .args(["--property", "TasksMax=64"])
        .args(["--property", "KillMode=control-group"])
        .args(["--property", "TimeoutStopSec=5s"])
        .args(["--property", &format!("RuntimeMaxSec={runtime_max}s")])
        .args(["--property", &description])
        .args(["--property", &quota])
        .args(["--property", &format!("MemoryMax={memory_max}")])
        .args([
            "--property",
            &format!(
                "BindPaths={} {}",
                attempt_dir.display(),
                socket_dir.display()
            ),
        ])
        .args([
            "--property",
            &format!("BindReadOnlyPaths={}", profile.kernel.path.display()),
        ])
        .args([
            "--property",
            &format!("BindReadOnlyPaths={}", profile.initrd.path.display()),
        ])
        .args([
            "--property",
            &format!("BindReadOnlyPaths={}", profile.rootfs.path.display()),
        ])
        .args([
            "--property",
            &format!(
                "BindReadOnlyPaths={}",
                profile.dependency_cache.path.display()
            ),
        ])
        .arg("--")
        .arg(&profile.qemu_binary)
        .args(["-enable-kvm", "-machine", "q35,accel=kvm", "-cpu", "host"])
        .args([
            "-smp",
            "2",
            "-m",
            "2048",
            "-nodefaults",
            "-no-reboot",
            "-display",
            "none",
            "-nic",
            "none",
        ])
        .args([
            "-sandbox",
            "on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny",
        ])
        .arg("-kernel")
        .arg(&profile.kernel.path)
        .arg("-initrd")
        .arg(&profile.initrd.path)
        .args([
            "-append",
            "root=/dev/vda rootwait ro console=ttyS0 panic=-1 init=/sbin/hostlet-build-guest",
        ])
        .args([
            "-object",
            "iothread,id=buildio,thread-pool-min=1,thread-pool-max=8",
        ])
        .args(["-drive", &drive("root", &profile.rootfs.path, true)])
        .args(["-device", "virtio-blk-pci,drive=root,iothread=buildio"])
        .args(["-drive", &drive("source", source, true)])
        .args(["-device", "virtio-blk-pci,drive=source,iothread=buildio"])
        .args([
            "-drive",
            &drive("cache", &profile.dependency_cache.path, true),
        ])
        .args(["-device", "virtio-blk-pci,drive=cache,iothread=buildio"])
        .args(["-drive", &drive("workspace", workspace, false)])
        .args(["-device", "virtio-blk-pci,drive=workspace,iothread=buildio"])
        .args(["-device", "virtio-serial-pci"])
        .args(["-chardev", &chardev("input", input)])
        .args([
            "-device",
            "virtserialport,chardev=input,name=org.hostlet.input",
        ])
        .args(["-chardev", &chardev("output", output)])
        .args([
            "-device",
            "virtserialport,chardev=output,name=org.hostlet.output",
        ])
        .args(["-chardev", &chardev("console", console)])
        .args(["-serial", "chardev:console"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let log_path = attempt_dir.join("launch.log");
    let log = Arc::new(Mutex::new(
        OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&log_path)?,
    ));
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let _ = fs::remove_file(&log_path);
            return Err(error);
        }
    };
    let mut captures = Vec::with_capacity(2);
    if let Some(stdout) = child.stdout.take() {
        captures.push(capture_launch_output(stdout, Arc::clone(&log)));
    }
    if let Some(stderr) = child.stderr.take() {
        captures.push(capture_launch_output(stderr, Arc::clone(&log)));
    }
    Ok((child, captures, log_path))
}

fn capture_launch_output(
    mut input: impl Read + Send + 'static,
    output: Arc<Mutex<File>>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        {
            let mut bounded = Read::by_ref(&mut input).take(32 * 1024);
            let _ = bounded.read_to_end(&mut bytes);
        }
        let _ = io::copy(&mut input, &mut io::sink());
        if let Ok(mut output) = output.lock() {
            let _ = output.write_all(&bytes);
            let _ = output.sync_data();
        }
    })
}

fn drive(id: &str, path: &Path, readonly: bool) -> String {
    format!(
        "if=none,id={id},file={},format=raw,cache=none,aio=threads{}",
        path.display(),
        if readonly { ",readonly=on" } else { "" }
    )
}

fn chardev(id: &str, path: &Path) -> String {
    format!("socket,id={id},path={},server=off", path.display())
}

fn send_input(
    listener: UnixListener,
    bytes: Zeroizing<Vec<u8>>,
    stop: Arc<AtomicBool>,
) -> io::Result<()> {
    let mut stream = accept(&listener, &stop)?;
    stream.write_all(GUEST_INPUT_MAGIC)?;
    stream.write_all(&(bytes.len() as u32).to_be_bytes())?;
    stream.write_all(&bytes)?;
    stream.flush()?;
    while !stop.load(Ordering::SeqCst) {
        thread::sleep(Duration::from_millis(20));
    }
    stream.shutdown(Shutdown::Both)
}

fn capture_console(
    listener: UnixListener,
    path: &Path,
    limit: u64,
    stop: Arc<AtomicBool>,
) -> io::Result<bool> {
    let mut stream = accept(&listener, &stop)?;
    let mut file = OpenOptions::new().create_new(true).write(true).open(path)?;
    let copied = io::copy(&mut Read::by_ref(&mut stream).take(limit + 1), &mut file)?;
    let truncated = copied > limit;
    if truncated {
        file.set_len(limit)?;
    }
    file.sync_all()?;
    Ok(truncated)
}

fn listener(path: &Path) -> io::Result<UnixListener> {
    let listener = UnixListener::bind(path)?;
    listener.set_nonblocking(true)?;
    Ok(listener)
}

fn accept(listener: &UnixListener, stop: &AtomicBool) -> io::Result<UnixStream> {
    loop {
        match listener.accept() {
            Ok((stream, _)) => return Ok(stream),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                if stop.load(Ordering::SeqCst) {
                    return Err(io::Error::new(io::ErrorKind::Interrupted, "VM stopped"));
                }
                thread::sleep(Duration::from_millis(20));
            }
            Err(error) => return Err(error),
        }
    }
}

fn make_workspace(profile: &BuildProfile, path: &Path, size: u64) -> io::Result<()> {
    if !(256 * 1024 * 1024..=16 * 1024 * 1024 * 1024).contains(&size) {
        return Err(invalid("workspace size"));
    }
    let file = OpenOptions::new().create_new(true).write(true).open(path)?;
    file.set_len(size)?;
    drop(file);
    let status = Command::new(&profile.mkfs_ext4)
        .args(["-q", "-F", "-L", "hostlet-work"])
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other("workspace format failed"))
    }
}

fn make_padded_source(source: &Path, destination: &Path) -> io::Result<()> {
    let mut input = File::open(source)?;
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)?;
    let copied = io::copy(&mut input, &mut output)?;
    let padded = copied.div_ceil(512) * 512;
    output.set_len(padded)?;
    output.sync_all()
}

fn numeric_uid() -> io::Result<String> {
    let output = Command::new("/usr/bin/id").arg("-u").output()?;
    let value = String::from_utf8(output.stdout).map_err(|_| invalid("uid"))?;
    let value = value.trim();
    if !output.status.success()
        || value.is_empty()
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(invalid("uid"));
    }
    Ok(value.to_owned())
}

fn unit_name(job: &str, attempt: &str) -> io::Result<String> {
    if !safe_id(job) || !safe_id(attempt) {
        return Err(invalid("VM identity"));
    }
    Ok(format!("hostlet-build-{job}-{attempt}"))
}

fn socket_directory(request: &GuestRequest) -> io::Result<PathBuf> {
    if !safe_id(&request.job_id) || !safe_id(&request.attempt_id) {
        return Err(invalid("VM identity"));
    }
    Ok(Path::new("/tmp").join(format!("hostlet-build-{}", request.attempt_id)))
}

fn socket_marker(request: &GuestRequest) -> String {
    format!(
        "hostlet-build-sockets/v1\njob={}\nattempt={}\n",
        request.job_id, request.attempt_id
    )
}

fn create_socket_directory(request: &GuestRequest) -> io::Result<PathBuf> {
    let directory = socket_directory(request)?;
    fs::DirBuilder::new().mode(0o700).create(&directory)?;
    let marker = directory.join(".hostlet-owned");
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&marker)?;
        file.write_all(socket_marker(request).as_bytes())?;
        file.sync_all()
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(marker);
        let _ = fs::remove_dir(&directory);
        return Err(error);
    }
    Ok(directory)
}

fn remove_owned_socket_directory(request: &GuestRequest) -> bool {
    let Ok(directory) = socket_directory(request) else {
        return false;
    };
    let metadata = match fs::symlink_metadata(&directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return true,
        Err(_) => return false,
    };
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.permissions().mode() & 0o077 != 0
    {
        return false;
    }
    let marker = directory.join(".hostlet-owned");
    let marker_metadata = match fs::symlink_metadata(&marker) {
        Ok(metadata) => metadata,
        Err(_) => return false,
    };
    if !marker_metadata.is_file()
        || marker_metadata.file_type().is_symlink()
        || marker_metadata.permissions().mode() & 0o077 != 0
        || marker_metadata.len() > 256
        || fs::read_to_string(&marker).ok().as_deref() != Some(socket_marker(request).as_str())
    {
        return false;
    }
    let input = directory.join("input.sock");
    let output = directory.join("output.sock");
    let console = directory.join("console.sock");
    remove_paths([input.as_path(), output.as_path(), console.as_path()])
        && fs::remove_file(marker).is_ok()
        && fs::remove_dir(directory).is_ok()
}

fn unit_is_absent(profile: &BuildProfile, unit: &str) -> bool {
    let mut child = match Command::new(&profile.sudo)
        .args(["-n"])
        .arg(&profile.systemctl)
        .args(["is-active", unit])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(_) => return false,
    };
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return matches!(status.code(), Some(3 | 4)),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            Ok(None) | Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

pub(crate) fn cleanup_failed_setup(
    profile: &BuildProfile,
    request: &GuestRequest,
    attempt_dir: &Path,
) -> CleanupEvidence {
    let qemu_exited = unit_name(&request.job_id, &request.attempt_id)
        .is_ok_and(|unit| unit_is_absent(profile, &unit));
    let sockets_removed = remove_owned_socket_directory(request);
    for name in ["workspace.ext4", "source.raw", "console.log", "launch.log"] {
        let _ = fs::remove_file(attempt_dir.join(name));
    }
    let _ = fs::remove_dir(attempt_dir);
    CleanupEvidence {
        qemu_exited,
        killed_for_timeout: false,
        killed_for_fence: false,
        sockets_removed,
        workspace_removed: !attempt_dir.exists(),
        console_truncated: false,
    }
}

fn safe_id(value: &str) -> bool {
    value.len() == 36
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
}

fn terminate(profile: &BuildProfile, unit: &str, process: &mut Child) {
    terminate_unit(profile, unit);
    let _ = process.kill();
}

fn terminate_unit(profile: &BuildProfile, unit: &str) {
    let _ = Command::new(&profile.sudo)
        .args(["-n"])
        .arg(&profile.systemctl)
        .args(["kill", "--kill-whom=all", "--signal=TERM", unit])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    thread::sleep(Duration::from_secs(2));
    let _ = Command::new(&profile.sudo)
        .args(["-n"])
        .arg(&profile.systemctl)
        .args(["kill", "--kill-whom=all", "--signal=KILL", unit])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

struct UnitGuard<'a> {
    profile: &'a BuildProfile,
    unit: &'a str,
    armed: bool,
}

impl<'a> UnitGuard<'a> {
    fn new(profile: &'a BuildProfile, unit: &'a str) -> Self {
        Self {
            profile,
            unit,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for UnitGuard<'_> {
    fn drop(&mut self) {
        if self.armed {
            terminate_unit(self.profile, self.unit);
        }
    }
}

fn remove_paths<const N: usize>(paths: [&Path; N]) -> bool {
    let mut removed = true;
    for path in paths {
        if path.exists() && fs::remove_file(path).is_err() {
            removed = false;
        }
    }
    removed
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
