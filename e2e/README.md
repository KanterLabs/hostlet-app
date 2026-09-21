# Hostlet E2E runner

`make e2e` runs the API/web shell scenarios and the M1 foundation module. The
shell scenarios start real Rust and Vite processes on run-owned loopback ports,
call HTTP endpoints, load Chromium, then stop the API to prove the offline UI.
The foundation module uses disposable PostgreSQL 18, authenticated HTTP, real
bookkeeping worker processes, and actual dump/restore commands. It does not mock
Hostlet code, replace durable storage with memory, or execute customer workloads.
The acceptance inventory is [M1-SCENARIOS.md](../docs/M1-SCENARIOS.md). The
presence of these scenarios is not a final M1 acceptance claim; the milestone
still requires a verified clean gate run and handoff.

Every invocation creates `artifacts/e2e/M1/<run-id>/` before prerequisite checks
or builds. The directory is private and ignored by Git. A handled pass, failure,
timeout, signal, or missing prerequisite contains `REPORT.md`, `manifest.json`,
`assertions.json`, retained sanitized logs and browser evidence, and an external
`SHA256SUMS` receipt that excludes itself. Hard kills may leave an incomplete
record. Before starting, the next same-host run marks a dead runner's record
abandoned when it is still running or when its terminal-looking manifest lacks
a nonempty, complete, path-safe receipt whose recorded file hashes verify. A
completed run with a valid receipt is left unchanged, and recovery preserves
the pre-recovery manifest and any provisional receipt for audit.

## Commands

```sh
make e2e
make e2e-scaffold
make e2e-failure
make e2e-gate
```

`make e2e` permits a dirty source tree for local development and records that
fact. `make e2e-gate` adds `--require-clean` and fails before process setup when
tracked or untracked source changes exist. `make e2e-failure` uses
`--inject-failure`; that integrity self-check deliberately falsifies one browser
oracle, must return nonzero, and retains the full failed evidence bundle.
`make e2e-scaffold` is the smaller API/web check; it cannot complete M1.

To prove an omitted required assertion also fails, run
`node e2e/run.mjs --scenario-module e2e/faults/missing-required.mjs`.
This deliberate fault must exit nonzero and must never be included in an
acceptance run. Use `--task HOST-242` to label the final milestone gate bundle.
Pass `--rebuild-retained` to force the retained schema-3 control binary to be
built from its recorded detached source worktree even when its private cache is
valid. The manifest records whether this option was enabled.

To prove the terminal-manifest crash window and its recovery with a real hard
kill, run this diagnostic command from the repository root:

```sh
node --require ./e2e/faults/crash-before-receipt.cjs e2e/run.mjs \
  --scenario-module e2e/scenarios/foundation.mjs --run-timeout 900000 \
  --task HOST-242
```

The preload intercepts only the current runner's terminal `SHA256SUMS` write
and sends that process `SIGKILL` immediately before it. The command is expected
to exit 137 and leave the terminal-looking bundle without `SHA256SUMS`. Run the
next E2E command without `--require`; its startup recovery must mark the crashed
bundle abandoned, preserve the pre-recovery manifest, and commit an abandoned
receipt. The manifest records the preload path in the exact Node command and
its fixture hash under `harness.fixtures`. Acceptance and final gate commands
must never include this preload.

Install the pinned Rust and Node toolchains, locked web dependencies, Make,
Chromium (default `/snap/bin/chromium`), Git with full history, and a reachable
Docker daemon. Full history is required because the compatibility drill verifies
and checks out the schema-3 commit named in `retained-foundation.json`. A cached
binary is accepted only from its manifest-defined private path with the pinned
SHA-256 digest. If that cache is absent or invalid, or `--rebuild-retained` is
set, the runner creates a clean detached worktree at the pinned commit and uses
locked dependencies to build a run-local binary. The evidence records the source
identity, acquisition path, and binary digest.

