# M3 runtime E2E boundary

`e2e/scenarios/m3-runtime.mjs` is the HOST-222 acceptance stage. It accepts
only real digest-bound build outputs and an explicit owned evaluator fixture.
The evaluator runs before customer admission, records receipts emitted by the
actual `hostlet-runtime`/gVisor boundary, and registers the resulting CAS digest
with control. Subsequent allocations use the capability returned by control.
The fixture path does not skip resource, network, evidence, or cleanup policy,
and production/customer admission remains disabled.

The stage consumes `m3.state.runtimeEvaluationInputs`:

- `buildOutputs`: a `Map` or object keyed by `node22_api`, `fullstack_v1`,
  `fullstack_v2`, `next16`, `policy_probes` and the relevant failure fixtures. Each entry binds
  durable build/artifact UUIDs, archive/manifest/profile digests, source commit,
  framework and Node major;
- `tenantPeers`: full run-owned Docker identities and labels plus exact
  IPv4/IPv6 PostgreSQL endpoints and UUID-derived database/role names; and
- `nodeBaseRoots`: exported digest-pinned official Node 22/24 filesystem roots.
  Each value may be the absolute `runtime-base/rootfs` path (with `base.json`
  beside it), or `{rootfs, manifest, rootfsDigest, manifestDigest}`. The stage
  invokes `scripts/runtime/prepare-artifact.py` against the canonical HCA1 and
  build-manifest objects in control's private CAS. Repeated assembly verifies
  and reuses the exact installed artifact identity. Assemblies are indexed by
  build-manifest digest, allowing equal archive bytes from different builds to
  coexist without changing retained artifacts. Requests also bind the archive
  and build-profile digests; a changed base under the same manifest is rejected.

The runtime stage itself launches the native comparison, operator-owned gVisor
evaluator, probes and continuity journey. Measurements must be backed by executor receipt digests
created during the same run. Hand-authored measurements or receipts from
another run are rejected.

The native Node baseline and the sandbox benchmark each issue 1,000 actual
health requests, consume the response body the same way, and calculate
throughput from the wall-clock duration of that request loop. The native
fixture supervisor (`scripts/runtime/hostlet-runtime-native-baseline`) runs the
assembled Node rootfs as UID/GID 65532 inside a dedicated cgroup with the exact
M3 comparison budget (`cpu.max=25000 100000`, 512 MiB memory, no swap and
`pids.max=128`); both CPU deltas and peak memory are read from that cgroup.
Stress-probe usage is kept out of the benchmark. Both request loops use the
same relay forwarding implementation; the native fixture relay stays in the
host network namespace and targets the native Node port, while the sandbox
relay enters its allocation-owned gateway namespace and targets the sandbox.
This is the narrowest equivalent forwarding path available without placing a
native process into a gVisor-owned namespace. The artifact records this
concrete namespace distinction and retains the 50% throughput target in an
explicit owned-fixture performance assessment. Control recomputes whether the
target was met from positive finite measurements; a miss is recorded as a
deferred production-performance decision while all other gates remain
mandatory. Each completed baseline and pattern writes a private measurement
payload before later phases run, so a later failure preserves the measurements
already taken.

After capability registration, resource, memory and crash probes run against
three distinct control-issued allocations. Actual executor receipts are recorded
through control, and the owner observations must contain all six enforcement
reasons for the exact allocation and generation. Scratch evidence includes the
trusted in-sandbox filesystem measurement; fixture ENOSPC alone cannot establish
the runtime reason. Peer and control health are sampled throughout pressure.

The runtime helper exposes evidence-gated allocation, launch, inspect,
observation, relay, PostgreSQL peer attach/detach, scoped credential injection,
stop and cleanup operations. It also exposes actual application read/write and
read-only-over-limit database probes, exact-artifact release evaluation, and a
callback-scoped pause of owned relay endpoints that verifies they become
unavailable and resume healthy. Relay discovery is a private atomic file at
`$HOSTLET_M3_STATE_DIR/runtime-relays/<allocation>/<generation>/<fence>.json`
with schema `hostlet.runtime.relay-map/v1`. Runtime cleanup verifies and removes
only that exact owned mapping.

Relay cleanup requires bounded stop receipts, leader reaping, and a second
verification that the exact process group and ownership map are absent.
Aborted or half-closed requests cannot leave handlers behind. Missing pidfd
support, an unowned group member, PID reuse, or a retained process/map fails
cleanup. Repeated starts and stops retain separate logs in the artifact.

