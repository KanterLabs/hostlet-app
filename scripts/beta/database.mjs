import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, mkdir, stat, lstat, rename, open, rm } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Persistent M3.5 preview composition. This module never initializes or migrates a schema.
// The tenant worker, not this module, provisions hdb_* and its least-privilege roles.
const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const IMAGE_FILE = join(ROOT, 'e2e/postgres-image.txt');
const SCOPE = 'm3-e2e'; // Required by the existing hostlet-database worker.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID = /^[0-9a-f]{64}$/;

function requireValue(ok, message) { if (!ok) throw new Error(message); }
function safeName(value, label) {
  requireValue(typeof value === 'string' && /^[a-z][a-z0-9_]{0,62}$/.test(value), `invalid ${label}`);
  return value;
}
function uuid(value, label) { requireValue(UUID.test(value ?? ''), `invalid ${label}`); return value.toLowerCase(); }
function port(value) { requireValue(Number.isInteger(value) && value >= 1024 && value <= 65535, 'invalid explicit platform loopback port'); return value; }

async function run(command, args, { env = process.env, input, timeoutMs = 30_000, allowFailure = false, outputFile } = {}) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { env, stdio: [input === undefined ? 'ignore' : 'pipe', outputFile ? 'pipe' : 'pipe', 'pipe'] });
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    if (outputFile) {
      child.stdout.pipe(outputFile);
      outputFile.on('error', error => { child.kill('SIGKILL'); fail(error); });
    } else child.stdout.on('data', chunk => { stdout = Buffer.concat([stdout, chunk]); if (stdout.length > 4_000_000) child.kill('SIGKILL'); });
    child.stderr.on('data', chunk => { stderr = Buffer.concat([stderr, chunk]); if (stderr.length > 64_000) child.kill('SIGKILL'); });
    child.on('error', error => { clearTimeout(timer); fail(error); });
    child.on('close', async code => {
      clearTimeout(timer);
      if (timedOut) return fail(new Error(`${command} timed out`));
      if (code !== 0 && !allowFailure) return fail(new Error(`${command} failed with exit ${code}: ${stderr.toString().slice(0, 500)}`));
      if (outputFile && !outputFile.writableFinished) {
        try { await new Promise((yes, no) => { outputFile.once('finish', yes); outputFile.once('error', no); }); }
        catch (error) { return fail(error); }
      }
      done({ code, stdout: stdout.toString(), stderr: stderr.toString() });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}
const docker = (args, options) => run('docker', args, options);
async function exists(path) { try { await stat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
async function privateDir(path) { await mkdir(path, { recursive: true, mode: 0o700 }); const s = await stat(path); requireValue(s.isDirectory() && (s.mode & 0o077) === 0, `unsafe private directory ${path}`); }
async function readPrivate(path) { const s = await lstat(path); requireValue(s.isFile() && !s.isSymbolicLink() && (s.mode & 0o077) === 0, `unsafe private file ${path}`); return (await readFile(path, 'utf8')).trim(); }
async function writeOnce(path, value) { const handle = await open(path, 'wx', 0o600); try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); } }
async function writeAtomic(path, value) { const temp = `${path}.${randomUUID()}.tmp`; await writeOnce(temp, value); await rename(temp, path); }

async function image() {
  const value = (await readFile(IMAGE_FILE, 'utf8')).trim();
  requireValue(/^postgres:18-[^@]+@sha256:[a-f0-9]{64}$/.test(value), 'PostgreSQL image pin is invalid');
  return value;
}
async function identity(stateDir) {
  await privateDir(stateDir);
  const path = join(stateDir, 'preview-database-run-id');
  if (!(await exists(path))) await writeOnce(path, `${randomUUID()}\n`).catch(e => { if (e.code !== 'EEXIST') throw e; });
  return uuid(await readPrivate(path), 'persisted database run ID');
}
async function existingIdentity(stateDir) {
  return uuid(await readPrivate(join(stateDir, 'preview-database-run-id')), 'persisted database run ID');
}
function labels({ kind, runId, databaseId, generation, recoveryId, restore = false }) {
  const values = {
    'io.hostlet.scope': SCOPE,
    'io.hostlet.run-id': runId,
    'io.hostlet.resource': kind,
    'io.hostlet.restore-target': String(restore),
  };
  if (databaseId) values['io.hostlet.database-id'] = databaseId;
  if (generation) values['io.hostlet.database-generation'] = generation;
  if (recoveryId) values['io.hostlet.recovery-id'] = recoveryId;
  return values;
}
function labelArgs(values) { return Object.entries(values).flatMap(([key, value]) => ['--label', `${key}=${value}`]); }
function matchingLabels(actual, wanted) { return Object.entries(wanted).every(([key, value]) => actual?.[key] === value); }
async function inspectContainer(name, wanted, { imagePin, volume, passwordFile, network, publishedPort } = {}) {
  const result = await docker(['container', 'inspect', name], { allowFailure: true });
  if (result.code !== 0) {
    if (/No such (object|container)/i.test(result.stderr)) return null;
    throw new Error(`cannot inspect container ${name}`);
  }
  const rows = JSON.parse(result.stdout);
  requireValue(rows.length === 1 && rows[0].Name === `/${name}`, `container ${name} identity mismatch`);
  const row = rows[0];
  requireValue(ID.test(row.Id) && matchingLabels(row.Config.Labels, wanted), `container ${name} owner mismatch`);
  requireValue(row.Config.Image === imagePin && row.HostConfig.NetworkMode === network, `container ${name} image/network mismatch`);
  requireValue(row.Mounts?.some(m => m.Type === 'volume' && m.Name === volume && m.Destination === '/var/lib/postgresql'), `container ${name} volume mismatch`);
  if (passwordFile) requireValue(row.Mounts?.some(m => m.Type === 'bind' && m.Source === passwordFile && m.Destination === '/run/secrets/pg_password' && m.RW === false), `container ${name} credential mount mismatch`);
  if (publishedPort !== undefined) {
    const binding = row.HostConfig.PortBindings?.['5432/tcp'];
    requireValue(binding?.length === 1 && binding[0].HostIp === '127.0.0.1' && Number(binding[0].HostPort) === publishedPort, `container ${name} loopback binding mismatch`);
  } else requireValue(!row.HostConfig.PortBindings || Object.keys(row.HostConfig.PortBindings).length === 0, `container ${name} unexpected published port`);
  return row;
}
async function inspectVolume(name, wanted) {
  const result = await docker(['volume', 'inspect', name], { allowFailure: true });
  if (result.code !== 0) {
    if (/No such volume/i.test(result.stderr)) return null;
    throw new Error(`cannot inspect volume ${name}`);
  }
  const rows = JSON.parse(result.stdout);
  requireValue(rows.length === 1 && rows[0].Name === name && matchingLabels(rows[0].Labels, wanted), `volume ${name} owner mismatch`);
  return rows[0];
}
async function ensurePassword(path) {
  if (!(await exists(path))) await writeOnce(path, `${randomBytes(36).toString('base64url')}\n`).catch(e => { if (e.code !== 'EEXIST') throw e; });
  const password = await readPrivate(path);
  requireValue(/^[A-Za-z0-9_-]{48}$/.test(password), 'database credential file invalid');
  return password;
}
async function ready(containerId, password) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const probe = await docker(['exec', '--env', 'PGPASSWORD', containerId, 'psql', '--no-psqlrc', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'postgres', '-Atqc', 'SELECT 1'], {
      env: { ...process.env, PGPASSWORD: password }, timeoutMs: 5_000, allowFailure: true,
    });
    if (probe.code === 0 && probe.stdout.trim() === '1') return;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('owned PostgreSQL did not become authenticated and ready within 15 seconds');
}

