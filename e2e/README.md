# Hostlet E2E runner

## Current M3 journey

`make e2e` runs the current M3 journey through `make e2e-m3`.
`make e2e-gate` aliases `make e2e-m3-gate` and requires a clean source tree.
These use real disposable build VMs, isolated runtimes, tenant PostgreSQL,
coordinated releases, owner approval, and independent static publishing.
Follow [M3-E2E.md](../docs/M3-E2E.md) for the required owned assets and host
prerequisites and [M3-SCENARIOS.md](../docs/M3-SCENARIOS.md) for acceptance.
A dirty run is diagnostic evidence. M3 local acceptance passed two clean full
runs on one implementation commit, including a forced retained M2 rebuild.
[The M3 handoff](../docs/M3-HANDOFF.md) records the run IDs, receipt hashes,
browser evidence, exact `umask 0022` repeat commands and limits. Repeating the
accepted implementation after later documentation commits requires an isolated
full-history checkout of its tested commit.

`make e2e-scaffold` is the smaller API/web shell check. `make e2e-failure`
intentionally corrupts a shell oracle to verify failure evidence. Neither
command completes a product milestone.

## Historical M2 runner

The M2-specific commands and modules below apply only in a full-history isolated
checkout of its tested implementation, `82ecd6d473335d563325989a7ecfaf040a7e8b4e`.
The current schema-6 binary cannot satisfy the historical schema-4-to-5 upgrade
oracle. Do not point that suite at the current binary or weaken its schema checks.

In that M2 checkout, `make e2e` runs the API/web shell scenarios and the
M2 onboarding module. The
shell scenarios start real Rust and Vite processes on run-owned loopback ports,
call HTTP endpoints, load Chromium, then stop the API to prove the offline UI.
The onboarding module uses disposable PostgreSQL 18, authenticated HTTP, an
owned synthetic GitHub HTTP provider and actual dump/restore commands. It does
not replace Hostlet internals with mocks or execute repository/customer code.
The M2 acceptance inventory is
[M2-SCENARIOS.md](../docs/M2-SCENARIOS.md). The [M2 handoff](../docs/M2-HANDOFF.md)
records two clean acceptance runs with 48 assertions each, verified receipts,
exact tested source and limits. A local dirty run is diagnostic evidence only.

[The M1 handoff](../docs/M1-HANDOFF.md) is the historical acceptance record. Its
clean runs tested exactly
`5d72bd0b5af60576d6e4bd71d932847cfe1976eb`. The current schema-6 HEAD cannot run the
old `foundation.mjs` relationship as though its current binary were schema 4;
rerun M1 only from a full-history isolated checkout of that tested commit.

Every invocation creates `artifacts/e2e/<milestone>/<run-id>/` before
prerequisite checks or builds. The directory is private and ignored by Git. A handled pass, failure,
timeout, signal, or missing prerequisite contains `REPORT.md`, `manifest.json`,
`assertions.json`, retained sanitized logs and browser evidence, and an external
`SHA256SUMS` receipt that excludes itself. Hard kills may leave an incomplete
record. Before starting, the next same-host run marks a dead runner's record
abandoned when it is still running or when its terminal-looking manifest lacks
a nonempty, complete, path-safe receipt whose recorded file hashes verify. A
completed run with a valid receipt is left unchanged, and recovery preserves
the pre-recovery manifest and any provisional receipt for audit.

## Historical M2 commands

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
`make e2e-scaffold` is the smaller API/web check; it completes neither M1 nor M2.

To prove an omitted required assertion also fails, run

```sh
node e2e/run.mjs --milestone M2 --task HOST-243 \
  --scenario-module e2e/scenarios/onboarding.mjs \
  --scenario-module e2e/faults/missing-required.mjs --run-timeout 900000
```

This deliberate fault must exit nonzero and must never be included in an
acceptance run. `make e2e` and `make e2e-gate` label current bundles as
M2/HOST-243.
Pass `--rebuild-retained` to force the retained schema-4 M1 control binary to be
built from its recorded detached source worktree even when its private cache is
valid. The manifest records whether this option was enabled.

