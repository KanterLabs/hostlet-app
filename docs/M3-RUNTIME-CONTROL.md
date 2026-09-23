# M3 runtime control contract

HOST-222 admits only owned M3 fixtures. Customer and production admission remain
disabled. The control plane records evidence, immutable allocation intent, and
owner-safe observations; none of these operations promotes a release or changes
a routing pointer.

## Evidence gate

`POST /internal/v1/runtime/evaluations` requires the runtime worker token and
accepts only `{ "evidence_digest": "sha256:<64 lowercase hex>" }`. The control
service reads that digest from:

```text
<HOSTLET_M3_STATE_DIR>/evidence/sha256/<first-two-hex>/<remaining-hex>.json
```

The file is bounded to 512 KiB, must be a regular file, and is hashed again
before parsing. Its root schema is `hostlet.runtime.executor-receipt/v1`, with
profile `owned_fixture_evaluation`, operation `validate`, no capability digest,
and a non-nil evaluation-subject UUID in the envelope's allocation field. The
subject, generation, and fence are retained and bound into the capability digest.
The `evaluation` object contains:

- `patterns`: exact framework, Node major, artifact and manifest digests, build
  profile digest, source commit, passed/total compatibility assertions, at
  least three actual healthy cold starts, and at least 60 seconds of warm idle
  observation for each admitted pattern;
- `compatibility`: recorded baseline/sandbox sample counts, a measured warm run,
  p95 startup, comparable native/sandbox request latency, and throughput;
- `performance`: exactly `{"decision":"owned_fixture_only","throughput_target_ratio":0.5,"throughput_target_met":<boolean>,"production_ready":false}`.
  Control recomputes `throughput_target_met` from positive finite baseline and
  sandbox throughput using the preserved 50% target. A false value records a
  deferred production-performance decision and does not claim production
  readiness;
- `network`: nonzero passed/total allowed and forbidden probes plus an
  independent observation marker;
- `resources`: the observed cgroup/network limits, all enforcement reason codes,
  exact restart series and no observed idle stop; and
- `benchmark`: bounded startup/request sample arrays and observed native/sandbox
  CPU and peak-memory metrics. Control recomputes p95 values from the samples.

The evaluation also binds digest identities for the evaluator, OCI schema,
artifact unpacker, runtime binary, build profile, and canonical runtime policy.

Control recomputes the gate. Node 22 and Node 24 HTTP patterns must pass. A
failing Next.js pattern remains explicitly unsupported and cannot be allocated.
Every reported pattern, including an observed incompatibility, must match an
exact succeeded registered build artifact record; a prior artifact cannot
authorize a new release digest.
Passing requires p95 startup at most 5 seconds,
sandbox latency no worse than `max(2 * baseline, baseline + 25ms)`, every
probe/assertion passing, the exact performance assessment above, and the exact
policy below. The 50% throughput target remains recorded and independently
recomputed; a target miss may pass the owned-fixture evaluation only when all
other gates pass. A receipt's own `result` does not override those checks.
Every accepted evaluation is explicitly for owned fixtures and has
`production_ready: false`; it cannot enable customer or production admission.
Registration accepts only a receipt observed within the last 30 minutes of
real UTC and an evaluation intent whose credential was issued within that same
real-time window. The original observation timestamp remains part of the
durable facts. An accepted evaluation expires seven policy-clock days after
registration. The generated capability digest binds the evidence, runtime
binary, platform, and policy.

The canonical policy document is the following single-line UTF-8 JSON with its
keys in the shown order; its digest is SHA-256 over those exact bytes:

```json
{"cpu_period_micros":100000,"cpu_quota_micros":25000,"healthy_reset_seconds":600,"max_connections":128,"memory_bytes":536870912,"memory_swap_bytes":0,"new_connections_burst":40,"new_connections_per_second":20,"pids":128,"restart_delays_seconds":[1,2,4,8,16,30],"restart_limit":6,"restart_window_seconds":600,"scratch_bytes":268435456,"schema":"hostlet.runtime.policy/v1"}
```

