# M3 disposable build worker

`hostlet-builder project-build-worker` is the HOST-225 host supervisor. It leases only `project_build` work from the loopback control listener, revalidates the source bundle and pinned profile, and executes repository commands only inside a no-NIC QEMU/KVM guest. The existing `hostlet-builder worker` bookkeeping mode is unchanged.

## CLI and local layout

```text
hostlet-builder project-build-worker \
  --control-url http://127.0.0.1:8081 \
  --worker-id m3-builder-1 \
  --profile /absolute/path/m3-owned-node24-v1.json \
  --cas-root /absolute/HOSTLET_M3_STATE_DIR/private-cas \
  --work-root /absolute/run-owned/build-work \
  [--once [--completion-capture /absolute/run-owned/completion.json]]
```

`HOSTLET_M3_BUILD_TOKEN` is required and is distinct from the M1 worker token. The control URL must be loopback HTTP. Profile, CAS, and work paths must be absolute. CAS objects are immutable regular files at `<cas-root>/sha256/<64-lowercase-hex>`.

`--completion-capture` is a one-shot E2E replay aid and is accepted only with
`--once`. After the authenticated `/complete` request receives its response,
the worker creates the requested path exactly once with mode `0600` and
`create_new`. The JSON record contains the method, path, request body, response
status, response content type and response body, plus `authenticated: true`;
the bearer credential is never captured. A completion replay supplies its own
worker authentication outside this file. Its schema is
`hostlet.build-completion-capture/v1`.

The profile JSON schema is `hostlet.build-profile/v1` and denies unknown fields:

```json
{
  "schema": "hostlet.build-profile/v1",
  "id": "m3-owned-node24-v1",
  "qemu_binary": "/usr/bin/qemu-system-x86_64",
  "qemu_digest": "sha256:...",
  "kernel": {"path": "/absolute/vmlinuz", "digest": "sha256:..."},
  "initrd": {"path": "/absolute/initrd", "digest": "sha256:..."},
  "rootfs": {"path": "/absolute/rootfs.ext4", "digest": "sha256:..."},
  "dependency_cache": {"path": "/absolute/cache.ext4", "digest": "sha256:..."},
  "mkfs_ext4": "/usr/sbin/mkfs.ext4",
  "sudo": "/usr/bin/sudo",
  "systemd_run": "/usr/bin/systemd-run",
  "systemctl": "/usr/bin/systemctl"
}
```

The worker hashes the profile file for lease capability negotiation and independently verifies QEMU, kernel, initrd, rootfs, and cache before every launch. The initial profiles are `m3-owned-node24-v1` and the separately measured `m3-owned-node22-v1`. They are internal-fixture profiles, not customer catalog entries.

## Pinned image preparation

The guest helper must be statically linked:

```text
rustup target add x86_64-unknown-linux-musl
cargo build --release --target x86_64-unknown-linux-musl \
  -p hostlet-builder --bin hostlet-build-guest
```

`scripts/build/prepare-kernel-initrd.sh` creates a deterministic minimal initramfs from static BusyBox. It accepts a readable pinned kernel and matching config only when devtmpfs, virtio PCI/block/console, and ext4 are built in; therefore the build guest does not depend on host module discovery. It emits kernel/initrd hashes and metadata. `scripts/build/prepare-rootfs.sh` refuses a dynamically linked helper, exports a digest-pinned official Node image without starting it, installs only the helper and BusyBox, and creates an immutable ext4 image. Adopted amd64 inputs resolved on 2026-09-22 are:

```text
node:24-bookworm-slim@sha256:5cbc7caba8c2c0f0bca675d1b61b9f2857e1cf1853c6164ee9dd409501a936e7
node:22-bookworm-slim@sha256:43aeff40f4afc22e83f7589a2f37e111cff5ca84529571f1c8415bcc5fcc21b2
```

`scripts/build/prepare-cache.sh` accepts an already populated npm cache and checked metadata. Cache population is a trusted preparation action using the matching pinned Node image's npm with lifecycle scripts disabled. It is never performed by running repository commands on the host. The cache metadata records Node/npm versions, fixture commit and lockfile digests, package integrity values, and profile ID. The guest later runs `npm ci --offline`; a miss fails rather than enabling networking.

`scripts/build/write-profile.sh` hashes the final QEMU/kernel/initrd/rootfs/cache files and writes the strict profile. Image/cache generation and lock updates are serialized shared-state work.

## Control protocol

All internal routes use the M3 Bearer token and the live `{worker_id,attempt_id,fence}` tuple:

```text
POST /internal/v1/build-jobs/lease
POST /internal/v1/build-jobs/{id}/renew
POST /internal/v1/build-jobs/{id}/source:materialize
POST /internal/v1/build-jobs/{id}/credentials:resolve
POST /internal/v1/build-jobs/{id}/complete
POST /internal/v1/build-jobs/{id}/cancel:ack
```

The lease contains the immutable exact source/configuration/report tuple, ordered service snapshots, explicit limits, build-environment secret references, and profile/input digests. Materialization returns only exact commit/tree, HBS1 bundle/tree-manifest digests, and counts. Repository credentials remain inside control/provider code. Credential resolution returns only exact bound build-environment versions.

HBS1 is `HBS1`, big-endian entry count, then sorted regular-file entries `{u16 path length, UTF-8 safe relative path, u32 mode 0644|0755, u64 size, bytes}`. No directory, link, submodule, device, duplicate, case collision, or traversal entry is accepted. Control hashes the exact HBS1 bytes as `bundle_digest`; the worker verifies that CAS object before attachment and the guest validates the framing again.