Database E2E calls identify the owning project and an exact published peer.
The harness builds a real full-stack application in each additional admitted
project while restoring the main build-stage map afterward. Successful primary
probes retain their healthy allocation for later storage-freeze and release
checks. Replacement restore probes derive the recovery UUID from the protected
peer inventory, obtain a control-scoped `hdr_` evaluator credential, and run
three disposable gVisor read/write observations before consuming the restore
probe intent in capability evidence. They never repoint the retained primary
allocation.

## Upfront failure inventory

All cases are exercised at the process, HTTP, namespace, PostgreSQL, or artifact
boundary; no isolated unit suite is introduced.

| Failure | Required observable result |
| --- | --- |
| Missing/wrong runsc, runtime binary, launcher/helper, `ip`, `nft`, `jq`, cgroup v2, sudo rule, Node rootfs or owned marker | The scenario fails before admission, retains the failed run artifact and creates no capability. |
| Malformed request, unknown field, unsafe path/symlink, wrong file mode, digest/tree mismatch, unsupported command or omitted/over-limit resource | Executor rejects before sandbox execution; no receipt can establish capability. |
| Missing, failed, outdated, mismatched or expired evaluation | Control rejects allocation and durable queries show no allocation. |
| Fabricated measurement, foreign/stale receipt, incomplete cold starts, less than 60 real seconds warm/idle, policy-clock substitution for elapsed time, latency outside the declared bound, nonpositive/nonfinite throughput, or a missing/forged/mismatched performance assessment | Evaluation construction or control recomputation fails closed. A real below-target result remains an owned-fixture evaluation with production performance deferred; it is never rewritten as a target pass. |
| Platform/API/database, peer tenant, builder, Docker/management socket, host path or metadata access by IPv4, IPv6 or DNS | Inside-sandbox probe and independent destination/network evidence both show denial. |
| Declared tenant PostgreSQL and public HTTP/DNS access omitted or broader egress silently enabled | Allowed-path assertion or rules/counter assertion fails. |
| CPU, memory, scratch, PID or connection limit not enforced; pressure starves peer/control | M3-RUNTIME-03 fails with actual receipt and liveness evidence retained. |
| Crash replay, concurrent reconcile, stale generation/fence, retry or API/runtime restart bypasses restart budget | Control rejects stale work; durable backoff follows exactly 1,2,4,8,16,30 seconds and stops after six attempts in ten minutes. |
| Credential from caller, build, migration or another project; value in argv/JSON/log/artifact; secret input retained after prepare | Launch fails and cleanup retains a safe failure receipt. Only control's allocation credential may become a 0400 tmpfs-mounted secret file. |
| Health failure, sandbox exit, runtime/API restart, build allowance exhaustion or stale worker completion changes ownership/policy or idles a live app | Durable owner observation stays truthful; the same allocation/database either remains usable or exposes its bounded failure reason. |
| Stop/cleanup interruption, mismatched namespace inode, remaining relay, sandbox, cgroup, mount, veth or secret input | Cleanup is incomplete and cannot be recorded as cleaned; exact owned state is retained for diagnosis. |
| Duplicate observation or allocation delivery | Exact replay is idempotent; changed receipt reuse and competing tuples fail closed. |

The stage retains only safe identities, measurements, limits and digests.
Credentials, connection URIs, host inventories and private source bytes never
enter the E2E artifact.

## Focused artifact identity diagnostic

This diagnostic uses two real VM builds of the same full-stack source and two
running gVisor applications against one owned tenant database. It checks equal
archive bytes with distinct build manifests, immutable assembly coexistence,
exact replay, conflicting-profile rejection, cross-application reads and
writes, and cleanup receipts. It registers no production capability and cannot
satisfy a full M3 gate.

```sh
node e2e/run.mjs --require-clean \
  --milestone M3-runtime-artifact-identity-development --task HOST-233 \
  --scenario-module e2e/scenarios/m3-runtime-artifact-identity-development.mjs \
  --operation-timeout 3600000 --run-timeout 7200000
```

The standard runner retains the outcome, exact inputs and external checksum
receipt under `artifacts/e2e/M3-runtime-artifact-identity-development/<run-id>/`.
