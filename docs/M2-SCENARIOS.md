# M2 onboarding acceptance scenarios

Scope: HOST-219, HOST-220, HOST-221, HOST-224 and the HOST-243 stop gate.
This inventory is written before M2 production implementation. It defines
observable outcomes for running-system E2E; it is not a unit-test plan or a
claim that any scenario already passes. M1 remains the durable foundation, and
M3 build, runtime, routing, tenant-database and public publication behavior is
outside this milestone.

Use real Hostlet API and web processes, a disposable PostgreSQL 18 instance,
real HTTP between Hostlet and an owned synthetic GitHub provider fixture, and a
real browser where specified. The provider fixture is the declared external
boundary: it implements only the GitHub OAuth, App installation, repository,
ref, commit, content and installation-token HTTP exchanges needed by these
scenarios, using synthetic repositories and credentials. It must record
sanitized requests and make wrong credentials, excess scopes or an unexpected
endpoint fail. It must not replace any Hostlet authentication, authorization,
webhook, source-selection, analysis, persistence or reconciliation code.

M2 does not authorize registering an external GitHub App, accessing a real
private repository, charging or refunding a payment instrument, provisioning
hosting, executing repository code, or publishing a portfolio. Entitlements
and capacity are explicit internal fixtures. All source and account data is
owned synthetic data.

## Shared boundary and invariants

- Start from a populated schema-4 M1 database and exercise M2 only through the
  public HTTP/browser surfaces plus independent PostgreSQL observations. A
  setup-only row or assertion against fixture state cannot prove product
  behavior.
- Every selected source revision is an immutable exact commit. Later movement
  of the authorized branch may create a new candidate, but cannot mutate an
  existing selection, compatibility report or preview's source commit.
- Private-source authorization is separate from portfolio approval. Repository
  access, a README, commit metadata and a compatibility result do not create
  public copy, a public source link or publication permission.
- Compatibility checks and previews execute no repository command and consume
  no entitlement, slot, capacity hold, deployment or build allowance. Capacity
  admission records durable intent only; M2 creates no tenant runtime, static
  release or project database.
- Responses, logs, browser evidence, database observations and artifacts contain
  no OAuth code, session token, webhook secret, App private key, installation
  token, repository credential or private source content. Safe identifiers and
  digests are permitted where the artifact contract requires them.

## GitHub connection, selected source and webhooks (HOST-219)

### `M2-GITHUB-01` — browser connection and least-privilege listing

From a real browser, an authenticated owner starts the connection flow. The
synthetic provider observes the real HTTP OAuth exchange and App installation
token request, then returns an installation granting two named synthetic
repositories. Hostlet persists the provider identity/installation relationship
and lists exactly those repositories. The request uses only the configured App
identity and required provider scopes; credentials supplied in browser input or
an arbitrary repository URL are rejected. A second Hostlet account cannot see
or use the first account's installation or repository list.

Canceling the provider flow, returning a mismatched/expired OAuth state, reusing
an authorization code, denying installation, receiving an expired token, or
receiving a provider timeout/error leaves no usable connection or partial
repository binding. Retrying with a fresh state succeeds without duplicate
installation relationships. Stored and logged data contains credential
references or encrypted values only.

### `M2-GITHUB-02` — repository, branch and immutable commit binding

The owner selects one granted repository and one provider-listed branch through
the browser. Hostlet resolves that branch through provider HTTP to an exact
commit, records the repository's immutable provider identity, authorized branch
or ref and exact commit in PostgreSQL, and returns those safe facts. A later
provider response moving the branch does not alter the saved binding or a report
already tied to it; an explicit refresh produces a separately recorded exact
commit candidate.

Reject a repository absent from the installation grant, an arbitrary URL or
clone credential, a client-supplied unverified commit, a branch not authorized
for the binding, a repository renamed to collide with another display name, and
a cross-owner project/repository reference. Revoking provider access makes a
fresh fetch fail closed while preserving the last immutable selection and its
audit history.

### `M2-GITHUB-03` — installation-token confinement

During repository/ref/content reads, the fixture accepts only a live token for
the selected installation and granted repository. It records that Hostlet did
not request or use another installation, repository, write operation or broader
credential. An expired token may be replaced through one bounded authenticated
token exchange; retries remain bounded and do not change the selected commit.
Wrong-installation tokens, provider authorization denial, rate limiting and
timeout return an actionable non-success response and persist no fabricated
source result. Neither HTTP responses nor artifacts expose token material.

### `M2-GITHUB-04` — signed webhook acceptance and idempotency

