# M2 onboarding API

This document describes the implemented M2 saved-project picker, GitHub source,
bounded compatibility, private editable preview, and synthetic admission
surfaces. It is a current code contract, not an M2 completion or
production-launch claim.

The M1 account, session, project, configuration, deployment-intent, secret and
job APIs remain unchanged. See [M1-GRAPH-API.md](M1-GRAPH-API.md),
[M1-JOBS-API.md](M1-JOBS-API.md), and [M1-SECRETS.md](M1-SECRETS.md). Project
configuration bodies use the checked-in `hostlet.project/v1`
`StandardProjectSpec` contract; the
[standard project fixture](../contracts/v1/projects/valid-standard.json) is a
complete example. Public owner routes require the existing Bearer session.
Mutations that say so below also require `Idempotency-Key` and a quoted
`If-Match: "<revision>"`. Unknown JSON fields are rejected. Cross-owner resource
identifiers return `404` rather than revealing their existence.

## Saved project picker

`GET /v1/projects` returns only the authenticated owner's saved project summaries:
`{projects: [{id, name, mode, revision, current_configuration_revision_id}],
next_cursor}`. Each page has at most 50 entries in UUID order. Pass the returned
UUID as `?after=<next_cursor>` for the next page; `null` marks the last page.
No account selector is accepted. Invalid or unknown query fields return
`400 invalid_project_cursor`; missing authentication returns `401`. Responses use
`Cache-Control: private, no-store`. Read the selected graph through the existing
`GET /v1/projects/{project_id}` route.

## GitHub provider configuration

`HOSTLET_GITHUB_PROVIDER` selects `disabled` (the default), `github_com`, or
`synthetic_loopback`. Disabled GitHub returns `503 github_unavailable` from the
GitHub routes while the M1 foundation can remain available. `github_com` always
uses the fixed `https://github.com` and `https://api.github.com` origins. Only
`synthetic_loopback` reads configurable origins and is the explicit acceptance
boundary; it permits loopback HTTP for an owned provider fixture and is not a
production-provider mode.

The provider reads these configuration names:

- `HOSTLET_GITHUB_PROVIDER`
- `HOSTLET_GITHUB_WEB_ORIGIN` and `HOSTLET_GITHUB_API_ORIGIN`, only for
  `synthetic_loopback`
- `HOSTLET_GITHUB_APP_ID`
- `HOSTLET_GITHUB_CLIENT_ID`
- `HOSTLET_GITHUB_CLIENT_SECRET`
- `HOSTLET_GITHUB_PRIVATE_KEY_PEM`
- `HOSTLET_GITHUB_WEBHOOK_SECRET`
- `HOSTLET_GITHUB_CALLBACK_URL`
- `HOSTLET_GITHUB_OAUTH_ATTEMPT_TTL_SECONDS`, only as a bounded acceptance-fixture
  override from 1 through 600 seconds

App, OAuth, private-key and webhook values are injected through the environment
only. They do not belong in requests, source bindings, logs, or artifacts. The
callback must be HTTPS in `github_com`; the synthetic mode permits its owned
loopback callback. Invalid or partial provider configuration prevents the
process from serving with `github_configuration_invalid`.

Provider HTTP has bounded requests and does not follow redirects. Current code
limits an operation to 15 seconds, an individual request to 5 seconds, JSON to
2 MiB, pagination to five 100-item pages, source trees to 2,000 entries, selected
files to 40, each source file to 64 KiB, and total selected source content to
512 KiB. A user token lifetime is capped at eight hours.

## GitHub owner API

All routes in this section require a Hostlet Bearer session.

