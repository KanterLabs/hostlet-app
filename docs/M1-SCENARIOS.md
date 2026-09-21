# M1 foundation acceptance scenarios

Scope: HOST-241, HOST-209, HOST-210, HOST-215, HOST-216, HOST-217,
HOST-218 and the HOST-242 stop gate. This inventory is written before the
foundation implementation. It defines observable outcomes for running-system
E2E; it is not a unit-test plan or a claim that any scenario already passes.

Use real API processes, a browser for the existing web shell, a disposable
PostgreSQL instance, real worker processes and actual migration/backup commands.
Only owned synthetic data is permitted. Do not run customer source or provision
hosting, GitHub integrations, payment, or a public portfolio in M1.

## Harness and contract boundaries

- The browser observes the real API version, liveness and honest dependency
  readiness. Stopping the API changes the observed response; no intercepted
  browser response or mocked Hostlet service can stand in for this check.
- A deliberately failing assertion, unavailable prerequisite, timeout, skipped
  required scenario or failed artifact finalization exits unsuccessfully and
  leaves evidence. Cleanup stops only resources created by this run.
- A clean repeat reproduces assertions from a recorded commit, dependency
  versions, seed, fixtures and command. Verify the external checksum receipt.
- Accept static-only, API-only and standard frontend/API/database definitions.
  Reject extra services, traversal roots, missing lockfiles, unsupported runtime
  patterns, missing application start/health configuration and unbounded limits.
- Typed portfolio fixtures distinguish drafts, owner edits, immutable approvals,
  authorized deployment facts and release-specific readiness. Hosting permission
  never implies permission to publish. M3 proves publication behavior.

## Accounts, authentication and durable ownership (HOST-215)

- Create two independent accounts through real HTTP. Authenticate each, reject
  wrong credentials, and reject absent, malformed, expired or revoked sessions.
  Store salted password hashes and token hashes, never raw credentials.
- Persist an owner's intent. The owner can read/update it; the other account
  cannot read, update or enumerate it by changing a path/body identifier.
- Restart the API and PostgreSQL with the same disposable data; identities,
  sessions, intent, ownership and audit relationships survive.
- Reject malformed/oversized input and unexpected fields without a server crash,
  SQL injection, leaked database errors or persisted partial state.
- When PostgreSQL is unavailable, readiness fails and writes never report success.
  Restore availability without erasing state; a later valid write succeeds.
- Authentication and ownership events remain queryable. Responses, logs and
  retained artifacts contain neither passwords, session tokens nor credentials.

## Project graph and release records (HOST-216)

- Create and read a standard project's repository/configuration, typed services
  and deployment snapshot through owner-scoped HTTP. Verify persisted ownership
  and references with independent PostgreSQL queries.
- Concurrent identical requests with one idempotency key create one result.
  Reusing a key for a different payload fails explicitly. Concurrent distinct
  updates use version checks; stale updates cannot silently overwrite a winner.
- A draft, compatibility inspection, portfolio or external case study reserves
  no hosted slot. Record explicit transitions for first-deployment reservation,
  failure with retained data, rollback and confirmed removal. M2 adds actual
  entitlement/capacity admission and M3 adds execution/routing.
- Reject cross-owner service/deployment references, invalid transitions, missing
  parents, excess service types and secret values in release metadata.
- Restart the API after concurrent operations; verify stable IDs, row counts,
  configurations, release references and the absence of dropped updates.

## Durable jobs and scoped credentials (HOST-217)

- Enqueue an authorized operation with an idempotency key. Observe durable
  queued/running/succeeded/failed/canceled/retriable states and immutable attempts.
- A real worker claims a lease, then is killed. After lease expiry a replacement
  claims a higher fence. The stale worker cannot renew, fetch credentials or
  commit an outcome; duplicate completion cannot create another result.
- Concurrent workers cannot both own one current lease. Retries preserve the
  same durable intent and do not duplicate committed effects.
- Encrypt secret values at rest with authenticated context binding to account,
  project, service, operation and version. Metadata responses contain references
  only. Missing/wrong recovery keys fail closed without logging values.
- A build credential request is constrained by the selected commit's declared
  reference set and the live job lease. Reject undeclared references, another
  tenant/service/operation, production database credentials and management keys.
- M1 workers exercise platform-owned bookkeeping only. An unsupported build or
  runtime operation must fail closed; the real build/runtime substrate is M3.

## Additive upgrades, backup and recovery (HOST-218)

- Initial migration runs only against an explicitly selected empty disposable
  database. Readiness refuses missing/pending/changed migration state.
- Populate accounts, projects, services, releases, jobs, encrypted secrets,
  portfolio draft revisions and audit relationships through the running system.
- Create and verify a pre-upgrade backup. Record database identity, schema
  version, source revision, timestamp, digest and required key version separately
  from the encryption key. A missing/stale/wrong-target backup blocks upgrade.
- Run the actual additive upgrade command. Concurrent migration attempts serialize;
  missing/out-of-order/changed migrations fail. Never reset or recreate data.
- Both the retained pre-upgrade binary and the new binary can read populated
  records after upgrade. New optional fields cannot invalidate old readers.
  Binary rollback never rewinds the database or discards later writes.
- Restore the verified backup into a separate, explicitly selected disposable
  recovery database. Refuse an occupied target or mismatched/corrupt backup.
  Verify ownership, relationships, counts and application reads after recovery.
- Exercise the hourly backup scheduler and 48-hour plus seven-daily retention
  policy using an explicit clock for scheduling. Perform real dump/restore work;
  label accelerated time honestly. No automatic replacement of a live database.
- Record observed data age and recovery time against the one-hour loss/four-hour
  recovery targets. These targets are not availability guarantees.

## Gate and evidence

Each run follows [TESTING.md](../TESTING.md). Gate completion requires passing
scenarios, retained failed-run evidence, a clean repeat, verified checksums,
source commit, exact rerun command, explicit limitations and cleanup receipts.
Future milestone cards remain unclaimed. At HOST-242, publish the handoff and stop.
