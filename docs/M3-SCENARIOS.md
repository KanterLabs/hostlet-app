# M3 working demo and portfolio acceptance scenarios

Written before M3 implementation. Scope is HOST-222, HOST-223, HOST-225,
HOST-227, HOST-226, HOST-229 and the HOST-233 stop. The September 22 assignment
authorizes owned local fixtures through this gate; the September 23 correction
requires GPT-6 Sol workers at medium reasoning, with the primary owning
integration and verification.
These are planned observable outcomes, not completed evidence. Stop before M4.
No post-implementation unit tests will be added.

## Real boundaries and inputs

Use actual Hostlet HTTP and browser flows, durable platform PostgreSQL, the
declared synthetic GitHub HTTP boundary from M2, disposable hardware VMs for
builds, actual evaluated gVisor sandboxes for runtimes, separate tenant
PostgreSQL, actual backup/export/restore commands, and an independent static
server. No Hostlet internal method mock can satisfy an assertion. Runtime
compatibility may be explicitly deferred for a pattern only with observed
failure evidence and fail-closed admission for that pattern.
The observed throughput shortfall and the separate owned-fixture admission
decision are recorded in [M3-RUNTIME-DECISION.md](M3-RUNTIME-DECISION.md).
The 50% throughput target remains measured and reported; missing or inconsistent
assessment rejects the evaluation. No production-readiness claim is permitted.

The main owned repository has a static frontend, a Node API, a locked dependency
set, an additive database migration, populated related rows and a health route.
Separate owned fixtures exercise Node 22/24 and Next standalone compatibility,
dependency/build failure, timeout, oversized output, unhealthy startup, policy
probes, restart exhaustion and backwards-incompatible database/API changes.
Record exact source, image, toolchain, dependency-cache and artifact digests.
Provider credentials are service-scoped and never enter a guest or artifact.

Use only owned temporary namespaces, sockets, directories, VMs, processes,
containers, databases and network resources. Existing Docker configuration,
databases, disks, routes and registries are not test targets. Resource ownership
must be verified before cleanup. Failed and interrupted runs retain receipts.
No real customer code, public admission, customer contact, charge, provider
purchase, production deployment or public portfolio publication is authorized.

An explicit shared test clock drives M3 policy timestamps, daily backup
scheduling, seven-day expiry and monthly drill coverage. Authentication and
lease deadlines and elapsed performance/resource measurements retain real
monotonic/wall time; advancing policy time must never bypass those controls.
The mode, each advance and each consumer are recorded. Clock advancement must
exercise the running scheduler and durable actions, not fabricate backup rows.

## Data preservation — M3-UPGRADE

Retain the actual clean M2 control binary and a source/hash manifest before
changing production code or migrations. Populate schema 5 through that binary
with accounts, project/service/configuration graph, jobs, scoped secret
references, selected source, admission, compatibility and private preview data.
Capture primary IDs, relationships, grants and row counts. Missing, corrupt,
stale or wrong-target backup evidence rejects a populated upgrade without
changing data. Take and verify a fresh encrypted backup, apply only new additive
migrations, and restart the current API. All original values/relationships
survive; current and actual retained M2 binaries read and write the upgraded
database. Repeated migration is idempotent. No reset, recreate or automatic
restore is an upgrade. Restore a final populated M3 platform backup only into an
explicit separate empty owned target and compare all relevant relations.

## Runtime isolation and enforcement — HOST-222

- **M3-RUNTIME-01:** Start actual Node 22/24 and Next standalone fixtures under
  the evaluated gVisor binary. Capture its verified identity, launch policy,
  startup/health latency, CPU/memory overhead, exit behavior and comparable
  baseline measurements. Exercise documented Next SSR, route/API, server-action,
  image/cache and release-overlap requirements, or record the exact unsupported
  pattern and demonstrate admission rejection. A fabricated benchmark or runc
  fallback cannot pass as gVisor evidence.