| Method and path | Request | Success |
| --- | --- | --- |
| `POST /v1/github/oauth-attempts` | Empty body | `201` with `authorization_url` and `expires_at` |
| `POST /v1/github/oauth-completions` | `{"code":"...","state":"..."}` | `200` with `github_user`, optional token `expires_at`, and authorization `revision` |
| `GET /v1/github/connection` | None | `200` connection status, GitHub user, expiry, and revision |
| `GET /v1/github/installations` | None | `200` provider-authorized installations |
| `GET /v1/github/installations/{installation_id}/repositories` | None | `200` readable repositories for that installation |
| `GET /v1/github/installations/{installation_id}/repositories/{repository_id}/branches` | None | `200` provider-listed full refs and commit SHAs |
| `PUT /v1/projects/{project_id}/github-source` | `Idempotency-Key`, project `If-Match`; `{"installation_id":123,"repository_id":456,"ref":"refs/heads/main"}` | `200` selected source |
| `GET /v1/projects/{project_id}/github-source` | None | `200` most recently selected binding and its latest owner-resolved revision |
| `POST /v1/projects/{project_id}/github-source/resolve` | `Idempotency-Key`, binding `If-Match`; empty body | `200` binding with a newly appended immutable source revision |
| `DELETE /v1/projects/{project_id}/github-source` | Binding `If-Match` | `204`; binding is disabled, history remains |

A selected source has this shape:

```json
{
  "binding_id": "uuid",
  "project_id": "uuid",
  "repository": {"id": 456, "owner": "owner", "name": "repo", "private": true},
  "ref": "refs/heads/main",
  "status": "active",
  "revision": 2,
  "source_revision": {
    "id": "uuid",
    "configuration_revision_id": "uuid",
    "resolved_commit": "40-or-64-lowercase-hex",
    "tree_sha": "40-or-64-lowercase-hex",
    "source": "owner_resolve",
    "observed_at": "RFC3339"
  },
  "configuration_fresh": true
}
```

Bind and resolve repeat current-user, installation, repository, permission and
ref proof through provider HTTP. The server resolves the commit; clients cannot
supply one. Each result is tied to the project's current configuration revision.
A later project configuration makes `configuration_fresh` false and requires a
new resolve before the source can authorize later work. Rebinding disables the
old active binding and creates a new one; it does not rewrite historical refs,
commits, trees, configurations, or source revisions.

OAuth state is stored as a SHA-256 digest. The PKCE verifier and user token are
encrypted with separate authenticated contexts. Completion is account- and
session-bound, expires, and is single-use. M2 stores no refresh token, so an
expired user token requires a new connection. Installation state distinguishes
active, suspended/revalidation-required, revoked/deleted history; deletion is
terminal for that installation identity. Discovery or binding cannot promote a
locally denied installation without fresh provider proof.

Source mutations serialize with idempotency locks. Provider revalidation and
commit persistence use database locks and recheck authorization, installation,
binding, project revision and configuration before commit. This prevents a
revocation, rebind or project edit from racing a source selection into authority.

Common stable failures include `github_unavailable` (503),
`github_connection_required`, `github_connection_expired`,
`github_connection_revoked`, `github_source_configuration_stale`,
`github_source_unverified`, `github_oauth_state_invalid`,
`github_oauth_state_expired`, `github_oauth_state_replayed`,
`github_ref_invalid`, `github_access_denied`, `stale_revision`, and the shared
idempotency error `idempotency_payload_changed`.

## Signed GitHub webhooks

`POST /v1/github/webhooks` is provider-authenticated rather than session-authenticated.
It requires exactly one `X-Hub-Signature-256`, `X-GitHub-Delivery`, and
`X-GitHub-Event` header. The signature is HMAC-SHA-256 over the unmodified body;
signature verification occurs before delivery headers, JSON, or SQL are
processed. The body is limited to 2 MiB.

Supported event families are `push`, `installation`, and
`installation_repositories`, with code-defined actions. An accepted event is
durably committed before `202 {"status":"accepted","delivery_id":"..."}`.
Repeating the same delivery UUID, event, and payload digest returns
`200` with `status:"duplicate"` and creates no second effect. Reusing a delivery
UUID for different bytes or an event returns `409 github_delivery_conflict`.
Signed but unsupported or unauthorized deliveries are durably recorded as
rejected and return a stable `422` reason. A push may append an immutable
`signed_push` candidate, but it never replaces the selected `owner_resolve`
source merely because a branch moved.

## Bounded compatibility API

Compatibility analysis consumes the exact owner-authorized GitHub source
revision and the existing immutable project configuration. It accepts no
repository URL, branch, commit, tree, blob, root, command, environment value, or
source content from the client. It reads source only through the GitHub
provider's bounded exact-source reader and never executes a package manager,
script, build, migration, application module, or repository command.

