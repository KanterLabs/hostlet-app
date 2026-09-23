# M3 gVisor runtime executor

HOST-222 uses direct OCI `runsc`; it never registers a Docker runtime or changes
host-global firewall rules. The default `hostlet-runtime` command still refuses
work. Only `owned-fixture` accepts work, and requests must select either the
bootstrap evaluation profile or an evidence-gated owned fixture. Customer
admission remains disabled.

Install the pinned official runtime without changing system configuration:

```sh
scripts/runtime/install-runsc.sh
```

This fetches gVisor `release-20260914.0`, verifies the published x86-64 archive
SHA-256, extracts the complete sidecar layout beneath `.local/tools`, and writes
file hashes. The executor independently verifies the requested runsc digest and
uses strict matching sidecars.

## CLI and protocol

```text
hostlet-runtime owned-fixture \
  --request-file /absolute/request.json \
  --launcher /absolute/scripts/runtime/hostlet-runtime-launcher \
  --state-root /absolute/owned/runtime-state \
  --artifact-root /absolute/owned/artifacts \
  --runsc /absolute/.local/tools/gvisor/release-20260914.0/runsc
```

The unprivileged executor invokes only the validated absolute launcher through
`/usr/bin/sudo -n --` with a cleared environment and fixed PATH. The launcher
revalidates the complete request and requires a non-symlink regular request file
without group/world write. Its sudo rule must name this one absolute executable;
control does not receive a general root shell or Docker/runsc socket.

Before the privileged launcher is used, the orchestrator creates the two exact
owned roots and writes `hostlet-runtime-state-v1` to
`.hostlet-runtime-owned` and `hostlet-artifacts-v1` to
`.hostlet-artifacts-owned`. The launcher rejects missing markers and symlinked
roots. These markers are prerequisites, not evidence.

The request is `hostlet.runtime.executor-request/v1`. It contains allocation
UUID, generation, fence, immutable archive (`artifact_digest`), build manifest
(`artifact_manifest_digest`), build profile (`build_profile_digest`), runtime,
policy and capability digests,
platform, fixed command ID expansion, safe environment names, application and
health ports, exact IPv4/IPv6 endpoints, the canonical resource policy and the
operation. `owned_fixture_evaluation` requires a null capability digest;
`evidence_gated_owned_fixture` requires one. Raw secrets, host paths, namespace
paths, mounts and runtime flags are not protocol fields.

HOST-226 stages the builder's verified HCA1 beneath
`<runtime-artifact-root>/<build-manifest-sha256-hex>/`, writes
`hostlet.runtime-artifact/v1`, and records source commit
from the build manifest plus build-profile digest from the trusted build job.
It combines the HCA1 payload at fixed `/app` with a pinned Node base rootfs and
records both build-manifest and base-rootfs digests; an HCA1 application archive
is never treated as a bootable root filesystem.
`scripts/runtime/prepare-artifact.py` verifies every input digest, parses the
bounded HCA1 framing itself, rejects special files and escaping or dangling
base-image links, and atomically installs the resulting tree. The manifest
fixes the work directory at `/app` and binds the reviewed secret-entrypoint
digest.

Identical archive bytes from different builds may have different manifests.
Each exact build manifest selects its own immutable assembly, so a rebuild
cannot replace an artifact used by a retained release. Repeating assembly must
match the archive, build profile, both base digests, source, service and shim,
and must verify the installed tree. A conflicting assembly is rejected rather
than overwritten. M3 pins one runtime base per exact build manifest; changing
that base requires a new build manifest. The executor and migration probe
select by the requested build manifest and verify the archive and profile
before mounting the tree.

```text
prepare-artifact.py --archive-file HCA1 --archive-digest sha256:... \
  --build-manifest BUILD.json --build-manifest-digest sha256:... \
  --build-profile-digest sha256:... --base-rootfs NODE_ROOT \
  --base-rootfs-digest sha256:... --base-manifest BASE.json \
  --base-manifest-digest sha256:... --artifact-root OWNED_ROOT
```