Policy time controls the capability lifetime and expiry comparisons. Worker
authentication, receipt and intent freshness, leases, elapsed benchmarks, and
executor behavior use real time. Advancing the owned policy clock therefore
expires the prior capability without making an old receipt fresh or preventing
a newly measured receipt from receiving a new bounded policy lifetime.

## Allocation

`POST /internal/v1/runtime/allocations` requires the runtime worker token:

```json
{
  "build_job_id": "uuid",
  "artifact_id": "uuid",
  "evaluation_id": "uuid"
}
```

Control derives every executable tuple field. The build must be succeeded, its
application artifact registered by its live fenced attempt, its deployment still
queued, and its reservation not released. The evaluation must be passing,
unexpired, for the current canonical policy, and contain a passing pattern that
exactly matches artifact digest, manifest digest, build profile digest, commit,
framework, and Node major. A missing, stale, failed, or mismatched condition
returns `runtime_allocation_ineligible` and creates no allocation.

Allocation serializes on the configured service, assigns increasing generation
and fence values, and returns the exact artifact/runtime/capability digests,
platform, stack `profile`, fixed executor `executor_profile` equal to
`evidence_gated_owned_fixture`, and policy document. The stack profile identifies
the admitted application shape, such as `node24-http-v1`; it is separate from
the executor receipt profile. Repeating the exact active tuple returns the
existing allocation. Fixtures declare `npm run start` for source compatibility.
The builder verifies the packaged `package.json` mapping and persists immutable
`entrypoint_argv` with the fenced artifact: either
`["node","dist/server.mjs"]` or the Next standalone
`["node","server.js"]`. Runtime accepts only that artifact-bound argv and
returns it with the validated health path plus fixed fixture application/health
port 3000. It never shell-splits or executes a caller command. The executor request schema is
`hostlet.runtime.executor-request/v1`; host paths, mounts, flags, namespace paths,
devices, commands, environment values, and network rules are never accepted from
this endpoint.

`POST /internal/v1/runtime/allocations/{allocation_id}/credentials` accepts only
the exact allocation ID, generation, and fence. Control resolves that allocation
tuple only while its state is `allocated`, `running`, `healthy`, or `backoff`,
then derives the project, configuration, reservation, live tenant database and
database generation before resolving only its active `runtime` credential through
the tenant-database keyring. A newer allocation for the same service does not
revoke a separately retained exact tuple; stopped and cleaned allocations still
cannot receive credentials or be revived. It cannot return
a migration, backup, provisioning, or caller-selected database credential. The
response retains UUID refs for authorization and supplies the worker's exact
usable identifiers: `hdb_<database UUID simple>` and
`ha_<runtime-role UUID simple>`. Its zeroized JSON value carries the password.
The single response is sensitive and must be serialized once into private ephemeral
secret injection, omitted from logs/artifacts, and zeroized after use.

Capability evaluation has a narrow bootstrap route:
`POST /internal/v1/runtime/evaluations/credentials` with `build_job_id`,
`artifact_id`, `evaluation_subject_id`, `generation`, and `fence`.
Runtime-worker authentication and owned-fixture mode are required.
Control derives a succeeded registered application artifact, its exact
deployment/configuration, finalized build meter, non-released reservation, and
ready tenant database,
persists an `owned_fixture_evaluation` intent, then returns the same active
runtime-purpose credential. Registration requires a CAS receipt with that exact
subject/generation/fence and the intent's artifact tuple before consuming the
intent. It creates no runtime allocation and cannot select a caller database,
purpose, role, or network target.

Initial evaluation accepts a queued deployment. A fresh evaluation after
evidence expiry may accept a healthy deployment only when the exact build and
artifact still have an eligible retained allocation in running, healthy, or
stopped state under the same account, project, deployment, configuration, and
reservation tuple. A newer allocation for another retained release does not
revoke this exact tuple.
The caller must use a fresh subject, generation, and fence; control never extends
or inherits an expired evaluation.