The foundation uses the exact PostgreSQL 18 image digest in
`postgres-image.txt`. Each run creates a uniquely labeled container and named
volume and removes only those resources. Backup and restore invoke matching
PostgreSQL 18 tools through that explicitly named run-owned container; the runner
does not discover a shared container. Database passwords, session tokens, and
separate secret/recovery keys are generated in memory and never retained. A
Docker named volume makes the PostgreSQL restart check preserve actual data; it
is not a reset.

Verify a finished bundle from its own directory with `sha256sum --check
SHA256SUMS`, then compare `sha256sum SHA256SUMS` with the handoff receipt. Check
the manifest's status, assertions, source identity and cleanup results as well:
a valid checksum proves file integrity, not that a failed scenario passed.

Run `node e2e/run.mjs --help` for optional paths, timeouts, milestone flags, and
the repeatable `--scenario-module` extension hook. A module exports
`scenario = { id, requiredAssertions, run(context) }`; its assertions join the
same fail-closed completeness check and its fixtures use `context.registerFixture`.
The exact effective invocation and a portable rerun command are copied into each
artifact. The source identity includes HEAD, dirty state, a Git diff digest, and
a harness-tree digest. Dirty runs are diagnostic evidence; their hashes identify
changes but do not preserve those changes. Reproducible gate evidence comes from
a clean committed tree and an unchanged source check at the end of the run.

## Implemented M1 foundation coverage

The foundation module composes the scenario files under `e2e/scenarios/` into
one persistence history. Later checks therefore operate on accounts, projects,
secrets, and jobs created through the earlier public APIs.

| Area | Real boundary and evidence |
| --- | --- |
| Authentication and persistence | Account creation, opaque sessions, owner isolation, profile concurrency and replay, audit records, PostgreSQL restart durability, dependency loss, schema drift, and credential-free artifacts are checked through HTTP plus independent SQL. |
| Project graph and portfolio | Standard project contracts, immutable configuration revisions, stable services, deployment/lifecycle intents, release references, and private portfolio drafts are persisted with owner-scoped reads and concurrency checks. Explicit trusted SQL observations model reserved and retained-resource states because M1 has no capacity provider or customer deployment execution. |
| Jobs and scoped secrets | Secret versions are encrypted at rest and references are constrained by account, project, service, operation, and credential kind. Real bookkeeping workers exercise authenticated claim, credential resolution, renew, completion, cancellation, retry, lease expiry, competing workers, fencing, process kill/replacement, and restart durability without running repository code or a customer command. |
| Upgrade and recovery | A populated schema-3 database is backed up with a real PostgreSQL 18 dump, encrypted and verified, upgraded additively to schema 4, read and written by both the current and retained schema-3 binaries, and restored into a distinct empty recovery database. Missing, stale, wrong-key, wrong-target, corrupt, occupied-target, and unsafe-path cases fail closed. |
| Scheduling and objectives | The scheduler creates real encrypted dumps, deduplicates a UTC hour, retains all 49 hourly boundary points in the inclusive current-to-48-hours window, and retains the latest point from each of the seven completed UTC calendar dates strictly before the date containing that cutoff. Manual backups remain outside scheduled pruning. The run records observed snapshot age and restore duration against the one-hour RPO and four-hour RTO targets; accelerated scheduling and a passing observation are not production availability guarantees. |

## Scaffold scenarios

| ID | Boundary and setup | Observable assertions | Cleanup |
| --- | --- | --- | --- |
| `api-liveness` | Start the compiled `hostlet-control` process with a dynamic loopback bind. | `GET /healthz` is HTTP 200 JSON with `status=ok`. | Gracefully terminate the owned API process group. |
| `api-version` | Use the same live process and the checked-in version fixture. | `GET /v1/version` is HTTP 200 JSON; service, semantic version, and protocol match the fixture exactly. | Same owned process cleanup. |
| `api-not-ready` | Call the real readiness route before product dependencies exist. | `GET /readyz` is HTTP 503 JSON with `status=not_ready` and the honest scaffold reason. | Same owned process cleanup. |
| `browser-connected` | Start Vite on another dynamic loopback port with its proxy targeting the run API; load it in installed Chromium. | Rendered DOM reports Online, Healthy, Not ready, the API version, protocol, and readiness reason; a screenshot and DOM are retained. | Browser is one-shot; terminate the owned Vite process group. |
| `browser-offline` | Stop and reap the API while leaving Vite running, then load a fresh Chromium page. | Rendered DOM reports three Offline states and the three endpoint-specific unreachable messages. | Terminate Vite and delete browser profiles; retain only sanitized evidence. |