async function ensureServer({ stateDir, kind, name, volume, port: hostPort, databaseId, generation, recoveryId, restore = false }) {
  const runId = await identity(stateDir), imagePin = await image();
  const containerLabels = labels({ kind, runId, databaseId, generation, recoveryId, restore });
  const volumeLabels = labels({ kind: `${kind}-data`, runId, databaseId, generation, recoveryId, restore });
  const passwordFile = join(stateDir, `${name}.password`);
  const desiredRestart = restore ? 'no' : 'unless-stopped';
  const existingVolume = await inspectVolume(volume, volumeLabels);
  const existingContainer = await inspectContainer(name, containerLabels, { imagePin, volume, passwordFile, network: hostPort === undefined ? 'none' : 'bridge', publishedPort: hostPort });
  if (existingVolume && !(await exists(passwordFile))) throw new Error('existing database volume has no matching credential file; refusing reuse');
  if (existingContainer && !existingVolume) throw new Error('existing database container has no matching owned volume');
  const password = await ensurePassword(passwordFile);
  if (!existingVolume) {
    const created = await docker(['volume', 'create', ...labelArgs(volumeLabels), volume]);
    requireValue(created.stdout.trim() === volume, 'Docker created an unexpected volume');
    await inspectVolume(volume, volumeLabels);
  }
  let row = existingContainer;
  if (!row) {
    const args = ['run', '--detach', '--name', name, ...labelArgs(containerLabels),
      '--restart', desiredRestart,
      '--network', hostPort === undefined ? 'none' : 'bridge',
      '--mount', `type=volume,source=${volume},target=/var/lib/postgresql`,
      '--mount', `type=bind,source=${passwordFile},target=/run/secrets/pg_password,readonly`,
      '--env', 'POSTGRES_PASSWORD_FILE=/run/secrets/pg_password',
      '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m'];
    if (hostPort !== undefined) args.push('--publish', `127.0.0.1:${hostPort}:5432`);
    args.push(imagePin);
    const started = await docker(args, { timeoutMs: 120_000 });
    requireValue(ID.test(started.stdout.trim()), 'Docker returned an invalid container ID');
    row = await inspectContainer(name, containerLabels, { imagePin, volume, passwordFile, network: hostPort === undefined ? 'none' : 'bridge', publishedPort: hostPort });
  }
  const observedRestart = row.HostConfig.RestartPolicy?.Name || 'no';
  const retryCount = row.HostConfig.RestartPolicy?.MaximumRetryCount ?? 0;
  requireValue(retryCount === 0, `container ${name} has unexpected restart retry policy`);
  if (observedRestart !== desiredRestart) {
    requireValue(existingContainer && !restore && observedRestart === 'no', `container ${name} has unexpected restart policy ${observedRestart}`);
    // Existing owned preview container from before this policy was adopted.
    // Change only its restart metadata after the exact identity checks above.
    await docker(['update', '--restart', 'unless-stopped', row.Id]);
    row = await inspectContainer(name, containerLabels, { imagePin, volume, passwordFile, network: hostPort === undefined ? 'none' : 'bridge', publishedPort: hostPort });
    requireValue(row.Id === existingContainer.Id && row.HostConfig.RestartPolicy?.Name === 'unless-stopped',
      `container ${name} restart policy reconciliation failed`);
  }
  if (!row.State.Running) {
    await docker(['start', row.Id], { timeoutMs: 30_000 });
    row = await inspectContainer(name, containerLabels, { imagePin, volume, passwordFile, network: hostPort === undefined ? 'none' : 'bridge', publishedPort: hostPort });
  }
  requireValue(row.Id && row.State.Running, 'owned PostgreSQL is not running');
  await ready(row.Id, password);
  return { runId, containerId: row.Id, containerName: name, volumeName: volume, passwordFile, image: imagePin,
    kind, databaseId: databaseId ?? null, databaseGeneration: generation ?? null, recoveryId: recoveryId ?? null, restore,
    reused: Boolean(existingContainer) };
}

