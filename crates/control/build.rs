use std::{
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

fn main() {
    for path in [
        "src",
        "build.rs",
        "Cargo.toml",
        "../../Cargo.toml",
        "../../Cargo.lock",
        "../../migrations",
    ] {
        println!("cargo:rerun-if-changed={path}");
    }
    for path in git_metadata_paths() {
        println!("cargo:rerun-if-changed={}", path.display());
    }
    let tracked = git_output_bounded(&["ls-files", "-z"], 1024 * 1024)
        .expect("tracked source paths must be bounded UTF-8");
    for path in tracked.split('\0').filter(|path| !path.is_empty()) {
        if path.chars().any(char::is_control) {
            panic!("tracked source path contains a control character");
        }
        println!("cargo:rerun-if-changed=../../{path}");
    }

    let revision = git_output(&["rev-parse", "HEAD"]).unwrap_or_else(|| "unknown".to_owned());
    let dirty = git_output(&["status", "--porcelain", "--untracked-files=normal"])
        .map(|status| !status.is_empty())
        .unwrap_or(true);

    println!("cargo:rustc-env=HOSTLET_BUILD_GIT_REVISION={revision}");
    println!(
        "cargo:rustc-env=HOSTLET_BUILD_GIT_DIRTY={}",
        if dirty { "true" } else { "false" }
    );
}

fn git_metadata_paths() -> Vec<PathBuf> {
    let root = Path::new("../..");
    let Some(git_dir) = git_output(&["rev-parse", "--git-dir"]).map(PathBuf::from) else {
        return Vec::new();
    };
    let git_dir = if git_dir.is_absolute() {
        git_dir
    } else {
        root.join(git_dir)
    };
    let mut paths = vec![git_dir.join("HEAD"), git_dir.join("index")];
    if let Some(reference) = git_output(&["symbolic-ref", "HEAD"]) {
        let common_dir = git_output(&["rev-parse", "--git-common-dir"])
            .map(PathBuf::from)
            .unwrap_or_else(|| git_dir.clone());
        let common_dir = if common_dir.is_absolute() {
            common_dir
        } else {
            root.join(common_dir)
        };
        paths.push(common_dir.join(reference));
    }
    paths
}

fn git_output(arguments: &[&str]) -> Option<String> {
    git_output_bounded(arguments, 4096)
}

fn git_output_bounded(arguments: &[&str], maximum: usize) -> Option<String> {
    let mut command = Command::new("git");
    command
        .args(arguments)
        .current_dir("../..")
        .env_clear()
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(path) = std::env::var_os("PATH") {
        command.env("PATH", path);
    }
    let mut child = command.spawn().ok()?;
    let stdout = child.stdout.take()?;
    let reader = thread::spawn(move || {
        let mut output = Vec::new();
        stdout
            .take(maximum as u64 + 1)
            .read_to_end(&mut output)
            .ok()?;
        Some(output)
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    let status = loop {
        if let Some(status) = child.try_wait().ok()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = reader.join();
            return None;
        }
        thread::sleep(Duration::from_millis(20));
    };
    let output = reader.join().ok()??;
    if !status.success() || output.len() > maximum {
        return None;
    }
    String::from_utf8(output)
        .ok()
        .map(|value| value.trim().to_owned())
}
