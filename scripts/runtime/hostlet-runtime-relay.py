#!/usr/bin/env python3
"""Owned loopback-to-gateway relay used by the M3 browser fixture."""

import argparse
import json
import os
import selectors
import signal
import socket
import stat
import time
import uuid
from pathlib import Path


HALF_CLOSE_DRAIN_SECONDS = 5.0


def fail(code):
    raise SystemExit(code)


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def canonical_uuid(value):
    try:
        parsed = uuid.UUID(value)
    except (AttributeError, TypeError, ValueError):
        fail("relay_identity_invalid")
    if str(parsed) != value:
        fail("relay_identity_invalid")
    return value


def private_runtime_root(value):
    path = Path(value)
    try:
        link = path.lstat()
        resolved = path.resolve(strict=True)
        marker = resolved / ".hostlet-runtime-owned"
        marker_link = marker.lstat()
    except OSError:
        fail("relay_root_not_owned")
    if (not path.is_absolute() or resolved != path or not stat.S_ISDIR(link.st_mode) or
            stat.S_IMODE(link.st_mode) & 0o077 or not stat.S_ISREG(marker_link.st_mode) or
            marker.read_text().strip() != "hostlet-runtime-state-v1"):
        fail("relay_root_not_owned")
    return resolved, link.st_uid, link.st_gid


def read_owned_runtime(root, allocation, generation, fence):
    path = root / allocation / str(generation) / "OWNERSHIP.json"
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        opened = os.fstat(descriptor)
        linked = path.lstat()
        if (not stat.S_ISREG(opened.st_mode) or opened.st_dev != linked.st_dev or
                opened.st_ino != linked.st_ino or opened.st_size > 64 * 1024 or
                opened.st_uid != 0 or stat.S_IMODE(opened.st_mode) & 0o077):
            os.close(descriptor)
            fail("relay_ownership_invalid")
        with os.fdopen(descriptor, "rb") as source:
            record = json.load(source)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        fail("relay_ownership_invalid")
    namespace = Path("/run/netns") / f"hostlet-gateway-{allocation}-{generation}"
    try:
        namespace_inode = namespace.stat().st_ino
    except OSError:
        fail("relay_namespace_mismatch")
    if (not isinstance(record, dict) or record.get("allocation_id") != allocation or
            record.get("generation") != generation or record.get("fence") != fence or
            record.get("gateway_namespace_inode") != namespace_inode):
        fail("relay_namespace_mismatch")
    return record, namespace, namespace_inode


def owned_directory(parent_fd, name, owner_uid, owner_gid):
    created = False
    try:
        os.mkdir(name, 0o700, dir_fd=parent_fd)
        created = True
    except FileExistsError:
        pass
    except OSError:
        fail("relay_map_directory_invalid")
    try:
        descriptor = os.open(name, os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0),
                             dir_fd=parent_fd)
        metadata = os.fstat(descriptor)
    except OSError:
        fail("relay_map_directory_invalid")
    if created:
        os.fchmod(descriptor, 0o700)
        os.fchown(descriptor, owner_uid, owner_gid)
        metadata = os.fstat(descriptor)
    if (not stat.S_ISDIR(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) != 0o700 or
            metadata.st_uid != owner_uid or metadata.st_gid != owner_gid):
        os.close(descriptor)
        fail("relay_map_directory_invalid")
    return descriptor


