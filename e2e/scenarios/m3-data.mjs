import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import {
  assertErrorShape,
  assertStatus,
  expectScenario,
  ScenarioExpectationError,
} from "../support/http-client.mjs";

export const M3_DATA_REQUIRED_ASSERTIONS = Object.freeze([
  "M3-DATA-01",
  "M3-DATA-01-STORAGE",
  "M3-DATA-02",
  "M3-DATA-03",
  "M3-DATA-04",
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTAINER_ID = /^[0-9a-f]{64}$/;
const DATABASE_WORKER_ID = "m3-database-1";
const MAX_DRAIN_OPERATIONS = 256;
const PROVISIONING_EXPECTATION = "two admitted projects provision separate PostgreSQL 18 databases through durable intent and a real worker; grants, limits, isolation, retries, ownership, and actual application read/write hold";

function safeObserved(error) {
  return error instanceof ScenarioExpectationError ? error.observed : { failed_checks: 1 };
}

async function dataStep(context, id, expected, run) {
  try {
    const observed = await run();
    context.assertion(id, "M3 tenant PostgreSQL lifecycle", expected, observed, true);
    return observed;
  } catch (error) {
    context.assertion(
      id,
      "M3 tenant PostgreSQL lifecycle",
      expected,
      safeObserved(error),
      false,
      error instanceof ScenarioExpectationError ? error.check : "tenant PostgreSQL boundary failed",
    );
    throw error;
  }
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  }
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function mutationHeaders(key, revision) {
  return { "Idempotency-Key": key, "If-Match": `"${revision}"` };
}

function assertCode(response, status, code, check) {
  assertErrorShape(response, status, check);
  expectScenario(response.payload.error.code === code, `${check}: stable error code`, {
    status: response.status,
    error_code: response.payload.error.code,
  });
}

function assertStatusWithPublicError(response, status, check) {
  if (response.status !== status) {
    const code = typeof response.payload?.error?.code === "string" ? response.payload.error.code : "unknown_error";
    throw new ScenarioExpectationError(check, { status: response.status, error_code: code });
  }
}

function parseWorkerEvents(stdout) {
  return stdout.split("\n").filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { throw new Error("database worker emitted non-JSON output"); }
  });
}

function databaseService(graph) {
  const service = graph?.services?.find((item) => (item.configuration ?? item).kind === "postgres");
  if (!service?.id || !UUID.test(service.id)) throw new Error("admitted project has no PostgreSQL service");
  return service;
}

function normalizeProject(value) {
  const graph = value?.graph ?? value;
  const projectId = value?.projectId ?? graph?.project?.id;
  const deploymentId = value?.deploymentId ?? value?.deployment?.id ?? graph?.deployment?.id;
  const configurationRevisionId = value?.configurationRevisionId ?? graph?.configuration?.id;
  const reservation = value?.reservation;
  const service = value?.databaseService ?? databaseService(graph);
  if (!UUID.test(projectId ?? "") || !UUID.test(deploymentId ?? "") ||
      !UUID.test(configurationRevisionId ?? "") || !UUID.test(reservation?.id ?? "") ||
      !UUID.test(reservation?.reservation_epoch ?? "")) {
    throw new Error("M3 data stage requires an admitted exact project/deployment/reservation tuple");
  }
  return { graph, projectId, deploymentId, configurationRevisionId, reservation, databaseService: service };
}

class OwnedTenantPostgres {
  constructor(m3) {
    this.m3 = m3;
    this.context = m3.context;
    this.runId = randomUUID();
    this.image = readFileSync(join(this.context.repo, "e2e", "postgres-image.txt"), "utf8").trim();
    this.inventoryPath = join(m3.policyClock.stateDir, "database-inventory.json");
    this.targets = [];
    this.resources = [];
    this.adminPasswords = new Map();
    this.sequence = 0;
    this.closed = false;
    this.context.state.configuration.m3TenantPostgres = {
      image: this.image,
      runId: this.runId,
      networkMode: "none",
      inventory: "private run-owned database-inventory.json",
    };
    this.context.registerCleanup("remove exact owned M3 tenant PostgreSQL containers and volumes", () => this.cleanup());
    this.writeInventory();
  }

  writeInventory() {
    const temporary = `${this.inventoryPath}.${randomUUID()}.tmp`;
    const payload = { schema_version: 1, run_id: this.runId, targets: this.targets };
    writeFileSync(temporary, `${JSON.stringify(payload)}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.inventoryPath);
    chmodSync(this.inventoryPath, 0o600);
  }

  async create(database, { recoveryId = null, force = false, labelDatabaseId = database.id } = {}) {
    const existing = this.targets.find((item) =>
      item.tenant_database_id === database.id && item.database_generation === database.generation &&
      item.recovery_id === recoveryId);
    if (existing && !force) return existing;
    this.sequence += 1;
    const short = `${this.runId.slice(0, 8)}-${String(this.sequence).padStart(2, "0")}`;
    const name = `hostlet-m3-tenant-${short}`;
    const volume = `${name}-data`;
    const restore = recoveryId !== null;
    const password = randomBytes(32).toString("base64url");
    this.context.registerSensitiveValues([password]);
    const environmentPath = join(this.m3.policyClock.stateDir, `${name}.env`);
    writeFileSync(environmentPath, `POSTGRES_PASSWORD=${password}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(environmentPath, 0o600);
    const labels = {
      "io.hostlet.scope": "m3-e2e",
      "io.hostlet.run-id": this.runId,
      "io.hostlet.resource": "tenant-postgres",
      "io.hostlet.database-id": labelDatabaseId,
      "io.hostlet.database-generation": database.generation,
      "io.hostlet.restore-target": String(restore),
      "hostlet.e2e.run": this.runId,
      "hostlet.e2e.owner": "m3-data-stage",
      "hostlet.m3.database": labelDatabaseId,
      "hostlet.m3.generation": database.generation,
      "hostlet.m3.restore": String(restore),
    };
    const volumeLabels = {
      "io.hostlet.scope": "m3-e2e",
      "io.hostlet.run-id": this.runId,
      "io.hostlet.resource": "tenant-postgres-data",
      "io.hostlet.database-id": database.id,
      "io.hostlet.database-generation": database.generation,
      "io.hostlet.restore-target": String(restore),
      "hostlet.e2e.run": this.runId,
      "hostlet.e2e.owner": "m3-data-stage",
      "hostlet.m3.database": database.id,
      "hostlet.m3.generation": database.generation,
      "hostlet.m3.restore": String(restore),
    };
    const absent = await this.context.runCommand("verify tenant PostgreSQL volume name is unused", "docker", ["volume", "ls", "--filter", `name=^${volume}$`, "--format", "{{.Name}}"], {
      timeoutMs: 15_000, logName: `m3-data-postgres-volume-absent-${String(this.sequence).padStart(2, "0")}.log`,
    });
    if (absent.code !== 0 || absent.stdout.trim() !== "") throw new Error(`refusing existing tenant PostgreSQL volume ${volume}`);
    const volumeArgs = ["volume", "create"];
    for (const [key, value] of Object.entries(volumeLabels)) volumeArgs.push("--label", `${key}=${value}`);
    volumeArgs.push(volume);
    const createdVolume = await this.context.runCommand("create owned tenant PostgreSQL volume", "docker", volumeArgs, {
      timeoutMs: 30_000, logName: `m3-data-postgres-volume-create-${String(this.sequence).padStart(2, "0")}.log`,
    });
    if (createdVolume.code !== 0 || createdVolume.stdout.trim() !== volume) throw new Error(`failed to create owned tenant PostgreSQL volume ${volume}`);
    const resource = { containerId: null, name, volume, labels, volumeLabels };
    this.resources.push(resource);
    const args = ["run", "--detach", "--name", name, "--network", "none", "--env-file", environmentPath,
      "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m", "--mount", `type=volume,source=${volume},target=/var/lib/postgresql`];
    for (const [key, value] of Object.entries(labels)) args.push("--label", `${key}=${value}`);
    args.push(this.image);
    const started = await this.context.runCommand(`start owned tenant PostgreSQL ${short}`, "docker", args, {
      timeoutMs: 120_000,
      logName: `m3-data-postgres-start-${String(this.sequence).padStart(2, "0")}.log`,
    });
    if (started.code !== 0 || !CONTAINER_ID.test(started.stdout.trim())) throw new Error("owned tenant PostgreSQL did not start");
    const containerId = started.stdout.trim();
    resource.containerId = containerId;
    this.adminPasswords.set(containerId, password);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const ready = await this.context.runCommand(`probe owned tenant PostgreSQL ${short}`, "docker", [
        "exec", containerId, "pg_isready", "--username", "postgres", "--dbname", "postgres",
      ], {
        timeoutMs: 5_000,
        logName: `m3-data-postgres-ready-${String(this.sequence).padStart(2, "0")}-${attempt + 1}.log`,
      });
      if (ready.code === 0) {
        const authenticated = await this.context.runCommand(`authenticate owned tenant PostgreSQL ${short}`, "docker", [
          "exec", "--env", "PGPASSWORD", containerId, "psql", "--no-psqlrc", "--set", "ON_ERROR_STOP=1",
          "--host", "127.0.0.1", "--port", "5432", "--username", "postgres", "--dbname", "postgres",
          "--command", "SELECT 1;",
        ], {
          env: { ...process.env, PGPASSWORD: password },
          timeoutMs: 5_000,
          logName: `m3-data-postgres-authenticated-${String(this.sequence).padStart(2, "0")}-${attempt + 1}.log`,
        });
        if (authenticated.code === 0) break;
      }
      if (attempt === 59) throw new Error("owned tenant PostgreSQL did not become ready");
      await this.context.delay(250);
    }
    const target = {
      tenant_database_id: database.id,
      database_generation: database.generation,
      recovery_id: recoveryId,
      container_id: containerId,
      restore_target: restore,
      endpoint_ipv4: `10.231.${this.sequence}.2`,
      endpoint_ipv6: `fd42:686f:7374:${this.sequence.toString(16)}::2`,
    };
    this.targets.push(target);
    this.writeInventory();
    return target;
  }

  async inspectRows(target, label) {
    const databaseName = this.databaseName(target);
    const sql = "SELECT json_build_object('authors',(SELECT json_agg(row_to_json(a) ORDER BY id) FROM app.authors a),'entries',(SELECT json_agg(row_to_json(e) ORDER BY id) FROM app.entries e),'foreign_keys',(SELECT count(*)::int FROM pg_constraint WHERE contype='f' AND convalidated),'unvalidated',(SELECT count(*)::int FROM pg_constraint WHERE contype='f' AND NOT convalidated));";
    const result = await this.query(target, label, sql, { databaseName });
    if (result.code !== 0) throw new Error(`${label} failed`);
    return JSON.parse(result.stdout.trim());
  }

  databaseName(target) {
    return target.restore_target
      ? `hdr_${target.recovery_id.replaceAll("-", "")}`
      : `hdb_${target.tenant_database_id.replaceAll("-", "")}`;
  }

  adminPassword(target) {
    const password = this.adminPasswords.get(target?.container_id ?? target?.containerId);
    if (typeof password !== "string" || password.length === 0) throw new Error("owned tenant PostgreSQL admin credential is unavailable");
    return password;
  }

  async query(target, label, sql, {
    databaseName = this.databaseName(target), user = "postgres", password = this.adminPassword(target),
    allowFailure = false, timeoutMs = 30_000,
  } = {}) {
    const args = ["exec"];
    if (password !== null) args.push("--env", "PGPASSWORD");
    args.push(target.container_id, "psql", "--no-psqlrc", "--tuples-only", "--no-align", "--set", "ON_ERROR_STOP=1");
    if (password !== null) args.push("--host", "127.0.0.1", "--port", "5432");
    args.push("--username", user, "--dbname", databaseName, "--command", sql);
    return this.context.runCommand(label, "docker", args, {
      env: password === null ? process.env : { ...process.env, PGPASSWORD: password },
      allowFailure, timeoutMs,
      logName: `${label.replaceAll(/[^a-z0-9]+/gi, "-").toLowerCase()}.log`,
    });
  }

  async queryJson(target, label, sql, options = {}) {
    const result = await this.query(target, label, sql, options);
    if (result.code !== 0) throw new Error(`${label} failed`);
    try { return JSON.parse(result.stdout.trim()); } catch { throw new Error(`${label} did not return JSON`); }
  }

  spawnPsql(target, label, sql, databaseName = "postgres") {
    if (!this.targets.some((item) => item.container_id === target?.container_id)) {
      throw new Error(`${label} refused a PostgreSQL target outside this owned fixture`);
    }
    if (!/^[a-z0-9_]+$/.test(databaseName)) throw new Error("unsafe E2E database name");
    return this.context.spawnManaged(
      `M3 tenant PostgreSQL ${label}`,
      "docker",
      [
        "exec", "--env", "PGPASSWORD", target.container_id, "psql", "--no-psqlrc", "--set", "ON_ERROR_STOP=1",
        "--host", "127.0.0.1", "--port", "5432", "--username", "postgres", "--dbname", databaseName, "--command", sql,
      ],
      { env: { ...process.env, PGPASSWORD: this.adminPassword(target) } },
      `${label.replaceAll(/[^a-z0-9]+/gi, "-").toLowerCase()}.log`,
    );
  }

  async inspectNetwork(target, label) {
    const result = await this.context.runCommand(label, "docker", ["inspect", target.container_id], {
      timeoutMs: 15_000,
      logName: `${label.replaceAll(/[^a-z0-9]+/gi, "-").toLowerCase()}.log`,
    });
    if (result.code !== 0) throw new Error(`${label} failed`);
    let record;
    try { record = JSON.parse(result.stdout)?.[0]; } catch { record = null; }
    if (!record || record.Id !== target.container_id) throw new Error(`${label} returned an unexpected container`);
    return {
      networkMode: record.HostConfig?.NetworkMode,
      networks: record.NetworkSettings?.Networks ?? {},
      labels: record.Config?.Labels ?? {},
    };
  }

