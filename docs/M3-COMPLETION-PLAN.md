# M3 completion plan for GPT-6 Sol agents

Completed 2026-09-24: two audited clean full gates at `0649f74` each passed
55/55 assertions and all 11 phases. The [M3 handoff](M3-HANDOFF.md) records the
verified receipts, exact repeat commands, cleanup and retained compatibility
limits. Stop before M4. The baseline and checkpoints below preserve the plan as
written before these runs.

Prepared 2026-09-24. This was the remaining execution plan through HOST-233,
superseding the earlier final-fix attempt plans. It does not change the product
scope in [PLAN.md](../PLAN.md), the [scenario inventory](M3-SCENARIOS.md), or
[TESTING.md](../TESTING.md). Planning does not restart implementation or tests.

## Outcome and current evidence

M3 is done when two clean runs prove the complete owned-fixture journey:
authorized source -> disposable VM build -> isolated running application and
database -> coordinated release and rollback -> owner approval -> independently
served portfolio. Backups, export, restore, storage enforcement, retained-binary
compatibility, failure behavior and cleanup must pass in that same journey.

Baseline at planning start: clean `a80433b07fea601cc5a24a271e1b2bec09000b20`.
There are **0/2 accepted full gates**. The Host-header correction is committed;
its real publisher diagnostic and `make check` passed. Preserve that fix.

Two remaining problems have evidence:

1. The latest native baseline exited with `MODULE_NOT_FOUND` for
   `/app/dist/server.mjs`. The parent launched the run under `umask 077`.
   Artifact preparation requests directory mode 0755 without restoring it after
   umask masking; the native helper drops to UID/GID 65532. This is a strong
   explanation, but actual directory modes were lost during cleanup. Confirm
   them before treating permissions as the proven cause.
2. Native readiness continued polling after its helper exited. It inherited the
   generic one-hour operation timeout. This delayed failure reporting and must
   be corrected independently of the permissions issue.

Prior focused checks passed data recovery, storage freeze and retained-M2
restore. They cannot substitute for either full gate. In particular, the full
combination of large export, live-runtime storage enforcement, stopped-target
rollback rejection and final restore remains unverified.

## Agents, ownership and dependencies

Use `agent_type="worker"`, `model="gpt-6-sol"`,
`reasoning_effort="medium"`, `fork_turns="none"` for every worker. Give each
worker this plan, its files and acceptance criteria. Workers must not spawn
agents, revert concurrent edits, run shared builds/tests, or claim future cards.
The primary owns interfaces, integration, all serialized verification and final
acceptance. Worker self-checks are supporting evidence.

| Worker | Exclusive file ownership | Deliverable and dependency |
| --- | --- | --- |
| A — runtime permissions and preflight | `scripts/runtime/prepare-artifact.py`; one narrow `e2e/scenarios/m3-runtime-native-baseline-development.mjs` | First write the real-process diagnostic and capture the permission evidence. Apply the smallest justified directory fix after diagnosis. Reuse existing build/context/runtime helpers rather than clone the full suite. Coordinate the native diagnostic interface with B before editing. |
| B — bounded native readiness | `e2e/support/m3-runtime.mjs`; `e2e/run.mjs` only for recording execution configuration or a genuinely necessary small shared API | Observe exact helper exit during readiness, impose a native-only deadline, retain abort/error/cleanup evidence, expose the minimum existing native-baseline path needed by A, and record the runner's actual umask. Can work alongside A's diagnostic preparation. |
| C — acceptance evidence and handoff | Private evidence checklist/draft initially; after both gates, `docs/M3-HANDOFF.md`, `README.md`, `docs/M3-E2E.md`, `e2e/README.md` | Review coverage and receipts, retain observed compatibility limits, prepare the final handoff. Do not edit acceptance oracles or mark completion. Final documentation depends on two audited passing gates. |

The primary owns `PLAN.md`, `ROADMAP.md`, `roadmap.json`, Git publication and
Helm transitions. No migrations, locks, dependencies, runtime budgets, provider
resources or customer data changes belong to this fix. Additional changes need
specific evidence; they are not an invitation to broaden the implementation.