def publish_map(root, owner_uid, owner_gid, value):
    flags = os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0)
    try:
        root_fd = os.open(root, flags)
    except OSError:
        fail("relay_map_directory_invalid")
    descriptors = [root_fd]
    try:
        for component in ("runtime-relays", value["allocation_id"], str(value["generation"])):
            descriptors.append(owned_directory(descriptors[-1], component, owner_uid, owner_gid))
        directory_fd = descriptors[-1]
        destination = f"{value['fence']}.json"
        temporary = f".{value['fence']}.{os.getpid()}.tmp"
        data = canonical(value)
        try:
            output_fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL |
                                getattr(os, "O_NOFOLLOW", 0), 0o600, dir_fd=directory_fd)
            with os.fdopen(output_fd, "wb") as output:
                os.fchmod(output.fileno(), 0o600)
                os.fchown(output.fileno(), owner_uid, owner_gid)
                output.write(data)
                output.flush()
                os.fsync(output.fileno())
            os.link(temporary, destination, src_dir_fd=directory_fd, dst_dir_fd=directory_fd,
                    follow_symlinks=False)
            os.unlink(temporary, dir_fd=directory_fd)
            os.fsync(directory_fd)
            published = os.stat(destination, dir_fd=directory_fd, follow_symlinks=False)
        except FileExistsError:
            try:
                os.unlink(temporary, dir_fd=directory_fd)
            except OSError:
                pass
            fail("relay_map_collision")
        except OSError:
            try:
                os.unlink(temporary, dir_fd=directory_fd)
            except OSError:
                pass
            fail("relay_map_publish_failed")
        if (not stat.S_ISREG(published.st_mode) or stat.S_IMODE(published.st_mode) != 0o600 or
                published.st_uid != owner_uid or published.st_gid != owner_gid):
            fail("relay_map_publish_failed")
        return descriptors, directory_fd, destination, (published.st_dev, published.st_ino)
    except BaseException:
        for descriptor in reversed(descriptors):
            try:
                os.close(descriptor)
            except OSError:
                pass
        raise


def remove_map(descriptors, directory_fd, name, identity, expected, namespace):
    try:
        if namespace.stat().st_ino != expected["gateway_namespace_inode"]:
            return
        metadata = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if (metadata.st_dev, metadata.st_ino) != identity or not stat.S_ISREG(metadata.st_mode):
            return
        descriptor = os.open(name, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0), dir_fd=directory_fd)
        with os.fdopen(descriptor, "rb") as source:
            observed = json.load(source)
        keys = ("schema", "allocation_id", "generation", "fence", "address", "port",
                "gateway_namespace_inode", "relay_pid", "relay_pgid", "relay_starttime_ticks")
        if any(observed.get(key) != expected[key] for key in keys):
            return
        os.unlink(name, dir_fd=directory_fd)
        os.fsync(directory_fd)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return
    finally:
        for descriptor in reversed(descriptors):
            try:
                os.close(descriptor)
            except OSError:
                pass


def process_starttime_ticks(pid):
    try:
        value = Path(f"/proc/{pid}/stat").read_text(encoding="ascii")
        return int(value.rsplit(") ", 1)[1].split()[19])
    except (OSError, IndexError, ValueError):
        fail("relay_identity_invalid")


def ensure_dedicated_process_group():
    try:
        if os.getpgrp() != os.getpid():
            os.setpgid(0, 0)
        if os.getpgrp() != os.getpid():
            fail("relay_process_group_invalid")
    except OSError:
        fail("relay_process_group_invalid")


def close_inherited_stdio():
    for descriptor in (1, 2):
        try:
            os.close(descriptor)
        except OSError:
            pass