- **M3-RUNTIME-02:** Code inside two real sandboxed tenants attempts to reach
  platform database/API, another tenant, builder infrastructure, host paths,
  cloud metadata and management/Docker sockets. Each forbidden operation fails;
  exact declared tenant database/fixture egress and routed public HTTP succeed.
  Test both address and hostname paths, IPv4/IPv6 policy and DNS behavior. Capture
  observations inside the sandbox and independent destination/network evidence.
- **M3-RUNTIME-03:** Exercise CPU saturation, memory exhaustion, scratch filling,
  process fanout, connection exhaustion and a repeatedly crashing application.
  Observe configured enforcement and a durable owner-visible bounded reason,
  without starving the other tenant/control service. Backoff is bounded and
  restart attempts cannot bypass budgets. A malformed or over-limit policy
  rejects before execution; limits cannot be silently omitted by the launcher.
  The owned process-pressure fixture must record both synchronous spawn errors
  and asynchronous child errors. The 2026-09-23 pressure diagnostic observed
  `spawn ENOMEM` with `pids.current=128`, a nonzero `pids.events.max`, and zero
  memory-limit/OOM events. Either `EAGAIN` or this observed `ENOMEM` can support
  the PID-limit oracle only alongside the exact configured limit, a nonzero
  kernel PID-limit event, and no OOM event. An errno alone is not enforcement
  evidence; an unhandled fixture HTTP 500 remains a failure. Repeated real
  pressure also demonstrated that the sandbox can exit before returning a
  response. That outcome may pass only with a retained kernel PID-limit event,
  the exact configured PID budget, zero memory-limit/OOM events, a matching
  owner-visible `process_limit_exceeded` observation, and healthy peer/control
  evidence. A timeout or generic exit without those receipts must fail.
  Resource counters must remain observable after the sandbox exits, including
  group OOM termination. A missing counter cannot become a guessed enforcement
  reason. Restart must preserve the previous failure receipt while allowing
  fresh observations for the new attempt; an earlier OOM must not label a
  healthy replacement as OOM. Counter ownership, budget limits and cleanup must
  remain tied to the exact allocation/generation/fence, with no shared host
  unit changes or unmanaged remnants.
  A restarted process must become reachable through the existing owned gateway;
  recreating a process alone is not health evidence. Restore only the exact
  owned namespace configuration, preserving peer attachments and network policy.

### Relay cleanup failure inventory

The 2026-09-23 pressure run exposed a cleanup boundary failure after an
aborted or half-closed loopback request: a forked root relay handler remained
in `CLOSE-WAIT` after the runner leader had exited, and its inherited stdout
and stderr pipes kept the runner alive. The relay stop boundary now records the
allocation, generation, fence, relay PID, process-group ID and Linux starttime
from the ownership map. The privileged stop helper validates every member of
that one process group, signals only pidfds for the exact root relay command,
and records bounded TERM/KILL outcomes. The runner then reaps its leader and a
second exact verification must prove no group member and no ownership map
remain. Any unowned process-group member, PID reuse, timeout, retained map or
surviving worker fails cleanup and retains the bounded receipt for diagnosis.
During `/proc` teardown races the helper re-inspects the exact group for at
most 500 ms so a child can become verifiably owned or disappear; it never
signals an unrecognized member or treats an unrecognized zombie as absent. A
persistent mismatch emits only bounded PID, UID, PGID, state, PPID, starttime
and command-match fields, never the raw command line.
The relay handler keeps legitimate TCP half-close response draining only until
a five-second deadline, then closes both sockets and its selector. It closes
inherited runner stdout/stderr in the forked handler, so a worker cannot keep
those pipes open after the request ends. This is an E2E boundary check; no
post-implementation unit test substitutes for the process-absence oracle.

- **M3-RUNTIME-04:** With no visitor traffic, verify the same allocated app and
  database remain usable across a documented observation interval and scheduler
  activity. Build allowance exhaustion does not stop them. Runtime restart,
  stale worker completion and API restart preserve durable ownership/policy.
- **M3-RUNTIME-05:** Missing, mismatched, outdated or failed isolation/compatibility
  evidence rejects workload admission. The internal fixture path still requires
  all controls. Production/customer admission remains disabled.