  async inspectAccess(target, roles, label) {
    const roleNames = [
      `ha_${roles.runtime.replaceAll("-", "")}`,
      `hm_${roles.migration.replaceAll("-", "")}`,
      `hb_${roles.backup.replaceAll("-", "")}`,
    ];
    const runtime = sqlString(roleNames[0]);
    const migration = sqlString(roleNames[1]);
    const backup = sqlString(roleNames[2]);
    const migrationName = sqlString(roleNames[1]);
    const roleList = roleNames.map(sqlString).join(",");
    const databaseName = this.databaseName(target);
    const database = sqlString(databaseName);
    const sql = `SELECT json_build_object(
      'database',(SELECT json_build_object(
        'name',d.datname,'owner',pg_get_userbyid(d.datdba),'connection_limit',d.datconnlimit,
        'public_connect',EXISTS(SELECT 1 FROM aclexplode(COALESCE(d.datacl,acldefault('d',d.datdba))) a WHERE a.grantee=0 AND a.privilege_type='CONNECT'),
        'runtime_connect',has_database_privilege(${runtime},d.datname,'CONNECT'),
        'migration_connect',has_database_privilege(${migration},d.datname,'CONNECT'),
        'backup_connect',has_database_privilege(${backup},d.datname,'CONNECT')) FROM pg_database d WHERE d.datname=${database}),
      'roles',(SELECT COALESCE(json_agg(json_build_object(
        'name',r.rolname,'login',r.rolcanlogin,'superuser',r.rolsuper,'createdb',r.rolcreatedb,
        'createrole',r.rolcreaterole,'replication',r.rolreplication,'bypass_rls',r.rolbypassrls,
        'inherit',r.rolinherit,'connection_limit',r.rolconnlimit) ORDER BY r.rolname),'[]'::json)
        FROM pg_roles r WHERE r.rolname IN (${roleList})),
      'app',(SELECT json_build_object(
        'schema_owner',pg_get_userbyid(n.nspowner),
        'runtime_usage',has_schema_privilege(${runtime},'app','USAGE'),
        'runtime_create',has_schema_privilege(${runtime},'app','CREATE'),
        'runtime_select_authors',has_table_privilege(${runtime},'app.authors','SELECT'),
        'runtime_insert_authors',has_table_privilege(${runtime},'app.authors','INSERT'),
        'runtime_update_authors',has_table_privilege(${runtime},'app.authors','UPDATE'),
        'runtime_delete_authors',has_table_privilege(${runtime},'app.authors','DELETE'),
        'runtime_select_entries',has_table_privilege(${runtime},'app.entries','SELECT'),
        'runtime_insert_entries',has_table_privilege(${runtime},'app.entries','INSERT'),
        'runtime_update_entries',has_table_privilege(${runtime},'app.entries','UPDATE'),
        'runtime_delete_entries',has_table_privilege(${runtime},'app.entries','DELETE'),
        'backup_usage',has_schema_privilege(${backup},'app','USAGE'),
        'backup_select_authors',has_table_privilege(${backup},'app.authors','SELECT'),
        'backup_insert_authors',has_table_privilege(${backup},'app.authors','INSERT'),
        'migration_owner_relations',(SELECT count(*)::int FROM pg_class c JOIN pg_namespace cn ON cn.oid=c.relnamespace WHERE cn.nspname='app' AND pg_get_userbyid(c.relowner)=${migrationName}),
        'non_migration_owner_relations',(SELECT count(*)::int FROM pg_class c JOIN pg_namespace cn ON cn.oid=c.relnamespace WHERE cn.nspname='app' AND pg_get_userbyid(c.relowner) <> ${migrationName})
      ) FROM pg_namespace n WHERE n.nspname='app'),
      'control',(SELECT json_build_object(
        'runtime_schema_usage',has_schema_privilege(${runtime},'hostlet_control','USAGE'),
        'runtime_identity_select',has_table_privilege(${runtime},'hostlet_control.database_identity','SELECT'),
        'migration_schema_usage',has_schema_privilege(${migration},'hostlet_control','USAGE'),
        'backup_schema_usage',has_schema_privilege(${backup},'hostlet_control','USAGE')));`;
    const result = await this.queryJson(target, label, sql, { databaseName });
    const expectedNames = new Set(roleNames);
    if (!Array.isArray(result.roles) || result.roles.length !== expectedNames.size ||
        result.roles.some((role) => !expectedNames.has(role.name))) {
      throw new Error(`${label} did not observe the exact application role set`);
    }
    return result;
  }

  async cleanup() {
    if (this.closed) return;
    this.closed = true;
    for (const resource of [...this.resources].reverse()) {
      if (resource.containerId) {
        const inspected = await this.context.runCommand("verify tenant PostgreSQL cleanup ownership", "docker", ["inspect", resource.containerId], { cleanup: true, timeoutMs: 15_000, logName: `m3-data-cleanup-inspect-${resource.name}.log` });
        let record;
        try { record = JSON.parse(inspected.stdout)?.[0]; } catch { record = null; }
        if (inspected.code !== 0 || record?.Id !== resource.containerId || record?.HostConfig?.NetworkMode !== "none" ||
            Object.entries(resource.labels).some(([key, value]) => record?.Config?.Labels?.[key] !== value)) {
          throw new Error(`refusing cleanup of unverified tenant PostgreSQL ${resource.name}`);
        }
        const removed = await this.context.runCommand("remove owned tenant PostgreSQL", "docker", ["rm", "--force", resource.containerId], { cleanup: true, timeoutMs: 30_000, logName: `m3-data-cleanup-container-${resource.name}.log` });
        if (removed.code !== 0) throw new Error(`failed to remove owned tenant PostgreSQL ${resource.name}`);
        this.adminPasswords.delete(resource.containerId);
        const containerAbsent = await this.context.runCommand("verify owned tenant PostgreSQL removal", "docker", ["ps", "--all", "--filter", `id=${resource.containerId}`, "--format", "{{.ID}}"], { cleanup: true, timeoutMs: 15_000, logName: `m3-data-cleanup-container-absent-${resource.name}.log` });
        if (containerAbsent.code !== 0 || containerAbsent.stdout.trim() !== "") throw new Error(`owned tenant PostgreSQL remains after cleanup ${resource.name}`);
      }
      const volumeInspected = await this.context.runCommand("verify tenant PostgreSQL volume cleanup ownership", "docker", ["volume", "inspect", resource.volume], {
        cleanup: true, timeoutMs: 15_000, logName: `m3-data-cleanup-volume-inspect-${resource.name}.log`,
      });
      let volumeRecord;
      try { volumeRecord = JSON.parse(volumeInspected.stdout)?.[0]; } catch { volumeRecord = null; }
      if (volumeInspected.code !== 0 || volumeRecord?.Name !== resource.volume ||
          Object.entries(resource.volumeLabels).some(([key, value]) => volumeRecord?.Labels?.[key] !== value)) {
        throw new Error(`refusing cleanup of unverified tenant PostgreSQL volume ${resource.volume}`);
      }
      const volume = await this.context.runCommand("remove owned tenant PostgreSQL volume", "docker", ["volume", "rm", resource.volume], { cleanup: true, timeoutMs: 30_000, logName: `m3-data-cleanup-volume-${resource.name}.log` });
      if (volume.code !== 0) throw new Error(`failed to remove owned tenant PostgreSQL volume ${resource.volume}`);
      const volumeAbsent = await this.context.runCommand("verify owned tenant PostgreSQL volume removal", "docker", ["volume", "ls", "--filter", `name=^${resource.volume}$`, "--format", "{{.Name}}"], {
        cleanup: true, timeoutMs: 15_000, logName: `m3-data-cleanup-volume-absent-${resource.name}.log`,
      });
      if (volumeAbsent.code !== 0 || volumeAbsent.stdout.trim() !== "") throw new Error(`owned tenant PostgreSQL volume remains after cleanup ${resource.volume}`);
    }
  }

  async withEndpointsPaused(run) {
    if (typeof run !== "function") throw new Error("paused endpoint boundary requires a callback");
    const verified = [];
    for (const resource of this.resources) {
      const result = await this.context.runCommand("verify owned tenant PostgreSQL pause target", "docker", ["inspect", resource.containerId], {
        timeoutMs: 15_000, logName: `m3-data-pause-inspect-${resource.name}.log`,
      });
      if (result.code !== 0) throw new Error(`could not inspect owned pause target ${resource.name}`);
      const records = JSON.parse(result.stdout);
      const record = records.length === 1 ? records[0] : null;
      const labels = record?.Config?.Labels ?? {};
      if (record?.Id !== resource.containerId || record?.HostConfig?.NetworkMode !== "none" || record?.State?.Running !== true ||
          Object.entries(resource.labels).some(([key, value]) => labels[key] !== value)) {
        throw new Error(`refusing to pause unverified tenant PostgreSQL ${resource.name}`);
      }
      verified.push(resource);
    }
    const paused = [];
    try {
      for (const resource of verified) {
        const result = await this.context.runCommand("pause owned tenant PostgreSQL endpoint", "docker", ["pause", resource.containerId], {
          timeoutMs: 15_000, logName: `m3-data-pause-${resource.name}.log`,
        });
        if (result.code !== 0) throw new Error(`failed to pause owned tenant PostgreSQL ${resource.name}`);
        paused.push(resource);
      }
      return await run();
    } finally {
      const failures = [];
      for (const resource of [...paused].reverse()) {
        const resumed = await this.context.runCommand("resume owned tenant PostgreSQL endpoint", "docker", ["unpause", resource.containerId], {
          cleanup: true, timeoutMs: 15_000, logName: `m3-data-unpause-${resource.name}.log`,
        });
        if (resumed.code !== 0) { failures.push(`${resource.name}:unpause`); continue; }
        let ready = false;
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const probe = await this.context.runCommand("verify resumed tenant PostgreSQL endpoint", "docker", [
            "exec", "--env", "PGPASSWORD", resource.containerId, "pg_isready", "--host", "127.0.0.1", "--port", "5432",
            "--username", "postgres", "--dbname", "postgres",
          ], {
            env: { ...process.env, PGPASSWORD: this.adminPassword(resource) },
            cleanup: true, timeoutMs: 5_000, logName: `m3-data-unpause-ready-${resource.name}-${attempt + 1}.log`,
          });
          if (probe.code === 0) { ready = true; break; }
          await this.context.delay(250);
        }
        if (!ready) failures.push(`${resource.name}:readiness`);
      }
      if (failures.length > 0) throw new Error(`owned tenant PostgreSQL resume failed: ${failures.join(",")}`);
    }
  }
}

export function registerM3DataFixtures(context) {
  context.registerFixture("M3 tenant PostgreSQL scenario module", "e2e/scenarios/m3-data.mjs");
  context.registerFixture("M3 tenant fixture bootstrap", "scripts/database/fixture-bootstrap.sql");
  context.registerFixture("M3 tenant additive migration", "scripts/database/fixture-migration-v2.sql");
  context.registerFixture("M3 PostgreSQL image pin", "e2e/postgres-image.txt");
  return Object.freeze({
    schemaVersion: 1,
    workerBinary: "target/debug/hostlet-database",
    inventory: "HOSTLET_M3_STATE_DIR/database-inventory.json",
    archiveFormat: "hostlet.tenant-backup/v1",
  });
}