export async function ensurePlatformDatabase({ stateDir, port: hostPort, connectionUrlFile: requestedUrlFile }) {
  port(hostPort);
  const base = await ensureServer({ stateDir, kind: 'platform-postgres', name: 'hostlet-preview-platform-pg', volume: 'hostlet-preview-platform-pgdata', port: hostPort });
  const database = 'postgres', user = 'postgres';
  const password = await readPrivate(base.passwordFile);
  const url = `postgresql://${user}:${encodeURIComponent(password)}@127.0.0.1:${hostPort}/${database}`;
  const connectionUrlFile = requestedUrlFile ?? join(stateDir, 'platform-database-url');
  await privateDir(resolve(connectionUrlFile, '..'));
  if (!(await exists(connectionUrlFile))) await writeOnce(connectionUrlFile, `${url}\n`).catch(e => { if (e.code !== 'EEXIST') throw e; });
  requireValue((await readPrivate(connectionUrlFile)) === url, 'platform connection file mismatch');
  return { ...base, database, user, host: '127.0.0.1', port: hostPort, connectionUrlFile };
}

function projectPeer(base, databaseId, generation, endpointIpv4, endpointIpv6) {
  return {
    containerId: base.containerId, runId: base.runId, tenantDatabaseId: databaseId,
    databaseGeneration: generation, restoreTarget: false,
    endpointIpv4, endpointIpv6,
    gatewayIpv4: endpointIpv4.replace(/\.2$/, '.1'), gatewayIpv6: endpointIpv6.replace(/::2$/, '::1'),
    ipv4: endpointIpv4, ipv6: endpointIpv6, port: 5432,
    databaseName: `hdb_${databaseId.replaceAll('-', '')}`,
  };
}