## Tenant PostgreSQL lifecycle — HOST-223

- **M3-DATA-01:** Provision two projects through authenticated durable intent and
  a real worker. Observe separate platform/tenant network and credential scopes,
  distinct least-privilege application roles, connection caps, storage accounting,
  populated related rows, and cross-project/system-schema denial. Duplicate or
  concurrent requests create one owned database; cross-owner requests fail.
  Missing grants, exhausted capacity, crash during provisioning and replay cannot
  leak an orphan or claim a healthy database before app connection succeeds.
- **M3-DATA-02:** The running scheduler creates actual encrypted daily backups
  with digest/target/schema/time receipts. Advance the shared policy clock
  through at least eight days and a full month: seven-day rotation retains the
  required usable history, and rotating drills cover every active database.
  A failed/corrupt backup is not the latest recoverable point and is never counted
  as successful coverage. Duplicate ticks/restarts produce no duplicate effects.
- **M3-DATA-03:** Perform actual portable export and encrypted restore into an
  isolated replacement PostgreSQL instance. Validate row values, foreign keys,
  ownership, least-privilege grants and the real fixture application's read/write
  connection. Portable output includes no cluster-wide roles or credentials.
  Record measured recoverable-data age and elapsed restore duration against the
  24-hour/four-hour policy targets, explicitly not an SLA. Live data is unchanged.
  Wrong key/digest/target, truncated archive, nonempty replacement or validation
  failure does not advance a live pointer or report recovery success.
- **M3-DATA-04:** Every candidate database migration requires a verified fresh
  pre-migration backup and a populated isolated compatibility trial. Crash,
  duplicate delivery and competing workers execute the controlled migration at
  most once. Customer builds never receive a tenant/production database secret.
  Retained release application binaries must read the resulting schema/data.

## Disposable VM builds — HOST-225

- **M3-BUILD-01:** Through selected-source/compatibility/internal-entitlement HTTP
  flows, enqueue the exact authorized commit in the durable fenced queue. A real
  builder claims it, materializes only that commit, runs locked installation and
  build commands inside a disposable VM, and emits immutable digest-addressed
  frontend/backend outputs. Observe VM identity, actual guest execution, CPU,
  RAM, bounded workspace/output and timeout. Moving the branch cannot change
  the job's commit or outputs. Source/archive paths, symlinks, device nodes and
  malformed manifests cannot escape workspace or artifact boundaries.
- **M3-BUILD-02:** Guest code probes other tenants, host management, runtime and
  tenant/production databases; all forbidden paths fail. An explicit offline
  dependency cache is allowed only if pinned and recorded, with a cache miss
  producing an honest dependency failure. No organization CI worker executes
  the fixture's package scripts. Scoped source credentials remain outside the VM;
  secret sentinels are absent from guest output, artifact and public responses.
- **M3-BUILD-03:** Missing compatibility, expired/revoked source authority, absent
  internal entitlement, exhausted quota, conflicting reservation or policy
  failure rejects before guest execution. Test queue retries, lease expiry,
  duplicate completion, concurrent claim and API/builder restart. Only the
  current lease can commit immutable output and exactly one usage debit; a stale
  attempt cannot promote a candidate or overwrite the succeeding artifact.
- **M3-BUILD-04:** Dependency failure, command failure, timeout, workspace/output
  exhaustion, corrupted artifact and interruption leave bounded safe reports,
  accurate exactly-once usage and no healthy release. Verify VM/process/disk/
  namespace cleanup on success and failure. Preserve the previous full-stack
  release once HOST-226 is implemented.

## Coordinated releases — HOST-226

- **M3-RELEASE-01:** A candidate records exact commit, both artifact digests,
  configuration, database migration, secret-version references and health
  evidence. Stage frontend and backend, perform actual candidate health checks,
  and atomically switch a durable routing manifest only after all checks pass.
  Browser and API traffic during promotion never pair incompatible versions.
  Exercise cached old frontend against new API and new frontend against retained
  API throughout a bounded drain; record retained asset lifetime and failures.