Deliver a provider-formatted event over real HTTP to the real Hostlet webhook
endpoint using the raw request bytes and a valid signature. For a bound
installation/repository and the authorized branch, one previously unseen
delivery ID records one durable event and one resulting exact-commit candidate.
Returning success means that durable acceptance committed before the response.
Redelivery of the identical delivery ID and payload is acknowledged as a
duplicate and creates no second event, candidate or downstream action, including
after an API restart.

### `M2-GITHUB-05` — webhook rejection matrix

Reject a missing, malformed or invalid signature; a valid signature over
different bytes; an unsupported event/action; a reused delivery ID with a
different payload; an unknown or revoked installation; an unauthorized
repository; a different branch/ref; a deleted binding; and a repository that is
granted to the App but unbound to the project. Each rejection has a stable safe
reason, creates no source candidate or job, and reveals neither whether another
owner has a matching binding nor any credential. Concurrent duplicate delivery
attempts still commit at most one accepted event.

## Bounded static compatibility (HOST-221)

### `M2-COMPAT-01` — bounded immutable-source inspection

Request analysis through real HTTP for the saved exact commit. Hostlet obtains a
bounded allowlist of metadata and source files from the provider fixture and
records file count, total-byte and per-file limits plus the exact commit. It
does not follow a moved branch during that analysis. Traversal paths, symlinks or
submodules escaping the selected repository/root, oversized content, excessive
file counts, provider pagination beyond the configured bound, binary payloads
where text is required, and provider timeout/rate limiting end with a stable
bounded failure or configuration-needed result. No partial report is presented
as complete.

### `M2-COMPAT-02` — no prepurchase execution sentinel

Analyze fixtures whose package lifecycle scripts, build/start/migration commands
and imported application modules would each write a distinct sentinel, make an
outbound request and fail if executed. Observe the Hostlet process tree and
run-owned filesystem/network sink for the full request and a bounded settling
period. No sentinel file, child package manager/runtime process, outbound
sentinel request or command output exists. PostgreSQL shows no build job,
deployment, entitlement, capacity hold, slot reservation or build-meter debit.
The report may quote command names as inert metadata but never evaluates them or
injects a secret.

### `M2-COMPAT-03` — supported advisory outcomes

Owned fixtures cover a Vite/static export, a single Node HTTP service and the
documented Next.js 16 standalone pattern, including monorepo service roots,
lockfiles, commands, health configuration and environment-variable names. The
running service returns the exact headline `Looks compatible — deployment not
yet verified` only when the bounded evidence satisfies the adopted pattern. It
returns Configuration needed, Database needed, or Secrets needed when the
fixture has that condition, with stable reasons and source locations. Public
build-time values are identified separately from server secret names; no secret
value is inferred, requested by the analyzer or persisted in the report.

### `M2-COMPAT-04` — unsupported and ambiguous source

Fixtures containing Docker Compose, an unsupported custom server, extra workers
or backends, missing lockfile/commands/health configuration, conflicting roots,
unsupported runtime, or persistent-disk assumptions return Showcase-only
unsupported or Configuration needed as defined by the product contract. The
response names the evidence and location without executing it. Malformed
manifests, ambiguous framework markers and files changed or removed at a newer
commit cannot silently upgrade the result to compatible. Reports for two exact
commits remain distinct and immutable after API/database restart.

## Private editable portfolio preview (HOST-224)

### `M2-PREVIEW-01` — authenticated browser selection and first save

An owner signs in through the real browser UI, selects a bound exact source and
its compatibility result, chooses a preview layout, enters owner-written profile
and project content, chooses approved placeholders, orders projects and answers
configuration questions. Saving through the UI persists a versioned private
draft in PostgreSQL; reloading and signing in again renders the same values,
order, exact source reference and unresolved questions. The flow succeeds with
no subscription and shows that deployment is not yet verified.

### `M2-PREVIEW-02` — edit, optimistic concurrency and validation

Edit typography/accent, section visibility, project order, narrative and
configuration answers in the browser, then save a new revision without mutating
the prior revision. Two tabs editing the same base revision cannot silently
overwrite one another: one save wins and the stale save receives a visible
conflict while both submitted values remain recoverable for resolution. Reject
malformed/oversized fields, unsafe link schemes and cross-project identifiers
without a partial revision. Refresh and API restart preserve the winning state.

### `M2-PREVIEW-03` — privacy and owner isolation