The base manifest must name an exact Node 22 or 24 Bookworm Slim image digest,
bind its exported archive, and attest that no project code ran during export.
The runtime independently recomputes the canonical rootfs tree digest. Safe
symlinks may resolve only inside that root; M3 builder output is regular-file-only.
Secret references contain only a name and version UUID. Values move from a
derived 0400 ownership-marked input into a per-allocation tmpfs outside the
private state tree, the input is unlinked immediately, and values never enter
JSON, argv, logs or receipts. The tmpfs is root-owned with group `100000`
traverse-only access, and each approved file is mode `0400` owned by mapped UID
`165532` (container UID `65532`). OCI exposes only those exact files as
read-only, `nosuid,nodev,noexec` binds. The fixed artifact entrypoint reads each
validated name into the child environment immediately before `exec`; it neither
persists nor prints the value. If preparation fails before all source versions
are consumed, the launcher verifies the exact allocation/fence input directory,
shreds only requested mode-0400 version files, and removes the ownership marker;
unexpected entries retain state and fail cleanup.
For `DATABASE_URL`, the trusted credential broker builds the URI from the
control-returned `database_name` and `role_name` plus the secret password and
owned endpoint. UUID references select versions only; they are never used as
PostgreSQL identifiers.

Operations are `validate`, `prepare`, `start`, `inspect`, `reconcile`, `stop`,
`cleanup` and `record_exit`. `reconcile` owns the durable exit window, performs
the bounded delayed restart, and resets it only after ten healthy minutes;
`record_exit` is a pure control-plane preview and cannot start work. Every
successful operation emits one canonicalizable
`hostlet.runtime.executor-receipt/v1` JSON object. The receipt carries the exact
allocation/generation/fence and input digests, platform/profile, observed time,
sandbox identity, OCI/network digests, namespace inodes, actual cgroup values and
events, safe reason, and real HTTP health checks. While a sandbox is running,
the launcher may also include this host-trusted readback:

```json
{
  "scratch_observation": {
    "capacity_bytes": 268435456,
    "available_bytes": 0
  }
}
```

It is produced only by the fixed immutable `/usr/bin/stat -f` command executed
inside that runsc sandbox against `/tmp`, bounded by a fixed two-second timeout;
the launcher omits it when the sandbox is not running, the command fails, or the
measured capacity is not exactly 256 MiB. It never accepts a guest JSON report
as the observer. Pre-start and cleanup limits are null.
Control stores canonical receipt bytes
at `evidence/sha256/<first-two>/<remaining>.json`; its `sha256:<lowerhex>` digest
is not embedded in the receipt itself.

The evaluator adds the agreed `evaluation` object with evaluator, OCI-schema and
unpack-tool digests; pattern identities, exact cold-start sample arrays and
assertion counts; at least three actual healthy cold starts and a 60-second
warm/idle observation per admitted pattern; baseline/sandbox
startup, CPU, peak-memory, request-sample and throughput metrics; allowed/forbidden network totals with
independent observation; exact resource limits/reasons/restart schedule; and
the no-idle-stop observation. Capability registration validates the bootstrap
compatibility, isolation and enforcement evidence. M3 acceptance additionally
requires the subsequent admitted-allocation, owner-observation and continuity
scenarios to pass.

## Isolation and lifecycle

`prepare` derives every name from the validated allocation, generation and fence,
verifies the digest-addressed rootfs, and creates a root-owned mount exposure at
`/run/hostlet-owned-fixture-mounts/<allocation>-<generation>-<fence>`. The prefix
is mode `0711` with a root-owned marker; each tuple directory is root-owned,
group `100000`, mode `0710`, so the mapped runtime root can traverse it without
being able to modify it. The verified rootfs is bind-mounted there and remounted
read-only with `nosuid,nodev` while retaining execute permission. The exact
source path, source inode, target and kernel mount identity are recorded in the
original `OWNERSHIP.json` before the OCI bundle is emitted. This exposure avoids
requiring the mapped root to traverse private `.local` directories and never
changes their permissions.