def relay_connection(incoming, namespace, target_address, target_port):
    signal.signal(signal.SIGTERM, signal.SIG_DFL)
    signal.signal(signal.SIGINT, signal.SIG_DFL)
    selector = None
    outgoing = None
    try:
        with namespace.open("rb") as handle:
            os.setns(handle.fileno(), os.CLONE_NEWNET)
        outgoing = socket.create_connection((target_address, target_port), timeout=2)
        incoming.setblocking(False)
        outgoing.setblocking(False)
        selector = selectors.DefaultSelector()
        selector.register(incoming, selectors.EVENT_READ, outgoing)
        selector.register(outgoing, selectors.EVENT_READ, incoming)
        drain_deadline = None
        while selector.get_map():
            timeout = 30
            if drain_deadline is not None:
                timeout = max(0, min(timeout, drain_deadline - time.monotonic()))
            events = selector.select(timeout=timeout)
            if not events:
                if drain_deadline is not None and time.monotonic() >= drain_deadline:
                    break
                continue
            for key, _ in events:
                try:
                    data = key.fileobj.recv(65536)
                except BlockingIOError:
                    continue
                if not data:
                    selector.unregister(key.fileobj)
                    try:
                        key.data.shutdown(socket.SHUT_WR)
                    except OSError:
                        pass
                    if drain_deadline is None:
                        drain_deadline = time.monotonic() + HALF_CLOSE_DRAIN_SECONDS
                    continue
                try:
                    key.data.sendall(data)
                except OSError:
                    return
    except OSError:
        pass
    finally:
        if selector is not None:
            try:
                selector.close()
            except OSError:
                pass
        for stream in (incoming, outgoing):
            if stream is not None:
                try:
                    stream.close()
                except OSError:
                    pass
        os._exit(0)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--state-root", required=True)
    parser.add_argument("--allocation-id", required=True)
    parser.add_argument("--generation", required=True, type=int)
    parser.add_argument("--listen-port", required=True, type=int)
    parser.add_argument("--fence", required=True, type=int)
    parser.add_argument("--target-address", required=True)
    parser.add_argument("--target-port", required=True, type=int)
    args = parser.parse_args()
    os.umask(0o077)
    allocation = canonical_uuid(args.allocation_id)
    if (args.generation <= 0 or args.generation > 2**63 - 1 or args.fence <= 0 or
            args.fence > 2**63 - 1 or not 0 <= args.listen_port < 65536 or
            not 0 < args.target_port < 65536):
        fail("relay_identity_invalid")
    root, owner_uid, owner_gid = private_runtime_root(args.state_root)
    record, namespace, namespace_inode = read_owned_runtime(
        root, allocation, args.generation, args.fence)
    if (args.target_address not in (record.get("application_ipv4"), record.get("application_ipv6")) or
            args.target_port != record.get("application_port")):
        fail("relay_target_not_owned")
    ensure_dedicated_process_group()
    try:
        listener = socket.create_server(("127.0.0.1", args.listen_port), reuse_port=False)
    except OSError:
        fail("relay_listen_failed")
    value = {
        "schema": "hostlet.runtime.relay-map/v1",
        "allocation_id": allocation,
        "generation": args.generation,
        "fence": args.fence,
        "address": "127.0.0.1",
        "port": listener.getsockname()[1],
        "gateway_namespace_inode": namespace_inode,
        "relay_pid": os.getpid(),
        "relay_pgid": os.getpgid(0),
        "relay_starttime_ticks": process_starttime_ticks(os.getpid()),
    }
    stopping = False
    children = set()

    def reap_children(_signum=None, _frame=None):
        while True:
            try:
                pid, _ = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                return
            except InterruptedError:
                continue
            if pid <= 0:
                return
            children.discard(pid)

    def stop(_signum, _frame):
        nonlocal stopping
        stopping = True
        try:
            listener.close()
        except OSError:
            pass
        # Keep a stale child PID from being reused between the snapshot and
        # its signal while the SIGCHLD reaper is pending.
        previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGCHLD})
        try:
            for child in tuple(children):
                try:
                    os.kill(child, signal.SIGTERM)
                except ProcessLookupError:
                    pass
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGCHLD, reap_children)
    descriptors, directory_fd, map_name, map_identity = publish_map(root, owner_uid, owner_gid, value)
    print(json.dumps({"schema": "hostlet.runtime.relay-ready/v1", "address": "127.0.0.1",
                      "port": value["port"]}, separators=(",", ":")), flush=True)
    try:
        while not stopping:
            try:
                incoming, _ = listener.accept()
            except InterruptedError:
                reap_children()
                continue
            except OSError:
                if stopping:
                    break
                raise
            previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGCHLD})
            try:
                pid = os.fork()
                if pid:
                    # SIGCHLD cannot reap this child until it is in the set.
                    children.add(pid)
                    incoming.close()
                    continue
                signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
            finally:
                signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
            listener.close()
            # A forked handler never writes logs. Closing both inherited pipe
            # ends prevents an aborted request from keeping the runner alive.
            close_inherited_stdio()
            relay_connection(incoming, namespace, args.target_address, args.target_port)
    finally:
        try:
            listener.close()
        except OSError:
            pass
        reap_deadline = time.monotonic() + HALF_CLOSE_DRAIN_SECONDS
        while children and time.monotonic() < reap_deadline:
            reap_children()
            if children:
                time.sleep(0.01)
        reap_children()
        remove_map(descriptors, directory_fd, map_name, map_identity, value, namespace)


if __name__ == "__main__":
    main()