- **M3-RELEASE-02:** Against populated tenant data, verify a fresh backup, run the
  controlled additive migration once, and connect current and every retained
  rollback application to the resulting schema. An incompatible migration,
  missing backup, expired secret reference, failed candidate health or artifact
  digest mismatch rejects before promotion. Compatible migration work may remain
  after candidate failure, while the prior release continues serving current data.
- **M3-RELEASE-03:** Keep current plus two successful predecessors. Roll back to an
  eligible prior binary against current data, including writes made since its
  original promotion. No dump restore/data rewind occurs. Ineligible target,
  cross-owner action, concurrent promotion, stale completion and restart retain
  one coherent active pointer and truthful history. Failed builds and candidates
  do not consume a successful-retention position. Rollback eligibility requires
  the retained release's exact owned allocation generation and fence to remain
  healthy. M3 rejects a stopped or cleaned retained allocation; it does not claim
  generalized retained-allocation restart or replacement-generation recovery.

## Owner approvals and fact synchronization — HOST-227

- **M3-APPROVAL-01:** The actual owner reviews an exact immutable revision in the
  browser and explicitly approves every displayed narrative, contribution,
  image, contact, source/demo link and deployment/status field through a recorded
  revision approval. Derive required fields from stored content. No publication
  from repository access, preview, another account, a stale revision, incomplete
  approval or forged deployment fact. Source commit remains private unless
  explicitly approved for public display. Duplicate approval is idempotent.
- **M3-APPROVAL-02:** On a real promoted deployment, automatic synchronization
  changes only the previously approved managed destination, deployment time and
  availability fields. Record source deployment and audit event on every
  fact-only revision. Owner-edited links, narrative, new fields and evidence
  remain reviewable; never overwrite edits. Concurrent draft edit, repeated
  deployment event and restart do not skip approval or duplicate revisions.
- **M3-APPROVAL-03:** A release/demo-access change marks separate readiness as
  needing recheck and preserves the last approved case study and prior attestation
  history. Health alone cannot attest demo readiness or ownership contributions.

## Independent static publishing — HOST-229

- **M3-PUBLISH-01:** Render one complete approved template with introduction,
  featured project detail/case-study pages, skills, resume/contact links and
  approved deployment facts. Browser assertions read actual content, project
  order, section visibility and link destinations. Escape content and reject
  unsafe paths/URLs; hidden/private/unapproved fields never enter public output.
  Do not fetch arbitrary private image/README content while publishing.
- **M3-PUBLISH-02:** Produce immutable digest-verified artifacts and atomically
  advance an independently durable public pointer. Render/write/upload failure,
  interruption, corrupt content, stale publication and competing workers preserve
  the last good artifact. Restart serving using only static artifacts/pointer.
- **M3-PUBLISH-03:** Stop dashboard/control, synthetic GitHub and tenant endpoints.
  A fresh real browser still loads the published portfolio and detail pages from
  the independent static server, with expected content and links and no dependent
  page-load request. Portfolio and external case-study publication consume no
  hosted-project slot. Approval/private-field failures leave prior public content.

## Gate and evidence — HOST-233

Compose the actual owned exact-source -> admitted queue -> disposable VM ->
isolated Node/database -> coordinated release -> browser approval -> independent
static journey. Exercise a failed replacement and eligible rollback with populated
current data, then the upstream-outage portfolio check. A setup-only object,
simulated worker report, canned success, HTTP 200 alone or screenshot alone is
not evidence. Preserve all failed runs; repair behavior/oracles honestly.

Run `make check` separately, then two clean E2E runs on the same implementation
commit, with one run rebuilding the retained M2 binary from clean pinned source.
Each run must satisfy TESTING.md: exact commit/commands, fixture and tool identities,
declared modes/clocks, explicit assertions, private redacted outputs, data and
resource receipts, cleanup and external SHA256SUMS. Verify every receipt and
record its own hash in docs/M3-HANDOFF.md. Report observed compatibility limits
and unverified production claims. Stop at HOST-233 with no M4 claim.