An unauthenticated browser, the second account and an expired/revoked session
cannot read, enumerate, edit or infer the existence of the owner's preview.
Direct identifier changes in URLs and request bodies remain denied. Preview
responses use private/no-store caching behavior and do not expose secrets,
provider credentials or raw private files. Logs and retained browser evidence
contain synthetic owner-written content only.

### `M2-PREVIEW-04` — private-source and unsupported boundaries

Creating a preview never copies a private README, source comment, commit message
or provider metadata into a public/content field. Only an explicit owner edit or
approval action can add owner-visible draft text, and M2 still performs no public
publication. An unsupported repository remains selectable as showcase-only with
its visible reason and no live-demo claim. Saving or editing any preview creates
no hosted slot, capacity hold, entitlement, deployment or build-meter event and
executes no source.

## Entitlement, capacity, slots and build meter (HOST-220)

These scenarios use explicit internal entitlement/capacity fixtures through a
declared test administration boundary. They do not emulate a settled charge,
create a price, contact a payment provider, provision a runtime or promise the
$5/$12/$20 hypotheses.

### `M2-ADMISSION-01` — concurrent first-deploy admission

Seed an account with a fixed purchased-slot entitlement and a smaller, exact
capacity pool. Submit more concurrent first-deploy requests through real HTTP
than either limit permits, including duplicate idempotency keys and distinct
projects. PostgreSQL commits no more reservations than both limits allow; every
accepted request has one retry-safe capacity hold durably committed before its
slot reservation and before any resource-creation intent. Duplicate retries
return the same outcome. Denied requests name entitlement or capacity without a
slot, hold, deployment/build job or meter debit. Restarting the API between
acceptance and response does not increase admitted counts.

### `M2-ADMISSION-02` — lifecycle accounting

A draft, compatibility report and preview use zero slots. A first accepted
deployment intent reserves one slot. Redeploy and rollback intents reuse that
slot; temporary overlap consumes separately labeled rollout headroom and cannot
be mistaken for a purchased slot. Owner stop, crash intent and a failure with a
retained database/resource keep the slot with a customer-visible reason. A
failure with no remaining runtime, static release or database releases the
reservation only after cleanup is durably confirmed. Repeated cleanup and
explicit export-and-remove are idempotent and cannot underflow counts or release
another project's slot.

### `M2-ADMISSION-03` — entitlement/capacity contention

Race first-deploy admission with an entitlement reduction, hold expiry and
capacity withdrawal. Serialization produces one explainable durable order: work
is admitted only while both entitlement and capacity are valid, and a lost hold
cannot become an active reservation. The platform never chooses a project to
remove after a downgrade and deletes no data. Because M2 has no real billing,
the lost-hold outcome records reconciliation/refund-required intent only; it
does not claim or perform a refund.

### `M2-ADMISSION-04` — build-meter debit and platform-fault credit

Against a fixed internal allowance, concurrent retry-safe build-intent requests
commit each logical debit once. Customer-caused failure or cancellation retains
the debit. A verified platform-fault retry credits the original logical debit
exactly once and may consume it again only for a separately accepted retry;
duplicate fault/credit events cannot increase allowance. Exhaustion rejects new
build intent while preserving the existing deployment/slot. No customer command
or build runs in M2.

### `M2-ADMISSION-05` — reconciliation and restart convergence

Interrupt the API/reconciler after each durable boundary: entitlement observed,
hold created, reservation created, meter debited, cleanup confirmed and fault
credit recorded. Start a real replacement process and deliver duplicate and
out-of-order reconciliation events. It converges to the intended entitlement,
capacity, slot and meter totals without double reservation, double credit,
orphan live holds or acceptance from memory-only state. Independent SQL totals
agree with public owner-visible counts and an audit trail explains every change.

## Populated schema-4 upgrade and retained M1 binary

### `M2-UPGRADE-01` — backed-up additive upgrade

Populate schema 4 through the M1 running API with both owners, projects,
services, deployments, jobs, encrypted secret references, portfolio drafts and
audit relationships. Build and retain the exact M1 implementation binary and
record its source and binary digests before introducing the M2 migration. Create
and cryptographically verify a fresh encrypted backup for the same immutable
database identity, physical target, schema 4 and intended next migration. A
missing, stale, corrupt, wrong-key, wrong-target or wrong-intended-migration
receipt blocks the actual migration command. The upgrade is additive and never
resets, recreates or restores the source database.

### `M2-UPGRADE-02` — old/new read-write compatibility

