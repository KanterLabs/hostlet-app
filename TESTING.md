# Hostlet testing and milestone policy

This policy applies to behavior added under the [PLAN.md](PLAN.md) and the
milestones described in [ROADMAP.md](ROADMAP.md). Helm owns live task,
dependency and claim state; `ROADMAP.md` and [roadmap.json](roadmap.json) are
committed snapshots of the intended ordering. This document defines the
evidence and stopping rules for each milestone.

## Acceptance default

Use end-to-end (E2E) tests as the sole behavioral acceptance mechanism for
complex features. Define the scenarios, boundary, setup, expected observable
outcomes and cleanup before implementation. Writing the E2E cases before
product code is optional; the scenario and oracle are not optional.

An E2E test crosses the real boundary that the feature promises: HTTP, a
browser, processes, PostgreSQL, worker/build boundaries and external services
as applicable. A managed external test mode or an explicit boundary fixture is
allowed when the mode and boundary are recorded and the promised outcome is
still observed. Mocking Hostlet internals and calling the result E2E is not
allowed. Do not replace a missing product oracle with a sleep, a setup-only
assertion or a hard-coded success.

Existing unit checks may remain and may run in the routine check, but they are
not proof that a complex feature is complete. Never write a unit test after the
production code for that behavior exists; if the code already exists, add or
repair the relevant E2E scenario instead.

## Narrow isolation exception

An isolated unit or component check is permitted only when a deterministic
property cannot be exercised meaningfully at an E2E boundary. Before writing
any implementation or isolated test code, commit or link a failure inventory
to the task. Include the applicable failure modes:

- boundary and malformed-input handling;
- authentication, authorization and ownership errors;
- retries, idempotency and duplicate delivery;
- concurrency, ordering and contention;
- timeouts, cancellation and backpressure;
- persistence, transaction and migration behavior;
- partial failure, cleanup and resource leaks; and
- recovery, restart and retained-state behavior.

For every listed failure, record the expected observable outcome and why an E2E
scenario cannot cover it. Then write executable failing cases from that
inventory before the production code. A test-first isolated check may remain
and run alongside E2E checks; it does not waive the E2E acceptance requirement.
If the inventory is missing, or the code already exists, use E2E rather than
adding a retroactive unit suite.

## E2E runner integrity

An E2E runner must assert product behavior at its declared boundary and fail
when that behavior is absent. Do not weaken an existing runner with fake
assertions, assertions that only inspect fixtures, or an assertion that can
never fail. Keep setup, seed data and test-mode switches explicit so that a
green run demonstrates the product path rather than a test harness shortcut.

The scaffold harness runs with `make e2e`; `make e2e-gate` requires a clean
source tree and `make e2e-failure` deliberately fails one assertion to verify
failed-run evidence. See [e2e/README.md](e2e/README.md) for prerequisites and
scenario coverage. Foundation scenarios extend this runner as their behavior
is implemented; a passing scaffold run alone does not complete M1.

## Run artifact contract

Every E2E run produces an artifact, including a failed, interrupted or
environment-blocked run, under:

```text
artifacts/e2e/<milestone>/<run-id>/
```

Create the run record before setup. Finalize it on handled exits; preserve
partial evidence after a hard interruption and mark an abandoned run incomplete
when next inspected. A missing or incomplete artifact can never pass a gate.

Each run contains a minimal readable `REPORT.md` and machine-readable
`manifest.json`. Record, at minimum:

- exact source commit and harness revision;
- toolchain versions, image digests and fixture digests;
- deterministic seed and non-secret configuration;
- prerequisites and their observed versions or health;
- the exact rerun command and all non-secret inputs;
- each machine-checkable assertion and its pass/fail result;
- redacted logs and browser traces or video only when they help diagnose a
  result;
- product outputs, durable-data assertions and relevant database checks;
- an external `SHA256SUMS` receipt listing SHA-256 checksums for `manifest.json`,
  `REPORT.md` and every retained payload; the receipt excludes itself and must
  not create a self-referential manifest hash; and
- cleanup actions and their result, including what was intentionally retained.

Use synthetic owned fixtures. Never place secrets, private repository contents,
customer data or unredacted credentials in an artifact. Artifacts are private
by default; a public artifact must be scrubbed to the same standard and contain
only releasable fixture data. Mark an inapplicable field `N/A` with its reason.

Repeatable means that the recorded commit, inputs, prerequisites and command
produce the same asserted outcomes and durable invariants on rerun. Timestamps,
generated identifiers and other documented nondeterministic values need not be
bit-identical. A trace without explicit assertions and results is not a passing
artifact.

A milestone gate requires a clean rerun from the recorded inputs, a verified
external `SHA256SUMS` receipt, and a linked handoff that records the receipt's
own SHA-256 hash. A failed run remains useful evidence and must be retained, but
it cannot satisfy the gate. This document and the planning files remain
documentation evidence only; actual runner artifacts establish observed results.

## Routine checks and milestone stops

`make check` remains the routine scaffold check for formatting, linting, builds
and legacy tests. It is not an E2E run and cannot by itself establish
complex-feature completion. Run it where the task requires it and report its
result separately from E2E evidence.

The roadmap's five milestones are stopping points for agents. The default
assignment is one milestone scope, with parallel work inside that milestone
only where the real dependency graph permits it. Do not claim the next
milestone merely because its prerequisites appear unblocked.

At a milestone gate, finish the assigned scope, run the required E2E scenarios,
retain the artifact and receipt privately, and hand off the commit, exact command,
artifact path, receipt hash, assertions, unresolved risks and cleanup result.
Stop there.
Continue only after a subsequent instruction or an explicit user override that
assigns a larger scope. Apply this contract to the roadmap's retained
`HOST-233` internal fixture gate and `HOST-239` paid-pilot readiness gate as
well as the other milestone gates.