## Checkpoint 1 — specify and diagnose before the permission fix

Before code changes, link the failure inventory to the existing M3 workstream:

| Failure or boundary | Required observable outcome |
| --- | --- |
| Normal 0022 versus restrictive 0077 umask | Record actual modes and ownership of `/app`, nested parents and the entrypoint; demonstrate access as the real runtime UID. Use a fresh owned assembly destination per umask, so a cached artifact cannot conceal the difference. |
| Private host state versus guest application files | Host artifacts/state/logs remain private; only intended guest application directories become traversable. Preserve canonical archive file modes and secret boundaries. |
| Reassembly, collision, malformed archive and unsafe paths | Preserve existing rejection rules and immutable identity checks; identical valid inputs have the same canonical modes/tree digest under either umask. Never silently repair an existing immutable artifact in place. |
| Native helper exits before or during readiness | Fail promptly with its exact exit status, last health observation and log reference; no wait for the generic one-hour deadline. |
| Helper lives but health never succeeds | Fail at the explicit native deadline, retain the last observation, and clean up the exact owned resources. |
| Abort or late HTTP response | Cancellation cannot become a later successful readiness result; pending work/listeners are cleaned up. |
| Successful startup and teardown | Actual Node process serves the expected application response; exact process, relay, cgroup and metadata cleanup is verified. |

A and B agree on a small diagnostic interface first. A prepares the diagnostic
while B fixes the already-confirmed readiness defect. The primary then runs one
bounded diagnosis through the real Node 22 disposable-VM build, canonical HCA,
artifact preparer and native helper. Capture permission evidence **before**
cleanup under both umasks. Existing bootstrap checks only exercise gVisor and
are insufficient on their own.

The known defect may be a predeclared expected negative observation in this
non-gating diagnosis; it must not be reported as a working runtime. If the
observations do not support the permissions explanation, stop and report the
discrepancy before applying the guessed fix. No unbounded investigation loop.

## Checkpoint 2 — finish the fixes and prove the exact startup path

After the diagnosis supports it, A explicitly sets modes on newly created,
owned guest app directories and their extracted parents. Do not use a broad
recursive chmod on the copied base, host state or existing immutable objects.
An invalid cached object must fail closed rather than be accepted or rewritten.
Keep tree-digest validation and atomic installation intact.

B's native readiness ceiling starts at **10 seconds**, matching the existing
native metadata/discovery budgets. Observe helper exit immediately, with a
short abortable HTTP request and correct cleanup of the losing wait. The E2E
must observe an exited helper failing within two seconds of the recorded exit,
and a live-but-unhealthy helper failing within the native deadline plus one
request interval. Cleanup has its existing separate TERM/KILL bounds.
Keep the sandbox's five-second startup policy separate. Do not reduce global
timeouts: the deliberate ten-minute build case and large backup operations
still require their existing allowances. Do not extend a deadline after a
failed run just to obtain a pass.

The primary reviews both diffs and runs the completed narrow regression once.
It must prove healthy native startup and the actual gVisor Node 22 bootstrap
under **both 0022 and 0077**, stable canonical assembly identity, and private
artifact modes. Use declared owned fixtures for early exit and unhealthy HTTP;
assert their expected errors, bounds and cleanup through the same readiness
path used by the full suite. Include abort handling. Do not mock HTTP success
or fabricate a rootfs or worker receipt.

Produce the standard repeatable E2E bundle with source/diff identity, selected
umasks, actual modes/UID observations, deadlines, elapsed times, responses,
exit status, logs, cleanup and external checksum receipt. A screenshot or a
directory listing alone is insufficient. No unit tests are added.

## Checkpoint 3 — freeze a reproducible execution environment

Only after the focused regression and its artifact audit pass:

1. Run `make check`, inspect the complete diff, and commit the implementation.
2. Confirm pinned assets, retained M2 source/cache, tool versions, available
   owned resources and a clean source tree. Reuse verified assets; do not
   rebuild them without a relevant change.
