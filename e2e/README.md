# Hostlet E2E runner

`make e2e` runs the API/web shell scenarios and the M1 foundation module. The
shell scenarios start real Rust and Vite processes on run-owned loopback ports,
call HTTP endpoints, load Chromium, then stop the API to prove the offline UI.
The foundation module adds real disposable PostgreSQL and authenticated HTTP
scenarios. It does not mock Hostlet code or replace durable storage with memory.
The acceptance inventory is [M1-SCENARIOS.md](../docs/M1-SCENARIOS.md).

Every invocation creates `artifacts/e2e/M1/<run-id>/` before prerequisite checks
or builds. The directory is private and ignored by Git. A handled pass, failure,
timeout, signal, or missing prerequisite contains `REPORT.md`, `manifest.json`,
`assertions.json`, retained sanitized logs and browser evidence, and an external
`SHA256SUMS` receipt that excludes itself. Hard kills may leave an incomplete
record; the next run marks any such prior record abandoned before starting.

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

Install the pinned Rust and Node toolchains, locked web dependencies, Make,
Chromium (default `/snap/bin/chromium`), and a reachable Docker daemon. The
foundation uses the exact PostgreSQL 18 image digest in `postgres-image.txt`.
Each run creates a uniquely labeled container and named volume and removes only
those resources. Database passwords, session tokens, and separate secret/recovery
keys are generated in memory and never retained. A Docker named volume makes
the PostgreSQL restart check preserve actual data; it is not a reset.

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
a harness-tree digest, so a local development run is reproducible from the
recorded tree even before integration creates a commit.

## M1 scaffold scenarios (written before runner implementation)

| ID | Boundary and setup | Observable assertions | Cleanup |
| --- | --- | --- | --- |
| `api-liveness` | Start the compiled `hostlet-control` process with a dynamic loopback bind. | `GET /healthz` is HTTP 200 JSON with `status=ok`. | Gracefully terminate the owned API process group. |
| `api-version` | Use the same live process and the checked-in version fixture. | `GET /v1/version` is HTTP 200 JSON; service, semantic version, and protocol match the fixture exactly. | Same owned process cleanup. |
| `api-not-ready` | Call the real readiness route before product dependencies exist. | `GET /readyz` is HTTP 503 JSON with `status=not_ready` and the honest scaffold reason. | Same owned process cleanup. |
| `browser-connected` | Start Vite on another dynamic loopback port with its proxy targeting the run API; load it in installed Chromium. | Rendered DOM reports Online, Healthy, Not ready, the API version, protocol, and readiness reason; a screenshot and DOM are retained. | Browser is one-shot; terminate the owned Vite process group. |
| `browser-offline` | Stop and reap the API while leaving Vite running, then load a fresh Chromium page. | Rendered DOM reports three Offline states and the three endpoint-specific unreachable messages. | Terminate Vite and delete browser profiles; retain only sanitized evidence. |

Foundation cards extend `foundation.mjs` and add real disposable
PostgreSQL/worker fixtures. They must retain public-boundary assertions,
run-owned resource cleanup, durable-data checks, and the same artifact contract;
they do not create a parallel unit-test suite.

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
| SIGINT/SIGTERM | Mark the run interrupted, clean owned groups, finalize handled evidence, and return nonzero. | Signal handler. |
| Artifact write/hash/finalization failure | Return nonzero; never report a passing gate. Partial evidence remains for the next run to mark abandoned. | Artifact phase. |
| Deliberately corrupted oracle | `--inject-failure` makes a real expected value wrong, producing a named failed assertion and nonzero exit while retaining evidence. | Integrity self-check. |
| Sensitive environment values in evidence | Environment variables and process environments are never dumped; logs are scrubbed for common credential/token/authorization forms and local absolute paths. | Artifact writer. |
| Concurrent runners | Unique run IDs and dynamic ports isolate files/processes; each runner only signals PIDs/process groups it started. | Ownership model. |
| PostgreSQL unavailable, transaction/migration failure, duplicate/concurrent delivery, restart recovery, worker lease expiry, backpressure, secret ownership | Not part of the scaffold promise. Each is a required future real-boundary scenario when its product behavior lands; none may be marked passed by this harness today. | Explicit extension boundary. |

The runner itself is infrastructure, so the failure inventory also covers
timeouts, cancellation, partial failure, resource leaks, recovery of incomplete
records, and concurrency. Authentication and durable persistence are verified
by the foundation module; the smaller scaffold-only command cannot prove them.
