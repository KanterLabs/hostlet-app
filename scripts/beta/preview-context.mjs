import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, lstatSync, writeFileSync, closeSync, fsyncSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createServer } from "node:net";
import { requestJson } from "../../e2e/support/http-client.mjs";
import { operateManagedUnit } from "./managed-services.mjs";

const ROLES = Object.freeze({ build: "HOSTLET_M3_BUILD_TOKEN", database: "HOSTLET_M3_DATABASE_TOKEN", runtime: "HOSTLET_M3_RUNTIME_TOKEN", publisher: "HOSTLET_M3_PUBLISHER_TOKEN" });
const HOST_ENV = Object.freeze(["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TZ", "TMPDIR", "RUST_BACKTRACE"]);
const hostEnvironment = () => Object.fromEntries(HOST_ENV.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
const emptyManifest = () => ({ schema: "hostlet.beta.preview/v1", generation: 0, identity: {}, source: {}, admission: {}, build: {}, evaluators: {}, database: {}, runtime: {}, release: {}, portfolio: {} });
export const readPreviewSecret = (path) => {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error(`preview credential file must be private: ${path}`);
  return readFileSync(path, "utf8").trim();
};
const secret = readPreviewSecret;
const privateDirectory = (path) => {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error(`preview directory must be private: ${path}`);
};

export function loadPreviewConfig(path) {
  const config = JSON.parse(readFileSync(resolve(path), "utf8"));
  if (config.schema !== "hostlet.beta.config/v1") throw new Error("unsupported preview config schema");
  if (!isAbsolute(config.stateDir)) throw new Error("stateDir must be absolute");
  for (const key of ["apiUrl", "workerUrl"]) {
    const url = new URL(config[key]);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error(`${key} must be a literal loopback HTTP origin`);
  }
  for (const actor of ["owner", "operator", "otherOwner"]) for (const key of ["email", "displayName", "passwordFile", "githubLogin"]) {
    if (!config[actor]?.[key]) throw new Error(`${actor}.${key} is required`);
  }
  for (const actor of ["owner", "operator", "otherOwner"]) {
    if (!/^[a-z0-9][a-z0-9-]{0,38}$/.test(config[actor].githubLogin)) throw new Error(`${actor}.githubLogin is invalid`);
  }
  for (const [role] of Object.entries(ROLES)) if (!config.roles?.[`${role}TokenFile`]) throw new Error(`roles.${role}TokenFile is required`);
  if (!config.roles?.admissionTokenFile) throw new Error("roles.admissionTokenFile is required");
  return Object.freeze(config);
}

export function createPreviewContext(config) {
  privateDirectory(config.stateDir);
  const manifestPath = join(config.stateDir, "identity-manifest.json");
  const readManifest = () => {
    if (!existsSync(manifestPath)) return emptyManifest();
    const stat = lstatSync(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("preview identity manifest must be a private regular file");
    const value = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (value.schema !== "hostlet.beta.preview/v1" || !Number.isSafeInteger(value.generation)) throw new Error("invalid preview identity manifest");
    return value;
  };
  const updateManifest = (patch) => {
    const current = readManifest();
    const next = { ...current, generation: current.generation + 1 };
    for (const [key, value] of Object.entries(patch)) {
      if (!["identity", "source", "admission", "build", "evaluators", "database", "runtime", "release", "portfolio", "provider"].includes(key) || !value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid preview manifest section: ${key}`);
      next[key] = { ...current[key], ...value };
    }
    atomicWrite(manifestPath, next);
    return next;
  };
  const roleToken = (role) => {
    if (!Object.hasOwn(ROLES, role)) throw new Error(`unknown preview role: ${role}`);
    const value = secret(config.roles[`${role}TokenFile`]);
    sensitiveValues.add(value);
    return value;
  };
  const policyClock = { stateDir: config.stateDir, path: null, current: () => ({ schema_version: 1, now: new Date().toISOString() }) };
  const repo = resolve(import.meta.dirname, "../..");
  const artifactDir = join(config.stateDir, "bootstrap-artifacts");
  privateDirectory(artifactDir);
  const processRecords = [];
  const cleanups = [];
  const state = { runId: "m35-preview", configuration: {}, toolchains: {}, processes: processRecords, cleanup: [], owner: null, graph: null };
  const sensitiveValues = new Set();
  const redact = (value) => {
    let result = String(value);
    for (const secret of sensitiveValues) if (secret) result = result.replaceAll(secret, "[REDACTED]");
    return result;
  };
  const fileSha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const registerSensitiveValues = (values) => { for (const value of values) if (typeof value === "string" && value.length > 0) sensitiveValues.add(value); };
  const registerFixture = () => {};
  const registerCleanup = (name, callback) => cleanups.push({ name, callback });
  const runCleanups = async () => {
    const failures = [];
    for (const item of cleanups.splice(0).reverse()) {
      try { await item.callback(); state.cleanup.push({ resource: item.name, result: "completed" }); }
      catch (error) { failures.push(`${item.name}: ${error.message}`); state.cleanup.push({ resource: item.name, result: "failed" }); }
    }
    if (failures.length) throw new Error(`preview temporary cleanup failed: ${failures.join("; ")}`);
  };
  const delay = (ms) => new Promise((done) => setTimeout(done, ms));
  const allocatePort = () => new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? fail(error) : done(address.port));
    });
  });
  const runCommand = async (name, binary, args, options = {}) => {
    const result = await processCommand(binary, args, options);
    const logPath = join(artifactDir, options.logName ?? `${randomBytes(8).toString("hex")}.log`);
    writeFileSync(logPath, redact(`${result.stdout}${result.stderr}`), { mode: 0o600 });
    processRecords.push({ name, exitCode: result.code, log: logPath });
    return { ...result, logPath };
  };
  const spawnManaged = (name, binary, args, options = {}, logName = `${randomBytes(8).toString("hex")}.log`) => {
    const managedShort = config.services?.managedProcessDispatch === true
      ? ({ "M3 owned TLS release gateway": "demo-gateway", "M3 coordinated release worker": "runtime" })[name]
      : null;
    if (managedShort) {
      const expected = { user: config.services.user, group: config.services.group };
      operateManagedUnit("start", managedShort, expected);
      const record = { name, managedUnit: managedShort, exitCode: null, signal: null, stoppedAt: null };
      processRecords.push(record);
      return { name, managedUnit: managedShort, child: { exitCode: null }, exited: new Promise(() => {}), record, stopped: false };
    }
    const child = spawn(binary, args, { cwd: options.cwd ?? repo, env: options.env ?? hostEnvironment(), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (bytes) => { output += bytes; });
    child.stderr.on("data", (bytes) => { output += bytes; });
    const logPath = join(artifactDir, logName);
    const record = { name, pid: child.pid, log: logPath, exitCode: null, signal: null, stoppedAt: null };
    processRecords.push(record);
    const exited = new Promise((done) => {
      let completed = false;
      const finish = (code, signal, error) => {
        if (completed) return;
        completed = true;
        record.exitCode = code; record.signal = signal; record.stoppedAt = new Date().toISOString();
        if (error) output += `\nspawn failed: ${error.message}\n`;
        writeFileSync(logPath, redact(output), { mode: 0o600 });
        done({ code, signal, error });
      };
      child.once("exit", (code, signal) => finish(code, signal, null));
      child.once("error", (error) => finish(null, "spawn_error", error));
    });
    return { name, child, exited, record, stopped: false };
  };
  const stopManaged = async (handle, reason = "stop") => {
    if (handle.stopped) return;
    handle.stopped = true;
    if (handle.managedUnit) {
      operateManagedUnit("stop", handle.managedUnit, { user: config.services.user, group: config.services.group });
      handle.record.stoppedAt = new Date().toISOString();
      state.cleanup.push({ resource: handle.name, action: reason });
      return;
    }
    if (handle.record.stoppedAt === null) {
      try { process.kill(-handle.child.pid, "SIGTERM"); } catch { handle.child.kill("SIGTERM"); }
      await Promise.race([handle.exited, delay(5_000)]);
      if (handle.record.stoppedAt === null) {
        try { process.kill(-handle.child.pid, "SIGKILL"); } catch { handle.child.kill("SIGKILL"); }
        await Promise.race([handle.exited, delay(5_000)]);
      }
      if (handle.record.stoppedAt === null) throw new Error(`managed process ${handle.name} did not exit after stop`);
    }
    state.cleanup.push({ resource: handle.name, action: reason });
  };
  const waitForHttp = async (url, expectedStatus = 200, label = url) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      try { const response = await fetch(url, { signal: AbortSignal.timeout(2_000) }); if (response.status === expectedStatus) return response; } catch { /* bounded retry */ }
      await delay(200);
    }
    throw new Error(`${label} did not become ready`);
  };
  const call = (path, options = {}) => requestJson(config.apiUrl, path, options);
  const roleInternal = (role, path, options = {}) => {
    return requestJson(config.workerUrl, path, { ...options, token: roleToken(role) });
  };
  const admissionInternal = (path, options = {}) => {
    const token = secret(config.roles.admissionTokenFile);
    sensitiveValues.add(token);
    return requestJson(config.workerUrl, path, { ...options, token });
  };
  const componentEnvironment = (role, overrides = {}) => {
    const token = roleToken(role);
    return { ...hostEnvironment(), HOSTLET_M3_MODE: "owned_fixture", HOSTLET_M3_STATE_DIR: config.stateDir,
      [ROLES[role]]: token, ...overrides };
  };
  let ownerToken = null;
  const signIn = async () => {
    const password = secret(config.owner.passwordFile);
    sensitiveValues.add(password);
    const response = await call("/v1/sessions", { method: "POST", body: { email: config.owner.email, password } });
    if (response.status !== 201 || !response.payload?.token) throw new Error(`owner sign-in failed (${response.status})`);
    ownerToken = response.payload.token;
    return response.payload;
  };
  const ownerHTTP = async (path, options = {}) => {
    if (!ownerToken) await signIn();
    let result = await call(path, { ...options, token: ownerToken });
    if (result.status === 401) { await signIn(); result = await call(path, { ...options, token: ownerToken }); }
    return result;
  };
  return Object.freeze({ config, repo, tempDir: config.stateDir, artifactDir, apiUrl: config.apiUrl, workerUrl: config.workerUrl, stateDir: config.stateDir,
    manifestPath, policyClock, readManifest, manifest: readManifest, updateManifest, call, signIn, ownerHTTP,
    roleInternal, admissionInternal, componentEnvironment, environmentForComponent: componentEnvironment, state, processes: processRecords,
    runCommand, spawnManaged, stopManaged, waitForHttp, delay, allocatePort, fileSha256, redact,
    registerFixture, registerSensitiveValues,
    registerCleanup, runCleanups, cleanups, abortSignal: new AbortController().signal });
}

export async function createPreviewM3(context) {
  const manifest = context.readManifest();
  if (!manifest.identity?.ownerId) throw new Error("preview owner must be seeded before M3 adapter hydration");
  const session = await context.signIn();
  if (session.account_id !== manifest.identity.ownerId) throw new Error("preview owner session differs from private manifest");
  context.state.owner = { record: { id: session.account_id }, token: session.token };
  if (manifest.identity.projectId) {
    const graph = await context.ownerHTTP(`/v1/projects/${manifest.identity.projectId}`);
    if (graph.status !== 200) throw new Error(`preview project unavailable (${graph.status})`);
    context.state.graph = graph.payload;
  }
  return Object.freeze({ context, state: context.state, apiUrl: context.apiUrl, workerUrl: context.workerUrl,
    policyClock: context.policyClock, call: context.call, ownerHTTP: context.ownerHTTP,
    roleInternal: context.roleInternal, componentEnvironment: context.componentEnvironment,
    environmentForComponent: context.componentEnvironment, currentApiBinary: context.config.binaries.control,
    extraEnvironment: { HOSTLET_M3_RUNTIME_TOKEN: secret(context.config.roles.runtimeTokenFile) } });
}

function processCommand(binary, args, { cwd, env, timeoutMs = 120_000 } = {}) {
  return new Promise((done, fail) => {
    const child = spawn(binary, args, { cwd, env: env ?? hostEnvironment(), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let settled = false;
    child.stdout.on("data", (bytes) => { stdout += bytes; });
    child.stderr.on("data", (bytes) => { stderr += bytes; });
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
      fail(new Error(`${binary} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("error", (error) => { if (settled) return; settled = true; clearTimeout(timeout); fail(error); });
    child.once("exit", (code, signal) => { if (settled) return; settled = true; clearTimeout(timeout); done({ code, signal, stdout, stderr }); });
  });
}

function atomicWrite(path, value, exclusive = false) {
  privateDirectory(dirname(path));
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor); descriptor = undefined;
    chmodSync(temporary, 0o600);
    if (exclusive && existsSync(path)) return;
    renameSync(temporary, path);
    const dir = openSync(dirname(path), "r");
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