`make e2e-scaffold` runs only this smaller compatibility surface. The M1
foundation coverage above adds PostgreSQL and worker fixtures while retaining
the same public-boundary assertions, run-owned cleanup, durable-data checks, and
artifact contract. It does not create a parallel unit-test suite.

## Failure inventory

This inventory is the runner oracle and cleanup design. No isolated tests are
introduced; each applicable failure is exercised or enforced at the process,
HTTP, browser, or artifact boundary.

| Failure mode | Required outcome | Coverage |
| --- | --- | --- |
| Missing Node, npm, Cargo, Rust, Chromium, Git, or checksum tool | Create/finalize a failed artifact and exit nonzero before starting product processes. No required assertion is marked skipped. | Prerequisite phase. |
| Invalid CLI input or dirty `--require-clean` source | Finalize failed evidence and exit nonzero. | Argument/source phase. |
| Build failure or missing compiled API | Record sanitized build output, fail, and clean any owned processes. | Setup phase. |
| Dynamic port contention or bind/start failure | Bounded readiness polling times out, records the failed process/log, exits nonzero, and cleans owned process groups only. | Setup phase. |
| Malformed/non-JSON response, wrong status, field, version, protocol, or readiness reason | The named machine assertion fails; the overall run is failed. | HTTP scenarios. |
| Browser launch/crash, proxy failure, stale loading UI, wrong UI text, or missing screenshot/DOM | The named browser assertion or required-evidence assertion fails; the overall run is failed. | Browser scenarios. |
| API fails to stop, remains reachable, or offline UI does not converge | Record cleanup/offline failure, terminate owned group, and fail. | Offline scenario and cleanup. |
| Any required scenario omitted or assertion not executed | Finalization synthesizes a failed `required-assertions-complete` assertion and returns nonzero. | Finalization. |
| Per-operation or whole-run timeout | Abort the operation, kill only run-owned process groups, finalize failed evidence, and return nonzero. | All phases. |
| SIGINT/SIGTERM observed by the JavaScript handler before the receipt commits | Mark the run interrupted, clean owned groups, finalize handled evidence, and return nonzero. Commands return only after the synchronous receipt commit; a signal observed after that commit preserves the finalized result. The runner makes no claim about OS signal delivery time while JavaScript is blocked. | Signal handler and artifact commit boundary. |
| Artifact write/hash/finalization failure | Return nonzero; never report a passing gate. Partial evidence remains for the next run to mark abandoned. | Artifact phase. |
| Deliberately corrupted oracle | `--inject-failure` makes a real expected value wrong, producing a named failed assertion and nonzero exit while retaining evidence. | Integrity self-check. |
| Sensitive environment values in evidence | Environment variables and process environments are never dumped; logs are scrubbed for common credential/token/authorization forms and local absolute paths. | Artifact writer. |
| Concurrent runners | Unique run IDs and dynamic ports isolate files/processes; each runner only signals PIDs/process groups it started. | Ownership model. |
| PostgreSQL unavailable, transaction/migration failure, duplicate or concurrent delivery, restart recovery, worker lease expiry, fencing, cancellation, scoped-secret denial, backup corruption, occupied restore target, or retained-binary incompatibility | The relevant named foundation assertion fails, no forbidden effect is reported, run-owned resources are cleaned, and the failed evidence bundle is retained. These checks are outside the smaller scaffold-only promise. | Foundation authentication, graph, jobs/secrets, and recovery scenarios. |

The runner itself is infrastructure, so the failure inventory also covers
timeouts, cancellation, partial failure, resource leaks, recovery of incomplete
records, and concurrency. Authentication and durable persistence are verified
by the foundation module; the smaller scaffold-only command cannot prove them.
