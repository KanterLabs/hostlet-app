# M2 implementation decisions

M2 is assigned through HOST-243. The acceptance inventory in
[M2-SCENARIOS.md](M2-SCENARIOS.md) was committed before implementation.
This document records interface decisions; passing artifacts establish completion.

## Source authorization

Use GitHub App user OAuth with S256 PKCE and a single-use state bound to the
initiating Hostlet account and session. Keep the expiring user token encrypted
in control-only storage. Discard refresh tokens; reconnect after expiry.
Each source operation rechecks the current user, installation and selected
repository through GitHub, then mints an installation token narrowed to one
repository and read-only contents. Tokens never enter worker secret leases.
The public App permissions are read-only contents and metadata; no write or
organization administration permission is needed.

Real GitHub origins are fixed. Synthetic mode accepts literal loopback origins
only and uses the same HTTP adapter. All requests have bounded time and response
sizes, and redirects are disabled. The external fixture verifies real App JWT
signatures, OAuth PKCE, user access and repository token scope. It substitutes
for GitHub.com in acceptance; it does not establish live App registration.

Binding resolves a selected branch to an immutable commit and tree without
reading source files. Analysis reads the stored commit, even after the branch
moves. A signed push creates an unresolved candidate only; provider verification
is required before it can be analyzed or admitted. Duplicate delivery IDs with
the same event and payload return a durable duplicate acknowledgment. Changed
payloads, invalid signatures, unauthorized branches and unbound repositories
are refused. Revocation disables access without changing prior immutable records.

Static inspection is limited to 2,000 tree entries, 40 selected text files,
64 KiB per file and 512 KiB in aggregate. No package manager, build, migration or
application command runs. Reports expose bounded findings and variable names,
never file bodies, README copy, secret values or deployment success claims.

## Preview and admission

The existing immutable PortfolioDraft stream remains the sole content model.
A preview save checks the latest account revision before appending owner-authored
content and separate private source/configuration context. The initial preview
uses one layout with bounded sans/serif typography and coral/indigo/forest
accents; three professional publication templates remain M4 work. Retained M1
content-only writes must preserve the prior context and cause stale M2 edits to
fail rather than overwrite the new revision.

Capacity and entitlement inputs are explicitly authenticated internal fixtures
until billing and runtime inventory exist. A hold reserves finite standard-project
capacity before admission creates a durable slot reservation. An admitted
replacement retains rollout capacity until a trusted cleanup observation releases
it. Expiry releases an unused hold only. Retained resources keep their project slot;
cleanup is scoped to the exact reservation generation. Build attempts debit usage,
and one verified platform-fault credit can reverse each matching debit once.
M2 queues no customer execution and keeps readiness's customer-admission and
workload-execution gates false.

## Data preservation

Use one additive schema-4 to schema-5 migration with minimum reader version 4.
Do not modify prior migrations or reset a populated database. A verified fresh
pre-upgrade backup remains mandatory. The clean M1 reader binary is retained at
source b17a48dc0dceac426b96d92824e16e8462752848; its provenance is in
[the retained manifest](../e2e/retained-m1.json).

Backups count every public platform table in their exported database snapshot,
including the new onboarding tables. Acceptance verifies populated IDs and
relationships, actual old/new binary reads and writes, and a separate owned
restore target. It never restores over the source database as an upgrade.

References: [GitHub user authorization](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app),
[installation tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app),
[webhook validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).
