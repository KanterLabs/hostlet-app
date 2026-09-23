# Owned M3 executable sources

These directories are complete synthetic repositories served by the loopback GitHub fixture. `e2e/support/m3-fixtures.mjs` reads the files, layers `fullstack-v2` over `fullstack-v1`, and computes real Git SHA-1 blob, tree, and commit object IDs. Source bytes live only in these files; there is no second giant JSON encoding.

`fullstack-v1` and `fullstack-v2` are the main Node 24/Vite/PostgreSQL releases. Both frontend releases call the real API. API v2 preserves the v1 fields and request shape while adding fields through an additive migration, so cached v1 assets work with API v2 and v2 assets work with API v1. The frontend release identifiers are deliberately distinct.

The remaining repositories exercise Node 22, Next 16 standalone SSR/API/server-action/image/cache behavior, offline dependency failure, build failure and timeout, oversized output, unhealthy and crashing runtimes, isolation/resource probes, and incompatible API/migration rejection. They are executable test inputs and make no claim that a Hostlet policy passed until the real E2E boundary observes it.

The `workspace-exhaustion` build writes ordinary 16 MiB blocks until the real
guest filesystem reports `ENOSPC`, with a bounded cap for accidentally
over-sized workspaces. `unsafe-output-symlink` makes the declared output root
a symlink. `unsafe-output-special` writes a character device when the guest
allows `mknod`, and otherwise makes a FIFO. Both special-output variants are
accepted only as failure inputs; the build artifact collector must reject them.

Lockfiles are generated in one parent-owned serialized preparation step using `/tmp/m3-fixture-locks.md`. Never install or execute these packages on the organization CI host as part of acceptance; build scripts belong in disposable guests and runtime scripts belong in evaluated sandboxes.