### Create a report

```http
POST /v1/projects/{project_id}/compatibility-reports
Authorization: Bearer <owner session>
Idempotency-Key: <key>
If-Match: "<current project revision>"
Content-Type: application/json
```

```json
{
  "source_revision_id": "uuid",
  "configuration_revision_id": "uuid"
}
```

The handler requires the path project to belong to the authenticated owner,
`If-Match` to equal the current project revision, and the supplied configuration
to be that project's current valid `StandardProjectSpec`. The source revision
must belong to the same project and configuration, remain selected through an
active binding, contain a provider-verified tree SHA, and pass fresh provider
authorization. The source/configuration pairing is rechecked under the
transaction locks held through report persistence. A branch moving later cannot
change the report's commit or facts.

Success is `201`. The complete report, digest, audit event, and idempotency
response commit together. Concurrent requests for the same owner, project,
configuration, source revision, and analyzer revision converge on one immutable
report. An exact idempotency replay returns that report; reusing the key with a
changed body returns `409 idempotency_payload_changed`. Stale pairings return
`compatibility_configuration_stale` or `compatibility_source_stale`; an invalid
selected spec returns `compatibility_configuration_invalid`. Provider failures,
malformed source, bounds failures, or PostgreSQL failures create no partial
report.

### Read reports

```http
GET /v1/projects/{project_id}/compatibility-reports/{report_id}
GET /v1/projects/{project_id}/compatibility-reports/latest?source_revision_id=<uuid>&configuration_revision_id=<uuid>
```

Both reads are owner-scoped. `latest` requires exactly one of each filter and
does not silently substitute the current configuration or a newer branch
commit. Missing, duplicated, unknown, or malformed query fields return
`400 invalid_compatibility_query`; unknown and cross-owner resources return the
same generic `404`. Errors use the standard safe API envelope and do not echo
the raw query. Every compatibility response, including errors, carries
`Cache-Control: private, no-store`.

### Safe report facts

A report includes its IDs, `analyzer_revision`, one status and headline,
`advisory:"deployment_not_verified"`, `deployment_verified:false`, creation
time, and strict versioned safe facts:

```json
{
  "contract_version": "hostlet.compatibility-report/v1",
  "repository": {
    "layout": "monorepo",
    "package_manager": "npm",
    "lockfile_path": "package-lock.json"
  },
  "services": [
    {
      "kind": "application",
      "root": "apps/api",
      "framework": "node_http",
      "node_major": 24,
      "build_command_present": true,
      "start_command_present": true,
      "http_health_path_present": false,
      "durable_data_detected": false
    }
  ],
  "environment_requirements": [
    {"name": "SESSION_SIGNING_KEY", "classification": "server_secret"}
  ],
  "reasons": [
    {
      "code": "health_endpoint_missing",
      "message": "Confirm an HTTP health endpoint for the application service.",
      "source_path": "apps/api/package.json"
    }
  ],
  "configuration_questions": [
    {
      "id": "service-0-health-path",
      "kind": "http_health_path",
      "classification": "configuration_choice",
      "target_path": "services[0].health_check.path",
      "prompt": "Select the HTTP health-check path.",
      "source_path": "apps/api/package.json",
      "required": true
    }
  ],
  "inspection": {
    "files_considered": 18,
    "files_read": 5,
    "bytes_read": 9812,
    "limits_revision": "hostlet.compatibility-bounds/v1"
  }
}
```

Safe facts may contain repository-relative paths, framework/runtime
classifications, boolean presence results, stable reason messages, unanswered
questions, and environment variable names classified as `public_build_value` or
`server_secret`. They never contain file bodies or excerpts, README or commit
text, command output or script bodies, environment values, credentials, tokens,
secret values, or portfolio copy. Commands and output paths remain in the
owner-private referenced project specification; the report records presence,
mismatch, reasons, and questions. A PostgreSQL 18 service makes `DATABASE_URL` a
platform-managed injected name, so it is excluded from owner-provided secret
requirements. Source references to the platform-managed `PORT` and `NODE_ENV`
names are also excluded from inferred owner requirements. If an owner explicitly
lists either name in `hostlet.json` under `publicBuildVariables` or
`serverSecrets`, that declaration remains in the report with its explicit
classification.