3. Use explicit **umask 0022 for both full gates** and record the observed value
   in each manifest/rerun context. Create redirected logs separately as mode
   0600 inside a private directory; never set the entire run to 0077 merely to
   protect a log. Retain the runner's explicit private artifact modes.
4. Freeze source, configuration and fixture identities across both gates.
   No edits, builds, migrations or another E2E run may run concurrently.

Do not repeat the already-passing publisher or storage diagnostics unless the
new changes or a specific finding affect them. Do not add a broad third
integration run before the two required gates.

## Checkpoint 4 — two complete acceptance runs

Run Gate A with the declared environment:

```sh
umask 0022
make e2e-m3-gate
```

The primary audits Gate A before starting Gate B. All required assertions must
be present and passed, including full outage publication, daily backup/retention,
portable recovery, live-runtime read/write behavior after storage freeze,
large export, stopped-target rollback rejection and final retained-M2 restore.

Only after that audit passes, run Gate B at the **same clean implementation
commit**, with the same declared environment:

```sh
umask 0022
make e2e-m3-gate E2E_ARGS='--rebuild-retained'
```

Both runs need complete phases and assertions, exact source/harness/tool/fixture
identities, explicit configuration, real browser evidence, populated-data
backup/migration/restore receipts, retained-binary compatibility, private
redacted outputs, exact owned cleanup and verified external `SHA256SUMS`.
Record each receipt's own SHA-256. Check artifact content as well as exit codes.
The rebuild must come from pinned clean retained M2 source with locked
dependencies. Any subsequent implementation change requires a new pair.

**Stop rule (clarified on September 24):** a failed full acceptance gate ends
the attempt after owned cleanup and a complete report. Do not automatically
repair or retry that gate, start Gate B after Gate A fails, or publish. Resolve
routine tooling problems before the gates using task-owned paths; a Python
bytecode-cache write error is not a failed product assertion. Focused checks
must establish the changed behavior before freezing the implementation. Keep
any failed evidence and fix only the demonstrated cause. An intentional
negative case passes only when its predeclared rejection and state invariants
are actually asserted; it never excuses a failed top-level gate.

## Checkpoint 5 — finish the milestone and hand off working evidence

After two audited full passes, C writes `docs/M3-HANDOFF.md` with both run IDs,
receipt hashes, exact repeat commands, the tested implementation commit,
workspace checks, browser results, data-preservation evidence and known limits.
The primary verifies C's result, records completion on existing Helm cards in
dependency order, and synchronizes the committed roadmap snapshots:

```text
HOST-243 -> HOST-222, HOST-223, HOST-225, HOST-227
HOST-222 + HOST-223 + HOST-225 -> HOST-226
HOST-227 -> HOST-229
HOST-226 + HOST-229 -> HOST-233
```

At planning time the first four M3 cards are already owned; HOST-226, HOST-229
and HOST-233 are dependency-blocked. Re-read live prerequisites before each
claim/closure. Do not create duplicate cards, use old-repository evidence or
claim M4. Keep the product release planned; milestone acceptance is not launch.

Commit the final documentation separately from the tested implementation and
state which commit the gates verified. Before repository publication, inspect
the complete unpublished change set for public suitability and run required
checks. Publish through the authorized canonical Gitea repository and GitHub
mirror, verify matching intended heads and applicable CI, and report any
publication/CI blocker separately from the local acceptance result. Use the
Infisical helper and existing homelab runner policy; do not deploy.

The final handoff must let Shane inspect a working-demo/portfolio browser
artifact and reproduce the journey. It must also preserve
`owned_fixture_only`, `production_ready=false`, rejected unsupported patterns
and any missed throughput target from [the runtime decision](M3-RUNTIME-DECISION.md).
M3 completion does not claim general Next.js support or production readiness.
Stop at HOST-233. This plan reduces known failure risks; only the two complete
observed passes establish that M3 is done.
