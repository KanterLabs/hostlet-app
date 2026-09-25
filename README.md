# Hostlet

A fresh foundation for a portfolio-and-demo service for students and early-career
developers: connect GitHub, deploy supported projects, and publish a professional
portfolio around working demos.

**Your projects, live and ready to show.**

**Status: M2 and M3 accepted for owned local fixtures.** M2
supports accounts, selected GitHub repositories and branches, bounded
compatibility checks, and an editable private portfolio preview before paid
hosting. The control API persists immutable source, configuration, report and
draft history, and provides synthetic entitlement, capacity, project-slot and
build-meter reconciliation. The [M2 handoff](docs/M2-HANDOFF.md) records the
verified acceptance evidence: two clean 48-assertion runs, exact repeat
commands, private receipts, and observed limits. M2 acceptance is complete
through HOST-243.

M3 acceptance is limited to owned local fixtures and run-scoped resources.
It covers the working-demo path, deployment and release boundaries, owner
approval and fact refresh, tenant data lifecycle, and independent static
portfolio publishing. Two clean 55-assertion full journeys passed on the same
implementation commit through HOST-233, with one rebuilding the retained M2
binary. The [M3 handoff](docs/M3-HANDOFF.md) records private receipts, exact
repeat commands, browser evidence, cleanup and limits. Customer admission,
production workload execution, payment collection, provider purchases, and
production portfolio publication remain disabled. M3.5 now adds a restricted
owner preview deployment through HOST-248. Its
[preview contract](docs/M3.5-PREVIEW-CONTRACT.md) and
[scenarios](docs/M3.5-SCENARIOS.md) define the scoped deployment and evidence;
the receipt-query correction is deployed and passes. The latest full gate
recorded 23 passing checks before a browser portfolio-save confirmation timeout.
The September 25 recovery traced the error to public compression weakening the
revision ETag. Its first correction at `bba9d67` was overwritten by outer API
middleware, so the focused browser save still failed. The recovery plan's
checkpoint stop rule applied; no new full gate ran. Exact original routing and
the original draft/publication are preserved. The new preview has not been
handed off at the public URL. [The M3.5 handoff](docs/M3.5-HANDOFF.md) records
the diagnosis and verified receipt. HOST-248 resumed after Shane's next "use sol and fix" instruction; M4 remains unclaimed.
The [M3.5 recovery plan](docs/M3.5-RECOVERY-PLAN.md) defines the next diagnostic,
focused E2E and acceptance checkpoints for this resumed Sol medium execution.
The [M3 runtime decision](docs/M3-RUNTIME-DECISION.md) records the measured
throughput target shortfall and the explicit limit to owned local fixtures.

The [M1 handoff](docs/M1-HANDOFF.md) records the verified foundation, backup and
recovery baseline. The [M2 API contract](docs/M2-API.md) describes onboarding
routes, preview validation, provider boundaries and internal admission controls.
The [product plan](PLAN.md) follows the brief supplied on September 21 and replaces
the provisional generic-hosting baseline. `PLAN.md` is the canonical current plan;
the [recommended answers](RECOMMENDATIONS.md) are the adopted planning baseline
and rationale. The [roadmap](ROADMAP.md) records six milestone stops and mirrors
Helm's live prerequisite graph. [TESTING.md](TESTING.md) defines the E2E evidence
and agent handoff policy. Prices, benchmark resource allowances and production
provider/spend/domain placement still require validation or explicit authorization.

The adopted baseline covers project slots, compatibility and payment, release
recovery, portfolio lifecycle and build order. It describes planned behavior, not
current product capabilities or a published pricing catalog.

## Run locally

Install Rust 1.96.0 with `rustfmt` and `clippy`, Node 22.22.1, npm and Make.
`rust-toolchain.toml` selects the Rust toolchain; `.node-version` records Node.

```sh
make install
make dev-api
```

In a second terminal:

```sh
make dev-web
```

