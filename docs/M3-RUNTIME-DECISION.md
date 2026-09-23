# M3 owned-fixture runtime decision

Decision recorded on 2026-09-23 before changing the evaluation contract.

The measured gVisor runtime does not meet the provisional throughput target.
The comparable 1,000-request Node 22 experiment in private run
`2026-09-23T022430-301Z-237590-03b957` measured 1,553.05 native requests/second
and 412.86 sandbox requests/second (26.58%). Both used the same 0.25 CPU,
512 MiB, no-swap and 128-PID budget and the same relay implementation.
Sandbox request p95 was 1.18 ms versus 0.69 ms native. The sandbox consumed
649,688 CPU microseconds versus 163,790 native. This result is evidence of
overhead, not a passed 50% throughput target or a production capacity result.
The run subsequently failed a resource probe; it is not acceptance evidence.

M3 authorizes owned local fixtures and evaluation, not customer admission.
PLAN.md makes resource numbers benchmark targets pending a launch decision.
Preserve the 50% target and its measured result, and separate it from permission
to continue the local integration experiment. Every accepted evaluation must
explicitly state `owned_fixture_only` and `production_ready: false`, even when
the throughput target is met. Control must independently recompute whether the
target was met from positive finite measurements. A target miss is recorded as
a deferred production-performance decision, never rewritten as a target pass.

All existing isolation, network, resource, restart, startup, request-latency,
artifact identity, freshness and per-pattern compatibility gates remain
mandatory. An unsupported pattern still rejects allocation. This decision
cannot authorize customer execution, change budgets, fall back to runc, or
claim production performance. Launch requires a fresh capacity/cost decision
and separate authorization. The M3 handoff must expose any target miss.

## Failure inventory and E2E acceptance changes

Before implementing the contract change, extend M3-RUNTIME-01/05 to cover:

- Missing assessment, an unknown scope, a changed 50% target, a production-ready
  claim, or an assessment inconsistent with measured throughput must reject
  evaluation or allocation and create no runnable workload.
- Zero, negative, nonfinite or missing measurements cannot qualify for a
  deferral. Exact baseline/sandbox measurements and the computed ratio remain
  in the repeatable artifact.
- A real below-target result may qualify only for the owned-fixture gate when
  every existing mandatory control passes. Its public-safe assertion evidence
  must say the performance decision is deferred and customer admission false.
- A target met result still cannot enable customer or production admission.
- Existing failed, missing, mismatched, stale and unsupported-pattern cases
  retain their rejection behavior. No security or functional gate is waived.

Use the real HTTP evaluation/admission boundary and the existing E2E artifact
contract. Do not add isolated or post-implementation unit tests.