Artifact assembly creates an empty `/run/secrets` mount point before sealing the
rootfs. Credential bytes live only in the allocation's private host tmpfs; its
directory is owned by mapped application UID `165532`, group `100000`, mode
`0550`, and credential files are mode `0400`. The directory is bound read-only
at `/run/secrets` with `nosuid,nodev,noexec`. This also lets gVisor resolve the
destination without trying to modify the immutable rootfs. Consumed input files
and empty allocation input directories are removed after preparation.

`prepare` then creates an application and gateway network namespace, moves both
veth ends out of the host namespace, applies an atomic namespace-local nftables
default-drop ruleset, and generates a read-only OCI bundle. The workload is UID/GID 65532, has empty capabilities and no-new-
privileges, receives no management device/socket/path, and gets only bounded
tmpfs scratch. Runsc uses systrap by default, its own netstack, a pre-created
direct cgroup-v2 leaf under `/sys/fs/cgroup`, strict sidecars, and the exact policy: 512 MiB/no swap, 0.25 CPU, 128 tasks,
256 MiB scratch, 128 TCP connections and 20 new connections/second (burst 40).
Runsc's sandbox network setup consumes the application veth addresses while it
copies that namespace into its netstack. Before every start, including an OOM
reconcile, the launcher verifies the recorded application and gateway namespace
inodes plus the exact veth names, indices, peer indices and MAC addresses. It
then restores only the recorded application IPv4/IPv6 addresses and default
routes through the recorded gateway; the IPv6 address uses per-address `nodad`
for deterministic startup. A mismatch fails closed and leaves gateway nftables,
peer attachments and routes untouched.
The next running observation reads `/tmp` capacity and available bytes through
the fixed in-sandbox stat observer; a zero available-byte readback supplies the
`scratch_limit_exceeded` reason unless a stronger OOM, PID, or network
enforcement reason is already present.

Ingress, PostgreSQL and egress peers are attached to the run-owned gateway by a
separate root helper after it independently validates their owned identities.
PostgreSQL is identified by full Docker ID and exact M3/database labels; the
helper obtains its PID by inspect and never accepts a PID or namespace path from
the request. The gateway rules permit only declared address/port tuples.
`hostlet-runtime-peer` implements that attachment and verifies the full
Docker ID, network-none/running state, exact run/database/generation/restore
labels and recorded gateway inode before moving a veth peer. A database target
has one stable IPv4/IPv6 address on the PostgreSQL namespace loopback and one
exact root-owned target record. Every retained allocation gets its own
collision-checked transport `/30` and `/126`, veth pair, and `/32`/`/128`
return routes; the gateway routes the stable target alias through that
allocation's transport. The target record is locked and updated atomically, so
a second release can share the same owned network-none PostgreSQL container
while preserving the first release's veth, routes, and credential endpoint.
Before any alias, veth, address, or route effect, the helper writes a
root-owned, fsynced per-attachment intent under the same registry lock. The
intent binds the exact target, allocation/generation/fence, namespace inodes,
planned interfaces, deterministic MACs, transport tuple, routes, and effect
ownership phases. A replay accepts only matching namespace/link/MAC/route
identities and either completes the member and peer records or removes only
the exact effects recorded by the intent. An ambiguous identity retains the
intent for diagnosis; it never deletes a link by name alone. Empty-target
reactivation persists preparing before aliases, while active retained members
stay active throughout.
The registry contains only exact allocation members, bounded per-allocation
completion records, and empty attachment-intent state after successful
replay. After the final member removes the loopback aliases it leaves an
empty, exact target record until run cleanup removes those records, the
attachment directory, and the lock. No host or Internet route is added.