Open `http://127.0.0.1:5173`. Both development servers bind to loopback. Vite
forwards `/v1` and `/readyz` to the API on `127.0.0.1:8080`. Stop each process
with Ctrl-C. The API also handles SIGTERM gracefully.

The API accepts `HOSTLET_API_BIND` as an explicit socket address. If you change
its port, update the development proxy in `web/vite.config.ts` to match. No
environment file, database or provider credential is needed for this status-only
mode. Setting `DATABASE_URL` selects the durable foundation mode described below.
The sign-up and private-preview screens need that durable mode. GitHub additionally
requires the explicit provider configuration in [M2-API.md](docs/M2-API.md); the
service defaults to GitHub disabled and does not register an App automatically.

| Endpoint | Behavior |
| --- | --- |
| `GET /healthz` | HTTP 200: the API process can serve requests |
| `GET /readyz` | HTTP 503: product dependencies are not connected |
| `GET /v1/version` | Service version and `hostlet.agent/v1` protocol identifier |

An HTTP 503 readiness result is expected in status-only mode. With PostgreSQL,
applied migrations, keys, and worker authentication configured, readiness can
report `control_foundation` while keeping `customer_admission` and
`workload_execution` false. Liveness does not imply customer-hosting readiness.

For the durable API, inject `DATABASE_URL`, `HOSTLET_SECRET_KEY`,
`HOSTLET_RECOVERY_KEY`, and `HOSTLET_WORKER_TOKEN` through the process environment.
The two keys are distinct 32-byte values encoded as 64 hexadecimal characters;
the worker token contains 32–256 non-whitespace bytes. Do not put credentials in
command arguments, source files, logs, or artifacts. `HOSTLET_WORKER_BIND` must
remain loopback (default `127.0.0.1:8081`).

Startup never migrates. Against an explicitly selected empty development
database, initialize with `cargo run --locked -p hostlet-control -- migrate`,
then run `make dev-api`. A populated upgrade requires the documented verified
backup procedure; it never resets the database. See the
[foundation architecture](docs/M1-ARCHITECTURE.md) and
[project/draft HTTP contract](docs/M1-GRAPH-API.md) for the current API boundaries.
The [job contract](docs/M1-JOBS-API.md) and
[secret metadata/version API](docs/M1-SECRETS.md) describe worker leases and
scoped credential access. The [recovery runbook](docs/M1-RECOVERY.md) documents
encrypted PostgreSQL backups, backup-gated additive upgrades, retained binary
compatibility, separate empty-target restore, and the hourly scheduler tick.
M2 adds schema 5 with minimum reader 4; the owned acceptance drill exercises
populated schema-4-to-5 upgrades and both retained and current binaries. Recovery
has a 64 MiB plaintext dump limit and does not install a host timer or perform
a production cutover.

The builder and runtime offer `--version` and `--check-config`; their default
execution continues to refuse customer work.

## M3 implementation and validation

The current M3 code is split across explicit trust boundaries. `crates/control`
contains the durable build-job, release, runtime-policy, tenant-database,
portfolio-approval, and portfolio-publication flows. `crates/builder` owns the
disposable VM build boundary; `crates/runtime` owns the isolated runtime and
release worker boundary; `crates/database` owns tenant PostgreSQL lifecycle and
backup/export/restore operations. `crates/publisher` renders approved public
documents, leases publication work, validates immutable artifacts, and serves
the independent static site. `crates/protocol` contains shared versioned
contracts, while `migrations/0006_m3_execution.sql` contains the M3 additive
schema work.

The scenario and support modules are under `e2e/scenarios/m3-*.mjs` and
`e2e/support/m3-*.mjs`. The acceptance inventory is
[M3-SCENARIOS.md](docs/M3-SCENARIOS.md); the approval and publishing boundaries
are described in the [approval contract](docs/M3-APPROVAL-CONTRACT.md) and
[publisher contract](docs/M3-PUBLISHER-CONTRACT.md). The full prerequisite,
asset-preparation, run, and receipt procedure is in the
[M3 E2E guide](docs/M3-E2E.md).
The build, database, release, and runtime boundaries are documented in the
[build contract](docs/M3-BUILD-CONTRACT.md),
[database contract](docs/M3-DATABASE-CONTRACT.md),
[release contract](docs/M3-RELEASE-CONTRACT.md), and
[runtime control contract](docs/M3-RUNTIME-CONTROL.md).