export function createM3DataStage(m3, { mainProject } = {}) {
  if (!m3?.context || !m3?.policyClock || !m3?.roleInternal) throw new Error("M3 data stage requires the shared M3 context");
  const context = m3.context;
  const workerBinary = join(context.repo, "target", "debug", "hostlet-database");
  const recoveryKey = randomBytes(32).toString("base64");
  context.registerSensitiveValues([recoveryKey]);
  const bootstrapBytes = readFileSync(join(context.repo, "scripts", "database", "fixture-bootstrap.sql"));
  const bootstrapDigest = `sha256:${createHash("sha256").update(bootstrapBytes).digest("hex")}`;
  const bootstrapHex = bootstrapDigest.slice(7);
  const bootstrapDirectory = join(m3.policyClock.stateDir, "database-fixtures", "sha256", bootstrapHex.slice(0, 2));
  const bootstrapPath = join(bootstrapDirectory, `${bootstrapHex.slice(2)}.sql`);
  mkdirSync(bootstrapDirectory, { recursive: true, mode: 0o700 });
  chmodSync(join(m3.policyClock.stateDir, "database-fixtures"), 0o700);
  chmodSync(join(m3.policyClock.stateDir, "database-fixtures", "sha256"), 0o700);
  chmodSync(bootstrapDirectory, 0o700);
  writeFileSync(bootstrapPath, bootstrapBytes, { mode: 0o600, flag: "wx" });
  chmodSync(bootstrapPath, 0o600);
  context.state.configuration.m3TenantDatabaseBootstrap = {
    digest: bootstrapDigest,
    bytes: bootstrapBytes.length,
    boundary: "owned fixture provision lease with exact migration credential",
  };
  const owned = new OwnedTenantPostgres(m3);
  const projects = [];
  const databases = [];
  const integrations = {};
  let sequence = 0;

  m3.state.tenantPeers = new Map();
  m3.state.pendingRuntimeDatabaseProbes = [];

  function key(label) { sequence += 1; return `m3-data-${label}-${sequence}`; }
  function workerEnvironment({ fixtureBootstrap = false } = {}) {
    return m3.componentEnvironment("database", {
      HOSTLET_TENANT_RECOVERY_KEY: recoveryKey,
      HOSTLET_TENANT_RECOVERY_KEY_ID: "fixture-v1",
      ...(fixtureBootstrap ? { HOSTLET_M3_FIXTURE_BOOTSTRAP_SHA256: bootstrapDigest } : {}),
    });
  }

  async function runWorker(mode, label, { environment = {}, allowFailure = false, fixtureBootstrap = false, kinds = null } = {}) {
    if (kinds !== null && kinds !== undefined &&
        (!Array.isArray(kinds) || kinds.length === 0 ||
          kinds.some((kind) => typeof kind !== "string" || kind.length === 0) ||
          new Set(kinds).size !== kinds.length)) {
      throw new Error("database worker kind filters must be a nonempty array of unique nonempty strings");
    }
    const flag = mode === "scheduler" ? "--scheduler-once" : "--once";
    const kindFlags = kinds?.flatMap((kind) => ["--kind", kind]) ?? [];
    const result = await context.runCommand(`M3 database worker ${label}`, workerBinary, [
      "worker", "--control-url", m3.workerUrl, "--worker-id", DATABASE_WORKER_ID, flag, ...kindFlags,
    ], { env: { ...workerEnvironment({ fixtureBootstrap }), ...environment }, timeoutMs: 180_000, logName: `m3-data-worker-${String(++sequence).padStart(3, "0")}-${label}.log` });
    if (result.code !== 0 && !allowFailure) throw new Error(`database worker failed during ${label}`);
    return { code: result.code, events: parseWorkerEvents(result.stdout) };
  }

  async function pendingReplacementOperations() {
    return m3.postgres.psqlJson("m3-data-pending-replacement-targets", `SELECT COALESCE(json_agg(json_build_object(
      'database_id',tenant_database_id::text,'generation',database_generation::text,
      'replacement_id',COALESCE(spec->>'recovery_id',spec->>'migration_id')) ORDER BY created_at,id),'[]'::json)
      FROM tenant_database_operations WHERE state IN ('queued','retriable') AND kind IN ('restore_drill','migration_trial');`);
  }

  async function credentialMetadata(database) {
    return m3.postgres.psqlJson(`m3-data-runtime-credential-${database.id}`, `SELECT json_build_object(
      'database_ref',d.database_ref,'role_ref',c.role_ref,'credential_version_id',c.id::text)
      FROM tenant_databases d JOIN tenant_database_credentials c ON c.tenant_database_id=d.id AND c.database_generation=d.generation
      WHERE d.id=${sqlString(database.id)} AND c.purpose='runtime' AND c.status='active';`);
  }

  async function credentialRoles(database) {
    const rows = await m3.postgres.psqlJson(`m3-data-credential-roles-${database.id}`, `SELECT COALESCE(json_agg(json_build_object(
      'purpose',purpose,'role_ref',role_ref,'credential_version_id',id::text) ORDER BY purpose),'[]'::json)
      FROM tenant_database_credentials
      WHERE tenant_database_id=${sqlString(database.id)} AND database_generation=${sqlString(database.generation)} AND status='active';`);
    const byPurpose = Object.fromEntries(rows.map((row) => [row.purpose, row]));
    if (rows.length !== 3 || !["runtime", "migration", "backup"].every((purpose) => UUID.test(byPurpose[purpose]?.role_ref ?? "")) ||
        new Set(rows.map((row) => row.role_ref)).size !== 3) {
      throw new Error(`database ${database.id} does not expose one distinct active credential for each worker purpose`);
    }
    return Object.freeze({ runtime: byPurpose.runtime.role_ref, migration: byPurpose.migration.role_ref, backup: byPurpose.backup.role_ref, rows });
  }

  async function runtimeCredential(database, allocation) {
    if (!allocation?.id || !allocation?.generation || !allocation?.fence) throw new Error("runtime allocation identity is incomplete");
    const response = await m3.roleInternal("runtime", `/internal/v1/runtime/allocations/${allocation.id}/credentials`, {
      method: "POST", body: { generation: allocation.generation, fence: allocation.fence },
    });
    assertStatus(response, 200, "runtime scoped credential resolution for database boundary");
    const value = response.payload?.value;
    if (typeof value !== "string") throw new Error("runtime database credential response is malformed");
    context.registerSensitiveValues([value]);
    let parsed;
    try { parsed = JSON.parse(value); } catch { throw new Error("runtime database credential plaintext is malformed"); }
    const expectedDatabaseRef = database.peer?.databaseRef ?? (await credentialMetadata(database)).database_ref;
    if (parsed.database_ref !== expectedDatabaseRef || !UUID.test(parsed.role_ref ?? "") || typeof parsed.password !== "string" || parsed.password.length === 0) {
      throw new Error("runtime database credential is not bound to the expected tenant database");
    }
    context.registerSensitiveValues([parsed.password]);
    return Object.freeze({ roleRef: parsed.role_ref, password: parsed.password, credentialVersionId: response.payload.credential_id });
  }

  async function publishPeer(project, database, target, suffix = "primary") {
    const credential = await credentialMetadata(database);
    const peer = Object.freeze({
      containerId: target.container_id,
      runId: owned.runId,
      tenantDatabaseId: database.id,
      databaseGeneration: database.generation,
      restoreTarget: target.restore_target,
      endpointIpv4: target.endpoint_ipv4,
      endpointIpv6: target.endpoint_ipv6,
      gatewayIpv4: target.endpoint_ipv4.replace(/\.2$/, ".1"),
      gatewayIpv6: target.endpoint_ipv6.replace(/::2$/, "::1"),
      labels: Object.freeze({
        "hostlet.e2e.run": owned.runId,
        "hostlet.e2e.owner": "m3-data-stage",
        "hostlet.m3.database": database.id,
        "hostlet.m3.generation": database.generation,
        "hostlet.m3.restore": String(target.restore_target),
      }),
      ipv4: target.endpoint_ipv4,
      ipv6: target.endpoint_ipv6,
      port: 5432,
      databaseRef: credential.database_ref,
      roleRef: credential.role_ref,
      databaseName: target.restore_target
        ? `hdr_${target.recovery_id.replaceAll("-", "")}`
        : `hdb_${database.id.replaceAll("-", "")}`,
      roleName: `ha_${credential.role_ref.replaceAll("-", "")}`,
      credentialVersionId: credential.credential_version_id,
    });
    m3.state.tenantPeers.set(suffix === "primary" ? project.projectId : `${project.projectId}:${suffix}`, peer);
    return peer;
  }

  async function syncReplacementTargets() {
    const pending = await pendingReplacementOperations();
    for (const item of pending) {
      if (!UUID.test(item.replacement_id ?? "")) throw new Error("replacement operation omitted its owned identity");
      const database = databases.find((candidate) => candidate.record.id === item.database_id)?.record;
      const project = databases.find((candidate) => candidate.record.id === item.database_id)?.project;
      if (!database || !project) throw new Error("replacement operation targeted an unknown tenant database");
      const target = await owned.create(database, { recoveryId: item.replacement_id });
      await publishPeer(project, database, target, `replacement:${item.replacement_id}`);
    }
  }

  async function expectedFailureEvidence(expectedFailure, label) {
    return m3.postgres.psqlJson(label, `SELECT json_build_object(
      'count',count(*)::int,
      'operation_id',(array_agg(id::text ORDER BY created_at,id))[1],
      'kind',(array_agg(kind ORDER BY created_at,id))[1],
      'operation_key',(array_agg(operation_key ORDER BY created_at,id))[1],
      'tenant_database_id',(array_agg(tenant_database_id::text ORDER BY created_at,id))[1],
      'database_generation',(array_agg(database_generation::text ORDER BY created_at,id))[1],
      'state',(array_agg(state ORDER BY created_at,id))[1],
      'result_code',(array_agg(result->>'code' ORDER BY created_at,id))[1],
      'attempt_count',(array_agg(attempt_count ORDER BY created_at,id))[1]
    ) FROM tenant_database_operations
      WHERE kind=${sqlString(expectedFailure.kind)} AND operation_key=${sqlString(expectedFailure.migrationId)};`);
  }

  async function drain(label, { fixtureBootstrap = false, expectedFailure = null, kinds = null } = {}) {
    if (kinds !== null && kinds !== undefined &&
        (!Array.isArray(kinds) || kinds.length === 0 ||
          kinds.some((kind) => typeof kind !== "string" || kind.length === 0) ||
          new Set(kinds).size !== kinds.length)) {
      throw new Error("database worker kind filters must be a nonempty array of unique nonempty strings");
    }
    if (expectedFailure && kinds && !kinds.includes(expectedFailure.kind)) {
      throw new Error("database worker kind filters exclude the exact expected failure kind");
    }
    if (expectedFailure !== null) {
      if (!expectedFailure || expectedFailure.kind !== "migration_trial" || !UUID.test(expectedFailure.migrationId ?? "") ||
          typeof expectedFailure.code !== "string" || expectedFailure.code.length === 0) {
        throw new Error("expected database worker failure requires migration_trial, an exact migration ID, and a stable failure code");
      }
    }
    const completed = [];
    for (let attempt = 0; attempt < MAX_DRAIN_OPERATIONS; attempt += 1) {
      await runWorker("scheduler", `${label}-scheduler-${attempt + 1}`, { kinds });
      await syncReplacementTargets();
      const beforeExpectedFailure = expectedFailure
        ? await expectedFailureEvidence(expectedFailure, `${label}-expected-failure-before-${attempt + 1}`)
        : null;
      if (expectedFailure && (beforeExpectedFailure.count !== 1 || !UUID.test(beforeExpectedFailure.operation_id ?? "") ||
          beforeExpectedFailure.kind !== expectedFailure.kind || beforeExpectedFailure.operation_key !== expectedFailure.migrationId ||
          !["queued", "retriable"].includes(beforeExpectedFailure.state))) {
        throw new Error(`${label} expected failure did not identify one exact queued migration trial`);
      }
      const result = await runWorker("once", `${label}-operation-${attempt + 1}`, {
        fixtureBootstrap, allowFailure: expectedFailure !== null, kinds,
      });
      const { events } = result;
      const claimed = events.find((event) => event.event === "tenant_database_operation_claimed");
      if (expectedFailure) {
        if (claimed && claimed.operation_id !== beforeExpectedFailure.operation_id) {
          const unrelatedTerminal = events.find((event) => event.event === "tenant_database_operation_completed");
          if (result.code !== 0 || !unrelatedTerminal || unrelatedTerminal.operation_id !== claimed.operation_id) {
            throw new Error(`${label} encountered an unexpected nonzero or incomplete operation before the expected migration trial`);
          }
          completed.push({ claimed, terminal: unrelatedTerminal });
          continue;
        }
        const afterExpectedFailure = await expectedFailureEvidence(expectedFailure, `${label}-expected-failure-after-${attempt + 1}`);
        expectScenario(result.code !== 0 && claimed?.operation_id === beforeExpectedFailure.operation_id &&
          claimed?.kind === expectedFailure.kind && afterExpectedFailure.count === 1 &&
          afterExpectedFailure.operation_id === beforeExpectedFailure.operation_id &&
          afterExpectedFailure.kind === expectedFailure.kind &&
          afterExpectedFailure.operation_key === expectedFailure.migrationId &&
          afterExpectedFailure.state === "failed" && afterExpectedFailure.result_code === expectedFailure.code &&
          afterExpectedFailure.attempt_count === 1,
        `${label} records the exact expected terminal database worker failure`, {
          worker_exit_code: result.code, claimed, before: beforeExpectedFailure, after: afterExpectedFailure,
        });
        return Object.freeze({
          completed,
          expectedFailure: Object.freeze({
            operationId: afterExpectedFailure.operation_id,
            kind: afterExpectedFailure.kind,
            operationKey: afterExpectedFailure.operation_key,
            migrationId: expectedFailure.migrationId,
            state: afterExpectedFailure.state,
            code: afterExpectedFailure.result_code,
            attemptCount: afterExpectedFailure.attempt_count,
            workerExitCode: result.code,
            claimed,
            evidence: afterExpectedFailure,
          }),
        });
      }
      if (!claimed) return completed;
      const terminal = events.find((event) => event.event === "tenant_database_operation_completed");
      if (!terminal || terminal.operation_id !== claimed.operation_id) throw new Error("database worker omitted its completion receipt");
      completed.push({ claimed, terminal });
    }
    throw new Error("database worker drain exceeded its bounded operation limit");
  }

  async function ensureAllowance() {
    const current = await m3.ownerHTTP("/v1/entitlements/current");
    assertStatus(current, 200, "M3 data current entitlement");
    const entitlement = current.payload.entitlement ?? current.payload;
    const fixtureEntitlement = await m3.postgres.psqlJson("m3-data-existing-entitlement", `SELECT json_build_object(
      'capacity_pool_key',capacity_pool_key,'hosted_slot_limit',hosted_slot_limit,'build_seconds_limit',build_seconds_limit,
      'period_starts_at',period_starts_at,'period_ends_at',period_ends_at)
      FROM admission_entitlements WHERE account_id=${sqlString(m3.state.owner.record.id)};`);
    if (!fixtureEntitlement?.capacity_pool_key) throw new Error("M3 data shared entitlement fixture is missing");
    const poolKey = fixtureEntitlement.capacity_pool_key;
    const periodStart = fixtureEntitlement.period_starts_at;
    const periodEnd = fixtureEntitlement.period_ends_at;
    const existingCapacity = await m3.postgres.psqlJson("m3-data-existing-capacity", `SELECT json_build_object(
      'hosted_slot_limit',hosted_slot_limit,'rollout_headroom_limit',rollout_headroom_limit,'profile',profile)
      FROM admission_capacity_pools WHERE pool_key=${sqlString(poolKey)};`);
    if (!existingCapacity) throw new Error("M3 data shared capacity pool is missing");
    const reconciled = await m3.callInternal("/internal/v1/admission/reconcile", { method: "POST", body: {} });
    assertStatus(reconciled, 200, "M3 data admission hold reconciliation");
    if (!Number.isInteger(reconciled.payload?.expired_holds) || reconciled.payload.expired_holds < 0) {
      throw new Error("M3 data admission hold reconciliation returned an invalid safe count");
    }
    const durableUse = await m3.postgres.psqlJson("m3-data-existing-capacity-use", `SELECT json_build_object(
      'account_slots',(
        (SELECT count(*) FROM slot_reservations WHERE account_id=${sqlString(m3.state.owner.record.id)} AND state<>'released') +
        (SELECT count(*) FROM capacity_holds WHERE account_id=${sqlString(m3.state.owner.record.id)} AND kind='initial' AND state='active')
      )::int,
      'pool_slots',(
        (SELECT count(*) FROM slot_reservations WHERE capacity_pool_key=${sqlString(poolKey)} AND state<>'released') +
        (SELECT count(*) FROM capacity_holds WHERE capacity_pool_key=${sqlString(poolKey)} AND kind='initial' AND state='active')
      )::int
    );`);
    if (!Number.isInteger(durableUse?.account_slots) || durableUse.account_slots < 0 ||
        !Number.isInteger(durableUse?.pool_slots) || durableUse.pool_slots < 0) {
      throw new Error("M3 data shared capacity fixture lacks valid durable hosted-slot use counts");
    }
    const hostedSlotLimit = Math.max(5, fixtureEntitlement.hosted_slot_limit, entitlement.hosted_slot_limit ?? 0, durableUse.account_slots + 1);
    const poolHostedSlotLimit = Math.max(5, existingCapacity.hosted_slot_limit, durableUse.pool_slots + 1);
    const capacity = await m3.callInternal("/internal/v1/admission/capacity", { method: "POST", body: {
      event_id: randomUUID(), pool_key: poolKey, profile: existingCapacity.profile,
      hosted_slot_limit: poolHostedSlotLimit,
      rollout_headroom_limit: Math.max(2, existingCapacity.rollout_headroom_limit),
    }});
    assertStatus(capacity, 200, "M3 data shared capacity allowance");
    const updated = await m3.callInternal("/internal/v1/admission/entitlements", { method: "POST", body: {
      event_id: randomUUID(), account_id: m3.state.owner.record.id, capacity_pool_key: poolKey,
      hosted_slot_limit: hostedSlotLimit,
      build_seconds_limit: Math.max(3600, fixtureEntitlement.build_seconds_limit, entitlement.build_seconds_limit ?? 0),
      period_starts_at: periodStart, period_ends_at: periodEnd, state: "active",
    }});
    assertStatus(updated, 200, "M3 data shared owner allowance");
    return poolKey;
  }

  async function createIsolationProject() {
    await ensureAllowance();
    const source = m3.fixtureCatalog.commits.fullstack_v1;
    const created = await m3.ownerHTTP("/v1/projects", {
      method: "POST", headers: { "Idempotency-Key": key("isolation-project") },
      body: { name: "M3 owned database isolation peer", configuration: m3.fixtureCatalog.standardProjectConfiguration },
    });
    assertStatus(created, 201, "M3 data isolation project creation");
    const deployment = await m3.ownerHTTP(`/v1/projects/${created.payload.project.id}/deployment-intents`, {
      method: "POST", headers: mutationHeaders(key("isolation-deployment"), created.payload.project.revision),
      body: { configuration_revision_id: created.payload.configuration.id, source_commit: source.commitSha },
    });
    assertStatus(deployment, 201, "M3 data isolation deployment intent");
    const proof = await m3.callInternal("/internal/v1/admission/source-proofs", { method: "POST", body: {
      event_id: randomUUID(), account_id: m3.state.owner.record.id, project_id: created.payload.project.id,
      deployment_id: deployment.payload.id, configuration_revision_id: created.payload.configuration.id,
      source_commit: source.commitSha, inventory_revision: 1,
      expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    }});
    assertStatus(proof, 200, "M3 data isolation exact-source proof");
    const proofRecord = proof.payload.proof ?? proof.payload;
    let graph = (await m3.ownerHTTP(`/v1/projects/${created.payload.project.id}`)).payload;
    const capacity = await m3.postgres.psqlJson("m3-data-isolation-capacity-boundary", `SELECT json_build_object(
      'pool_key',p.pool_key,'profile',p.profile,'hosted_slot_limit',p.hosted_slot_limit,'rollout_headroom_limit',p.rollout_headroom_limit)
      FROM admission_capacity_pools p JOIN admission_entitlements e ON e.capacity_pool_key=p.pool_key
      WHERE e.account_id=${sqlString(m3.state.owner.record.id)};`);
    const usedSlots = await m3.postgres.psqlJson("m3-data-isolation-capacity-use", `SELECT (
      (SELECT count(*) FROM slot_reservations WHERE capacity_pool_key=${sqlString(capacity?.pool_key ?? "")} AND state<>'released') +
      (SELECT count(*) FROM capacity_holds WHERE capacity_pool_key=${sqlString(capacity?.pool_key ?? "")} AND kind='initial' AND state='active')
    )::int;`);
    if (!capacity?.pool_key || !Number.isInteger(usedSlots) || usedSlots < 0 || usedSlots > capacity.hosted_slot_limit) {
      throw new Error("M3 data isolation capacity boundary lacks a valid durable hosted-slot use count");
    }
    const exhausted = await m3.callInternal("/internal/v1/admission/capacity", { method: "POST", body: {
      event_id: randomUUID(), pool_key: capacity.pool_key, profile: capacity.profile,
      hosted_slot_limit: usedSlots, rollout_headroom_limit: capacity.rollout_headroom_limit,
    }});
    assertStatus(exhausted, 200, "M3 data isolation exhausted hosted capacity fixture");
    try {
      const deniedHold = await m3.ownerHTTP(`/v1/projects/${created.payload.project.id}/deployments/${deployment.payload.id}/capacity-holds`, {
        method: "POST", headers: mutationHeaders(key("isolation-capacity-negative"), graph.project.revision),
        body: { source_proof_id: proofRecord.id, ttl_seconds: 5 },
      });
      assertCode(deniedHold, 409, "platform_capacity_exhausted", "M3 data isolation capacity exhaustion denial");
    } finally {
      const restored = await m3.callInternal("/internal/v1/admission/capacity", { method: "POST", body: {
        event_id: randomUUID(), pool_key: capacity.pool_key, profile: capacity.profile,
        hosted_slot_limit: capacity.hosted_slot_limit, rollout_headroom_limit: capacity.rollout_headroom_limit,
      }});
      assertStatus(restored, 200, "M3 data isolation restore capacity fixture");
    }
    const hold = await m3.ownerHTTP(`/v1/projects/${created.payload.project.id}/deployments/${deployment.payload.id}/capacity-holds`, {
      method: "POST", headers: mutationHeaders(key("isolation-hold"), graph.project.revision),
      body: { source_proof_id: proofRecord.id, ttl_seconds: 120 },
    });
    assertStatus(hold, 201, "M3 data isolation capacity hold");
    graph = (await m3.ownerHTTP(`/v1/projects/${created.payload.project.id}`)).payload;
    const admission = await m3.ownerHTTP(`/v1/projects/${created.payload.project.id}/deployments/${deployment.payload.id}/admissions`, {
      method: "POST", headers: mutationHeaders(key("isolation-admission"), graph.project.revision),
      body: { capacity_hold_id: hold.payload.hold.id },
    });
    if (![200, 201].includes(admission.status)) {
      throw new Error(`M3 data isolation admission: HTTP ${admission.status} ${admission.payload?.error?.code ?? "unknown_error"}`);
    }
    graph = (await m3.ownerHTTP(`/v1/projects/${created.payload.project.id}`)).payload;
    const normalized = normalizeProject({ graph, deployment: deployment.payload, reservation: admission.payload.reservation });
    normalized.capacityBoundary = Object.freeze({ denied: true, code: "platform_capacity_exhausted", usedSlots });
    return normalized;
  }

  async function provisionProject(project, label) {
    const current = await m3.ownerHTTP(`/v1/projects/${project.projectId}`);
    assertStatus(current, 200, `${label} current project`);
    project.graph = current.payload;
    const path = `/v1/projects/${project.projectId}/deployments/${project.deploymentId}/tenant-databases`;
    const requestKey = key(`${label}-database`);
    const request = {
      method: "POST",
      headers: mutationHeaders(requestKey, project.graph.project.revision),
      body: {
        configuration_revision_id: project.configurationRevisionId,
        service_id: project.databaseService.id,
        reservation_id: project.reservation.id,
        reservation_epoch: project.reservation.reservation_epoch,
      },
    };
    const [left, right] = await Promise.all([m3.ownerHTTP(path, request), m3.ownerHTTP(path, request)]);
    assertStatusWithPublicError(left, 201, `${label} database intent`);
    assertStatusWithPublicError(right, 201, `${label} concurrent database replay`);
    expectScenario(left.payload.id === right.payload.id && left.payload.generation === right.payload.generation,
      `${label} concurrent provisioning creates one durable identity`, { left: left.payload.id, right: right.payload.id });
    const replay = await m3.ownerHTTP(path, {
      method: "POST", headers: mutationHeaders(requestKey, project.graph.project.revision), body: { ...request.body },
    });
    assertStatusWithPublicError(replay, 201, `${label} idempotent database replay`);
    expectScenario(replay.payload.id === left.payload.id && replay.payload.generation === left.payload.generation,
      `${label} repeated provisioning replay returns the original identity`, { replay: replay.payload.id, original: left.payload.id });
    const changedReplay = await m3.ownerHTTP(path, {
      method: "POST", headers: mutationHeaders(requestKey, project.graph.project.revision), body: { ...request.body, service_id: randomUUID() },
    });
    assertCode(changedReplay, 409, "idempotency_payload_changed", `${label} changed provisioning replay`);
    const target = await owned.create(left.payload);
    return { project, record: left.payload, target, replaySafe: true, changedReplayRejected: true };
  }

  async function provision() {
    try {
      const primary = normalizeProject(mainProject);
      const isolation = await createIsolationProject();
      projects.push(primary, isolation);
      const created = await Promise.all([
        provisionProject(primary, "primary"),
        provisionProject(isolation, "isolation"),
      ]);
      databases.push(...created);
      const provisioningCrashRecovery = await verifyProvisioningCrashRecovery();
      m3.state.m3DataProvisioningCrashRecovery = provisioningCrashRecovery;
      await drain("provision", { fixtureBootstrap: true });
      for (const database of databases) {
        const read = await m3.ownerHTTP(`/v1/projects/${database.project.projectId}/services/${database.project.databaseService.id}/tenant-database`);
        assertStatus(read, 200, "ready tenant database read");
        expectScenario(read.payload.state === "ready" && read.payload.application_connection_limit === 10 && read.payload.storage_limit_bytes === 1_073_741_824,
          "real worker publishes bounded ready tenant database", read.payload);
        database.record = read.payload;
        const bootstrap = await m3.postgres.psqlJson(`m3-data-bootstrap-proof-${database.record.id}`, `SELECT result->'proof' FROM tenant_database_operations
          WHERE tenant_database_id=${sqlString(database.record.id)} AND database_generation=${sqlString(database.record.generation)}
            AND kind='provision' AND state='succeeded';`);
        expectScenario(bootstrap?.fixture_bootstrap_sha256 === bootstrapDigest && bootstrap?.fixture_populated_rows === 4 &&
          bootstrap?.fixture_application_connection_verified === true,
        "provision fixture bootstrap is digest-bound and verified through the exact migration credential", bootstrap);
        database.bootstrap = Object.freeze({ digest: bootstrapDigest, populatedRows: bootstrap.fixture_populated_rows });
        database.peer = await publishPeer(database.project, database.record, database.target);
        database.rows = await owned.inspectRows(database.target, `m3-data-populated-${database.record.id}`);
      }
      const denied = await m3.call(`/v1/projects/${primary.projectId}/services/${primary.databaseService.id}/tenant-database`, { token: m3.state.other.token });
      assertCode(denied, 404, "not_found", "cross-owner tenant database read");
      m3.state.tenantDatabases = Object.freeze(databases);
      return Object.freeze({ projects, databases, tenantPeers: m3.state.tenantPeers, provisioningCrashRecovery });
    } catch (error) {
      if (context.state.configuration.scenarios?.includes("m3-journey")) {
        context.assertion("M3-DATA-01", "M3 tenant PostgreSQL lifecycle", PROVISIONING_EXPECTATION, safeObserved(error), false,
          error instanceof ScenarioExpectationError ? error.check : "tenant PostgreSQL provisioning setup failed");
      }
      throw error;
    }
  }

  async function provisioningLease(database, label) {
    const databaseId = sqlString(database.record.id);
    const generation = sqlString(database.record.generation);
    return m3.postgres.psqlJson(label, `SELECT COALESCE((SELECT json_build_object(
      'operation_id',o.id::text,
      'operation_count',(SELECT count(*)::int FROM tenant_database_operations same WHERE same.tenant_database_id=o.tenant_database_id AND same.database_generation=o.database_generation AND same.kind='provision'),
      'state',o.state,
      'attempt_count',o.attempt_count,
      'current_fence',o.current_fence,
      'attempt_id',o.current_attempt_id::text,
      'attempt_state',(SELECT a.state FROM tenant_database_operation_attempts a WHERE a.operation_id=o.id AND a.id=o.current_attempt_id AND a.fence=o.current_fence),
      'attempt_worker_id',(SELECT a.worker_id FROM tenant_database_operation_attempts a WHERE a.operation_id=o.id AND a.id=o.current_attempt_id AND a.fence=o.current_fence),
      'attempt_expired',COALESCE((SELECT a.lease_expires_at<=clock_timestamp() FROM tenant_database_operation_attempts a WHERE a.operation_id=o.id ORDER BY a.attempt_number DESC LIMIT 1),false),
      'lease_expires_at',o.lease_expires_at,
      'attempts',(SELECT count(*)::int FROM tenant_database_operation_attempts a WHERE a.operation_id=o.id),
      'expired_attempts',(SELECT count(*)::int FROM tenant_database_operation_attempts a WHERE a.operation_id=o.id AND a.state='expired'),
      'succeeded_attempts',(SELECT count(*)::int FROM tenant_database_operation_attempts a WHERE a.operation_id=o.id AND a.state='succeeded'),
      'result_code',o.result->>'code',
      'database_state',d.state,
      'database_ready',d.ready_at IS NOT NULL
    ) FROM tenant_database_operations o JOIN tenant_databases d ON d.id=o.tenant_database_id AND d.generation=o.database_generation
      WHERE o.tenant_database_id=${databaseId} AND o.database_generation=${generation} AND o.kind='provision'
      ORDER BY o.created_at,o.id LIMIT 1),'null'::json);`);
  }

  async function catalogLockState(target, label) {
    return owned.queryJson(target, label, `SELECT json_build_object(
      'holder_count',(SELECT count(*)::int FROM pg_locks WHERE relation='pg_catalog.pg_database'::regclass AND mode='ShareLock' AND granted),
      'holder_pid',(SELECT pid::int FROM pg_locks WHERE relation='pg_catalog.pg_database'::regclass AND mode='ShareLock' AND granted ORDER BY pid LIMIT 1),
      'waiting_count',(SELECT count(*)::int FROM pg_locks WHERE relation='pg_catalog.pg_database'::regclass AND mode='RowExclusiveLock' AND NOT granted),
      'waiting_activity_count',(SELECT count(*)::int FROM pg_stat_activity WHERE wait_event_type='Lock' AND pid<>pg_backend_pid())
    );`, { databaseName: "postgres" });
  }

  async function verifyProvisioningCrashRecovery() {
    if (databases.length !== 2) throw new Error("M3 provisioning crash recovery requires exactly two admitted database identities");
    const identities = databases.map(({ record }) => `${record.id}:${record.generation}`);
    const candidate = await m3.postgres.psqlJson("m3-data-provision-crash-candidate", `SELECT COALESCE((SELECT json_build_object(
      'operation_id',o.id::text,'database_id',o.tenant_database_id::text,'generation',o.database_generation::text)
      FROM tenant_database_operations o
      WHERE o.tenant_database_id IN (${databases.map(({ record }) => sqlString(record.id)).join(",")})
        AND o.kind='provision' AND o.state='queued'
      ORDER BY o.created_at,o.id LIMIT 1),'null'::json);`);
    if (!candidate?.operation_id || !UUID.test(candidate.database_id ?? "") || !UUID.test(candidate.generation ?? "")) {
      throw new Error("M3 provisioning crash recovery could not identify one exact queued provision operation");
    }
    const database = databases.find(({ record }) => record.id === candidate.database_id && record.generation === candidate.generation);
    if (!database) throw new Error("M3 provisioning crash recovery selected an unknown database identity");
    const crashWorkerId = `m3-database-provision-crash-${randomUUID().slice(0, 8)}`;
    const lock = owned.spawnPsql(
      database.target,
      "m3-data-provision-catalog-lock",
      "BEGIN; LOCK TABLE pg_catalog.pg_database IN SHARE MODE; SELECT pg_sleep(600);",
      "postgres",
    );
    let worker = null;
    let lockStopped = false;
    let workerStopped = false;
    try {
      let held;
      await context.withTimeout("M3 provisioning catalog lock acquisition", async () => {
        while (true) {
          held = await catalogLockState(database.target, "m3-data-provision-catalog-lock-state");
          if (held.holder_count === 1) return;
          await context.delay(100);
        }
      }, 15_000);
      worker = context.spawnManaged(
        "M3 provisioning crash worker",
        workerBinary,
        ["worker", "--control-url", m3.workerUrl, "--worker-id", crashWorkerId, "--once"],
        { env: workerEnvironment({ fixtureBootstrap: true }) },
        `m3-data-provision-crash-${crashWorkerId}.log`,
      );
      let running;
      await context.withTimeout("M3 provisioning crash lease claim", async () => {
        while (true) {
          running = await provisioningLease(database, "m3-data-provision-crash-lease");
          if (running?.operation_id === candidate.operation_id && running.state === "running" &&
              running.database_state === "provisioning" && running.database_ready === false &&
              running.attempt_id && running.attempt_worker_id === crashWorkerId &&
              running.attempt_state === "running" && Date.parse(running.lease_expires_at) > Date.now()) return;
          await context.delay(100);
        }
      }, 15_000);
      let blocked;
      await context.withTimeout("M3 provisioning catalog lock wait", async () => {
        while (true) {
          blocked = await catalogLockState(database.target, "m3-data-provision-catalog-blocked");
          if (blocked.holder_count === 1 && blocked.waiting_count >= 1) return;
          await context.delay(100);
        }
      }, 15_000);
      expectScenario(running.database_state === "provisioning" && running.database_ready === false &&
        running.attempt_state === "running" && blocked.holder_count === 1 && blocked.waiting_count >= 1,
      "a real provision worker is blocked behind an owned PostgreSQL catalog lock without publishing ready", {
        operation: running.operation_id, database_state: running.database_state, database_ready: running.database_ready,
        worker_id: running.attempt_worker_id, lease_expires_at: running.lease_expires_at,
        lock_holder_count: blocked.holder_count, lock_waiter_count: blocked.waiting_count,
      });
      if (!Number.isInteger(worker.child?.pid) || worker.child.exitCode !== null || worker.child.signalCode !== null) {
        throw new Error("M3 provisioning crash worker was not alive at the observed blocked lease boundary");
      }
      try {
        process.kill(-worker.child.pid, "SIGKILL");
      } catch (error) {
        throw new Error(`M3 provisioning crash worker process-group kill failed: ${error.message}`);
      }
      const crashed = await worker.exited;
      expectScenario(crashed.signal === "SIGKILL", "the owned provision worker process group is actually killed", {
        worker_id: crashWorkerId, exit_code: crashed.code, signal: crashed.signal,
      });
      await context.stopManaged(worker, "M3 provisioning crash worker killed after blocked lease");
      workerStopped = true;
      if (!Number.isInteger(blocked.holder_pid) || blocked.holder_pid <= 0) {
        throw new Error("M3 provisioning catalog lock did not expose one exact owned holder PID");
      }
      const terminated = await owned.queryJson(database.target, "m3-data-provision-catalog-lock-terminate", `SELECT json_build_object(
        'terminated',COALESCE((SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid=${blocked.holder_pid}),false)
      );`, { databaseName: "postgres" });
      expectScenario(terminated.terminated === true, "the owned provisioning catalog lock session is terminated after worker death", {
        holder_pid: blocked.holder_pid, terminated: terminated.terminated,
      });
      await context.stopManaged(lock, "M3 provisioning catalog lock released after worker death");
      lockStopped = true;
      let expired;
      await context.withTimeout("M3 provisioning lease expiry after worker death", async () => {
        while (true) {
          expired = await provisioningLease(database, "m3-data-provision-expired-lease");
          if (expired?.attempt_expired === true && expired.attempt_count === 1) return;
          await context.delay(100);
        }
      }, 20_000);
      expectScenario(expired.attempt_expired === true && expired.database_state === "provisioning" && expired.database_ready === false,
        "the killed provision lease expires before retry and keeps the database out of ready", {
          attempt_count: expired.attempt_count, attempt_state: expired.attempt_state,
          attempt_expired: expired.attempt_expired, database_state: expired.database_state,
          database_ready: expired.database_ready,
        });
      const retry = await runWorker("once", "m3-data-provision-crash-retry", { fixtureBootstrap: true });
      const claimed = retry.events.find((event) => event.event === "tenant_database_operation_claimed");
      const completed = retry.events.find((event) => event.event === "tenant_database_operation_completed");
      expectScenario(claimed?.operation_id === candidate.operation_id && completed?.operation_id === candidate.operation_id &&
        completed?.effect_id === candidate.operation_id && completed?.effect_created === true,
      "a fresh real worker reclaims the expired provision lease and commits one operation effect", {
        claimed, completed, retry_exit_code: retry.code,
      });
      const final = await provisioningLease(database, "m3-data-provision-crash-final");
      expectScenario(final.operation_id === candidate.operation_id && final.operation_count === 1 && final.state === "succeeded" &&
        final.database_state === "ready" && final.database_ready === true && final.attempt_count === 2 &&
        final.expired_attempts === 1 && final.succeeded_attempts === 1 && final.result_code === "database_ready" &&
        sameJson(identities, databases.map(({ record }) => `${record.id}:${record.generation}`)),
      "provision crash retry preserves both durable identities and produces one healthy ready database effect", {
        final, identities, current_identities: databases.map(({ record }) => `${record.id}:${record.generation}`),
      });
      return {
        databaseId: database.record.id,
        operationId: candidate.operation_id,
        crashWorkerId,
        lockObserved: true,
        blocked: true,
        killedSignal: crashed.signal,
        leaseExpired: true,
        retryClaimed: claimed.operation_id,
        attemptCount: final.attempt_count,
        expiredAttempts: final.expired_attempts,
        succeededAttempts: final.succeeded_attempts,
        effectCreated: completed.effect_created,
        identitiesPreserved: true,
      };
    } finally {
      if (worker && !workerStopped) {
        if (worker.child.exitCode === null && worker.child.signalCode === null && Number.isInteger(worker.child.pid)) {
          try { process.kill(-worker.child.pid, "SIGKILL"); } catch { /* the owned worker may have exited during failure cleanup */ }
        }
        await context.stopManaged(worker, "M3 provisioning crash worker failure cleanup");
      }
      if (!lockStopped) await context.stopManaged(lock, "M3 provisioning catalog lock failure cleanup");
    }
  }

  async function verifyPausedWorkerRecovery() {
    const beforeTargets = databases.map(({ target }) => target.container_id);
    const nextPolicyTime = new Date(Date.parse(m3.policyClock.current().now) + 86_400_000).toISOString();
    m3.policyClock.advance({ now: nextPolicyTime });
    const attempts = [];
    let failedOperation = null;
    await owned.withEndpointsPaused(async () => {
      await runWorker("scheduler", "paused-worker-scheduler");
      for (let attempt = 0; attempt < 8 && !failedOperation; attempt += 1) {
        const result = await runWorker("once", `paused-worker-crash-${attempt + 1}`, { allowFailure: true });
        attempts.push(result.code);
        failedOperation = await m3.postgres.psqlJson("m3-data-paused-worker-failure", `SELECT COALESCE((SELECT json_build_object(
          'id',id::text,'kind',kind,'state',state,'code',result->>'code')
          FROM tenant_database_operations WHERE policy_time=${sqlString(nextPolicyTime)}::timestamptz
            AND state IN ('failed','retriable') ORDER BY created_at DESC,id DESC LIMIT 1),'null'::json);`);
      }
    });
    expectScenario(Boolean(failedOperation?.id) && attempts.some((code) => code !== 0),
      "a paused tenant endpoint records a retriable or terminal operation without losing the owned database", { failedOperation, attempts });
    await drain("paused-worker-recovery");
    const ready = await m3.postgres.psqlJson("m3-data-paused-worker-ready", `SELECT json_build_object(
      'ready',(SELECT count(*)::int FROM tenant_databases WHERE id IN (${databases.map(({ record }) => sqlString(record.id)).join(",")}) AND state='ready'),
      'targets',(SELECT count(*)::int FROM tenant_databases WHERE id IN (${databases.map(({ record }) => sqlString(record.id)).join(",")}) AND state IN ('ready','recovery_attention')));`);
    expectScenario(ready.ready === databases.length && ready.targets === databases.length && sameJson(beforeTargets, databases.map(({ target }) => target.container_id)),
      "a fresh worker resumes after endpoint failure with the same durable targets", { ready, beforeTargets, afterTargets: databases.map(({ target }) => target.container_id), failedOperation });
    return { pausedEndpointFailureObserved: true, failureObserved: true, resumed: true, operation: failedOperation, attempts: attempts.length };
  }

  async function verifyProvisioning() {
    return dataStep(context, "M3-DATA-01",
      PROVISIONING_EXPECTATION,
      async () => {
        const provisioningCrashRecovery = m3.state.m3DataProvisioningCrashRecovery;
        expectScenario(provisioningCrashRecovery?.killedSignal === "SIGKILL" && provisioningCrashRecovery?.blocked === true &&
          provisioningCrashRecovery?.leaseExpired === true && provisioningCrashRecovery?.attemptCount === 2 &&
          provisioningCrashRecovery?.expiredAttempts === 1 && provisioningCrashRecovery?.succeededAttempts === 1 &&
          provisioningCrashRecovery?.effectCreated === true && provisioningCrashRecovery?.identitiesPreserved === true,
        "DATA01 includes an actual pre-provision worker crash, lease expiry, fresh retry, and one durable effect", provisioningCrashRecovery);
        const runtimeProbe = m3.state.runtimeDatabaseProbe ?? m3.state.runtime?.runtimeDatabaseProbe;
        if (typeof runtimeProbe !== "function") throw new Error("M3-DATA-01 requires the runtime database probe integration");
        const probes = [];
        for (const [index, database] of databases.entries()) {
          probes.push(await runtimeProbe({ artifactKey: "fullstack_v1", databasePeer: database.peer, expectedProjectId: database.project.projectId, mode: "read_write", index: 40 + index }));
        }
        expectScenario(probes.every((probe) => probe.readObserved && probe.writeObserved && /^sha256:[0-9a-f]{64}$/.test(probe.executorReceiptDigest ?? "")),
          "sandbox applications read and write only their exact tenant database", { probes });
        expectScenario(databases.length >= 2 && new Set(databases.map(({ record }) => record.id)).size === databases.length && new Set(databases.map(({ target }) => target.container_id)).size === databases.length,
          "tenant database identities and owned containers are distinct", { database_ids: databases.map(({ record }) => record.id) });
        const access = [];
        for (const [index, database] of databases.entries()) {
          const roles = await credentialRoles(database.record);
          const observed = await owned.inspectAccess(database.target, roles, `m3-data-access-${index + 1}`);
          const network = await owned.inspectNetwork(database.target, `m3-data-network-${index + 1}`);
          const runtime = m3.state.runtime?.active?.get(probes[index].allocationId);
          if (!runtime) throw new Error(`runtime allocation ${probes[index].allocationId} is not observable in the owned active set`);
          const expectedDestinations = [
            { address: database.peer.endpointIpv4, port: 5432, protocol: "tcp" },
            { address: database.peer.endpointIpv6, port: 5432, protocol: "tcp" },
          ];
          const foreign = databases.filter((candidate) => candidate !== database).flatMap((candidate) => [candidate.peer.endpointIpv4, candidate.peer.endpointIpv6]);
          expectScenario(network.networkMode === "none" && Object.keys(network.networks).length === 0 &&
            network.labels["io.hostlet.scope"] === "m3-e2e" && network.labels["io.hostlet.run-id"] === owned.runId,
          "tenant PostgreSQL remains on an owned network-none boundary", { networkMode: network.networkMode, networks: Object.keys(network.networks) });
          expectScenario(sameJson(runtime.network?.outbound_destinations ?? [], expectedDestinations) &&
            runtime.secretVersionRefs?.length === 1 && sameJson(runtime.environment ?? [], [{ name: "DATABASE_URL" }]) &&
            foreign.every((address) => !(runtime.network?.outbound_destinations ?? []).some((destination) => destination.address === address)),
          "runtime credentials and network policy name only the exact tenant database peer", {
            allocationId: probes[index].allocationId,
            outboundDestinations: runtime.network?.outbound_destinations,
            secretVersionRefs: runtime.secretVersionRefs?.length,
            environment: runtime.environment,
          });
          const credential = await runtimeCredential(database, runtime.allocation);
          const roleName = `ha_${credential.roleRef.replaceAll("-", "")}`;
          const appRead = await owned.query(database.target, `m3-data-runtime-app-read-${index + 1}`, "SELECT current_user, count(*)::int FROM app.authors;", {
            user: roleName, password: credential.password,
          });
          const controlDenied = await owned.query(database.target, `m3-data-runtime-control-deny-${index + 1}`, "SELECT * FROM hostlet_control.database_identity;", {
            user: roleName, password: credential.password, allowFailure: true,
          });
          const systemDenied = await owned.query(database.target, `m3-data-runtime-system-deny-${index + 1}`, "SELECT 1;", {
            databaseName: "postgres", user: roleName, password: credential.password, allowFailure: true,
          });
          const createDenied = await owned.query(database.target, `m3-data-runtime-create-deny-${index + 1}`, `CREATE TABLE app.m3_data_forbidden_${index + 1}(id integer);`, {
            user: roleName, password: credential.password, allowFailure: true,
          });
          const connections = await Promise.all(Array.from({ length: 12 }, (_, connection) => owned.query(
            database.target, `m3-data-runtime-connection-cap-${index + 1}-${connection + 1}`, "SELECT pg_sleep(2);", {
              user: roleName, password: credential.password, allowFailure: true, timeoutMs: 15_000,
            },
          )));
          const capRejected = connections.filter((result) => result.code !== 0).length;
          const afterCap = await owned.query(database.target, `m3-data-runtime-after-cap-${index + 1}`, "SELECT count(*)::int FROM app.entries;", {
            user: roleName, password: credential.password,
          });
          const backupName = `hb_${roles.backup.replaceAll("-", "")}`;
          const backupRead = await owned.query(database.target, `m3-data-backup-read-${index + 1}`, `SET ROLE ${backupName}; SELECT count(*)::int FROM app.authors;`, {});
          const backupWrite = await owned.query(database.target, `m3-data-backup-write-deny-${index + 1}`, `SET ROLE ${backupName}; INSERT INTO app.authors(display_name) VALUES ('m3-forbidden-backup-write');`, { allowFailure: true });
          const runtimeRole = observed.roles.find((role) => role.name === roleName);
          const migrationRole = observed.roles.find((role) => role.name === `hm_${roles.migration.replaceAll("-", "")}`);
          const backupRole = observed.roles.find((role) => role.name === backupName);
          expectScenario(appRead.code === 0 && controlDenied.code !== 0 && systemDenied.code !== 0 && createDenied.code !== 0 &&
            capRejected > 0 && afterCap.code === 0 && backupRead.code === 0 && backupWrite.code !== 0 &&
            observed.database?.owner === migrationRole?.name && observed.database?.public_connect === false &&
            observed.database?.runtime_connect === true && observed.database?.migration_connect === true && observed.database?.backup_connect === true &&
            runtimeRole?.login === true && runtimeRole?.superuser === false && runtimeRole?.createdb === false && runtimeRole?.createrole === false &&
            runtimeRole?.replication === false && runtimeRole?.bypass_rls === false && runtimeRole?.inherit === false && runtimeRole?.connection_limit === 10 &&
            migrationRole?.login === true && migrationRole?.connection_limit === 2 && backupRole?.login === true && backupRole?.connection_limit === 2 &&
            observed.app?.schema_owner === migrationRole?.name && observed.app?.runtime_usage === true && observed.app?.runtime_create === false &&
            observed.app?.runtime_select_authors === true && observed.app?.runtime_insert_authors === true && observed.app?.runtime_update_authors === true && observed.app?.runtime_delete_authors === true &&
            observed.app?.runtime_select_entries === true && observed.app?.runtime_insert_entries === true && observed.app?.runtime_update_entries === true && observed.app?.runtime_delete_entries === true &&
            observed.app?.backup_usage === true && observed.app?.backup_select_authors === true && observed.app?.backup_insert_authors === false &&
            observed.app?.migration_owner_relations > 0 && observed.app?.non_migration_owner_relations === 0 &&
            observed.control?.runtime_schema_usage === false && observed.control?.runtime_identity_select === false &&
            observed.control?.migration_schema_usage === false && observed.control?.backup_schema_usage === false,
          "actual tenant role grants, ownership, credentials, and connection caps fail closed at the PostgreSQL boundary", {
            database: observed.database, roles: observed.roles, app: observed.app, control: observed.control,
            denied: { control: controlDenied.code, system: systemDenied.code, create: createDenied.code, backupWrite: backupWrite.code },
            connectionCapRejected: capRejected,
          });
          access.push({ databaseId: database.record.id, runtimeRole: roleName, connectionCapRejected: capRejected, appRead: true, controlDenied: true, systemDenied: true });
        }
        const workerRecovery = await verifyPausedWorkerRecovery();
        return { databaseCount: databases.length, containerCount: new Set(databases.map(({ target }) => target.container_id)).size, applicationProbes: probes.length, crossOwnerDenied: true,
          concurrentIntentDeduplicated: true, replaySafe: databases.every(({ replaySafe }) => replaySafe),
          changedReplayRejected: databases.every(({ changedReplayRejected }) => changedReplayRejected),
          capacity: projects.find(({ capacityBoundary }) => capacityBoundary)?.capacityBoundary ?? { denied: false },
          bootstrapDigest, bootstrapDatabases: databases.filter(({ bootstrap }) => bootstrap?.digest === bootstrapDigest).length,
          access, provisioningCrashRecovery, workerRecovery };
      });
  }

  async function verifyStorageOverage() {
    return dataStep(context, "M3-DATA-01-STORAGE",
      "real PostgreSQL growth beyond the 1 GiB limit becomes sticky read-only after observation while reads and portable export remain available",
      async () => {
        const fixture = databases[1];
        if (!fixture) throw new Error("storage overage requires the isolated second tenant database");
        const migration = await m3.postgres.psqlJson("m3-data-storage-migration-role", `SELECT json_build_object('role_ref',role_ref)
          FROM tenant_database_credentials WHERE tenant_database_id=${sqlString(fixture.record.id)} AND database_generation=${sqlString(fixture.record.generation)}
            AND purpose='migration' AND status='active';`);
        if (!UUID.test(migration?.role_ref ?? "")) throw new Error("storage overage lacks its exact migration role");
        const migrationRole = `hm_${migration.role_ref.replaceAll("-", "")}`;
        const databaseName = `hdb_${fixture.record.id.replaceAll("-", "")}`;
        const growthSql = `SET ROLE ${migrationRole}; CREATE TABLE app.storage_pressure AS
          SELECT i, string_agg(md5(i::text || ':' || j::text),'') AS payload
          FROM generate_series(1,1050000) AS i CROSS JOIN LATERAL generate_series(1,34) AS j GROUP BY i;`;
        const grown = await context.runCommand("grow owned tenant database beyond actual storage limit", "docker", ["exec", "--env", "PGPASSWORD", fixture.target.container_id,
          "psql", "-X", "-v", "ON_ERROR_STOP=1", "--host", "127.0.0.1", "--port", "5432", "-U", "postgres", "-d", databaseName, "-c", growthSql], {
          env: { ...process.env, PGPASSWORD: owned.adminPassword(fixture.target) },
          timeoutMs: 1_800_000, logName: "m3-data-storage-real-growth.log",
        });
        if (grown.code !== 0) throw new Error("real tenant database growth failed");
        const measuredBefore = await context.runCommand("measure grown tenant database", "docker", ["exec", "--env", "PGPASSWORD", fixture.target.container_id,
          "psql", "-X", "-A", "-t", "--host", "127.0.0.1", "--port", "5432", "-U", "postgres", "-d", "postgres", "-c", `SELECT pg_database_size('${databaseName}')`], {
          env: { ...process.env, PGPASSWORD: owned.adminPassword(fixture.target) },
          timeoutMs: 30_000, logName: "m3-data-storage-real-size.log",
        });
        const physicalBytes = Number(measuredBefore.stdout.trim());
        expectScenario(measuredBefore.code === 0 && Number.isSafeInteger(physicalBytes) && physicalBytes > 1_073_741_824,
          "physical PostgreSQL size crosses the canonical limit", { physicalBytes });
        m3.policyClock.advance({ now: new Date(Date.parse(m3.policyClock.current().now) + 86_400_000).toISOString() });
        await drain("storage-over-limit-observation");
        const current = await m3.ownerHTTP(`/v1/projects/${fixture.project.projectId}/services/${fixture.project.databaseService.id}/tenant-database`);
        assertStatus(current, 200, "read-only over-limit database state");
        expectScenario(current.payload.growth_mode === "read_only_over_limit" && current.payload.measured_storage_bytes > current.payload.storage_limit_bytes,
          "worker persists the actual sticky storage freeze", current.payload);
        const runtimeProbe = m3.state.runtimeReadOnlyDatabaseProbe ?? m3.state.runtime?.runtimeReadOnlyDatabaseProbe;
        if (typeof runtimeProbe !== "function") throw new Error("storage overage requires the runtime read-only database probe integration");
        const runtime = await runtimeProbe({ artifactKey: "fullstack_v1", databasePeer: fixture.peer, expectedProjectId: fixture.project.projectId, mode: "read_only", index: 44 });
        expectScenario(runtime.readObserved && runtime.writeDenied && /^sha256:[0-9a-f]{64}$/.test(runtime.executorReceiptDigest ?? ""),
          "fresh runtime reads survive while writes are denied", runtime);
        const exported = await m3.ownerHTTP(`/v1/projects/${fixture.project.projectId}/services/${fixture.project.databaseService.id}/tenant-database/exports`, {
          method: "POST", headers: mutationHeaders(key("over-limit-export"), current.payload.revision), body: {},
        });
        assertStatus(exported, 201, "over-limit portable export intent");
        await drain("over-limit-portable-export");
        const receipt = await m3.ownerHTTP(`/v1/projects/${fixture.project.projectId}/services/${fixture.project.databaseService.id}/tenant-database/exports/${exported.payload.id}`);
        assertStatus(receipt, 200, "over-limit portable export receipt");
        expectScenario(receipt.payload.state === "usable" && receipt.payload.plaintext_bytes > 0,
          "portable export remains usable after the write freeze", receipt.payload);
        return { physicalBytes, growthMode: current.payload.growth_mode, readObserved: true, writeDenied: true, exportPreserved: true };
      });
  }

  async function runBackupPolicy() {
    return dataStep(context, "M3-DATA-02",
      "the running scheduler creates encrypted daily backups, retains the usable seven-day window, expires exact old objects, deduplicates ticks/restarts, and rotates successful drills across every active database in one policy month",
      async () => {
        const start = Date.parse(m3.policyClock.current().now);
        let failedBackup = null;
        let failedBackupArchiveId = null;
        let failedBackupInitial = null;
        for (let day = 1; day <= 8; day += 1) {
          const policyTime = new Date(start + day * 86_400_000).toISOString();
          m3.policyClock.advance({ now: policyTime });
          await runWorker("scheduler", `policy-day-${day}-restart-a`);
          await runWorker("scheduler", `policy-day-${day}-restart-b`);
          if (day === 1) {
            const policyDate = policyTime.slice(0, 10);
            const queued = await m3.postgres.psqlJson("m3-data-queued-failed-backup", `SELECT COALESCE((SELECT json_build_object(
              'operation_id',id::text,'archive_id',spec->>'archive_id') FROM tenant_database_operations
              WHERE kind='backup_daily' AND state='queued' AND spec->>'scheduled_for'=${sqlString(policyDate)}
              ORDER BY created_at,id LIMIT 1),'null'::json);`);
            if (!queued?.operation_id || !UUID.test(queued.archive_id ?? "")) throw new Error("duplicate scheduler ticks did not leave an exact queued daily backup");
            const changed = await m3.postgres.psqlJson("m3-data-corrupt-queued-backup", `WITH changed AS (
              UPDATE tenant_database_operations SET spec=jsonb_set(spec,'{source_data_generation}','0'::jsonb,false)
              WHERE id=${sqlString(queued.operation_id)} AND state='queued' RETURNING id::text)
              SELECT json_build_object('updated',(SELECT count(*)::int FROM changed));`);
            if (changed.updated !== 1) throw new Error("could not mutate the exact queued backup fault boundary");
            const attempts = [];
            for (let attempt = 0; attempt < 8; attempt += 1) {
              const result = await runWorker("once", `policy-day-${day}-failed-backup-${attempt + 1}`, { allowFailure: true });
              attempts.push(result.code);
              failedBackup = await m3.postgres.psqlJson("m3-data-failed-backup-receipt", `SELECT COALESCE((SELECT json_build_object(
                'operation_id',o.id::text,'operation_state',o.state,'operation_code',o.result->>'code',
                'archive_state',a.state,'archive_id',a.id::text)
                FROM tenant_database_operations o JOIN tenant_database_archives a ON a.id=(o.spec->>'archive_id')::uuid
                WHERE o.id=${sqlString(queued.operation_id)}),'null'::json);`);
              if (failedBackup?.operation_state === "failed" && failedBackup.archive_state === "corrupt") break;
            }
            if (!failedBackup?.operation_id || failedBackup.operation_state !== "failed" || failedBackup.archive_state !== "corrupt" || !attempts.some((code) => code !== 0)) {
              throw new Error("corrupted queued backup was not excluded as a failed archive");
            }
            failedBackupArchiveId = failedBackup.archive_id;
            failedBackupInitial = { ...failedBackup };
          }
          await drain(`policy-day-${day}`);
        }
        m3.policyClock.advance({ now: new Date(start + 31 * 86_400_000).toISOString() });
        await runWorker("scheduler", "policy-month-restart-a");
        await runWorker("scheduler", "policy-month-restart-b");
        await drain("policy-month");
        const databaseIds = databases.map(({ record }) => sqlString(record.id)).join(",");
        const failedArchiveFinal = await m3.postgres.psqlJson("m3-data-failed-backup-retention-evidence", `SELECT COALESCE((SELECT json_build_object(
          'archive_id',a.id::text,
          'archive_state',a.state,
          'successful_expiry_operation_count',(SELECT count(*)::int FROM tenant_database_operations o
            WHERE o.kind='archive_expire' AND o.state='succeeded' AND o.spec->>'archive_id'=a.id::text
              AND o.result->>'code'='archive_expired' AND o.result#>>'{proof,archive_id}'=a.id::text),
          'successful_expiry_operation_id',(SELECT o.id::text FROM tenant_database_operations o
            WHERE o.kind='archive_expire' AND o.state='succeeded' AND o.spec->>'archive_id'=a.id::text
              AND o.result->>'code'='archive_expired' AND o.result#>>'{proof,archive_id}'=a.id::text
            ORDER BY o.updated_at DESC,o.id DESC LIMIT 1)
        ) FROM tenant_database_archives a WHERE a.id=${sqlString(failedBackupArchiveId ?? "")}), 'null'::json);`);
        const evidence = await m3.postgres.psqlJson("m3-data-backup-policy-evidence", `SELECT json_build_object(
          'active_database_count',(SELECT count(*)::int FROM tenant_databases WHERE id IN (${databaseIds}) AND state IN ('ready','recovery_attention')),
          'daily_usable',(SELECT count(*)::int FROM tenant_database_archives WHERE tenant_database_id IN (${databaseIds}) AND kind='daily' AND state='usable'),
          'daily_history',(SELECT count(*)::int FROM tenant_database_archives WHERE tenant_database_id IN (${databaseIds}) AND kind='daily'),
          'daily_deleted',(SELECT count(*)::int FROM tenant_database_archives WHERE tenant_database_id IN (${databaseIds}) AND kind='daily' AND state='deleted'),
          'duplicate_days',(SELECT count(*)::int FROM (SELECT tenant_database_id,database_generation,scheduled_for FROM tenant_database_archives WHERE tenant_database_id IN (${databaseIds}) AND kind='daily' GROUP BY 1,2,3 HAVING count(*)>1) q),
          'validated_databases',(SELECT count(DISTINCT tenant_database_id)::int FROM tenant_database_recoveries WHERE tenant_database_id IN (${databaseIds}) AND state IN ('validated','cleaned')),
          'validated_recoveries',(SELECT count(*)::int FROM tenant_database_recoveries WHERE tenant_database_id IN (${databaseIds}) AND state IN ('validated','cleaned')),
          'missing_drill_coverage',(SELECT count(*)::int FROM tenant_databases d WHERE d.id IN (${databaseIds}) AND NOT EXISTS (SELECT 1 FROM tenant_database_recoveries r WHERE r.tenant_database_id=d.id AND r.database_generation=d.generation AND r.state IN ('validated','cleaned'))),
          'failed_counted_as_coverage',(SELECT count(*)::int FROM tenant_database_recoveries WHERE tenant_database_id IN (${databaseIds}) AND state NOT IN ('validated','cleaned') AND validated_at IS NOT NULL),
          'usable_bad_receipts',(SELECT count(*)::int FROM tenant_database_archives WHERE tenant_database_id IN (${databaseIds}) AND state='usable' AND (verified_at IS NULL OR snapshot_at IS NULL OR plaintext_sha256 !~ '^[0-9a-f]{64}$' OR encrypted_sha256 !~ '^[0-9a-f]{64}$' OR plaintext_bytes IS NULL OR encrypted_bytes IS NULL OR plaintext_bytes <= 0 OR encrypted_bytes <= 0 OR object_ref IS NULL OR format IS NULL OR recovery_key_id IS NULL)),
          'manifest_mismatches',(SELECT count(*)::int FROM tenant_database_archives WHERE tenant_database_id IN (${databaseIds}) AND state='usable' AND (
            format <> 'hostlet.tenant-backup/v1' OR manifest->>'format' <> format OR manifest->>'archive_id' <> id::text OR
            manifest->>'tenant_database_id' <> tenant_database_id::text OR manifest->>'database_generation' <> database_generation::text OR
            manifest->>'archive_kind' <> kind OR manifest->>'source_data_generation' <> source_data_generation::text OR
            manifest->>'key_id' <> recovery_key_id OR manifest->>'plaintext_sha256' <> plaintext_sha256 OR
            (manifest->>'plaintext_bytes')::bigint IS DISTINCT FROM plaintext_bytes OR manifest->>'portable' <> 'true' OR
            manifest->>'no_owner' <> 'true' OR manifest->>'no_privileges' <> 'true' OR manifest->>'cluster_roles_included' <> 'false' OR
            manifest->>'pg_dump_major' <> '18')),
          'corrupt_daily',(SELECT count(*)::int FROM tenant_database_archives WHERE tenant_database_id IN (${databaseIds}) AND kind='daily' AND state='corrupt'),
          'per_database',(SELECT COALESCE(json_agg(json_build_object(
            'database_id',d.id::text,
            'usable_daily',(SELECT count(*)::int FROM tenant_database_archives a WHERE a.tenant_database_id=d.id AND a.database_generation=d.generation AND a.kind='daily' AND a.state='usable'),
            'daily_history',(SELECT count(*)::int FROM tenant_database_archives a WHERE a.tenant_database_id=d.id AND a.database_generation=d.generation AND a.kind='daily'),
            'validated_drills',(SELECT count(*)::int FROM tenant_database_recoveries r WHERE r.tenant_database_id=d.id AND r.database_generation=d.generation AND r.state IN ('validated','cleaned')))
            ORDER BY d.id),'[]'::json) FROM tenant_databases d WHERE d.id IN (${databaseIds}))
        );`);
        const perDatabase = Array.isArray(evidence.per_database) ? evidence.per_database : [];
        const failedArchiveLifecycleValid = failedArchiveFinal?.archive_id === failedBackupArchiveId &&
          (failedArchiveFinal.archive_state === "corrupt" ||
            (failedArchiveFinal.archive_state === "deleted" && failedArchiveFinal.successful_expiry_operation_count === 1 &&
              typeof failedArchiveFinal.successful_expiry_operation_id === "string"));
        expectScenario(evidence.active_database_count === databases.length && evidence.daily_usable >= databases.length && evidence.daily_usable <= databases.length * 8 &&
          evidence.daily_history >= databases.length * 8 && evidence.daily_deleted > 0 && evidence.duplicate_days === 0 &&
          evidence.validated_databases === databases.length && evidence.validated_recoveries >= databases.length && evidence.missing_drill_coverage === 0 &&
          evidence.failed_counted_as_coverage === 0 && evidence.usable_bad_receipts === 0 && evidence.manifest_mismatches === 0 &&
          failedBackupInitial?.operation_id === failedBackup?.operation_id && failedBackupInitial?.archive_id === failedBackupArchiveId &&
          failedBackupInitial?.operation_state === "failed" && failedBackupInitial?.archive_state === "corrupt" && failedArchiveLifecycleValid &&
          perDatabase.length === databases.length && perDatabase.every((item) => item.usable_daily >= 1 && item.daily_history >= 4 && item.validated_drills >= 1),
        "durable backup receipts, manifests, seven-day history, duplicate ticks, failed exclusions, and per-database drill coverage match actual worker evidence",
        { ...evidence, failedBackup, failedBackupInitial, failedArchiveFinal, perDatabase });
        return { ...evidence, failedBackup, failedBackupInitial, failedArchiveFinal, perDatabase, duplicateSchedulerRestarts: true, failedReceiptExcluded: true };
    });
  }

  async function nextQueuedOperation() {
    return m3.postgres.psqlJson("m3-data-next-invalid-operation", `SELECT COALESCE((SELECT json_build_object(
      'operation_id',o.id::text,'kind',o.kind,'database_id',o.tenant_database_id::text,
      'recovery_id',o.spec->>'recovery_id','archive_id',o.spec->>'archive_id',
      'object_ref',o.spec->>'object_ref','encrypted_sha256',o.spec->>'encrypted_sha256')
      FROM tenant_database_operations o WHERE o.state IN ('queued','retriable')
      ORDER BY o.created_at,o.id LIMIT 1),'null'::json);`);
  }

  async function prepareInvalidRestore(label) {
    const next = Date.parse(m3.policyClock.current().now) + 8 * 86_400_000;
    m3.policyClock.advance({ now: new Date(next).toISOString() });
    for (let attempt = 0; attempt < 64; attempt += 1) {
      await runWorker("scheduler", `${label}-schedule-${attempt + 1}`);
      const operation = await nextQueuedOperation();
      if (operation?.kind === "restore_drill") {
        await syncReplacementTargets();
        const fixture = databases.find(({ record }) => record.id === operation.database_id);
        const target = owned.targets.find((item) => item.recovery_id === operation.recovery_id);
        if (!fixture || !target) throw new Error(`${label} did not resolve its owned restore target`);
        return { operation, fixture, target };
      }
      const { events } = await runWorker("once", `${label}-prerequisite-${attempt + 1}`);
      if (!events.some((event) => event.event === "tenant_database_operation_claimed")) {
        throw new Error(`${label} could not schedule a fresh recovery after producing its daily archive`);
      }
    }
    throw new Error(`${label} exceeded its bounded recovery preparation limit`);
  }

  async function pointerEvidence(databaseId, recoveryId) {
    return m3.postgres.psqlJson("m3-data-invalid-recovery-evidence", `SELECT json_build_object(
      'database',(SELECT json_build_object('state',state,'generation',generation::text,'source_data_generation',source_data_generation) FROM tenant_databases WHERE id=${sqlString(databaseId)}),
      'recovery',(SELECT json_build_object('state',state,'error',last_error_code,'validated_at',validated_at) FROM tenant_database_recoveries WHERE id=${sqlString(recoveryId)}),
      'operation',(SELECT json_build_object('state',state,'code',result->>'code') FROM tenant_database_operations WHERE kind='restore_drill' AND spec->>'recovery_id'=${sqlString(recoveryId)})
    );`);
  }

  async function runInvalidRestore(label, mutate, { environment = {} } = {}) {
    const prepared = await prepareInvalidRestore(label);
    const beforeRows = await owned.inspectRows(prepared.fixture.target, `m3-data-${label}-primary-before`);
    const beforePointer = await pointerEvidence(prepared.fixture.record.id, prepared.operation.recovery_id);
    const restore = await mutate(prepared);
    let result;
    try {
      result = await runWorker("once", `${label}-expected-failure`, { environment, allowFailure: true });
    } finally {
      await restore?.();
    }
    expectScenario(result.code !== 0, `${label} worker execution fails closed`, { exit_code: result.code });
    const afterRows = await owned.inspectRows(prepared.fixture.target, `m3-data-${label}-primary-after`);
    const afterPointer = await pointerEvidence(prepared.fixture.record.id, prepared.operation.recovery_id);
    expectScenario(
      sameJson(beforeRows, afterRows) &&
        beforePointer.database.generation === afterPointer.database.generation &&
        beforePointer.database.source_data_generation === afterPointer.database.source_data_generation &&
        afterPointer.recovery.state !== "validated" && afterPointer.recovery.validated_at === null &&
        afterPointer.operation.state === "failed",
      `${label} preserves the live database and records no recovery success`,
      { recovery: afterPointer.recovery, operation: afterPointer.operation, sourceUnchanged: sameJson(beforeRows, afterRows) },
    );
    return { ...prepared, error: afterPointer.recovery.error ?? afterPointer.operation.code };
  }

  async function runInvalidRecoveryCases() {
    const incorrectRecoveryKey = randomBytes(32).toString("base64");
    context.registerSensitiveValues([incorrectRecoveryKey]);
    const wrongKey = await runInvalidRestore("wrong-key", async () => undefined, {
      environment: { HOSTLET_TENANT_RECOVERY_KEY: incorrectRecoveryKey },
    });
    expectScenario(wrongKey.error === "archive_authentication_failed", "wrong recovery key is authenticated and rejected", { code: wrongKey.error });

    const wrongDigest = await runInvalidRestore("wrong-digest", async ({ operation }) => {
      const digest = "0".repeat(64) === operation.encrypted_sha256 ? "1".repeat(64) : "0".repeat(64);
      const changed = await m3.postgres.psqlJson("m3-data-corrupt-queued-digest", `WITH changed AS (
        UPDATE tenant_database_operations SET spec=jsonb_set(spec,'{encrypted_sha256}',to_jsonb(${sqlString(digest)}::text),false)
        WHERE id=${sqlString(operation.operation_id)} AND state='queued' RETURNING id::text)
        SELECT json_build_object('updated',(SELECT count(*)::int FROM changed));`);
      if (changed.updated !== 1) throw new Error("could not mutate the exact queued digest fault boundary");
    });
    expectScenario(wrongDigest.error === "archive_digest_mismatch", "wrong encrypted digest is rejected", { code: wrongDigest.error });

    const wrongTarget = await runInvalidRestore("wrong-target", async ({ fixture, target, operation }) => {
      const originalIndex = owned.targets.indexOf(target);
      owned.targets.splice(originalIndex, 1);
      const mismatched = await owned.create(fixture.record, { recoveryId: operation.recovery_id, force: true, labelDatabaseId: randomUUID() });
      owned.writeInventory();
      return async () => {
        const mismatchIndex = owned.targets.indexOf(mismatched);
        if (mismatchIndex >= 0) owned.targets.splice(mismatchIndex, 1);
        owned.targets.splice(originalIndex, 0, target);
        owned.writeInventory();
      };
    });
    expectScenario(wrongTarget.error === "tenant_target_identity_mismatch", "mismatched replacement identity is rejected", { code: wrongTarget.error });

    const truncated = await runInvalidRestore("truncated-archive", async ({ operation }) => {
      if (!/^tenant_[0-9a-f]{32}\/[0-9a-f-]{36}\.htb$/.test(operation.object_ref ?? "")) throw new Error("restore object ref escaped the owned repository");
      const repository = resolve(m3.policyClock.stateDir, "tenant-backups");
      const archive = resolve(repository, operation.object_ref);
      if (!archive.startsWith(`${repository}/`)) throw new Error("restore object ref escaped the owned repository");
      const saved = `${archive}.m3-owned-saved`;
      copyFileSync(archive, saved);
      chmodSync(saved, 0o600);
      truncateSync(archive, Math.max(1, Math.floor(statSync(archive).size / 2)));
      return async () => { copyFileSync(saved, archive); chmodSync(archive, 0o600); unlinkSync(saved); };
    });
    expectScenario(truncated.error === "archive_digest_mismatch", "truncated encrypted archive is rejected", { code: truncated.error });

    const nonempty = await runInvalidRestore("nonempty-target", async ({ target, operation }) => {
      const result = await context.runCommand("seed nonempty isolated replacement", "docker", ["exec", "--env", "PGPASSWORD", target.container_id,
        "createdb", "--host", "127.0.0.1", "--port", "5432", "-U", "postgres", `hdr_${operation.recovery_id.replaceAll("-", "")}`], {
        env: { ...process.env, PGPASSWORD: owned.adminPassword(target) },
        timeoutMs: 30_000, logName: "m3-data-nonempty-replacement.log",
      });
      if (result.code !== 0) throw new Error("could not seed the owned nonempty replacement fault");
    });
    expectScenario(nonempty.error === "restore_target_nonempty", "nonempty replacement is rejected", { code: nonempty.error });

    return {
      wrongKeyRejected: true, digestRejected: true, targetRejected: true,
      truncatedRejected: true, nonemptyRejected: true, livePointerAdvances: 0,
    };
  }

  async function prepareFreshDailyArchive(database) {
    const policyTime = new Date(Date.parse(m3.policyClock.current().now) + 8 * 86_400_000);
    m3.policyClock.advance({ now: policyTime.toISOString() });
    const policyDate = policyTime.toISOString().slice(0, 10);
    for (let attempt = 0; attempt < 64; attempt += 1) {
      await runWorker("scheduler", `fresh-recovery-archive-scheduler-${attempt + 1}`);
      const archiveId = await m3.postgres.psqlJson("m3-data-fresh-recovery-archive", `SELECT to_jsonb(id::text)
        FROM tenant_database_archives WHERE tenant_database_id=${sqlString(database.record.id)}
          AND database_generation=${sqlString(database.record.generation)} AND kind='daily' AND state='usable'
          AND scheduled_for=${sqlString(policyDate)}::date ORDER BY snapshot_at DESC,id DESC LIMIT 1;`);
      if (UUID.test(archiveId ?? "")) return archiveId;
      const { events } = await runWorker("once", `fresh-recovery-archive-operation-${attempt + 1}`);
      if (!events.some((event) => event.event === "tenant_database_operation_claimed")) {
        throw new Error("fresh daily archive was not produced by the real scheduler and worker");
      }
      const completedArchiveId = await m3.postgres.psqlJson("m3-data-completed-fresh-recovery-archive", `SELECT to_jsonb(id::text)
        FROM tenant_database_archives WHERE tenant_database_id=${sqlString(database.record.id)}
          AND database_generation=${sqlString(database.record.generation)} AND kind='daily' AND state='usable'
          AND scheduled_for=${sqlString(policyDate)}::date ORDER BY snapshot_at DESC,id DESC LIMIT 1;`);
      if (UUID.test(completedArchiveId ?? "")) return completedArchiveId;
    }
    throw new Error("fresh daily archive preparation exceeded its bounded operation limit");
  }

  async function runExportRestore() {
    return dataStep(context, "M3-DATA-03",
      "an actual portable encrypted export and isolated empty replacement restore preserve rows, foreign keys, grants, application access, and primary data; invalid recovery cases never advance success",
      async () => {
        const database = databases[0];
        const freshArchiveId = await prepareFreshDailyArchive(database);
        const current = await m3.ownerHTTP(`/v1/projects/${database.project.projectId}/services/${database.project.databaseService.id}/tenant-database`);
        assertStatus(current, 200, "tenant database before export");
        const exported = await m3.ownerHTTP(`/v1/projects/${database.project.projectId}/services/${database.project.databaseService.id}/tenant-database/exports`, {
          method: "POST", headers: mutationHeaders(key("portable-export"), current.payload.revision), body: {},
        });
        assertStatus(exported, 201, "portable export intent");
        const backups = await m3.ownerHTTP(`/v1/projects/${database.project.projectId}/services/${database.project.databaseService.id}/tenant-database/backups`);
        assertStatus(backups, 200, "tenant backups for explicit recovery");
        const usable = backups.payload.find((archive) => archive.id === freshArchiveId && archive.kind === "daily" && archive.state === "usable");
        if (!usable) throw new Error("no usable daily backup exists for isolated restore");
        const before = await owned.inspectRows(database.target, "m3-data-primary-before-explicit-restore");
        const databaseRead = await m3.ownerHTTP(`/v1/projects/${database.project.projectId}/services/${database.project.databaseService.id}/tenant-database`);
        const recovery = await m3.ownerHTTP(`/v1/projects/${database.project.projectId}/services/${database.project.databaseService.id}/tenant-database/recovery-drills`, {
          method: "POST", headers: mutationHeaders(key("explicit-recovery"), databaseRead.payload.revision), body: { archive_id: usable.id },
        });
        assertStatus(recovery, 201, "explicit isolated recovery intent");
        await syncReplacementTargets();
        await drain("portable-export");
        const exportRead = await m3.ownerHTTP(`/v1/projects/${database.project.projectId}/services/${database.project.databaseService.id}/tenant-database/exports/${exported.payload.id}`);
        assertStatus(exportRead, 200, "portable export receipt");
        expectScenario(exportRead.payload.state === "usable" && /^[0-9a-f]{64}$/.test(exportRead.payload.plaintext_sha256 ?? "") && exportRead.payload.plaintext_bytes > 0,
          "portable export is backed by a verified nonempty dump", exportRead.payload);
        const exportProof = await m3.postgres.psqlJson("m3-data-portable-export-proof", `SELECT result->'proof' FROM tenant_database_operations
          WHERE kind='export' AND spec->>'archive_id'=${sqlString(exported.payload.id)} AND state='succeeded';`);
        expectScenario(exportProof?.manifest?.no_owner === true && exportProof?.manifest?.no_privileges === true &&
          exportProof?.manifest?.cluster_roles_included === false && exportProof?.format === "hostlet.tenant-backup/v1",
        "portable export omits owners, privileges, cluster roles, and credentials", exportProof);
        const recovered = await m3.ownerHTTP(`/v1/projects/${database.project.projectId}/services/${database.project.databaseService.id}/tenant-database/recovery-drills/${recovery.payload.id}`);
        assertStatus(recovered, 200, "explicit recovery receipt");
        expectScenario(recovered.payload.state === "validated" && recovered.payload.elapsed_milliseconds >= 0 && recovered.payload.elapsed_milliseconds <= 4 * 3_600_000,
          "isolated replacement restore is validated", recovered.payload);
        const replacementTarget = owned.targets.find((target) => target.recovery_id === recovery.payload.id);
        const after = await owned.inspectRows(replacementTarget, "m3-data-restored-populated-state");
        const primaryAfter = await owned.inspectRows(database.target, "m3-data-primary-after-explicit-restore");
        expectScenario(sameJson(before, after) && sameJson(before, primaryAfter) && after.foreign_keys > 0 && after.unvalidated === 0,
          "replacement matches populated relationships while primary remains unchanged", { rowsMatch: sameJson(before, after), sourceUnchanged: sameJson(before, primaryAfter), foreignKeys: after.foreign_keys });
        const restoredRoles = await credentialRoles(database.record);
        const restoredAccess = await owned.inspectAccess(replacementTarget, restoredRoles, "m3-data-restored-access");
        const restoredRuntimeName = `ha_${restoredRoles.runtime.replaceAll("-", "")}`;
        const restoredMigrationName = `hm_${restoredRoles.migration.replaceAll("-", "")}`;
        const restoredRuntimeRole = restoredAccess.roles.find((role) => role.name === restoredRuntimeName);
        expectScenario(restoredAccess.database?.owner === restoredMigrationName && restoredAccess.database?.public_connect === false &&
          restoredAccess.database?.runtime_connect === true && restoredAccess.database?.migration_connect === true && restoredAccess.database?.backup_connect === true &&
          restoredRuntimeRole?.login === true && restoredRuntimeRole?.superuser === false && restoredRuntimeRole?.createdb === false &&
          restoredRuntimeRole?.createrole === false && restoredRuntimeRole?.replication === false && restoredRuntimeRole?.bypass_rls === false &&
          restoredRuntimeRole?.inherit === false && restoredRuntimeRole?.connection_limit === 10 && restoredAccess.app?.schema_owner === restoredMigrationName &&
          restoredAccess.app?.runtime_usage === true && restoredAccess.app?.runtime_create === false && restoredAccess.app?.runtime_select_authors === true &&
          restoredAccess.app?.runtime_insert_authors === true && restoredAccess.app?.runtime_update_authors === true && restoredAccess.app?.runtime_delete_authors === true &&
          restoredAccess.app?.runtime_select_entries === true && restoredAccess.app?.runtime_insert_entries === true && restoredAccess.app?.runtime_update_entries === true &&
          restoredAccess.app?.runtime_delete_entries === true && restoredAccess.app?.backup_usage === true && restoredAccess.app?.backup_select_authors === true &&
          restoredAccess.app?.backup_insert_authors === false && restoredAccess.app?.migration_owner_relations > 0 && restoredAccess.app?.non_migration_owner_relations === 0 &&
          restoredAccess.control?.runtime_schema_usage === false && restoredAccess.control?.runtime_identity_select === false &&
          restoredAccess.control?.migration_schema_usage === false && restoredAccess.control?.backup_schema_usage === false,
        "restored PostgreSQL roles, ownership, grants, and control schema boundaries match the source contract", {
          database: restoredAccess.database, roles: restoredAccess.roles, app: restoredAccess.app, control: restoredAccess.control,
        });
        const restoredPeer = m3.state.tenantPeers.get(`${database.project.projectId}:replacement:${recovery.payload.id}`);
        const restoredProbe = m3.state.runtimeDatabaseProbe ?? m3.state.runtime?.runtimeDatabaseProbe;
        if (typeof restoredProbe !== "function") throw new Error("M3-DATA-03 requires the restored application probe integration");
        const application = await restoredProbe({ artifactKey: "fullstack_v1", databasePeer: restoredPeer, expectedProjectId: database.project.projectId, mode: "read_write", index: 45 });
        expectScenario(application.readObserved && application.writeObserved && /^sha256:[0-9a-f]{64}$/.test(application.executorReceiptDigest ?? ""),
          "real sandbox application reads and writes the restored database", application);
        const recoverableAgeMilliseconds = Date.parse(m3.policyClock.current().now) - Date.parse(usable.snapshot_at);
        expectScenario(recoverableAgeMilliseconds >= 0 && recoverableAgeMilliseconds <= 24 * 3_600_000,
          "selected recovery point remains within the observed 24-hour target", { recoverableAgeMilliseconds });
        const invalid = await runInvalidRecoveryCases();
        expectScenario(invalid?.wrongKeyRejected && invalid?.digestRejected && invalid?.targetRejected && invalid?.truncatedRejected && invalid?.nonemptyRejected && invalid?.livePointerAdvances === 0,
          "wrong key, digest, target, truncation, and nonempty replacements fail without cutover", invalid);
        return { exportId: exported.payload.id, recoveryId: recovery.payload.id, rowsMatch: true, sourceUnchanged: true, restoredGrants: true, applicationReadWrite: true, invalidCases: 5, recoverableAgeMilliseconds, restoreElapsedMilliseconds: recovered.payload.elapsed_milliseconds };
      });
  }

  async function runMigrationCompatibility() {
    return dataStep(context, "M3-DATA-04",
      "a verified fresh backup and populated isolated trial gate an additive migration applied once; duplicate/competing work is fenced, builds lack database secrets, and current plus retained applications use resulting data",
      async () => {
        if (typeof integrations.migrationCompatibility !== "function") throw new Error("M3-DATA-04 requires release migration compatibility integration");
        const result = await integrations.migrationCompatibility({
          m3,
          database: databases[0],
          primaryPeer: databases[0].peer,
          syncReplacementTargets,
          drain,
          workerEnvironment: workerEnvironment(),
        });
        expectScenario(result?.freshBackupVerified && result?.populatedTrialPassed && result?.applyCount === 1 &&
          result?.duplicateSafe && result?.competingWorkerFenced && result?.customerBuildDatabaseSecrets === 0 &&
          result?.currentApplicationReadWrite && result?.retainedApplicationReadWrite && result?.dataRewinds === 0,
        "controlled migration and retained-application evidence satisfy every gate", result);
        return result;
      });
  }

  return Object.freeze({
    bindIntegrations(callbacks) {
      for (const [name, callback] of Object.entries(callbacks ?? {})) {
        if (typeof callback !== "function") throw new Error(`M3 data integration ${name} must be a function`);
        integrations[name] = callback;
      }
    },
    provision,
    verifyProvisioning,
    verifyStorageOverage,
    runBackupPolicy,
    runExportRestore,
    runMigrationCompatibility,
    drainWorker: drain,
    syncReplacementTargets,
    withEndpointsPaused: (run) => owned.withEndpointsPaused(run),
    inventoryPath: owned.inventoryPath,
    databases,
    projects,
  });
}
