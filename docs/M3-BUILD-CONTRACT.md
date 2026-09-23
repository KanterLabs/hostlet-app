# M3 owned-fixture build contract

HOST-225 is an explicitly configured `owned_fixture` path. Customer admission
stays closed. The M3 queue is separate from retained M1 bookkeeping jobs and a
successful build registers immutable artifacts only; it cannot create or
promote an application release.

## Durable admission

`POST /v1/projects/{project}/deployments/{deployment}/builds` requires an
idempotency key and quoted project revision. Control locks the owner, project,
deployment, exact GitHub source revision, current compatibility report, live
source proof, reservation generation, entitlement period and allowance. It
derives the commit, tree, service commands, profile, limits and secret names
from durable records. The browser cannot supply them. Enqueue atomically
reserves 600 build seconds and stores an immutable service and
`build_environment` secret-version snapshot. Repository, runtime, production
database and platform credentials are rejected.

`GET /v1/projects/{project}/builds/{job}` returns safe queue, artifact and
terminal metadata. `POST .../{job}/cancel` fences a queued or live attempt.
Queued cancellation launches and debits nothing. Live cancellation debits only
measured time after the credential-resolution launch boundary.

## Worker protocol

The dedicated build token authenticates these loopback routes:

- `POST /internal/v1/build-jobs/lease` claims one account build under a
  PostgreSQL fence and returns the exact input, ordered services, limits and
  secret references.
- `POST /internal/v1/build-jobs/{job}/renew` extends both current job and
  attempt leases. All live operations check both expiries with
  `clock_timestamp()` after locking them.
- `POST .../{job}/source:materialize` revalidates current GitHub authorization,
  installation, binding, project configuration and saved commit/tree. It
  returns digests only. HTTP 409 is reserved for a stale attempt/fence. A
  deterministic exact-source or policy verification failure returns HTTP 422
  with `error.code=build_source_rejected`, after extending only the already
  locked attempt/worker/fence for a bounded 30-second completion handoff. The
  worker then submits a zero-time `source_policy_rejected` completion with
  confirmed pre-launch cleanup; provider transport failures keep their
  non-422 status and cannot authorize execution.
- `POST .../{job}/credentials:resolve` resolves only exact bound
  `build_environment` versions and marks the execution-time meter boundary.
- `POST .../{job}/cancel:ack` accepts the old fenced attempt identity only after
  the worker has killed QEMU and verified socket/workspace cleanup. A canceled
  job remains an active account-concurrency record with `cleanup_status=pending`
  until this endpoint verifies a `confirmed` cleanup receipt and finalizes
  measured usage.
- `POST .../{job}/complete` verifies the live fence, every CAS object and every
  manifest before one transaction registers artifacts, finalizes usage and
  writes the terminal effect. An identical attempt replay returns its receipt;
  a changed replay conflicts.

Pre-launch platform faults are the only automatic retry. They debit zero and
retain the job allowance reservation. Customer, policy, dependency, timeout,
OOM, output and post-launch platform failures are terminal and retain measured
usage. Lease loss before launch may retry; lease loss after launch is terminal,
metered and records cleanup as pending.

## Exact source and private CAS

The provider accepts regular `100644` and `100755` Git blobs only. It rejects
symlinks, submodules, unsafe paths, duplicate or case-colliding paths, truncated
trees, over-limit entries and blobs, and any blob whose recomputed Git SHA-1
differs from the selected object ID. It never invokes Git, an archive tool, a
package manager or repository code.

The canonical source bundle is HBS1:

```text
"HBS1" | u32-be entry count |
repeat sorted-by-path { u16-be path bytes | path | u32-be mode | u64-be size | bytes }
```

Mode is `0644` or `0755`. The tree-manifest JSON records each path, mode, size,
Git blob SHA-1 and content SHA-256. Bundle and manifest objects are written with
`0600` mode beneath `<HOSTLET_M3_STATE_DIR>/private-cas/sha256/<64hex>` using a
synced temporary file and no-replace hard link, followed by directory sync and
full digest verification. Source is never extracted or made executable on the
control host.

## Completion manifests

The result manifest is exactly
`{schema,job_id,attempt_id,fence,input_manifest_digest,state,code,elapsed_seconds,artifacts}`
with schema `hostlet.build-result/v1`. The cleanup receipt is exactly
`{schema,job_id,attempt_id,fence,status}` with schema
`hostlet.build-cleanup/v1`. Success requires `status=confirmed`.

The `elapsed_seconds` completion field is billable time. The fixed build
reservation is 600 seconds, so the worker caps this value at 600 when guest
termination or cleanup runs past the reservation. The worker's
`build_vm_cleaned` evidence keeps the full supervisor and cleanup duration as
`actual_elapsed_seconds`.

Each artifact manifest is exactly
`{schema,job_id,attempt_id,fence,input_manifest_digest,source_commit,service_id,kind,archive_digest,packed_bytes,unpacked_bytes,entry_count,entrypoint_argv}`
with schema `hostlet.build-artifact/v1`. Control verifies the manifest digest,
archive digest, exact source/input/fence identity, service-to-kind mapping,
counts and size caps. Failed or retriable attempts cannot register artifacts.
Static artifacts have a null entrypoint. After inspecting the packaged files,
the builder records Node HTTP as `["node","dist/server.mjs"]` and Next.js
standalone as `["node","server.js"]`; control checks that mapping against the
immutable framework and saved `npm run start` source contract. Runtime executes
only this registered argv and does not invoke npm or a shell.
Guest workspace `ENOSPC` is a terminal `workspace_limit` result. Any symlink,
FIFO, device node or other non-regular declared output is a terminal
`output_invalid` result, and the guest emits that failed report before a
success header can be sent.
CAS objects written before a stale or rejected completion remain unregistered
and are eligible for reconciliation; they never become deployment artifacts.

Approved profiles are `m3-owned-node24-v1`, `m3-owned-node22-v1`, and the
failure-only `m3-owned-node24-cache-miss-v1`. Control reads the exact strict JSON
from `<HOSTLET_M3_STATE_DIR>/profiles/{id}.json` and persists its real SHA-256;
the worker must advertise the digest of identical bytes. Node 22 is derived from
the immutable service graph. Node 24 is the default. The cache-miss profile is
accepted only when the exact source commit is listed in the protected
`profiles/admissions.json` file under schema
`hostlet.build-profile-admissions/v1`. Profile replacement never mutates a
queued job; the replacement digest cannot lease it. Kernel, rootfs, guest,
Node/npm and offline cache digests remain mandatory profile inputs and evidence.
