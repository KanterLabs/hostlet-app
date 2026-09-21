# Standard project contract

`hostlet.project/v1` is the typed configuration contract for the first Hostlet
project shape. The Rust values live in `crates/protocol/src/project.rs`; owned
fixtures live in `contracts/v1/projects/`.

This contract is planning and configuration input. Validation performs no
checkout, install, build, migration, network request, capacity admission, or
workload execution. Passing validation means only that the declaration fits the
initial supported shape.

## Input and server records

`StandardProjectSpec` is the client-controlled input. It contains exactly:

- `contract_version`;
- one repository or monorepo declaration;
- service declarations; and
- the starting benchmark resource envelope.

It contains no account, owner, assigned UUID, deployment health, release fact,
or slot claim. The control API authenticates the account, validates this input
on its normal create/configure route, assigns IDs, and persists separate
`AccountRecord`, `ProjectRecord`, `RepositoryRecord`, `ServiceRecord`,
`ConfigurationRevision`, and `DeploymentRecord` values. There is no test-only
validation endpoint.

The separate reference types keep account, project, service, configuration,
deployment, artifact, database-migration, health-result, and secret-version
relationships explicit. Releases retain references, never secret values.
`ProjectMode`, `SlotRelationship`, `SlotState`, and `DeploymentLifecycle` are
server-owned lifecycle facts. Merely serializing `reserved` does not prove that
M2 entitlement and capacity admission happened, and no M1 record proves that an
M3 workload ran.

An eventual create request uses the configuration directly:

```json
{
  "name": "Course planner",
  "configuration": {
    "contract_version": "hostlet.project/v1",
    "repositories": [{
      "layout": "monorepo",
      "package_manager": "npm",
      "lockfile_path": "package-lock.json"
    }],
    "services": [],
    "resources": { "limits": [] }
  }
}
```

The abbreviated arrays above illustrate API nesting only. Use a valid fixture
for a complete request.

## Supported shape

A project has exactly one repository declaration. `single_project` and
`monorepo` are supported. It uses npm and a repository-relative
`package-lock.json`. Source roots and output paths use forward-slash relative
paths; `.` means repository root. Absolute paths, drive paths, backslashes,
empty segments, and `..` traversal are rejected.

The project may have at most:

- one `static_frontend` using `vite_static` or `static_export`;
- one long-running `application` using `node_http` or
  `nextjs16_standalone`; and
- one managed `postgres` service using PostgreSQL 18.

Static-only and API-only projects are valid. A static service declares its
build command and output directory. An application declares a start command
and an absolute HTTP health path; Next.js standalone also declares a build
command. Source services use Node 24 by default or the explicitly tested Node
22 alternative. A service declaring durable data requires the project database.
A database without an application is rejected in the initial contract.

Extra static frontends, application services, databases, workers, scheduled
jobs, and additional backends are rejected. Docker Compose, custom Next.js
servers, unsupported frameworks, other package managers, and missing lockfiles
are also rejected. Service names are nonblank, control-free, and at most 64
bytes. Commands are at most 4096 bytes and relative paths at most 1024 bytes.
The managed database accepts no source root, Node runtime, build/start command,
output directory, or user-defined health configuration.

`validate()` returns deterministic `ProjectValidationIssue` values in discovery
order. Each has a stable snake-case `code`, a field `path`, and a safe message.
API behavior should branch on the code rather than the prose. Deserialization
also rejects unknown fields.

## Starting benchmark envelope

Every value below is labeled `benchmark_candidate`; none is an approved or
published promise. The typed fixture records the amount, unit, scope, and
enforcement behavior for each row.

| Resource | Amount and unit | Scope | Enforcement label |
| --- | --- | --- | --- |
| Application memory | 512 MiB | hosted project | `report_memory_termination_with_bounded_restart_backoff` |
| Application CPU | 250 millicpu | hosted project | `throttle_cpu` |
| Database storage | 1 GiB | project database | `warn_at80_prevent_growth_preserve_reads_and_export` |
| Database connections | 10 connections | project database | `cap_application_connections` |
| Scratch storage | 256 MiB | hosted project | `fail_excess_ephemeral_writes` |
| Build CPU | 2000 millicpu | build | `fail_build_preserve_live_release` |
| Build memory | 2 GiB | build | `fail_build_preserve_live_release` |
| Build timeout | 10 minutes | build | `time_out_build_preserve_live_release` |
| Concurrent builds | 1 | account | `queue_builds_until_capacity` |
| Monthly build execution | 60 minutes | purchased slot / billing month | `queue_builds_until_billing_renewal` |
| Static artifact | 250 MiB | release | `reject_oversized_replacement_preserve_current` |
| Runtime artifact | 1 GiB | release | `reject_oversized_replacement_preserve_current` |
| Retained releases | 3 (current plus two previous) | hosted project | `retain_current_plus_two_previous` |
| Public transfer | 10 GiB | purchased slot / billing month | `warn_at80_and95_then_limit_public_traffic` |
| Portfolio assets | 100 MiB | account portfolio | `reject_new_assets_preserve_published_revision` |
| Log storage | 100 MiB | project logs | `rotate_oldest_and_redact_secrets` |
| Log retention | 7 days | project logs | `rotate_oldest_and_redact_secrets` |

Validation requires every row exactly once, with a finite positive amount and
the adopted amount, unit, scope, enforcement label, and benchmark status.

## Fixtures and acceptance

The positive fixtures are `valid-standard.json`, `valid-static-only.json`, and
`valid-api-only.json`. Negative fixtures cover separate repositories, extra
services, path traversal, missing lockfile and unsupported runtime/framework,
missing application start/health configuration, an unbounded resource, and
bounded text/database-field rules. Every negative fixture has a sibling
`.expected.json` containing its stable expected issue codes.

These fixtures are contract inputs, not isolated acceptance tests. The
`M1-CONTRACT-01` running-service scenario in
[`../docs/M1-SCENARIOS.md`](../docs/M1-SCENARIOS.md) must submit them through
the real owner-scoped HTTP API once HOST-216 implements that route. E2E evidence
under [`../TESTING.md`](../TESTING.md) is the acceptance proof.