export async function ensureProjectTarget({ stateDir, tenantDatabaseId, databaseGeneration, endpointIpv4, endpointIpv6 }) {
  const databaseId = uuid(tenantDatabaseId, 'tenant database ID');
  const generation = uuid(databaseGeneration, 'tenant database generation');
  requireValue(isIP(endpointIpv4) === 4 && isIP(endpointIpv6) === 6 && endpointIpv4.endsWith('.2') && endpointIpv6.endsWith('::2'), 'invalid explicit tenant peer address');
  const base = await ensureServer({ stateDir, kind: 'tenant-postgres', name: 'hostlet-preview-project-pg', volume: 'hostlet-preview-project-pgdata', databaseId, generation });
  const inventoryPath = join(stateDir, 'database-inventory.json');
  const target = { tenant_database_id: databaseId, database_generation: generation, recovery_id: null, container_id: base.containerId, restore_target: false, endpoint_ipv4: endpointIpv4, endpoint_ipv6: endpointIpv6 };
  const inventory = { schema_version: 1, run_id: base.runId, targets: [target] };
  if (await exists(inventoryPath)) {
    const current = JSON.parse(await readPrivate(inventoryPath));
    requireValue(current.schema_version === 1 && current.run_id === base.runId &&
      JSON.stringify(current.targets?.find(t => t.recovery_id === null)) === JSON.stringify(target),
    'tenant inventory mismatch; refusing to replace persisted peer identity');
  } else await writeOnce(inventoryPath, `${JSON.stringify(inventory)}\n`);
  return { ...base, inventoryPath, target, databaseName: `hdb_${databaseId.replaceAll('-', '')}`,
    databasePeer: projectPeer(base, databaseId, generation, endpointIpv4, endpointIpv6) };
}

