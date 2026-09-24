#!/usr/bin/env python3
"""Build an immutable runtime root from a verified HCA1 app and Node rootfs."""

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import struct
import tempfile
import uuid
from pathlib import Path, PurePosixPath

SCHEMA = "hostlet.runtime-artifact/v1"
MARKER = "hostlet-runtime-artifact-v1\n"
ROOT_MARKER = "hostlet-artifacts-v1"
MAX_ENTRIES = 100_000
MAX_UNPACKED = 2 * 1024 * 1024 * 1024
SECRET_ENV_SHIM = b'''#!/bin/sh
set -eu
for secret in /run/secrets/*; do
    [ -f "$secret" ] || continue
    name=${secret##*/}
    case "$name" in (*[!A-Z0-9_]*|'') exit 64;; esac
    value=$(cat "$secret")
    export "$name=$value"
    unset value
done
exec "$@"
'''


def fail(code):
    raise SystemExit(code)


def digest_bytes(value):
    return "sha256:" + hashlib.sha256(value).hexdigest()


def valid_digest(value):
    return isinstance(value, str) and len(value) == 71 and value.startswith("sha256:") and all(c in "0123456789abcdef" for c in value[7:])


def canonical_json(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def checked_root(path, marker_name, marker_value):
    path = Path(path)
    if not path.is_absolute() or path.is_symlink() or not path.is_dir():
        fail("runtime_artifact_root_invalid")
    marker = path / marker_name
    if marker.is_symlink() or not marker.is_file() or marker.read_text().strip() != marker_value:
        fail("runtime_artifact_root_not_owned")
    return path


def image_resolve(root, relative):
    """Resolve a rootfs symlink using image-root semantics for absolute links."""
    todo = list(PurePosixPath(relative).parts)
    resolved = []
    links = 0
    while todo:
        component = todo.pop(0)
        if component in ("", ".", "/"):
            continue
        if component == "..":
            if not resolved:
                fail("runtime_rootfs_symlink_escape")
            resolved.pop()
            continue
        candidate = root.joinpath(*resolved, component)
        try:
            metadata = candidate.lstat()
        except OSError:
            # Images commonly link into procfs or another OCI mount which is
            # absent while staging. Continue lexically within the image root.
            resolved.append(component)
            continue
        if stat.S_ISLNK(metadata.st_mode):
            links += 1
            if links > 64:
                fail("runtime_rootfs_symlink_loop")
            target = os.readlink(candidate)
            target_parts = list(PurePosixPath(target).parts)
            if target.startswith("/"):
                resolved = []
            todo = target_parts + todo
        else:
            resolved.append(component)
    return root.joinpath(*resolved)


def validate_tree(root):
    root = Path(root)
    if not root.is_absolute() or root.is_symlink() or not root.is_dir():
        fail("runtime_base_rootfs_invalid")
    root_dev = root.stat().st_dev
    for directory, names, files in os.walk(root, topdown=True, followlinks=False):
        for name in names + files:
            path = Path(directory) / name
            metadata = path.lstat()
            if metadata.st_dev != root_dev:
                fail("runtime_rootfs_mount_crossing")
            if stat.S_ISLNK(metadata.st_mode):
                image_resolve(root, path.relative_to(root).as_posix())
            elif not (stat.S_ISDIR(metadata.st_mode) or stat.S_ISREG(metadata.st_mode)):
                fail("runtime_rootfs_special_file")


def tree_digest(root):
    root = Path(root)
    records = bytearray()
    paths = [root]
    paths.extend(sorted(root.rglob("*"), key=lambda p: os.fsencode(p.relative_to(root).as_posix())))
    for path in paths:
        metadata = path.lstat()
        mode = format(stat.S_IMODE(metadata.st_mode), "o")
        relative = "." if path == root else path.relative_to(root).as_posix()
        if stat.S_ISLNK(metadata.st_mode):
            kind, payload = "l", os.readlink(path)
        elif stat.S_ISREG(metadata.st_mode):
            kind = "f"
            hasher = hashlib.sha256()
            with path.open("rb") as source:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    hasher.update(chunk)
            payload = hasher.hexdigest()
        elif stat.S_ISDIR(metadata.st_mode):
            kind, payload = "d", "-"
        else:
            fail("runtime_rootfs_special_file")
        records.extend(kind.encode() + b"\0" + mode.encode() + b"\0" + relative.encode() + b"\0" + payload.encode() + b"\n")
    return digest_bytes(records)


def u16(source):
    value = source.read(2)
    if len(value) != 2:
        fail("runtime_hca_truncated")
    return struct.unpack(">H", value)[0]


def u32(source):
    value = source.read(4)
    if len(value) != 4:
        fail("runtime_hca_truncated")
    return struct.unpack(">I", value)[0]


def u64(source):
    value = source.read(8)
    if len(value) != 8:
        fail("runtime_hca_truncated")
    return struct.unpack(">Q", value)[0]


def read_exact(source, size):
    value = source.read(size)
    if len(value) != size:
        fail("runtime_hca_truncated")
    return value


def safe_archive_path(raw):
    try:
        value = raw.decode("utf-8")
    except UnicodeDecodeError:
        fail("runtime_hca_path_invalid")
    path = PurePosixPath(value)
    if (not value or value.startswith("/") or "\\" in value or
            any(ord(character) < 32 or ord(character) == 127 for character in value) or
            any(part in ("", ".", "..") for part in path.parts)):
        fail("runtime_hca_path_invalid")
    return value


def create_guest_parents(root, destination):
    """Create only new guest directories with canonical, umask-free modes."""
    relative = destination.relative_to(root)
    current = root
    for part in relative.parts:
        current = current / part
        if os.path.lexists(current):
            if current.is_symlink() or not current.is_dir():
                fail("runtime_guest_parent_invalid")
            continue
        current.mkdir(mode=0o755)
        current.chmod(0o755)


def validate_guest_app_dirs(rootfs):
    app = rootfs / "app"
    if app.is_symlink() or not app.is_dir():
        fail("runtime_artifact_collision")
    for directory, names, _files in os.walk(app, topdown=True, followlinks=False):
        current = Path(directory)
        metadata = current.lstat()
        if not stat.S_ISDIR(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) != 0o755:
            fail("runtime_artifact_collision")
        for name in names:
            child = current / name
            if child.is_symlink() or not child.is_dir():
                fail("runtime_artifact_collision")


def unpack_hca(archive, app_root, build_manifest):
    with archive.open("rb") as source:
        if read_exact(source, 4) != b"HCA1":
            fail("runtime_hca_magic_invalid")
        kind = read_exact(source, 1)[0]
        try:
            service = read_exact(source, u16(source)).decode("utf-8", "strict")
            if str(uuid.UUID(service)) != service:
                fail("runtime_hca_identity_mismatch")
        except (UnicodeDecodeError, ValueError):
            fail("runtime_hca_identity_mismatch")
        count, total = u32(source), u64(source)
        if kind != 2 or count > MAX_ENTRIES or total > MAX_UNPACKED:
            fail("runtime_hca_limits_invalid")
        if build_manifest.get("kind") != "application" or build_manifest.get("service_id") != service:
            fail("runtime_hca_identity_mismatch")
        previous = None
        observed = 0
        for _ in range(count):
            relative = safe_archive_path(read_exact(source, u16(source)))
            if previous is not None and relative <= previous:
                fail("runtime_hca_order_invalid")
            previous = relative
            mode, size = u32(source), u64(source)
            if mode not in (0o644, 0o755) or size > MAX_UNPACKED or observed + size > total:
                fail("runtime_hca_entry_invalid")
            destination = app_root.joinpath(*PurePosixPath(relative).parts)
            create_guest_parents(app_root, destination.parent)
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
            descriptor = os.open(destination, flags, mode)
            try:
                remaining = size
                while remaining:
                    chunk = read_exact(source, min(1024 * 1024, remaining))
                    os.write(descriptor, chunk)
                    remaining -= len(chunk)
                os.fchmod(descriptor, mode)
            finally:
                os.close(descriptor)
            observed += size
        if observed != total or source.read(1):
            fail("runtime_hca_size_invalid")
    if (build_manifest.get("entry_count") != count or build_manifest.get("unpacked_bytes") != total or
            build_manifest.get("packed_bytes") != archive.stat().st_size):
        fail("runtime_hca_manifest_mismatch")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tree-digest")
    parser.add_argument("--archive-file")
    parser.add_argument("--archive-digest")
    parser.add_argument("--build-manifest")
    parser.add_argument("--build-manifest-digest")
    parser.add_argument("--build-profile-digest")
    parser.add_argument("--base-rootfs")
    parser.add_argument("--base-rootfs-digest")
    parser.add_argument("--base-manifest")
    parser.add_argument("--base-manifest-digest")
    parser.add_argument("--artifact-root")
    args = parser.parse_args()
    if args.tree_digest:
        if any(value is not None for name, value in vars(args).items() if name != "tree_digest"):
            fail("runtime_tree_digest_usage")
        root = Path(args.tree_digest)
        validate_tree(root)
        print(tree_digest(root))
        return
    required = (args.archive_file, args.archive_digest, args.build_manifest, args.build_manifest_digest,
                args.build_profile_digest, args.base_rootfs, args.base_rootfs_digest, args.base_manifest,
                args.base_manifest_digest, args.artifact_root)
    if any(value is None for value in required):
        fail("runtime_artifact_usage")
    expected = [args.archive_digest, args.build_manifest_digest, args.build_profile_digest,
                args.base_rootfs_digest, args.base_manifest_digest]
    if not all(valid_digest(value) for value in expected):
        fail("runtime_artifact_digest_invalid")
    artifact_root = checked_root(args.artifact_root, ".hostlet-artifacts-owned", ROOT_MARKER)
    archive, build_path, base_manifest_path = Path(args.archive_file), Path(args.build_manifest), Path(args.base_manifest)
    if any(not path.is_absolute() or path.is_symlink() or not path.is_file() for path in (archive, build_path, base_manifest_path)):
        fail("runtime_artifact_input_invalid")
    build_bytes = build_path.read_bytes()
    base_manifest_bytes = base_manifest_path.read_bytes()
    archive_hasher = hashlib.sha256()
    with archive.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            archive_hasher.update(chunk)
    if ("sha256:" + archive_hasher.hexdigest() != args.archive_digest or
            digest_bytes(build_bytes) != args.build_manifest_digest or
            digest_bytes(base_manifest_bytes) != args.base_manifest_digest):
        fail("runtime_artifact_input_digest_mismatch")
    try:
        build = json.loads(build_bytes)
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("runtime_build_manifest_invalid")
    if build.get("schema") != "hostlet.build-artifact/v1" or build.get("archive_digest") != args.archive_digest:
        fail("runtime_build_manifest_invalid")
    try:
        base_manifest = json.loads(base_manifest_bytes)
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("runtime_base_manifest_invalid")
    image = base_manifest.get("image", "")
    if (base_manifest.get("schema") != "hostlet.runtime-base/v1" or
            base_manifest.get("project_code_executed") is not False or
            not re.fullmatch(r"node:(22|24)-bookworm-slim@sha256:[0-9a-f]{64}", image) or
            not re.fullmatch(r"[0-9a-f]{64}", base_manifest.get("archive_sha256", ""))):
        fail("runtime_base_manifest_invalid")
    source_commit = build.get("source_commit", "")
    if len(source_commit) not in (40, 64) or any(c not in "0123456789abcdef" for c in source_commit):
        fail("runtime_source_commit_invalid")
    base = Path(args.base_rootfs)
    validate_tree(base)
    if tree_digest(base) != args.base_rootfs_digest:
        fail("runtime_base_rootfs_digest_mismatch")
    # Build manifests include the exact build job and attempt. Identical HCA
    # bytes can therefore have distinct, valid provenance and must coexist.
    destination = artifact_root / args.build_manifest_digest[7:]
    expected_manifest = {
        "schema": SCHEMA,
        "archive_digest": args.archive_digest,
        "build_manifest_digest": args.build_manifest_digest,
        "build_profile_digest": args.build_profile_digest,
        "base_rootfs_digest": args.base_rootfs_digest,
        "base_manifest_digest": args.base_manifest_digest,
        "base_image": image,
        "secret_env_shim_digest": digest_bytes(SECRET_ENV_SHIM),
        "source_commit": source_commit,
        "service_id": build["service_id"],
        "workdir": "/app",
    }
    if os.path.lexists(destination):
        manifest = destination / "manifest.json"
        marker = destination / ".hostlet-artifact-owned"
        rootfs = destination / "rootfs"
        if (destination.is_symlink() or not destination.is_dir() or
                manifest.is_symlink() or not manifest.is_file() or
                marker.is_symlink() or not marker.is_file() or marker.read_text() != MARKER or
                rootfs.is_symlink() or not rootfs.is_dir()):
            fail("runtime_artifact_collision")
        try:
            existing = json.loads(manifest.read_bytes())
        except (UnicodeDecodeError, json.JSONDecodeError):
            fail("runtime_artifact_collision")
        if (not isinstance(existing, dict) or
                set(existing) != (set(expected_manifest) | {"rootfs_tree_digest"}) or
                any(existing.get(key) != value for key, value in expected_manifest.items()) or
                not valid_digest(existing.get("rootfs_tree_digest"))):
            fail("runtime_artifact_collision")
        validate_tree(rootfs)
        validate_guest_app_dirs(rootfs)
        if tree_digest(rootfs) != existing["rootfs_tree_digest"]:
            fail("runtime_artifact_collision")
        print(canonical_json(existing).decode(), end="")
        return
    temporary = Path(tempfile.mkdtemp(prefix=".prepare-", dir=artifact_root))
    try:
        rootfs = temporary / "rootfs"
        shutil.copytree(base, rootfs, symlinks=True)
        app = rootfs / "app"
        if app.exists() or app.is_symlink():
            fail("runtime_base_app_collision")
        app.mkdir(mode=0o755)
        app.chmod(0o755)
        unpack_hca(archive, app, build)
        shim = rootfs / "hostlet" / "bin" / "secret-env"
        create_guest_parents(rootfs, shim.parent)
        if shim.exists() or shim.is_symlink():
            fail("runtime_base_shim_collision")
        shim.write_bytes(SECRET_ENV_SHIM)
        shim.chmod(0o755)
        # The gofer resolves bind destinations against the immutable rootfs
        # before applying the guest /run tmpfs. Seal the directory mount point
        # into the artifact; no credential bytes enter this tree.
        secret_mountpoint = rootfs / "run" / "secrets"
        if secret_mountpoint.is_symlink() or (rootfs / "run").is_symlink():
            fail("runtime_base_secret_mountpoint_invalid")
        secret_mountpoint.mkdir(mode=0o755, parents=True, exist_ok=True)
        secret_mountpoint.chmod(0o755)
        validate_tree(rootfs)
        validate_guest_app_dirs(rootfs)
        manifest_value = {**expected_manifest, "rootfs_tree_digest": tree_digest(rootfs)}
        (temporary / "manifest.json").write_bytes(canonical_json(manifest_value))
        (temporary / ".hostlet-artifact-owned").write_text(MARKER)
        os.chmod(temporary / "manifest.json", 0o444)
        os.chmod(temporary / ".hostlet-artifact-owned", 0o444)
        os.rename(temporary, destination)
        print(canonical_json(manifest_value).decode(), end="")
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


if __name__ == "__main__":
    main()