To prove the terminal-manifest crash window and its recovery with a real hard
kill, run this diagnostic command from the repository root:

```sh
node --require ./e2e/faults/crash-before-receipt.cjs e2e/run.mjs \
  --milestone M2 --task HOST-243 \
  --scenario-module e2e/scenarios/onboarding.mjs --run-timeout 900000
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
and checks out the schema-4 commit named in `retained-m1.json`. A cached
binary is accepted only from its manifest-defined private path with the pinned
SHA-256 digest. The current retained source is
`b17a48dc0dceac426b96d92824e16e8462752848`; its private cache pin is
`a544f8b3e24e9375f4be7b04a4711329ae9cfce1a4d70eba9bdfdc472c7306a1`.
If that cache is absent or invalid, or `--rebuild-retained` is set, the runner
creates a clean detached worktree at the pinned commit and uses locked
dependencies to build a run-local binary. The evidence records the source
identity, acquisition path, actual rebuilt SHA-256 and expected cached SHA-256.
Rust debug binaries can embed build paths, so a detached fallback is verified by
its exact source commit, clean worktree and locked dependencies; it is not
required to have the cache binary's bytes.

The onboarding harness uses the exact PostgreSQL 18 image digest in
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
a valid checksum proves file integrity, not that a failed scenario passed or
that an in-progress milestone was accepted.

Run `node e2e/run.mjs --help` for optional paths, timeouts, milestone flags, and
the repeatable `--scenario-module` extension hook. A module exports
`scenario = { id, requiredAssertions, run(context) }`; its assertions join the
same fail-closed completeness check and its fixtures use `context.registerFixture`.
The exact effective invocation and a portable rerun command are copied into each
artifact. The source identity includes HEAD, dirty state, a Git diff digest, and
a harness-tree digest. Dirty runs are diagnostic evidence; their hashes identify
changes but do not preserve those changes. Reproducible gate evidence comes from
a clean committed tree and an unchanged source check at the end of the run.

## Historical M2 onboarding modules

`onboarding.mjs` composes all M2 modules into one persistence history.
Together with the scaffold and runner-integrity checks, the runner now requires
47 baseline assertions, including the four private-preview assertions. A clean
gate adds the unchanged-source assertion for 48 total. Both clean M2 repeats
passed; their receipts are in [the handoff](../docs/M2-HANDOFF.md).

| Area | Running boundary and intended evidence |
| --- | --- |
| Populated upgrade and recovery | A retained schema-4 M1 binary creates meaningful account, project, configuration, service, portfolio draft, secret and completed bookkeeping-job data through HTTP. The current binary must refuse a populated 4-to-5 migration without a fresh verified encrypted backup, preserve rows, IDs and relationships during the additive migration, and restore a fully populated schema-5 backup into a distinct run-owned empty database. Current and retained M1 binaries then exercise compatible reads, writes and restarts without rewinding the database. |
| GitHub connection and immutable source | `m2-github.mjs` crosses real loopback HTTP to an owned synthetic provider fixture for OAuth, installation tokens, repository/ref/content reads and signed webhooks. The fixture owns only the external GitHub boundary, records sanitized observations and rejects wrong credentials, scope, installation, repository and endpoint use. No real GitHub account, App, private repository or credential is used. |
| Real-browser onboarding | `m2-browser.mjs` drives installed Chromium through the Vite UI and real loopback OAuth redirects. A new user signs up, signs back in, selects an authorized repository and branch, and saves one exact immutable source. Independent PostgreSQL reads prove persistence while job, deployment and hosted-slot counts prove that onboarding does not execute or host customer code. |
| Admission and accounting | `m2-admission.mjs` uses the authenticated public API plus an explicit synthetic internal entitlement/capacity/resource-observation boundary. It checks durable slot and rollout-hold accounting, observation generations and reservation epochs, build-meter debit and verified platform-fault credit, contention, restart convergence and reconciliation intent. Admission records work for later execution; it does not launch a build, provision a runtime, run repository commands, contact a payment provider or claim a settled charge/refund. |
| Bounded compatibility | `m2-compatibility.mjs` reads one authorized immutable commit through the synthetic provider and performs conservative, bounded static inspection. It checks exact source/configuration binding, safe owner-private facts, stable `candidate`, `configuration_needed`, `database_needed`, `secrets_needed` and `showcase_only` results, and bounded malformed/unavailable inputs. The analyzer never runs repository commands, package managers, builds, migrations or application code, and `candidate` does not verify a deployment. |
| Private editable preview | `m2-preview.mjs` is composed with four required assertions for authenticated browser authoring, immutable revision and concurrency behavior, privacy, owner isolation, safe placeholders, inherited M1 drafts, and no execution or publication effects. It also verifies fresh revision-zero saves, actual keyset pagination, preservation of unsaved edits during source binding, and configuration/source/report reruns through the real UI. |

The 47-assertion dirty diagnostic run
`2026-09-22T020704-126Z-2950768-9ccbb6` passed the scaffold, populated
upgrade, GitHub, real-browser, admission, compatibility and all four private
preview assertions. Its external `SHA256SUMS` receipt is
`690bed5bc45c2cd69ea69ac12f0d58d6e7add1cdff461d936c07b6dd2c76211f`.
This is implementation diagnostic evidence, not an M2 gate or handoff.

## Historical M1 evidence

M1 foundation coverage remains documented in
[M1-HANDOFF.md](../docs/M1-HANDOFF.md), including authentication, project and
portfolio persistence, jobs and scoped secrets, schema 3-to-4 recovery, and
scheduled backup retention. Those are accepted results for the exact tested M1
commit, not fresh evidence for schema-5 HEAD. Use the commands recorded in that
handoff only after checking out its pinned implementation commit in an isolated
full-history worktree.

## Scaffold scenarios

| ID | Boundary and setup | Observable assertions | Cleanup |
| --- | --- | --- | --- |
| `api-liveness` | Start the compiled `hostlet-control` process with a dynamic loopback bind. | `GET /healthz` is HTTP 200 JSON with `status=ok`. | Gracefully terminate the owned API process group. |
| `api-version` | Use the same live process and the checked-in version fixture. | `GET /v1/version` is HTTP 200 JSON; service, semantic version, and protocol match the fixture exactly. | Same owned process cleanup. |
| `api-not-ready` | Call the real readiness route before product dependencies exist. | `GET /readyz` is HTTP 503 JSON with `status=not_ready` and the honest scaffold reason. | Same owned process cleanup. |
| `browser-connected` | Start Vite on another dynamic loopback port with its proxy targeting the run API; load it in installed Chromium. | Rendered DOM reports Online, Healthy, Not ready, the API version, protocol, and readiness reason; a screenshot and DOM are retained. | Browser is one-shot; terminate the owned Vite process group. |
| `browser-offline` | Stop and reap the API while leaving Vite running, then load a fresh Chromium page. | Rendered DOM reports three Offline states and the three endpoint-specific unreachable messages. | Terminate Vite and delete browser profiles; retain only sanitized evidence. |

`make e2e-scaffold` runs only this smaller API/web shell surface. The M1
historical runner and M2 onboarding runner add their own PostgreSQL and
external-boundary fixtures while retaining the same run-owned cleanup,
durable-data checks and artifact contract. The scaffold alone proves neither
milestone and does not create a parallel unit-test suite.

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
| PostgreSQL or provider unavailable, transaction/migration failure, invalid or duplicate webhook delivery, browser onboarding failure, admission contention, stale observation generation, meter exhaustion, bounded compatibility rejection, preview validation or revision conflict, restart recovery, backup verification or restore failure, or retained-binary incompatibility | The relevant named onboarding assertion fails, no forbidden execution is reported, run-owned resources are cleaned, and the failed evidence bundle is retained. These checks are outside the smaller scaffold-only promise. | M2 upgrade, GitHub, browser, admission, compatibility and preview scenarios. |

The runner itself is infrastructure, so the failure inventory also covers
timeouts, cancellation, partial failure, resource leaks, recovery of incomplete
records, and concurrency. The smaller scaffold-only command cannot prove
authentication, provider behavior, admission accounting or durable persistence.
