# Hostlet

A fresh foundation for a portfolio-and-demo service for students and early-career
developers: connect GitHub, deploy supported projects, and publish a professional
portfolio around working demos.

**Your projects, live and ready to show.**

**Status: development scaffold.** The API exposes health and version information,
and the web shell reports its actual status. Portfolios, compatibility analysis,
accounts, billing, project databases, builds and deployments are not implemented.
The [product plan](PLAN.md) follows the brief supplied on September 21 and replaces
the provisional generic-hosting baseline. Prices and production placement remain
unresolved proposals.

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
environment file, database or provider credential is needed for this scaffold.

| Endpoint | Behavior |
| --- | --- |
| `GET /healthz` | HTTP 200: the API process can serve requests |
| `GET /readyz` | HTTP 503: product dependencies are not connected |
| `GET /v1/version` | Service version and `hostlet.agent/v1` protocol identifier |

An HTTP 503 readiness result is expected at this stage. It prevents a live
process from being mistaken for a service ready to accept customer work.
The agents offer `--version` and `--check-config`; normal execution refuses to
start because enrollment and work processing are not implemented.

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

This runs Rust formatting, Clippy, focused behavioral tests, TypeScript checks
and a production web build. Dependency resolution is committed in `Cargo.lock`
and `web/package-lock.json`; Rust validation uses `--locked` and web installs
use `npm ci`.

GitHub Actions runs web checks on `homelab` and Rust checks on `homelab-heavy`.
Fork pull requests are skipped pending a separate runner trust decision.
There are no deploy jobs, schedules, provider secrets or customer builds in CI.

## Repository workflow

`origin` is the private canonical Gitea repository,
`https://gitea.home.shanekanterman.dev/KanterLabs/hostlet-app.git`.
`github` is the public mirror, `https://github.com/KanterLabs/hostlet-app.git`.
The initial `main` commit is published to both. Subsequent mirroring is explicit;
no automatic mirror credentials or webhook are configured.

Push reviewed changes to Gitea first using the approved Infisical-injected
authentication process, then push the same refs to `github`. Keep secrets,
private provider configuration and customer data out of this mirrored history.

Existing Hostlet repositories and resources are preserved. This project starts
with new history and introduces no schema, migration, infrastructure deployment
or customer/billing mutation.
