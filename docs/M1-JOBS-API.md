# M1 durable jobs and scoped credentials

M1 runs platform bookkeeping only. It records and probes the credential policy for
an exact source commit; it never checks out source, invokes a build command, starts a
tenant process, provisions capacity, or promotes a release.

## Owner API

All owner routes require a Bearer session and enforce the account/project/service
relationship in both queries and composite foreign keys.

`POST /v1/projects/{project_id}/jobs` requires `Idempotency-Key` and accepts:

```json
{
  "kind": "foundation_bookkeeping",
  "operation": "build",
  "service_id": "<uuid>",
  "source_commit": "<40-or-64-lowercase-hex>",
  "secret_version_refs": [
    {"service_id": "<uuid>", "secret_version_id": "<uuid>"}
  ]
}
```

It returns `201` with a `JobRecord` containing the identifiers above plus `state`,
`revision`, `attempt_count`, `current_attempt_id`, `current_fence`,
`lease_expires_at`, `created_at`, and `updated_at`. A new record is `queued`, revision
1, attempt count 0, and fence 0. Exact replay returns the stored record; changed
payload reuse returns `409 idempotency_payload_changed`.

Only `foundation_bookkeeping` plus operation `build` is supported. Build, release,
and runtime execution kinds return `422 unsupported_job_kind`. A bookkeeping job may
bind at most one immutable version of each declared secret. The secret must belong to
the same owner/project/service, be scoped to `build`, and have kind
`source_repository_read` or `build_environment`. Production-database, management,
runtime, undeclared, and cross-owner references fail before a job is inserted.

- `GET /v1/projects/{project_id}/jobs/{job_id}` returns the owner-scoped record.
- `POST /v1/projects/{project_id}/jobs/{job_id}/cancel` requires
  `Idempotency-Key`, quoted `If-Match`, and `{}`. It cancels queued, running, or
  retriable work, advances the fence, and returns the record. A terminal job returns
  `409 job_terminal`.

## Internal worker API

These routes exist only on the loopback worker listener. They require the
service-scoped worker Bearer token before reading a JSON body.

- `POST /internal/v1/jobs/lease` with
  `{"worker_id":"...","kinds":["foundation_bookkeeping"]}` returns `204` with an
  empty body when no work is eligible, or `200` with:

  ```json
  {"job": {}, "attempt": {"id":"<uuid>","attempt_number":1,"fence":1,"worker_id":"...","lease_expires_at":"..."}}
  ```

- `POST /internal/v1/jobs/{job_id}/renew` accepts
  `{"worker_id":"...","attempt_id":"<uuid>","fence":1}` and returns the job,
  attempt, fence, and new expiry identifiers.
- `POST /internal/v1/jobs/{job_id}/credentials:resolve` accepts the same lease
  tuple plus `secret_version_ids`. It returns only the exact versions bound at
  enqueue. Values exist in the response solely for injection into the bookkeeping
  worker and are never logged or persisted in job reports.
- `POST /internal/v1/jobs/{job_id}/complete` accepts the lease tuple plus one safe
  outcome: `succeeded/bookkeeping_complete`, `failed/bookkeeping_failed`, or
  `retriable/retry_requested`. It returns `{job,effect}`; retriable has a null effect.

Every lease-sensitive route verifies the current attempt, worker ID, fence, running
state, and both unexpired lease timestamps. It acquires the row lock before consulting
`clock_timestamp()`, so time spent waiting for a lock cannot revive an expired lease.
A stale or canceled worker receives `409 job_fenced` and cannot renew, decrypt, or
complete.

Claiming atomically increments the attempt count and fence and inserts an immutable
attempt. The one-second reaper processes at most 64 expired rows per tick. It records
an expired attempt and makes the same durable job retriable. Attempt three terminates
as failed with code `attempts_exhausted` and one effect. An exact retriable completion
can be replayed until another claim advances the fence. An exact terminal completion
returns its stored response; a changed completion returns `409 completion_conflict`.

The default lease is 30 seconds. `HOSTLET_WORKER_LEASE_SECONDS` may set 2 through 300
seconds; the E2E suite uses 2. Worker audit rows contain only bounded worker/attempt
identifiers and fences.

## Secret storage boundary

Secret definitions are scoped by account, project, service, operation, and credential
kind. Versions are append-only and encrypted with XChaCha20-Poly1305 using a random
24-byte nonce. Additional authenticated data binds every scope identifier plus the
secret and version UUIDs. Metadata routes never return values, ciphertext, nonce, tag,
or key bytes. Secret-bearing idempotency uses a keyed fingerprint and stores its key
version; ordinary requests retain the existing unkeyed request hash.

The real `hostlet-builder worker` mode leases bookkeeping jobs, emits a safe
`job_claimed` event, resolves exactly the declared versions, drops their values after
counting them, and commits the safe completion. Its token is read only from
`HOSTLET_WORKER_TOKEN`; redirects and proxy discovery are disabled, and the control
URL must be loopback HTTP.