// Recovery reads an existing placement. A missing/stopped container, inventory,
// volume or credential fails closed; this never creates or restarts anything.
export async function inspectProjectTarget({ stateDir, tenantDatabaseId, databaseGeneration, endpointIpv4, endpointIpv6 }) {
  const databaseId = uuid(tenantDatabaseId, 'tenant database ID');
  const generation = uuid(databaseGeneration, 'tenant database generation');
  requireValue(isIP(endpointIpv4) === 4 && isIP(endpointIpv6) === 6, 'invalid tenant peer address');
  const runId = await existingIdentity(stateDir);
  const name = 'hostlet-preview-project-pg', volumeName = 'hostlet-preview-project-pgdata';
  const passwordFile = join(stateDir, `${name}.password`);
  const imagePin = await image();
  const wanted = labels({ kind: 'tenant-postgres', runId, databaseId, generation });
  const row = await inspectContainer(name, wanted, { imagePin, volume: volumeName, passwordFile, network: 'none' });
  requireValue(row?.State.Running && row.HostConfig.RestartPolicy?.Name === 'unless-stopped', 'project PostgreSQL is absent, stopped, or has wrong restart policy');
  requireValue(await inspectVolume(volumeName, labels({ kind: 'tenant-postgres-data', runId, databaseId, generation })), 'project PostgreSQL volume is absent');
  const password = await readPrivate(passwordFile);
  const probe = await docker(['exec', '--env', 'PGPASSWORD', row.Id, 'psql', '--no-psqlrc', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'postgres', '-Atqc', 'SELECT 1'],
    { env: { ...process.env, PGPASSWORD: password }, timeoutMs: 5_000 });
  requireValue(probe.stdout.trim() === '1', 'project PostgreSQL read-only authentication failed');
  const inventoryPath = join(stateDir, 'database-inventory.json');
  const inventory = JSON.parse(await readPrivate(inventoryPath));
  const target = { tenant_database_id: databaseId, database_generation: generation, recovery_id: null,
    container_id: row.Id, restore_target: false, endpoint_ipv4: endpointIpv4, endpoint_ipv6: endpointIpv6 };
  requireValue(inventory.schema_version === 1 && inventory.run_id === runId &&
    JSON.stringify(inventory.targets?.find(t => t.recovery_id === null)) === JSON.stringify(target),
  'project PostgreSQL inventory identity mismatch');
  const base = { runId, containerId: row.Id, containerName: name, volumeName, passwordFile,
    image: imagePin, kind: 'tenant-postgres', databaseId, databaseGeneration: generation, recoveryId: null, restore: false, reused: true };
  return { ...base, inventoryPath, target, databaseName: `hdb_${databaseId.replaceAll('-', '')}`,
    databasePeer: projectPeer(base, databaseId, generation, endpointIpv4, endpointIpv6) };
}

// The real M3 worker fills this empty, separately owned target through its fenced
// restore_drill or migration_trial operation. This does not copy data itself.
export async function ensureProjectRestoreTarget({ stateDir, tenantDatabaseId, databaseGeneration, recoveryId, endpointIpv4, endpointIpv6 }) {
  const databaseId = uuid(tenantDatabaseId, 'tenant database ID');
  const generation = uuid(databaseGeneration, 'tenant database generation');
  const replacement = uuid(recoveryId, 'recovery ID');
  requireValue(isIP(endpointIpv4) === 4 && isIP(endpointIpv6) === 6 && endpointIpv4.endsWith('.2') && endpointIpv6.endsWith('::2'), 'invalid explicit restore peer address');
  const inventoryPath = join(stateDir, 'database-inventory.json');
  const inventory = JSON.parse(await readPrivate(inventoryPath));
  requireValue(inventory.schema_version === 1 && inventory.run_id === await identity(stateDir) &&
    inventory.targets?.some(t => t.tenant_database_id === databaseId && t.database_generation === generation && t.recovery_id === null),
  'matching primary tenant inventory required before replacement');
  const name = `hostlet-preview-project-restore-${replacement.slice(0, 8)}`;
  const base = await ensureServer({ stateDir, kind: 'tenant-postgres', name, volume: `${name}-data`, databaseId, generation, recoveryId: replacement, restore: true });
  const target = { tenant_database_id: databaseId, database_generation: generation, recovery_id: replacement, container_id: base.containerId, restore_target: true, endpoint_ipv4: endpointIpv4, endpoint_ipv6: endpointIpv6 };
  const existing = inventory.targets.find(t => t.recovery_id === replacement);
  if (existing) requireValue(JSON.stringify(existing) === JSON.stringify(target), 'replacement inventory identity mismatch');
  else {
    requireValue(!inventory.targets.some(t => t.endpoint_ipv4 === endpointIpv4 || t.endpoint_ipv6 === endpointIpv6), 'replacement peer address already allocated');
    inventory.targets.push(target);
    await writeAtomic(inventoryPath, `${JSON.stringify(inventory)}\n`);
  }
  return { ...base, inventoryPath, target, databaseName: `hdr_${replacement.replaceAll('-', '')}` };
}