After the real schema-4-to-current upgrade, the retained M1 binary reads the
populated M1 graph and successfully performs an M1-supported write; the M2 binary
reads that write, preserves all row counts/ownership/relationships and performs
an M2 write. Restart the retained M1 binary against the same upgraded database
and verify it still reads its supported data without deleting, defaulting over
or corrupting M2 state. If the migration cannot truthfully keep the retained M1
reader/writer compatible, the gate fails and requires a separately reviewed
compatibility design; database rollback or restore is not used to manufacture a
pass.

## Failure inventory and cleanup

All applicable failures are exercised at the HTTP, browser, process, provider or
PostgreSQL boundary. No isolated test is currently justified. If implementation
discovers a deterministic property that cannot be observed there, update this
inventory before that code, state why E2E cannot cover it, and add the failing
isolated case first as required by [TESTING.md](../TESTING.md).

| Failure class | Required observable outcome |
| --- | --- |
| Malformed/bounded input | Invalid callback, provider, webhook, repository content, preview or admission input returns a stable safe failure; no crash, leaked parser/database detail or partial durable effect. |
| Authentication/authorization | Missing, expired or wrong-owner Hostlet credentials and wrong provider installation/repository/ref credentials fail closed without existence leaks or cross-owner effects. |
| Retry/replay/idempotency | Reused OAuth codes/state, webhook delivery IDs, save bases, admission keys and reconciliation events create at most one matching effect; same key with different content is rejected. |
| Concurrency/ordering/contention | Webhook duplicates, preview edits, slot admission, entitlement changes, hold expiry, meter credits and reconcilers serialize to an explainable durable outcome with no lost update or exceeded limit. |
| Timeout/cancellation/backpressure | Provider slowness, pagination/file bounds, analysis deadline, canceled browser/API request and stopped reconciler end within recorded bounds; retries are bounded and no partial result is promoted. |
| Persistence/migration | An acknowledged outcome survives process/PostgreSQL restart; schema-4 upgrade requires its verified backup and retained M1/new binaries preserve meaningful populated reads and writes. |
| Partial failure/cleanup | No credential or private source reaches evidence. Failed operations clean only run-owned processes, fixture data, holds and temporary files; a slot is released only after confirmed resource cleanup, while retained-resource state keeps it. |
| Recovery/restart | Replacement API/reconciler processes resume durable state and converge without relying on memory; immutable selections/reports/revisions remain tied to their exact commits. |

Every invocation creates `artifacts/e2e/M2/<run-id>/` before prerequisite or
fixture setup and follows the complete [TESTING.md](../TESTING.md) artifact
contract. In addition to the common manifest, report and external checksum
receipt, retain safe provider-fixture request summaries, exact synthetic source
fixture digests, sentinel/process/network observations, browser assertions,
durable SQL assertion results, migration/backup receipts, retained/current
binary identities, admission/reconciliation event summaries and cleanup results.
Private source file bodies and all credentials are excluded.

A failed, timed-out, interrupted, skipped or environment-blocked run finalizes a
non-passing artifact when possible; a hard interruption remains incomplete for
the next run to mark abandoned. Cleanup stops only run-owned Hostlet/provider
processes and removes only explicitly labeled disposable PostgreSQL/container,
temporary source and capacity fixtures. Retain diagnostic evidence and any
deliberately retained lifecycle record named by the scenario. A missing required
assertion, missing sentinel observation, failed cleanup, source-tree change,
artifact-finalization failure or invalid checksum receipt fails the run.

## HOST-243 gate and open design questions

The gate requires all scenarios above in one traceable M2 assertion inventory,
a passing clean run and clean repeat from the recorded commit and inputs,
verified external `SHA256SUMS` receipts, explicit fixture boundaries and a
handoff with limitations and cleanup results. M1 evidence remains linked rather
than reclassified as M2 evidence. Stop at HOST-243 without claiming M3 customer
builds, runtime, routing, databases, billing or publication.

Resolve these questions before the affected production interface is fixed:

1. Which GitHub user-authorization flow is part of connection (App user OAuth,
   installation setup callback, or both), and what exact minimum permission set
   should the synthetic provider enforce?
2. Which webhook event/action set and branch/ref forms are accepted initially,
   and what durable response semantics should valid duplicates receive?
3. What file-count, byte, pagination, depth, timeout and symlink/submodule bounds
   define static inspection, and which limit maps to Configuration needed versus
   Showcase-only unsupported?
4. What is the M2 capacity unit and hold-expiry policy, and which trusted internal
   interface supplies entitlement/capacity fixtures before billing exists?
5. Which M2 schema version and compatibility row will permit the retained
   schema-4 M1 binary to write safely after upgrade, including how M2 rows survive
   old-binary writes?