Restore validation has a separate narrow bootstrap route:
`POST /internal/v1/runtime/restore-probes/credentials` with `build_job_id`,
`artifact_id`, `evaluation_subject_id`, `generation`, `fence`, `recovery_id`,
`tenant_database_id`, and `database_generation`. It requires the exact latest
eligible retained allocation for the requested build, artifact, account,
project, deployment, service, configuration, and reservation tuple, plus a
validated, uncleaned replacement for the same owned project and database
generation. If several eligible exact allocations exist, control selects the
highest exact generation deterministically. The associated `restore_drill` operation must
have succeeded with an exact recovery, archive, replacement, identity, grant,
application-connectivity, and source-unchanged proof. Control persists a fenced
restore-probe intent and derives `hdr_<recovery UUID simple>` plus the active
runtime role `ha_<role UUID simple>` server-side. A caller cannot supply a
database name, address, role, credential purpose, or secret. Registering the
matching digest-addressed evaluation consumes both the evaluation and restore
probe intents; it does not mutate the retained allocation or promote a release.

## Observations

`POST /internal/v1/runtime/observations` requires the runtime worker token and
accepts `{allocation_id,generation,fence,state,receipt_digest}`. The receipt uses
the same CAS path and `hostlet.runtime.executor-receipt/v1` envelope. Control
validates the exact allocation ID, generation, fence, artifact/runtime/policy/
capability digests, and platform. The allocation's stack `profile` remains its
application identity; the receipt must use the fixed executor `profile`
`evidence_gated_owned_fixture`. A running receipt may include the optional
host-trusted `scratch_observation` object:

```json
{"capacity_bytes":268435456,"available_bytes":0}
```

Control accepts the field only with exactly 256 MiB capacity and available bytes
between zero and capacity. Pre-start, cleanup, evaluation, legacy, and failed
stat reads may omit it; no guest-reported JSON value is trusted as a substitute.

Running and healthy observations require actual cgroup readback matching the
policy. Healthy additionally requires at least one passing gateway-namespace
HTTP check. Cleaned requires observed absence of the owned sandbox, both network
namespaces, and cgroup, with no retained executor state.

Cleanup receipts include the strict `cleanup.mounts_absent` flag. A missing flag
is an invalid receipt; `mounts_absent: false` cannot establish the `cleaned`
state and leaves cleanup unrecorded as complete.

The durable owner lifecycle is `allocated -> running -> healthy`, with bounded
`backoff`, then `stopped -> cleaned`. A `running` executor receipt with a passing
health summary maps to `healthy`; `restart_scheduled` or `crash_loop_backoff`
maps to `backoff`. A backoff allocation may return directly to `healthy` only
through the same strong healthy receipt checks. Observations fence against their
exact allocation tuple, so separately retained allocations for one service can
coexist; stopped and cleaned states cannot revive. Forbidden transitions, stale
tuples, reused receipts, and receipt/state mismatches fail closed. Exact receipt
replay is idempotent.

`GET /v1/runtime/compatibility` returns authenticated, currently passing safe
profile support only. `GET /v1/projects/{project_id}/runtime/observations`
requires the owner and returns bounded state, enforcement reason, timestamp, and
published limits. It does not expose host addresses, paths, namespace identifiers,
sandbox identifiers, raw counters, source, environment, secrets, or credentials.

Stable bounded reason codes are `runtime_prepared`, `runtime_started`,
`runtime_stopped`, `runtime_cleaned`, `runtime_exit`, `runtime_oom`,
`cpu_throttled`, `process_limit_exceeded`, `scratch_limit_exceeded`,
`network_connection_limit`, `health_failed`, `crash_loop_backoff`,
`runtime_isolation_unverified`, and `runtime_internal_failure`.
