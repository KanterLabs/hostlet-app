# Hostlet plan review and scaffold scope

Reviewed 2026-09-21 for the fresh `hostlet-app` project (Helm `HOST-207`).

## Source and interpretation

The project directory was empty and no plan was attached to the request. This
scaffold provisionally follows the existing September Hostlet planning package:
`HOST-145`, the September 7 decision register, and the September 8 implementation
contract and first-release amendment. The local source documents are in
`/home/shane/projects/hostlet/hostlet`: `docs/PLAN.md`, `DESIGN.md`,
`docs/DECISIONS.md`, `docs/IMPLEMENTATION_CONTRACT.md`, and
`docs/FIRST_RELEASE.md`. This document is a new summary, not an import of that
repository or its operational state. A newer supplied plan takes precedence.

The current request names this project `hostlet-app`. Current repository policy
uses private Gitea as source of truth and GitHub as a public mirror, superseding
the historical proposal for a private GitHub repository named `hostlet`.

## Product direction

Hostlet is a managed service for one stateless HTTP application per project.
The intended customer flow is account creation, subscription, GitHub connection,
exact-revision build, deployment and ongoing management from a web panel.

The planned first release includes Dockerfile builds, bounded resource limits,
secrets, health checks, logs, health-gated promotion, retained-image rollback,
safe deletion and Stripe subscriptions. A bounded Railpack path follows the
Dockerfile path. Checkout redirects cannot grant entitlement; verified provider
state and durable records decide access.

Self-host distribution, Compose stacks, worker-only processes, arbitrary TCP/UDP,
tenant volumes, managed databases, custom domains, team RBAC and a general CLI
are outside the recorded first-release scope.

## Architecture carried into this scaffold

| Boundary | Direction | Current implementation |
| --- | --- | --- |
| Control | Rust/Axum modular API; PostgreSQL owns durable state | Liveness, version, explicit not-ready response |
| Web | React/TypeScript; same-origin API; public prerendering later | Vite development shell and real API status |
| Protocol | Versioned HTTP and outbound agent contracts | Version response and protocol compatibility primitive |
| Builder | Outbound supervisor, rootless BuildKit in one disposable VM per attempt | Configuration/version entrypoint only |
| Runtime | Separate outbound reconciler; digest-addressed Docker/gVisor workloads | Configuration/version entrypoint only |
| Persistence | PostgreSQL with additive numbered migrations | Boundary documented; no schema or database |
| Infrastructure | Separate control, registry, runtime, builder and ingress trust zones | Boundary documented; no provisioning |

The historical baseline pins Rust 1.96.0 and Node 22.22.1. The browser API uses
`/v1`; the agent protocol identifier is `hostlet.agent/v1`. The current wire
fixture covers only version reporting. Authentication, jobs, errors, identifiers,
lease/fence envelopes and compatibility rollout remain implementation work.

Trusted platform surfaces are intended for `hostlet.cloud`; customer applications
use `hostlet.app`. No domain, certificate or route is configured by this scaffold.
The planned homelab placement has a shared host/power/uplink failure domain;
separate trust zones do not provide high availability.

## Review findings

1. The September documents mix preparation status with later completed work.
   Prior card completion must not imply that features exist in this fresh tree.
2. Earlier OVH placement is superseded by the recorded homelab amendment.
   Existing infrastructure remains preserved; this task creates no replacement.
3. The first-release amendment defers operational backups and broad recovery
   drills. Later upgrades of populated data still require backup and migration
   evidence; those are separate from an initial empty scaffold.
4. Paid hosting and customer execution require real persistence, identity,
   entitlement, isolation and provider integration before admission. Readiness
   stays false and agents refuse to run until those boundaries are implemented.
5. Public sales/docs prerendering is a future web milestone. Vite's development
   shell alone does not meet that release requirement.

## Next implementation slices

- Establish authoritative PostgreSQL persistence, safe migrations and a disposable
  local database harness; prove data survives restart and additive upgrades.
- Implement customer/operator identity and account ownership with cross-account
  denial checks, then GitHub installation binding and immutable source resolution.
- Add project snapshots, scoped secrets and durable jobs with leases/fences;
  prove retries and cancellation cannot accept stale work.
- Connect disposable builders, artifact verification and the isolated runtime;
  prove a real build, healthy promotion, rollback and cleanup.
- Add verified billing/entitlements, customer journeys and public sales/docs;
  validate the recorded minimal functional release journeys before deployment.

These are sequencing notes, not new claims on existing backlog cards or claims
of feature completion. Select implementation-sized cards when work is assigned.