The status precedence is:

1. `showcase_only` / `Showcase-only unsupported`
2. `configuration_needed` / `Configuration needed`
3. `database_needed` / `Database needed`
4. `secrets_needed` / `Secrets needed`
5. `candidate` / `Looks compatible — deployment not yet verified`

Every applicable reason is retained even though only the highest-precedence
status is selected. `candidate` is an advisory result from bounded static
inspection. No result verifies deployment, consumes an entitlement or meter,
creates a slot, hold, deployment, build job, secret version, publication
approval, or public source link.

### Supported evidence and bounds

The analyzer recognizes locked npm with `package-lock.json`, Node 24 or the
documented Node 22 alternative, Vite/static export, one Node HTTP application,
Next.js 16 with an unambiguous literal `output: "standalone"`, and PostgreSQL
18. Unsupported package managers/runtimes, Compose or arbitrary Dockerfiles,
custom Next servers, extra workers/backends, and persistent application-disk
assumptions produce safe reasons rather than execution. Missing or ambiguous
lockfiles, roots, commands, output directories, health paths, database choice,
or environment requirements produce questions and the applicable status.

The GitHub exact-source boundary supplies sorted validated paths and only
allowlisted bounded text files. README and `.env*` files are excluded;
symlinks/submodules are rejected. Current limits are:

- 15 seconds per provider operation and 5 seconds per HTTP request;
- five pages of 100 provider list items and 2 MiB per JSON response;
- 2,000 tree entries and 1,024 bytes per repository-relative path;
- 40 selected files, 64 KiB decoded per file, and 512 KiB decoded total;
- 64 reasons, 32 configuration questions, and 128 environment names; and
- 128 KiB for canonical persisted safe facts.

A truncated tree, exceeded bound, invalid encoding, malformed manifest,
invalid source path, or provider inconsistency fails the request. It is not
downgraded to `candidate`. Reports are keyed to their exact account, project,
configuration, source revision, and analyzer revision; a newer commit or
configuration creates different evidence rather than mutating an old report.

## Private editable preview API

The preview API appends private portfolio drafts and their selected presentation
context. It does not publish a portfolio. Both routes require the existing
Bearer session, return `Cache-Control: private, no-store`, and expose no account
selector.

| Method and path | Request | Success |
| --- | --- | --- |
| `GET /v1/portfolio/draft-revisions/latest` | No body or query parameters | `200` with the latest draft plus its applicable preview context and a quoted revision `ETag` |
| `POST /v1/portfolio/preview-revisions` | `Idempotency-Key`, strict quoted revision `If-Match`, and `{"draft":<PortfolioDraft>,"preview":<PreviewContext>}` | `201` with the appended draft and preview context plus a quoted revision `ETag` |

An abridged response envelope is shown below; `draft` stands for the complete
object rather than a valid minimal draft:

```json
{
  "id": "portfolio-revision-uuid",
  "owner_account_id": "account-uuid",
  "revision": 4,
  "draft": {},
  "preview": {
    "layout": "layout_1",
    "typography": "system_sans",
    "accent": "coral",
    "project_contexts": [
      {
        "project_reference_id": "portfolio-project-reference",
        "project_id": "project-uuid",
        "configuration_revision_id": "configuration-revision-uuid",
        "source_revision_id": "source-revision-uuid",
        "compatibility_report_id": "compatibility-report-uuid",
        "placeholder": "gradient_1",
        "configuration_answers": []
      }
    ]
  },
  "preview_context_revision": 4,
  "created_at": "RFC3339 timestamp"
}
```

`draft` is the full existing `PortfolioDraft` contract described in
[M1-GRAPH-API.md](M1-GRAPH-API.md), not a partial patch. Unknown request fields
are rejected. The only current presentation tokens are:

- layout: `layout_1`;
- typography: `system_sans` or `editorial_serif`;
- accent: `coral`, `indigo`, or `forest`; and
- placeholder: `gradient_1`, `grid_1`, or `terminal_1`.

Omitting a project placeholder selects `gradient_1`. Each project context must
refer to the same hosted project reference in the submitted draft and to one
owner-scoped compatibility report with exactly matching project,
configuration-revision, and source-revision IDs. Duplicate project-reference
contexts are rejected. Historical report context remains readable after a
provider connection or binding is revoked; a preview read does not reauthorize
the old report against the provider.

