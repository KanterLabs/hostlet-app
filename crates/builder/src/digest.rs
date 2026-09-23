use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

use sha2::{Digest, Sha256};

pub(crate) const SHA256_PREFIX: &str = "sha256:";

pub(crate) fn valid_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with(SHA256_PREFIX)
        && value[SHA256_PREFIX.len()..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(crate) fn cas_path(root: &Path, digest: &str) -> io::Result<PathBuf> {
    if !valid_digest(digest) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid digest",
        ));
    }
    Ok(root.join("sha256").join(&digest[SHA256_PREFIX.len()..]))
}

pub(crate) fn sha256_reader(mut reader: impl Read) -> io::Result<(String, u64)> {
    let mut hasher = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        total = total
            .checked_add(read as u64)
            .ok_or_else(|| io::Error::other("object size overflow"))?;
    }
    Ok((format!("sha256:{:x}", hasher.finalize()), total))
}

pub(crate) fn verify_file(path: &Path, expected: &str) -> io::Result<u64> {
    let (observed, size) = sha256_reader(File::open(path)?)?;
    if observed != expected {
        return Err(io::Error::other("object digest mismatch"));
    }
    Ok(size)
}

pub(crate) fn verify_cas_file(path: &Path, expected: &str) -> io::Result<u64> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.permissions().mode() & 0o077 != 0
    {
        return Err(io::Error::other("CAS object permissions"));
    }
    verify_file(path, expected)
}

pub(crate) fn store_bytes(root: &Path, bytes: &[u8]) -> io::Result<String> {
    let digest = format!("sha256:{:x}", Sha256::digest(bytes));
    let destination = cas_path(root, &digest)?;
    if destination.exists() {
        verify_cas_file(&destination, &digest)?;
        return Ok(digest);
    }
    let directory = destination
        .parent()
        .ok_or_else(|| io::Error::other("CAS destination has no parent"))?;
    fs::create_dir_all(directory)?;
    let temporary = directory.join(format!(
        ".{}.{}.tmp",
        std::process::id(),
        monotonic_suffix()
    ));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    match fs::hard_link(&temporary, &destination) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            verify_cas_file(&destination, &digest)?;
        }
        Err(error) => {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
    }
    fs::remove_file(&temporary)?;
    File::open(directory)?.sync_all()?;
    Ok(digest)
}

pub(crate) fn monotonic_suffix() -> u128 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0)
}
