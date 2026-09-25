import { randomBytes, createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, lstatSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const cleanEnv = () => Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR'].filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const exact = (program, args, { env = cleanEnv(), input, timeout = 30000 } = {}) => {
  const result = spawnSync(program, args, { env, input, encoding: 'utf8', timeout, maxBuffer: 1048576 });
  if (result.error || result.status !== 0) throw new Error(`${program} ${args[0]} failed (${result.status ?? result.error?.code})`);
  return result.stdout.trim();
};
const privateText = path => {
  const s = lstatSync(path);
  if (!s.isFile() || s.isSymbolicLink() || (s.mode & 0o077)) throw new Error('restore credential is not private');
  return readFileSync(path, 'utf8').trim();
};
const controlKeys = config => {
  const content = privateText(config.services?.envFiles?.control);
  const values = {};
  for (const line of content.split('\n')) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match) continue;
    let value = match[2];
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).replaceAll('\\"', '"');
    values[match[1]] = value;
  }
  const names = ['HOSTLET_SECRET_KEY', 'HOSTLET_RECOVERY_KEY', 'HOSTLET_WORKER_TOKEN'];
  if (names.some(name => !values[name])) throw new Error('private control key material unavailable for isolated restore');
  return Object.fromEntries(names.map(name => [name, values[name]]));
};
const dockerInspect = id => {
  const rows = JSON.parse(exact('docker', ['container', 'inspect', id]));
  if (rows.length !== 1 || rows[0].Id !== id || rows[0].State?.Running !== true) throw new Error('restore container identity or state changed');
  if (rows[0].HostConfig?.NetworkMode !== 'none' || Object.keys(rows[0].HostConfig?.PortBindings ?? {}).length) throw new Error('restore container is not isolated');
  return rows[0];
};
const grantRestoreRole = (restore, table) => {
  const password = randomBytes(32).toString('base64url');
  const role = 'restore_checker';
  const grants = table === 'journal_items'
    ? `GRANT USAGE ON SCHEMA app TO ${role}; GRANT SELECT,INSERT ON TABLE app.journal_items TO ${role}; GRANT USAGE ON SEQUENCE app.journal_items_id_seq TO ${role}; ALTER ROLE ${role} SET search_path=app,pg_catalog;`
    : `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}; GRANT INSERT ON TABLE public.sessions,public.audit_events TO ${role}; GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${role};`;
  const statement = `CREATE ROLE ${role} LOGIN PASSWORD '${password}'; GRANT CONNECT ON DATABASE postgres TO ${role}; GRANT USAGE ON SCHEMA public TO ${role}; ${grants}`;
  exact('docker', ['exec', '-i', '--env', 'PGPASSWORD', restore.containerId, 'psql', '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'postgres', '-q', '-f', '-'], { env: { ...cleanEnv(), PGPASSWORD: privateText(restore.passwordFile) }, input: statement });
  return { role, password };
};
const stagedApp = (config, manifest) => {
  const ids = manifest.build?.artifactIds;
  if (!Array.isArray(ids) || ids.length < 1) throw new Error('built application artifact identity missing');
  const candidates = ids.map(id => {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('invalid build artifact identity');
    const dir = join(config.stateDir, 'staged-build-artifacts', `artifact-${id}`);
    const marker = join(dir, '.hostlet-artifact-owned');
    const metadata = join(dir, 'manifest.json');
    if (!existsSync(marker) || !existsSync(metadata)) throw new Error('built artifact staging missing');
    const record = JSON.parse(readFileSync(metadata, 'utf8'));
    if (record.artifact_id !== id || privateText(marker) !== record.archive_digest || record.schema !== 'hostlet.e2e-staged-build-artifact/v1') throw new Error('built artifact provenance mismatch');
    return { dir, record };
  });
  const apps = candidates.filter(value => value.record.kind === 'application');
  if (apps.length !== 1 || !existsSync(join(apps[0].dir, 'rootfs', 'dist', 'server.mjs')) || !existsSync(join(apps[0].dir, 'rootfs', 'node_modules', 'pg', 'package.json'))) throw new Error('pinned application output unavailable');
  return apps[0];
};
const pinnedImage = config => {
  const base = JSON.parse(readFileSync(config.runtimeNodeBases?.['24']?.manifest, 'utf8'));
  if (base.schema !== 'hostlet.runtime-base/v1' || !/^node:24-bookworm-slim@sha256:[a-f0-9]{64}$/.test(base.image)) throw new Error('pinned Node runtime base missing');
  const image = JSON.parse(exact('docker', ['image', 'inspect', base.image]));
  const repositoryDigest = `node@${base.image.split('@')[1]}`;
  if (image.length !== 1 || !/^sha256:[a-f0-9]{64}$/.test(image[0].Id) || !image[0].RepoDigests?.includes(repositoryDigest)) throw new Error('local Node image does not match runtime repository digest');
  return { image: image[0].Id, repositoryDigest, baseManifestSha256: sha(readFileSync(config.runtimeNodeBases['24'].manifest)) };
};
const stagedRootfsUser = app => {
  const rootfs = lstatSync(join(app.dir, 'rootfs'));
  if (!rootfs.isDirectory() || rootfs.isSymbolicLink() ||
      !Number.isSafeInteger(rootfs.uid) || rootfs.uid <= 0 || rootfs.uid > 4294967295 ||
      !Number.isSafeInteger(rootfs.gid) || rootfs.gid <= 0 || rootfs.gid > 4294967295) {
    throw new Error('staged application rootfs owner is not a non-root numeric user');
  }
  return `${rootfs.uid}:${rootfs.gid}`;
};

export async function probeRestoredProject({ config, manifest, restore, directory, runId, originalItemId, registerChecker = () => {}, injectFailure }) {
  dockerInspect(restore.containerId);
  const app = stagedApp(config, manifest), pinned = pinnedImage(config);
  const checkerUser = stagedRootfsUser(app);
  const credential = grantRestoreRole(restore, 'journal_items');
  const envFile = join(directory, 'project-restore-app.env');
  if (existsSync(envFile)) throw new Error('restore app credential collision');
  const name = `hostlet-m35-restore-app-${runId.toLowerCase().replaceAll(/[^a-z0-9-]/g, '-').slice(0, 42)}`;
  registerChecker({ checkerContainerName: name, envFile });
  let id, result, cleanup, primaryError;
  try {
  writeFileSync(envFile, `DATABASE_URL=postgresql://${credential.role}:${encodeURIComponent(credential.password)}@127.0.0.1:5432/postgres\nPORT=3000\n`, { flag: 'wx', mode: 0o600 });
  id = exact('docker', ['run', '-d', '--name', name, '--label', 'io.hostlet.scope=m35-gate', '--label', `io.hostlet.run-id=${runId}`, '--restart', 'no', '--network', `container:${restore.containerId}`, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '128m', '--cpus', '0.25', '--user', checkerUser, '--mount', `type=bind,source=${join(app.dir, 'rootfs')},target=/app,readonly`, '--workdir', '/app', '--env-file', envFile, '--tmpfs', '/tmp:rw,nosuid,nodev,size=16m', pinned.image, 'node', 'dist/server.mjs']);
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('restore application container ID invalid');
  const inspected = JSON.parse(exact('docker', ['container', 'inspect', id]))[0];
  if (inspected.Id !== id || inspected.Name !== `/${name}` || inspected.HostConfig.NetworkMode !== `container:${restore.containerId}` || inspected.Config.Image !== pinned.image || inspected.Config.User !== checkerUser || inspected.Config.Labels?.['io.hostlet.run-id'] !== runId || inspected.HostConfig.ReadonlyRootfs !== true || Object.keys(inspected.HostConfig.PortBindings ?? {}).length) throw new Error('restore application container identity mismatch');
  if (injectFailure === 'afterProjectCheckerStart') throw new Error('deliberate failure after owned restore checker start');
  const script = `const expected=Number(process.argv[1]), name=process.argv[2]; const base='http://127.0.0.1:3000'; const get=async()=>{const r=await fetch(base+'/api/items'); if(r.status!==200) throw Error('items read '+r.status); return r.json()}; const before=await get(); if(!before.items?.some(x=>Number(x.id)===expected)) throw Error('restored item missing'); const post=await fetch(base+'/api/items',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name})}); if(post.status!==201) throw Error('items write '+post.status); const added=(await post.json()).item; const after=await get(); if(!after.items?.some(x=>x.id===added.id&&x.name===name)) throw Error('app readback missing'); console.log(JSON.stringify({originalItemId:expected,writtenItemId:added.id,originalPresent:true,writtenPresent:true,readStatus:200,writeStatus:201}))`;
  let observed;
  for (let attempt = 0; attempt < 25; attempt++) {
    const check = spawnSync('docker', ['exec', id, 'node', '--input-type=module', '-e', script, String(originalItemId), `restored-app-${runId}`.slice(0, 80)], { env: cleanEnv(), encoding: 'utf8', timeout: 5000, maxBuffer: 16384 });
    if (check.status === 0) { observed = JSON.parse(check.stdout); break; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!observed) throw new Error('restored application HTTP probe did not pass');
  result = { observed, checkerContainerId: id, checkerContainerName: name, checkerUser, imageId: pinned.image, imageRepositoryDigest: pinned.repositoryDigest, imageManifestSha256: pinned.baseManifestSha256, artifactId: app.record.artifact_id, archiveDigest: app.record.archive_digest, artifactManifestSha256: sha(readFileSync(join(app.dir, 'manifest.json'))) };
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      cleanup = removeRestoredProjectChecker({ checkerContainerId: id, checkerContainerName: name, envFile, runId });
    } catch (cleanupError) {
      if (primaryError) throw new AggregateError([primaryError, cleanupError], `restore application probe failed: ${primaryError.message}; cleanup failed: ${cleanupError.message}`);
      throw cleanupError;
    }
  }
  if (primaryError) throw primaryError;
  return { ...result, checkerRemoved: cleanup?.removed === true };
}

export function removeRestoredProjectChecker({ checkerContainerId, checkerContainerName, envFile, runId }) {
  const inspect = spawnSync('docker', ['container', 'inspect', checkerContainerName], { env: cleanEnv(), encoding: 'utf8', timeout: 10000, maxBuffer: 16384 });
  if (inspect.error || (inspect.status !== 0 && !/No such (object|container)/i.test(inspect.stderr ?? ''))) throw new Error('restore app cleanup inspection failed');
  const inspected = inspect.status === 0 ? JSON.parse(inspect.stdout)[0] : null;
  if (inspected && (inspected.Name !== `/${checkerContainerName}` || (checkerContainerId && inspected.Id !== checkerContainerId) || inspected.Config.Labels?.['io.hostlet.scope'] !== 'm35-gate' || inspected.Config.Labels?.['io.hostlet.run-id'] !== runId)) throw new Error('restore app cleanup identity mismatch');
  if (inspected) exact('docker', ['rm', '-f', inspected.Id]);
  if (envFile && existsSync(envFile)) rmSync(envFile);
  const after = spawnSync('docker', ['container', 'inspect', checkerContainerName], { env: cleanEnv(), encoding: 'utf8', timeout: 10000, maxBuffer: 16384 });
  if (after.status === 0 || !/No such (object|container)/i.test(after.stderr ?? '')) throw new Error('restore application container remains after exact cleanup');
  return { removed: true, checkerContainerId: inspected?.Id ?? null };
}

const controlGroupMembers = pgid => exact('/usr/bin/ps', ['-eo', 'pgid=,args=']).split('\n').map(line => /^\s*(\d+)\s+(.*)$/.exec(line)).filter(match => match && Number(match[1]) === pgid).map(match => match[2]);
async function stopExactControlGroup(child, binary, namespacePid) {
  const pgid = child.pid;
  if (!Number.isInteger(pgid) || pgid <= 1) throw new Error('isolated control process group identity missing');
  const members = controlGroupMembers(pgid);
  if (!members.length) return { removed: true, pgid };
  if (!members.some(args => args.includes(binary) || args.includes(`/usr/bin/nsenter --target ${namespacePid} --net`))) throw new Error('isolated control process group identity changed');
  exact('sudo', ['-n', '/bin/kill', '-TERM', '--', `-${pgid}`]);
  for (let attempt = 0; attempt < 30; attempt++) {
    if (!controlGroupMembers(pgid).length) return { removed: true, pgid };
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const remaining = controlGroupMembers(pgid);
  if (remaining.some(args => args.includes(binary) || args.includes(`/usr/bin/nsenter --target ${namespacePid} --net`))) exact('sudo', ['-n', '/bin/kill', '-KILL', '--', `-${pgid}`]);
  for (let attempt = 0; attempt < 30; attempt++) {
    if (!controlGroupMembers(pgid).length) return { removed: true, pgid };
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('isolated control process group remains after exact cleanup');
}

export async function probeRestoredPlatform({ config, restore, ownerId, projectId, directory }) {
  const inspected = dockerInspect(restore.containerId);
  const credential = grantRestoreRole(restore, 'platform');
  const port = 18451;
  const databaseUrl = `postgresql://${credential.role}:${encodeURIComponent(credential.password)}@127.0.0.1:5432/postgres`;
  const env = { ...cleanEnv(), ...controlKeys(config), DATABASE_URL: databaseUrl, HOSTLET_API_BIND: `127.0.0.1:${port}`, HOSTLET_WORKER_BIND: '127.0.0.1:18452' };
  const binary = config.binaries?.control;
  if (!binary || !existsSync(binary)) throw new Error('pinned control binary unavailable for restore probe');
  const child = spawn('sudo', ['-n', '--preserve-env=DATABASE_URL,HOSTLET_API_BIND,HOSTLET_WORKER_BIND,HOSTLET_SECRET_KEY,HOSTLET_RECOVERY_KEY,HOSTLET_WORKER_TOKEN', '/usr/bin/nsenter', '--target', String(inspected.State.Pid), '--net', binary], { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  if (!Number.isInteger(child.pid) || child.pid <= 1) throw new Error('isolated control process failed to start');
  const stderr = [];
  child.stderr.on('data', chunk => { if (stderr.length < 10) stderr.push(chunk.length); });
  const script = `let input='';for await(const c of process.stdin) input+=c;const {email,password,ownerId,projectId,port}=JSON.parse(input);const base='http://127.0.0.1:'+port;const login=await fetch(base+'/v1/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password})});if(login.status!==201)throw Error('restore login '+login.status);const session=await login.json();if(session.account_id!==ownerId)throw Error('restore owner mismatch');const list=await fetch(base+'/v1/projects',{headers:{authorization:'Bearer '+session.token}});if(list.status!==200)throw Error('restore projects '+list.status);const payload=await list.json();if(!(payload.projects??[]).some(p=>p.id===projectId))throw Error('restore project relationship missing');const detail=await fetch(base+'/v1/projects/'+projectId,{headers:{authorization:'Bearer '+session.token}});if(detail.status!==200)throw Error('restore project detail '+detail.status);console.log(JSON.stringify({loginStatus:201,projectListStatus:200,projectDetailStatus:200,ownerId,projectId,sessionWritten:true}))`;
  let observed, result, cleanup, primaryError;
  try {
    for (let attempt = 0; attempt < 30; attempt++) {
      if (child.exitCode !== null) throw new Error('isolated control binary exited before readiness');
      const probe = spawnSync('sudo', ['-n', '/usr/bin/nsenter', '--target', String(inspected.State.Pid), '--net', '/usr/bin/node', '--input-type=module', '-e', script], { env: cleanEnv(), input: JSON.stringify({ email: config.owner.email, password: privateText(config.owner.passwordFile), ownerId, projectId, port }), encoding: 'utf8', timeout: 5000, maxBuffer: 16384 });
      if (probe.status === 0) { observed = JSON.parse(probe.stdout); break; }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!observed) throw new Error('isolated control HTTP login/project probe did not pass');
    result = { observed, controlBinarySha256: sha(readFileSync(binary)), networkNamespaceContainerId: restore.containerId, networkNamespacePid: inspected.State.Pid };
  } catch (error) {
    primaryError = error;
  } finally {
    try { cleanup = await stopExactControlGroup(child, binary, inspected.State.Pid); }
    catch (cleanupError) {
      if (primaryError) throw new AggregateError([primaryError, cleanupError], `restore platform probe failed: ${primaryError.message}; cleanup failed: ${cleanupError.message}`);
      throw cleanupError;
    }
  }
  if (primaryError) throw primaryError;
  return { ...result, checkerRemoved: cleanup.removed, checkerProcessGroup: cleanup.pgid };
}