The gateway does have namespace-local IPv4 and IPv6 default routes to an
unaddressed dummy sink. This sink has no peer and exists only so undeclared
packets reach the existing forward-chain `forbidden` counter and drop rule;
declared peer routes are more specific and continue to the allow rules. Detach
removes only the recorded veth and its kernel-owned routes. Deleting the
inode-validated gateway namespace also removes the sink and its routes. The
browser-facing
`hostlet-runtime-relay.py` runs through the narrow privileged helper boundary,
listens only on host loopback and enters the validated gateway namespace only in
forked connection handlers; it adds no host route. After validating the
allocation, generation, fence and namespace inode from root-owned runtime state,
it atomically publishes only a sanitized
`runtime-relays/<allocation>/<generation>/<fence>.json` map. The 0700 map
directories and 0600 map are owned by the original runtime-state owner, so the
unprivileged gateway can read the loopback address and port without reading
`OWNERSHIP.json`. On termination the relay removes only the same file inode when
its tuple, relay PID and gateway namespace inode still match.
`hostlet-runtime-fixture-peer` applies the same full-ID, network-none, run-label,
namespace-inode and fence checks to owned HTTP and DNS observers. HTTP must be
declared for both endpoint families at its exact TCP port; DNS must be declared
for TCP and UDP port 53. These peers provide routed public-service fixtures for
the network oracle without granting the gateway a host or Internet uplink.

The peer failure inventory is part of the acceptance boundary. A retained
release must attach to an already attached database target with the same stable
endpoint while receiving a distinct transport pair. A duplicate allocation
transport, application return route, interface, target alias, or registry
member is rejected before the existing member is changed. A stale PID,
namespace inode, interface index, MAC, route, target identity, or fence fails
closed. Attach rollback removes only the new veth, routes, and aliases; a
failure after shared-target admission leaves existing members usable and
retains an exact intent record for retry. The intent also covers a crash
between a named veth creation and ifindex observation: the planned MAC pair
and reciprocal peer identity must match before cleanup. Detached history keeps
the full member shape, is bounded to 256 records, and rejects duplicate
allocation/generation/fence tuples; freed transport/interface values may be
reused by later allocations. Detach verifies the recorded identity and route
ownership, tolerates only an already absent exact attachment on replay, and
removes the stable aliases only when the final member is gone.
The cleanup helper accepts only a root-owned, locked registry with empty target
records and removes its exact files; active members, malformed records, unknown
children, and retained aliases stop cleanup rather than being recursively
deleted.

Hosted release probe requests never contain a network target. The privileged
`hostlet-runtime-probe` derives the application IPv4 address and port only after
validating the root-owned allocation generation/fence record, gateway namespace
inode, artifact digest and running executor receipt. Supplying
`target_address` or `target_port` is rejected, so the unprivileged release
worker cannot redirect a probe through the gateway namespace.

## Disposable migration compatibility probes

Release migration validation never points a probe at an already hosted runtime.
The release lease supplies a server-generated `probe_execution_id`, the fenced
reconciliation/attempt identity, the approved source-allocation tuple, its
healthy executor receipt, and the immutable executor request fields. The probe
credential endpoint returns a credential document bound to that same identity
and `target: "isolated"`. The document must be a mode-0600 regular file at:

```text
<M3-state>/probe-credentials/<probe_execution_id>.json
```

`hostlet-runtime-migration-probe.py` accepts SHA-256-bound request and credential
files plus fixed operator-configured executable and owned-root paths:

```text
hostlet-runtime-migration-probe.py \
  --request-file REQUEST --request-sha256 HEX \
  --credential-file CREDENTIAL --credential-sha256 HEX \
  --runtime-binary HOSTLET_RUNTIME --launcher LAUNCHER --runsc RUNSC \
  --peer-helper POSTGRES_PEER --state-root RUNTIME_STATE \
  --artifact-root RUNTIME_ARTIFACTS --evidence-root M3_STATE
```

The request schema is `hostlet.runtime.migration-probe-request/v1`. It binds:

- `probe_execution_id`, `reconciliation_id`, `attempt_id`, and `release_fence`;
- check/release/peer identity and the approved source allocation's
  allocation/generation/fence;
- artifact and healthy executor-template receipt digests;
- tenant database generation and migration UUID with `target: "isolated"`; and
- the control-derived runtime, policy and capability digests, platform/profile,
  argv, ports and health path.

The credential schema is `hostlet.runtime.probe-credential/v1`. Besides the
same complete fence and database identity, it contains a credential UUID, exact
clone database/role names and password. The helper resolves the clone container
only from the private `database-inventory.json` entry whose recovery UUID equals
the migration UUID. It constructs `DATABASE_URL` in memory, writes it to the
executor's derived protected secret input, then overwrites and unlinks the
credential document. Credential values never enter JSON requests, command
arguments, logs or receipts.