Completion contains state/code, result and cleanup manifest digests, billable
elapsed seconds, and zero or more host-verified artifact records. The durable
reservation is 600 seconds, so the worker caps billable elapsed time at 600
even when QEMU termination and cleanup finish later. The `build_vm_cleaned`
worker event records the full supervisor duration separately as
`actual_elapsed_seconds`. Failed work sends no artifact. The exact referenced JSON schemas are:

```text
hostlet.build-result/v1:
  job_id, attempt_id, fence, input_manifest_digest, state, code,
  elapsed_seconds, artifacts

hostlet.build-cleanup/v1:
  job_id, attempt_id, fence, status=confirmed|pending

hostlet.build-artifact/v1:
  job_id, attempt_id, fence, input_manifest_digest, source_commit,
  service_id, kind, archive_digest, packed_bytes, unpacked_bytes, entry_count,
  entrypoint_argv
```

Control re-hashes every CAS object, compares manifest fields with the request, and commits artifact registration, usage finalization, and the terminal effect only for the live fence. A stale attempt cannot promote a release. Cancellation is the narrow exception to live-fence completion: after fence loss kills QEMU, the worker sends the old attempt tuple, cleanup receipt digest, and elapsed seconds to `cancel:ack`. Control accepts only the canceled job's recorded attempt and fence, keeps its account in active admission while cleanup is pending, and releases that slot only after a verified confirmed receipt. `application_releases` and `project_release_routes` are outside the builder and cannot be changed by build completion.

## VM and artifact boundary

The worker launches QEMU through a transient restricted systemd unit named `hostlet-build-<full-job-uuid>-<full-attempt-uuid>.service`: KVM/q35, host CPU, exactly two vCPUs, 2048 MiB guest memory, no default devices, no NIC, no display, no monitor/QMP, immutable root/source/cache devices, and one fixed-size ext4 workspace. The four virtio block devices share one explicit IOThread whose blocking AIO pool reserves one worker and is capped at eight, leaving bounded headroom beneath the unit task cap for vCPUs, QEMU service threads, and the systemd supervisor. The unit's exact description repeats both UUIDs. Systemd applies a 200% CPU quota, memory ceiling including bounded QEMU overhead, device policy allowing only KVM, AF_UNIX restriction, no-new-privileges, protected host filesystem/home and a task cap. Its only writable host binds are the run-owned attempt directory and a short `/tmp/hostlet-build-<full-attempt-uuid>` socket directory needed to stay within the Unix-domain path limit. The socket directory is mode 0700 with a mode-0600 marker bound to the full job and attempt IDs; cleanup rejects symlinks, loose permissions and missing or mismatched markers.

Two named virtio-serial ports carry one-shot JSON input and HBO1 output; a third bounded socket captures console bytes. Build secrets are zeroized host values and are injected only into their declared service command environment. They are absent from disks, argv, reports, manifests, and retained console evidence. The guest has no repository token, runtime secret, management credential, or production database credential.

The guest extracts source into the fixed workspace, runs `npm ci --offline` and the declared build command per service, then packages the bounded service output. Static artifacts contain only the declared output directory. A Node HTTP artifact contains `dist`, its package metadata, and production dependencies after an offline `npm prune --omit=dev`; a Next.js artifact contains the generated standalone tree. HBO1 includes a bounded guest report and at most one static and one application artifact. Every artifact is sorted regular files with normalized mode and explicit sizes. The guest rejects output symlinks, FIFOs, device nodes, unsafe or duplicate paths, and output discovered after the success header boundary; a workspace `ENOSPC` is reported as `workspace_limit` using filesystem capacity available to the build, excluding ext4-reserved blocks. The host rejects malformed framing, unsafe/duplicate paths, unsupported entries, excess entry/byte counts, trailing bytes, and mismatched services. It writes canonical HCA1 bytes, hashes them itself, atomically installs the immutable CAS object, and writes the artifact manifest. It also validates the packaged application metadata and entry file and emits an immutable argv: `node dist/server.mjs` for Node HTTP, `node server.js` for Next.js standalone, and null for static output.

HOST-226 staging consumes verified `archive_digest` plus `manifest_digest`, safely extracts HCA1 into its owned runtime/static generation, and independently computes its serving/runtime tree digest. Builder archives currently reject symlinks.

Lease renewal runs during QEMU execution. Lease loss or cancellation kills the complete transient control group and discards unregistered output. A drop guard stops the owned unit on an unwinding/error exit. Independently, systemd enforces `RuntimeMaxSec=<declared timeout + 15>` with a five-second stop timeout, so an abruptly terminated worker cannot leave an unbounded guest. The E2E harness registers external cleanup before worker start and validates the full unit name, UUID description, and run-owned `BindPaths` before stopping an orphan. `systemd-run --pipe` output is captured in a private 0600 attempt file with a 64 KiB retained cap while both pipes continue to drain. On failure the worker emits an at-most-8-KiB JSON diagnostic with its digest and byte count after replacing the attempt and pinned-asset paths and any build-secret values. A platform fault may additionally emit only the bounded tail of the guest console with its digest after build-credential redaction; ordinary tenant build failures do not retain console text. It then removes the private files with the other attempt state. Success requires QEMU exit plus socket/workspace cleanup; otherwise cleanup is pending and success completion is rejected by control. Every outcome is subject to the M3 E2E artifact contract; a Docker process, shell subprocess, or mocked QEMU call is not proof.