Configuration answers use
`answer_version: "hostlet.configuration-answer/v1"`, a unique known
`question_id`, and exactly one of these strict tagged shapes:

```json
{"classification":"configuration_choice","answer_version":"hostlet.configuration-answer/v1","question_id":"...","selected_option":"..."}
{"classification":"public_build_value","answer_version":"hostlet.configuration-answer/v1","question_id":"...","value":"..."}
{"classification":"secret_required","answer_version":"hostlet.configuration-answer/v1","question_id":"..."}
{"classification":"unresolved","answer_version":"hostlet.configuration-answer/v1","question_id":"..."}
```

A configuration choice must equal one of the report question's options. A
public build value must be nonempty, contain no control bytes, and be at most
2,048 bytes. `secret_required` records only that a secret is needed and accepts
no value. `unresolved` may preserve any known unanswered question. The complete
answer array for one project context is limited to 65,536 serialized bytes.
Question IDs are limited to 256 control-free bytes.

### Revisions, inheritance, and errors

`If-Match` contains exactly one quoted nonnegative decimal revision. Revision
`0` creates the first revision only when the owner has no draft revisions. An
exact replay of that creation remains valid after revision 1 exists. A missing
precondition returns `428 if_match_required`, malformed or negative input returns
`400 malformed_if_match`, and a noncurrent revision returns
`412 stale_revision`. An exact idempotency replay returns the stored `201`
response and `ETag`; reuse with a different body returns
`409 idempotency_payload_changed`. A missing or invalid idempotency key returns
`400 idempotency_key_required` or `400 invalid_idempotency_key`.

A successful save commits one immutable M1-compatible draft revision, its
project references, the complete preview sidecar, audit event, and replay record
in one transaction. `GET latest` selects the highest draft revision and the
newest preview context at or before it. This lets a later draft appended through
the retained M1 API inherit the last M2 preview choices. Context entries whose
hosted project reference and project ID no longer match the latest draft are
filtered out. `preview_context_revision` identifies the revision that supplied
the returned context; it is `null` when no saved context exists, in which case
the server returns `layout_1`, `system_sans`, `coral`, and no project contexts.

The latest route rejects every query parameter with
`400 invalid_preview_query`; no draft returns generic `404 not_found`.
Malformed JSON and unknown fields return `400 malformed_json`; draft contract
violations return `422 invalid_portfolio_draft`; invalid tokens, duplicate or
mismatched context references return `422 invalid_preview_context`; and invalid
answers return `422 invalid_configuration_answer`. Unknown, foreign-account,
or cross-project owned resources return the same generic `404` without exposing
their existence. Failed saves append no draft, context, audit, or replay row.

Preview context stores references, presentation tokens, and validated answers;
it does not copy private source bodies. Preview reads and saves do not publish,
execute source, create a build or deployment, consume an entitlement or build
meter, or create capacity holds or hosted slots.

## Admission owner API

M2 admission consumes explicit synthetic entitlement, capacity and source-proof
facts. Every admission response contains `execution_enqueued:false`; these APIs
create durable intent and accounting only. They do not run a build, create a
runtime or database, publish content, contact a payment provider, or prove that
a refund occurred.

### Capacity hold

`POST /v1/projects/{project_id}/deployments/{deployment_id}/capacity-holds`
requires Bearer auth, `Idempotency-Key`, and the quoted current project
`If-Match`. Its body is:

```json
{"source_proof_id":"uuid","ttl_seconds":120}
```

The TTL must be 5 through 300 seconds. The server rechecks the deployment's
exact commit and configuration, current project configuration, entitlement,
build allowance, capacity and lifecycle while holding database locks. It infers
an `initial` hold when there is no live slot reservation and `rollout` when the
project already has one. Success is `201` with the hold, an existing reservation
for rollout or `null` for initial admission, `admitted_for_later_execution:false`,
and `execution_enqueued:false`.

### Consume admission

`POST /v1/projects/{project_id}/deployments/{deployment_id}/admissions` has the
same headers and accepts:

```json
{"capacity_hold_id":"uuid"}
```

The server rechecks proof, configuration, entitlement, capacity and expiry under
lock. An initial admission consumes the hold and creates one reservation with a
new `reservation_epoch`; a rollout admission consumes headroom and reuses the
existing reservation. Success is `201` for a new reservation and `200` for a
rollout or exact replay. It returns `admitted_for_later_execution:true` and still
returns `execution_enqueued:false`. An expired or lost hold returns
`409 capacity_hold_expired` and creates no reservation.

Owner reads are `GET /v1/projects/{project_id}/slot-reservation`,
`GET /v1/projects/{project_id}/deployments/{deployment_id}/capacity-holds`, and
`GET /v1/entitlements/current`. The entitlement summary identifies
`source:"synthetic_internal"` and reports slot limit/use, active initial holds,
build-second limit/debits/credits/remaining, and its immutable period bounds.

Other stable conflicts include `entitlement_unavailable`,
`entitlement_capacity_exhausted`, `platform_capacity_exhausted`,
`rollout_capacity_exhausted`, `capacity_hold_exists`, `admission_source_stale`,
`deployment_not_admissible`, `lifecycle_intent_pending`, and `stale_revision`.

## Admission internal fixture API

These routes exist only on the loopback worker listener and require the existing
worker token. They declare the M2 synthetic boundary; they are not customer or
billing-provider APIs. Except reconcile, every request contains an `event_id`.
The server takes an event-scoped advisory lock, stores the request hash and
response, returns the stored response for an exact replay, and rejects changed
reuse with `409 fixture_event_payload_changed`.

| Route | Body and effect |
| --- | --- |
| `POST /internal/v1/admission/capacity` | `event_id`, `pool_key`, `profile`, `hosted_slot_limit`, `rollout_headroom_limit`; creates or revises a synthetic pool. A reduction below live use returns `capacity_in_use`. |
| `POST /internal/v1/admission/entitlements` | `event_id`, account and pool IDs, hosted/build limits, period bounds, `state`; creates or revises an entitlement. Pool and period are immutable for that entitlement generation. Reductions below holds, reservations or net use fail. |
| `POST /internal/v1/admission/source-proofs` | `event_id`, account/project/deployment/configuration IDs, exact commit, `inventory_revision`, `expires_at`; validates the immutable deployment tuple and supersedes the prior valid synthetic proof. |
| `POST /internal/v1/admission/resource-observations` | Exact reservation identity and epoch, outcome, inventory, proof reference, optional rollout hold; records trusted synthetic lifecycle evidence. |
| `POST /internal/v1/admission/build-usage` | Exact account/project/deployment/attempt plus a debit or platform-fault credit; updates the synthetic meter only. |
| `POST /internal/v1/admission/reconcile` | Empty object; expires overdue unconsumed holds using PostgreSQL time and returns `expired_holds`. |

Entitlement, pool, project, proof, hold and reservation rows are locked in a
consistent scope before decisions are committed. The reservation epoch is a
generation fence: cleanup or retained-resource observations affect only the
exact current reservation and cannot release a later generation. Source proofs
also carry an inventory revision and expiry. If a project has any GitHub binding
history, a synthetic proof cannot bypass it: admission requires a live user
authorization, active installation and binding, and an exact owner-resolved
source revision for the admitted configuration and commit. Only a project with
no binding history may use the standalone synthetic source-proof boundary.

Resource outcomes are constrained: `cleanup_confirmed` requires inventory
`none` and releases the exact reservation; `resources_retained` keeps the slot;
`rollout_released` releases only matching rollout headroom; and
`deployment_healthy` changes synthetic lifecycle state without creating an
artifact, public fact, readiness claim, or execution proof. Expired unconsumed
initial holds create one durable pending `refund_required/hold_expired`
reconciliation intent. They do not issue a refund. Consumed rollout holds remain
charged to headroom until a matching release observation.

A build debit must have positive seconds and is unique for an entitlement and
attempt. It cannot exceed the remaining allowance. A
`platform_fault_credit` must reference an existing debit and match its account,
project, deployment, attempt, and seconds. At most one credit is accepted per
debit, so retries cannot create allowance. Credits and debits never enqueue a
build.
