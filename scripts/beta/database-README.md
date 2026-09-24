# M3.5 owned database composition

`database.mjs` creates two **distinct** persistent PostgreSQL 18 stores from
`e2e/postgres-image.txt`: a platform store on a configured `127.0.0.1` port and
a project store with Docker `network=none`. The project placement is required by
the existing `hostlet-database` worker and runtime peer. It is not a host-published
database. Both stores have independent owned volumes, credential files, and exact
container IDs. Repeated `ensure*` calls authenticate the existing containers and
reject identity, label, volume, image, port, credential, or peer-inventory drift.
They restart a stopped owned container with the same volume and ID. They never
remove a persistent volume or run a migration.
Persistent containers use Docker's `unless-stopped` policy so daemon/host reboot
preserves the same container and volume. On a previously created exact owned
container with Docker's default `no` policy, `ensure*` explicitly updates only
that restart policy after checking ownership. Other policy drift is rejected.
Isolated restore containers use `no` and are never restarted automatically.
`inspectProjectTarget` is a read-only recovery path: it requires the running
container, volume, private credential and inventory to match exactly, and does
not create or start a missing target.

The deployment's private config supplies `stateDir`, `postgres.platform.port`,
`postgres.platform.connectionUrlFile`, and project
`tenantDatabaseId`, `databaseGeneration` (UUID), `endpointIpv4`, and
`endpointIpv6`. Project endpoints are distinct peer addresses usable by the M3
runtime namespace relay, for example an IPv4 `.2` with paired `.1` gateway and
an IPv6 `::2` with paired `::1` gateway. They are not loopback addresses. The
state directory and service-specific credential files must be private. The module
does not print password values, put them in command arguments, or copy them to
artifacts. Only the control service receives the platform URL file. The project
admin password file belongs to the database composition/worker service; runtime
credentials are resolved by the actual control/database worker boundary.

```sh
node scripts/beta/database.mjs ensure-platform /private/preview-config.json
node scripts/beta/database.mjs ensure-project /private/preview-config.json
```

The module exports `ensurePlatformDatabase`, `ensureProjectTarget`, and
`ensureProjectRestoreTarget`. The first returns `connectionUrlFile`, `containerId`,
and `volumeName`; the second writes the exact private
`database-inventory.json` consumed by `hostlet-database` and returns a peer
descriptor. After actual provision, `bindProjectPeerCredential` adds credential
metadata read from control's durable tenant record. The project target is empty
until the real worker processes the
control API's fenced `provision` operation. The worker then creates `hdb_*`, the
three scoped roles, grants, and application credential. The worker's actual
backup/restore operations remain the primary tenant recovery path.

`backupDatabase` makes a role-free `pg_dump -Fc` archive without overwriting an
existing path. `restoreDatabase` checks the digest, creates a fresh isolated
owned container and volume, then restores there. `ensureProjectRestoreTarget`
creates an empty isolated M3 worker target and appends its exact UUID and
container ID to the private worker inventory; the worker itself performs the
fenced `restore_drill`. `removeTemporaryRestore` and
`removeProjectRestoreTarget` remove only their own isolated restore
container/volume after checking all ownership labels. They
never targets the live platform or project store. E2E must compare populated
rows, relationships, ownership/grants, and real read/write through the API or
application; a successful dump process alone is insufficient evidence.

Schema 6 initialization is a separate, explicit bootstrap action on a verified
new empty platform database. Routine managed restart calls no migration or seed
command. A populated storage/schema change requires the documented backup and
isolated compatibility gate before deployment.