// Bind only metadata returned after an actual, completed worker provision.
export function bindProjectPeerCredential(peer, { databaseRef, roleRef, credentialVersionId }) {
  requireValue(peer?.containerId && uuid(peer.tenantDatabaseId, 'peer tenant database ID') &&
    uuid(peer.databaseGeneration, 'peer database generation'), 'invalid project peer');
  const dbRef = uuid(databaseRef, 'database ref');
  const runtimeRole = uuid(roleRef, 'runtime role ref');
  const credential = uuid(credentialVersionId, 'credential version ID');
  return Object.freeze({ ...peer, databaseRef: dbRef, roleRef: runtimeRole,
    roleName: `ha_${runtimeRole.replaceAll('-', '')}`, credentialVersionId: credential });
}

// Backups are role-free custom PostgreSQL archives. Tenant M3 archives should normally use
// hostlet-database's fenced backup/export operation; this helper supports the isolated drill.
export async function backupDatabase({ stateDir, source, archivePath, database = 'postgres' }) {
  safeName(database, 'database name');
  requireValue(ID.test(source?.containerId ?? '') && source?.passwordFile && source?.containerName && source?.volumeName && source?.image, 'source database identity required');
  requireValue(source.runId === await identity(stateDir), 'backup source run identity mismatch');
  const wanted = labels({ kind: source.kind, runId: source.runId, databaseId: source.databaseId, generation: source.databaseGeneration, recoveryId: source.recoveryId, restore: source.restore });
  const inspected = await inspectContainer(source.containerName, wanted, { imagePin: source.image, volume: source.volumeName, passwordFile: source.passwordFile,
    network: source.kind === 'platform-postgres' ? 'bridge' : 'none', publishedPort: source.kind === 'platform-postgres' ? source.port : undefined });
  requireValue(inspected?.Id === source.containerId, 'backup source container identity drift');
  const password = await readPrivate(source.passwordFile);
  const temp = `${archivePath}.${randomUUID()}.tmp`;
  await privateDir(resolve(archivePath, '..'));
  const handle = await open(temp, 'wx', 0o600);
  try {
    await run('docker', ['exec', '--env', 'PGPASSWORD', source.containerId, 'pg_dump', '-Fc', '--no-owner', '--no-privileges', '-h', '127.0.0.1', '-U', 'postgres', '-d', database], {
      env: { ...process.env, PGPASSWORD: password }, outputFile: handle.createWriteStream({ autoClose: false }), timeoutMs: 120_000,
    });
    await handle.sync();
  } catch (error) { await handle.close(); await rm(temp, { force: true }); throw error; }
  await handle.close();
  const bytes = await readFile(temp);
  requireValue(bytes.length > 0, 'empty PostgreSQL backup');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (await exists(archivePath)) throw new Error('backup target already exists');
  await rename(temp, archivePath);
  return { archivePath, sha256, bytes: bytes.length, database, containerId: source.containerId };
}

export async function restoreDatabase({ stateDir, archivePath, sha256, restoreId, database = 'postgres' }) {
  uuid(restoreId, 'restore ID'); safeName(database, 'database name');
  const bytes = await readFile(archivePath);
  requireValue(createHash('sha256').update(bytes).digest('hex') === sha256, 'backup digest mismatch');
  const name = `hostlet-preview-restore-${restoreId.slice(0, 8)}`;
  const volume = `${name}-data`;
  // An existing target is never overwritten, even if it belongs to this preview.
  requireValue(!(await exists(join(stateDir, `${name}.password`))), 'restore target already exists');
  const runId = await identity(stateDir);
  requireValue(!(await inspectVolume(volume, labels({ kind: 'restore-postgres-data', runId, recoveryId: restoreId, restore: true }))), 'restore volume already exists');
  requireValue(!(await inspectContainer(name, labels({ kind: 'restore-postgres', runId, recoveryId: restoreId, restore: true }), { imagePin: await image(), volume, network: 'none' })), 'restore container already exists');
  const target = await ensureServer({ stateDir, kind: 'restore-postgres', name, volume, recoveryId: restoreId, restore: true });
  const password = await readPrivate(target.passwordFile);
  await run('docker', ['exec', '-i', '--env', 'PGPASSWORD', target.containerId, 'pg_restore', '--no-owner', '--no-privileges', '--exit-on-error', '-h', '127.0.0.1', '-U', 'postgres', '-d', database], {
    env: { ...process.env, PGPASSWORD: password }, input: bytes, timeoutMs: 120_000,
  });
  return { ...target, database, sourceDigest: sha256, isolated: true };
}