For each requirement, the helper creates a fresh allocation with identity
`probe_execution_id`, generation 1, and fence `release_fence`. It reuses the
approved artifact and policy but creates new OCI, namespaces, cgroup, secret
mount and runsc sandbox. It attaches only the owned clone PostgreSQL peer,
requires an actual healthy executor observation, writes a unique item through
the application API, reads that exact item back, and then stops, detaches and
cleans the allocation in a `finally` path. It cannot return success unless the
cleanup receipt proves sandbox, namespaces, cgroup and retained state are all
absent.

Canonical receipts are stored in the M3 evidence CAS. The application fact uses
`hostlet.runtime.application-probe-receipt/v1`. The accepted envelope is
`hostlet.runtime.probe-receipt/v2` and binds the complete release/source/probe
identity plus three digests: the healthy disposable executor receipt, actual
application write/read receipt, and cleanup receipt. The helper emits only a
`hostlet.runtime.migration-probe-result/v1` containing `probe_execution_id`,
`probe_receipt_digest`, `executor_receipt_digest`,
`application_probe_receipt_digest`, and `cleanup_receipt_digest`. A source
allocation ID reused as the execution ID, live target, missing clone, mismatched
credential, stale fence, unhealthy start, failed write/read, or incomplete
cleanup fails closed and cannot satisfy release reconciliation.

`stop` gives the sandbox five seconds after TERM, then uses KILL and deletes the
runsc object. `cleanup` verifies ownership markers, namespace inodes and the
recorded source/target mount identities, unmounts the exact secret and rootfs
targets before removing their tuple directory, and reports `cleanup_pending`
while retaining state if any sandbox, namespace, cgroup, mount or state removal
fails. A retry accepts a previously recorded target only when it is already
absent or an empty unmounted directory; any active mount must still match its
recorded identity. Partial `prepare` failures run the same exact unmount checks
and retain the owned tuple for a later cleanup retry. `reconcile` implements delays 1, 2, 4, 8,
16 and 30 seconds, with `crash_loop_backoff` after six exits in ten minutes. A
healthy ten-minute interval resets the durable window. There is no inactivity stop.

Before runsc is invoked, the launcher requires every controller advertised by
the cgroup-v2 root to already be enabled there; it never changes a shared slice
or ancestor. It creates the exact leaf
`/sys/fs/cgroup/hostlet-owned-runtime-<identity>-e<epoch>`, applies the M3 CPU,
memory, swap, PID and OOM-group controls, and journals its path, inode, fence and
epoch in the owned generation evidence before handing the path to runsc. The
filesystem driver leaves this pre-existing leaf in place after the sandbox exits,
so inspection reads the kernel counters from that exact inode even when the
worker PID is gone. A reconcile retires the old leaf only after recording its
reason, advances to a fresh epoch, and creates a new leaf; restart receipts carry
the old reason while their limits come from the new epoch. Healthy observations
never read a previous epoch's cached counters.

`stop` treats missing, created and already-stopped runsc objects as idempotent
cleanup states. `cleanup` removes only the inode-validated direct leaf after its
process and descendant lists are empty. If the generation directory has already
been removed, a root-owned exact tombstone proves the last path and inode before
replay verifies its absence; an allocation that never started records the same
exact path with a null inode and verifies that it is absent. The final runtime cleanup
helper verifies that exact path is absent before removing the tombstone. Without
that journal cleanup fails closed.
No cgroup discovery scan or broad deletion is used.

Reason codes are `runtime_prepared`, `runtime_started`,
`runtime_stopped`, `runtime_cleaned`, `runtime_exit`, `runtime_oom`,
`cpu_throttled`, `process_limit_exceeded`, `scratch_limit_exceeded`,
`network_connection_limit`, `health_failed`, `crash_loop_backoff`,
`runtime_isolation_unverified`, and `runtime_internal_failure`.

No run is evidence until the M3 harness launches actual fixtures and retains the
TESTING.md artifact. Validation output, generated configuration or a runsc
version string alone cannot pass HOST-222.