For a routine workspace check, run:

```sh
make check
```

After the prerequisites and owned assets in the [M3 E2E guide](docs/M3-E2E.md)
are available, these commands run a diagnostic journey from a development tree:

```sh
make e2e-m3
make e2e-m3 E2E_ARGS='--rebuild-retained'
```

These commands may run from a dirty development tree and do not establish M3
acceptance. The accepted gates used a clean checkout of the tested
implementation commit and ran serially with an explicit umask:

```sh
umask 0022
make e2e-m3-gate
make e2e-m3-gate E2E_ARGS='--rebuild-retained'
```

See [the handoff](docs/M3-HANDOFF.md) for the exact tested commit, both run IDs,
verified receipts and observed behavior. Later documentation commits require
an isolated full-history checkout to repeat the exact accepted source. Follow
[TESTING.md](TESTING.md) for the artifact contract and stop before M4.

## Workspace

```text
crates/
  protocol/       Shared versioned wire types
  control/        Control API, durable M1–M3 workflows
  builder/        Disposable VM build supervisor and worker
  database/       Tenant PostgreSQL lifecycle and recovery worker
  publisher/      Independent static portfolio worker, renderer and server
  runtime/        Isolated runtime and release workers
web/             React application and Vite development proxy
e2e/             Real-process M2 and owned-fixture M3 scenarios
contracts/       Shared protocol fixtures
migrations/      PostgreSQL ownership and migration policy
docs/            Milestone contracts, scenarios, E2E guides and handoffs
scripts/         Owned build, runtime, database and release preparation tools
.github/         Non-deploying validation workflow
```

## Verify

```sh
make check
```

This runs Rust formatting, Clippy, existing Rust tests, TypeScript checks
and a production web build. Dependency resolution is committed in `Cargo.lock`
and `web/package-lock.json`; Rust validation uses `--locked` and web installs
use `npm ci`.

These routine checks are not product E2E evidence. `make e2e` aliases the full
owned M3 journey (`make e2e-m3`), including its VM/runtime prerequisites.
`make e2e-gate` aliases `make e2e-m3-gate` and requires clean source.
Historical M2 reruns use its tested commit in an isolated checkout.
See [the E2E guide](e2e/README.md) for prerequisites, scenarios and the deliberate
failure command. Complex features require E2E acceptance, and every run retains a
verifiable report, manifest, checksums and rerun instructions. Never write unit
tests after implementation. Any necessary isolation check starts with a written
failure inventory and failing cases before code, as specified in
[TESTING.md](TESTING.md).

Agents default to one milestone: finish its gate, verify a clean repeat run,
record the artifact and handoff, and stop. Continue only on a later instruction
or an explicit assignment covering a larger scope.

GitHub Actions runs web checks on `homelab` and Rust checks on `homelab-heavy`.
Fork pull requests are skipped pending a separate runner trust decision.
There are no deploy jobs, schedules, provider secrets or customer builds in CI.

## Repository workflow

`origin` is the private canonical Gitea repository,
`https://gitea.home.shanekanterman.dev/KanterLabs/hostlet-app.git`.
`github` is the public mirror, `https://github.com/KanterLabs/hostlet-app.git`.
Mirroring is explicit;
no automatic mirror credentials or webhook are configured.

Push reviewed changes to Gitea first using the approved Infisical-injected
authentication process, then push the same refs to `github`. Keep secrets,
private provider configuration and customer data out of this mirrored history.

Existing Hostlet repositories and resources are preserved. This repository has
its own history and additive platform migrations. E2E uses only owned synthetic
data and disposable resources; no production infrastructure or customer/billing
state is changed.
