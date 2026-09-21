# Hostlet

A fresh foundation for a portfolio-and-demo service for students and early-career
developers: connect GitHub, deploy supported projects, and publish a professional
portfolio around working demos.

**Your projects, live and ready to show.**

**Status: M1 complete — local control foundation.** The API persists authenticated accounts,
owner-scoped projects, immutable configurations, deployment intents, and portfolio
drafts in PostgreSQL. It also supports fenced bookkeeping jobs, service-scoped
encrypted secrets, and verified platform backup, additive upgrade, and restore
commands. The web application remains a status preview; it does not
yet provide account or project-management screens. Customer hosting, GitHub
integration, compatibility analysis, billing, tenant databases, builds, and
portfolio publication belong to later milestones.
The [M1 handoff](docs/M1-HANDOFF.md) records the two clean acceptance runs,
exact tested commit, repeat commands, private evidence receipts and limitations.
The [product plan](PLAN.md) follows the brief supplied on September 21 and replaces
the provisional generic-hosting baseline. `PLAN.md` is the canonical current plan;
the [recommended answers](RECOMMENDATIONS.md) are the adopted planning baseline
and rationale. The [roadmap](ROADMAP.md) records five milestone stops and mirrors
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
encrypted PostgreSQL backups, the backup-gated schema-3-to-4 upgrade, retained
binary compatibility, separate empty-target restore, and the hourly scheduler
tick. M1 recovery has a 64 MiB plaintext dump limit and does not install a host
timer or perform a production cutover.

The builder and runtime offer `--version` and `--check-config`; their default
execution continues to refuse customer work.

## Workspace

```text
crates/
  protocol/       Shared versioned wire types
  control/        Control API entrypoint
  builder/        Builder supervisor entrypoint
  runtime/        Runtime reconciler entrypoint
web/             React application and Vite development proxy
contracts/       Shared protocol fixtures
migrations/      PostgreSQL ownership and migration policy
infra/           Future provisioning boundaries
portfolio/       Content and independent static-publishing boundary
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

These routine checks are not product E2E evidence. `make e2e` exercises the real
API/web processes through HTTP and Chromium plus an owned PostgreSQL instance;
`make e2e-gate` requires clean source.
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