export async function removeTemporaryRestore({ stateDir, restoreId }) {
  uuid(restoreId, 'restore ID');
  const runId = await identity(stateDir), name = `hostlet-preview-restore-${restoreId.slice(0, 8)}`, volume = `${name}-data`;
  const row = await inspectContainer(name, labels({ kind: 'restore-postgres', runId, recoveryId: restoreId, restore: true }), { imagePin: await image(), volume, network: 'none' });
  if (row) await docker(['container', 'rm', '--force', row.Id]);
  const owned = await inspectVolume(volume, labels({ kind: 'restore-postgres-data', runId, recoveryId: restoreId, restore: true }));
  if (owned) await docker(['volume', 'rm', volume]);
  await rm(join(stateDir, `${name}.password`), { force: true });
  return { containerId: row?.Id ?? null, volumeName: owned?.Name ?? null };
}

export async function removeProjectRestoreTarget({ stateDir, tenantDatabaseId, databaseGeneration, recoveryId }) {
  const runId = await identity(stateDir);
  const databaseId = uuid(tenantDatabaseId, 'tenant database ID');
  const generation = uuid(databaseGeneration, 'tenant database generation');
  const replacement = uuid(recoveryId, 'recovery ID');
  const name = `hostlet-preview-project-restore-${replacement.slice(0, 8)}`;
  const volume = `${name}-data`;
  const containerLabels = labels({ kind: 'tenant-postgres', runId, databaseId, generation, recoveryId: replacement, restore: true });
  const volumeLabels = labels({ kind: 'tenant-postgres-data', runId, databaseId, generation, recoveryId: replacement, restore: true });
  const inventoryPath = join(stateDir, 'database-inventory.json');
  const inventory = JSON.parse(await readPrivate(inventoryPath));
  const target = inventory.targets?.find(t => t.recovery_id === replacement);
  requireValue(target?.tenant_database_id === databaseId && target.database_generation === generation && target.restore_target === true,
    'replacement inventory identity mismatch');
  const row = await inspectContainer(name, containerLabels, { imagePin: await image(), volume, passwordFile: join(stateDir, `${name}.password`), network: 'none' });
  requireValue(row?.Id === target.container_id, 'replacement container identity mismatch');
  const owned = await inspectVolume(volume, volumeLabels);
  requireValue(owned, 'replacement volume identity mismatch');
  await docker(['container', 'rm', '--force', row.Id]);
  await docker(['volume', 'rm', volume]);
  inventory.targets = inventory.targets.filter(t => t.recovery_id !== replacement);
  await writeAtomic(inventoryPath, `${JSON.stringify(inventory)}\n`);
  await rm(join(stateDir, `${name}.password`), { force: true });
  return { containerId: row.Id, volumeName: volume, inventoryPath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, configPath] = process.argv.slice(2);
  try {
    requireValue(configPath, 'usage: node scripts/beta/database.mjs <ensure-platform|ensure-project> <private-config.json>');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    const p = config.postgres ?? {};
    const result = command === 'ensure-platform'
      ? await ensurePlatformDatabase({ stateDir: config.stateDir, port: p.platform?.port, connectionUrlFile: p.platform?.connectionUrlFile })
      : command === 'ensure-project'
        ? await ensureProjectTarget({ stateDir: config.stateDir, ...p.project })
        : (() => { throw new Error('unknown database command'); })();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
