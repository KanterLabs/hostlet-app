#!/usr/bin/env node

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import { scaffoldScenario } from "./scenarios/scaffold.mjs";

const REPO = resolve(import.meta.dirname, "..");
const DEFAULT_ARTIFACT_ROOT = join(REPO, "artifacts", "e2e");
const DEFAULT_CHROMIUM = "/snap/bin/chromium";
const startedAt = new Date();
const runId = `${startedAt.toISOString().replaceAll(":", "").replaceAll(".", "-")}-${process.pid}-${randomBytes(3).toString("hex")}`;

const args = {
  milestone: "M1",
  artifactRoot: DEFAULT_ARTIFACT_ROOT,
  chromium: process.env.HOSTLET_E2E_CHROMIUM || DEFAULT_CHROMIUM,
  requireClean: false,
  injectFailure: false,
  operationTimeoutMs: 30_000,
  runTimeoutMs: 180_000,
  scenarioModules: [],
};

function usage() {
  return `Usage: node e2e/run.mjs [options]

Options:
  --milestone NAME          Artifact milestone directory (default: M1)
  --artifact-root PATH      Artifact root (default: artifacts/e2e)
  --chromium PATH           Chromium executable (default: /snap/bin/chromium)
  --operation-timeout MS    Per-operation timeout (default: 30000)
  --run-timeout MS          Whole-run timeout (default: 180000)
  --scenario-module PATH    Append a scenario module exporting a scenario object
  --require-clean           Fail unless the source tree is clean
  --inject-failure          Deliberately falsify one browser oracle and fail
  --help                    Show this help without creating a run
`;
}

if (process.argv.slice(2).includes("--help")) {
  process.stdout.write(usage());
  process.exit(0);
}

let parseError = null;
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  const next = () => {
    index += 1;
    if (index >= process.argv.length) throw new Error(`${argument} requires a value`);
    return process.argv[index];
  };
  try {
    if (argument === "--milestone") args.milestone = next();
    else if (argument === "--artifact-root") args.artifactRoot = resolve(REPO, next());
    else if (argument === "--chromium") args.chromium = resolve(next());
    else if (argument === "--operation-timeout") args.operationTimeoutMs = positiveInteger(next(), argument);
    else if (argument === "--run-timeout") args.runTimeoutMs = positiveInteger(next(), argument);
    else if (argument === "--scenario-module") args.scenarioModules.push(resolve(REPO, next()));
    else if (argument === "--require-clean") args.requireClean = true;
    else if (argument === "--inject-failure") args.injectFailure = true;
    else throw new Error(`unknown argument: ${argument}`);
  } catch (error) {
    parseError = error;
    break;
  }
}

function positiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} requires a positive integer`);
  return parsed;
}

if (!/^[A-Za-z0-9._-]+$/.test(args.milestone) || args.milestone === "." || args.milestone === "..") {
  parseError = new Error("milestone may contain only letters, digits, dot, underscore, and dash");
}

const artifactMilestone = parseError && !/^[A-Za-z0-9_-]+$/.test(args.milestone)
  ? "invalid-input"
  : args.milestone;
const artifactDir = join(args.artifactRoot, artifactMilestone, runId);
const logDir = join(artifactDir, "logs");
const browserDir = join(artifactDir, "browser");
const tempDir = join(REPO, ".local", "e2e", runId);
mkdirSync(logDir, { recursive: true, mode: 0o700 });
mkdirSync(browserDir, { recursive: true, mode: 0o700 });
mkdirSync(tempDir, { recursive: true, mode: 0o700 });
chmodSync(artifactDir, 0o700);

const effectiveRunnerArgs = [...process.argv.slice(2)];
if (!effectiveRunnerArgs.includes("--chromium")) effectiveRunnerArgs.push("--chromium", args.chromium);

const state = {
  schemaVersion: 1,
  task: "HOST-241",
  milestone: args.milestone,
  runId,
  status: "running",
  injectedFailure: args.injectFailure,
  startedAt: startedAt.toISOString(),
  endedAt: null,
  durationMs: null,
  runner: { pid: process.pid, hostname: hostname() },
  source: {},
  harness: {},
  command: {
    argv: process.argv,
    effective: shellJoin([process.execPath, "e2e/run.mjs", ...effectiveRunnerArgs]),
    rerun: shellJoin([process.execPath, "e2e/run.mjs", ...effectiveRunnerArgs]),
    workingDirectory: "$REPO",
  },
  configuration: {
    bindHost: "127.0.0.1",
    dynamicPorts: true,
    operationTimeoutMs: args.operationTimeoutMs,
    runTimeoutMs: args.runTimeoutMs,
    requireClean: args.requireClean,
    artifactVisibility: "private; ignored by Git",
    deterministicSeed: "hostlet-e2e-m1-v1",
    environmentCapture: "disabled; only named non-secret configuration is recorded",
    scenarios: [scaffoldScenario.id],
  },
  prerequisites: [],
  toolchains: {},
  fixtures: [],
  processes: [],
  assertions: [],
  productOutputs: {},
  cleanup: [],
  errors: [],
  retained: [],
};

const manifestPath = join(artifactDir, "manifest.json");
const reportPath = join(artifactDir, "REPORT.md");
const assertionsPath = join(artifactDir, "assertions.json");

writeFileSync(manifestPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
writeFileSync(reportPath, `# Hostlet E2E run ${runId}\n\nStatus: **RUNNING**\n`, { mode: 0o600 });

const managed = [];
const resourceCleanups = [];
const sensitiveValues = new Set();
const runAbortController = new AbortController();
let rejectRunAbort;
const runAborted = new Promise((_, reject) => {
  rejectRunAbort = reject;
});
// A deadline can fire before the bottom-level race is installed during module setup.
runAborted.catch(() => {});
let shutdownChain = Promise.resolve();
let interruptedSignal = null;
let fatalError = null;
let finalized = false;
let shutdownStarted = false;
let finalizationIncomplete = false;
let artifactCommitted = false;
let phase = "initialization";

const requiredAssertions = [...scaffoldScenario.requiredAssertions];
const scenarioExtensions = [];

const runDeadline = setTimeout(() => {
  abortRun(new Error(`whole run exceeded ${args.runTimeoutMs}ms`), "timeout");
}, args.runTimeoutMs);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (interruptedSignal || artifactCommitted) return;
    interruptedSignal = signal;
    abortRun(new Error(`received ${signal}`), "interrupted");
  });
}

function abortRun(error, kind) {
  if (runAbortController.signal.aborted) return;
  fatalError = error;
  state.errors.push({ phase, message: redact(error.message), kind });
  runAbortController.abort(error);
  rejectRunAbort(error);
}

function ensureStartAllowed(label, { cleanup = false } = {}) {
  // Explicit cleanup calls may also come from an extension's finally block
  // while the central abort is stopping processes. They still have command
  // deadlines and may act only on resources owned by that extension's run.
  if (cleanup) return;
  if (shutdownStarted || runAbortController.signal.aborted) {
    throw new Error(`${label} cannot start after runner shutdown began`);
  }
}

function shellJoin(values) {
  return values.map((value) => `'${String(value).replaceAll("'", `'\\''`)}'`).join(" ");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fileSha256(path) {
  return sha256(readFileSync(path));
}

function redact(value) {
  let redacted = String(value).replaceAll(REPO, "$REPO");
  for (const sensitive of [...sensitiveValues].sort((left, right) => right.length - left.length)) {
    redacted = redacted.replaceAll(sensitive, "[REDACTED]");
  }
  return redacted
    .replace(/(authorization\s*[:=]\s*)[^\r\n]*/gi, "$1[REDACTED]")
    .replace(
      /((?:["']?(?:authorization|(?:access[_-]?)?token|password|secret|api[_-]?key|database_url|recovery[_-]?key|private[_-]?key)["']?)\s*[:=]\s*)(["'])[^"'\r\n]*\2/gi,
      "$1$2[REDACTED]$2",
    )
    .replace(
      /((?:authorization|(?:access[_-]?)?token|password|secret|api[_-]?key|database_url|recovery[_-]?key|private[_-]?key)\s*[:=]\s*)[^\s,}\r\n]*/gi,
      "$1[REDACTED]",
    )
    .replace(/(postgres(?:ql)?:\/\/)[^\s@]+@/gi, "$1[REDACTED]@");
}

function registerSensitiveValues(values) {
  for (const value of values || []) {
    if (typeof value === "string" && value.length > 0) sensitiveValues.add(value);
  }
}

function git(...gitArgs) {
  const result = spawnSync("git", gitArgs, { cwd: REPO, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${gitArgs[0]} failed: ${redact(result.stderr).trim()}`);
  return result.stdout.trimEnd();
}

function commandVersion(command, commandArgs = ["--version"]) {
  const result = spawnSync(command, commandArgs, { cwd: REPO, encoding: "utf8", timeout: 10_000 });
  if (result.error || result.status !== 0) {
    return { ok: false, observed: redact(result.error?.message || result.stderr || `exit ${result.status}`).trim() };
  }
  return { ok: true, observed: redact(`${result.stdout}${result.stderr}`).trim().split("\n")[0] };
}

function assertion(id, scenario, expected, observed, passed, details = null) {
  const item = {
    id,
    scenario,
    required: true,
    expected,
    observed,
    passed: Boolean(passed),
    details,
    checkedAt: new Date().toISOString(),
  };
  state.assertions.push(item);
  return item.passed;
}

function recordPrerequisite(name, result) {
  state.prerequisites.push({ name, required: true, passed: result.ok, observed: result.observed });
  if (!result.ok) throw new Error(`missing prerequisite ${name}: ${result.observed}`);
  state.toolchains[name] = result.observed;
}

function treeDigest(paths) {
  const entries = [];
  for (const path of [...paths].sort()) {
    if (!existsSync(path)) {
      entries.push(`${relative(REPO, path)}\0MISSING`);
      continue;
    }
    entries.push(`${relative(REPO, path)}\0${fileSha256(path)}`);
  }
  return sha256(`${entries.join("\n")}\n`);
}

function sourceIdentity() {
  const commit = git("rev-parse", "HEAD");
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  const status = git("status", "--porcelain=v1", "--untracked-files=all");
  const diff = git("diff", "--binary", "HEAD", "--", ".");
  const untracked = status
    .split("\n")
    .filter((line) => line.startsWith("?? "))
    .map((line) => join(REPO, line.slice(3)))
    .filter((path) => existsSync(path) && statSync(path).isFile());
  const untrackedReceipt = untracked
    .sort()
    .map((path) => `${relative(REPO, path)}\0${fileSha256(path)}`)
    .join("\n");
  state.source = {
    commit,
    branch,
    dirty: status.length > 0,
    statusEntryCount: status ? status.split("\n").length : 0,
    diffSha256: sha256(`${diff}\n${untrackedReceipt}`),
  };
  state.harness = {
    revisionSha256: treeDigest([
      join(REPO, "e2e", "README.md"),
      join(REPO, "e2e", "run.mjs"),
      join(REPO, "e2e", "scenarios", "scaffold.mjs"),
      join(REPO, "Makefile"),
      join(REPO, "web", "vite.config.ts"),
    ]),
    files: ["e2e/README.md", "e2e/run.mjs", "e2e/scenarios/scaffold.mjs", "Makefile", "web/vite.config.ts"],
  };
  assertion(
    "source-policy",
    "source",
    args.requireClean ? "clean Git source tree" : "source state recorded; dirty local runs allowed",
    state.source.dirty ? "dirty" : "clean",
    !args.requireClean || !state.source.dirty,
  );
  if (args.requireClean && state.source.dirty) throw new Error("gate requires a clean source tree");
}

function markAbandonedRuns() {
  const milestoneDir = join(args.artifactRoot, args.milestone);
  if (!existsSync(milestoneDir)) return;
  for (const entry of readdirSync(milestoneDir)) {
    if (entry === runId) continue;
    const priorDir = join(milestoneDir, entry);
    const priorManifest = join(priorDir, "manifest.json");
    if (!existsSync(priorManifest)) continue;
    try {
      const prior = JSON.parse(readFileSync(priorManifest, "utf8"));
      if (prior.status !== "running" || prior.runner?.hostname !== hostname()) continue;
      try {
        process.kill(prior.runner.pid, 0);
        continue;
      } catch {
        // A dead same-host PID means the prior runner cannot finalize itself.
      }
      prior.status = "abandoned";
      prior.endedAt = new Date().toISOString();
      prior.errors ||= [];
      prior.errors.push({ phase: "recovery", kind: "hard-interruption", message: `marked abandoned by ${runId}; prior PID was not alive` });
      writeFileSync(priorManifest, `${JSON.stringify(prior, null, 2)}\n`, { mode: 0o600 });
      const priorReport = join(priorDir, "REPORT.md");
      appendFileSync(priorReport, `\nRecovered status: **ABANDONED**\n\nThe next runner found the recorded process absent. This run cannot pass a gate.\n`);
      writeChecksums(priorDir);
    } catch (error) {
      state.errors.push({ phase: "recovery", kind: "warning", message: `could not inspect prior run ${entry}: ${redact(error.message)}` });
    }
  }
}

function allocatePort() {
  ensureStartAllowed("port allocation");
  return new Promise((resolvePromise, reject) => {
    const server = net.createServer();
    let settled = false;
    server.unref();
    const finish = (error, port) => {
      if (settled) return;
      settled = true;
      runAbortController.signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolvePromise(port);
    };
    const onAbort = () => {
      server.close(() => finish(runAbortController.signal.reason));
      finish(runAbortController.signal.reason);
    };
    runAbortController.signal.addEventListener("abort", onAbort, { once: true });
    server.once("error", (error) => finish(error));
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => finish(error, port));
    });
  });
}

function spawnManaged(name, command, commandArgs, options, logName) {
  ensureStartAllowed(name);
  const logPath = join(logDir, logName);
  writeFileSync(logPath, "", { mode: 0o600 });
  const child = spawn(command, commandArgs, {
    cwd: options.cwd || REPO,
    env: options.env || process.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const record = {
    name,
    pid: child.pid,
    command: redact(shellJoin([command, ...commandArgs])),
    log: relative(artifactDir, logPath),
    startedAt: new Date().toISOString(),
    stoppedAt: null,
    exitCode: null,
    signal: null,
    cleanup: null,
  };
  state.processes.push(record);
  const exited = new Promise((resolvePromise) => {
    child.once("error", (error) => {
      stderr += `${error.message}\n`;
      record.exitCode = -1;
      record.stoppedAt = new Date().toISOString();
      writeFileSync(logPath, redact(`${stdout}${stderr}`), { mode: 0o600 });
      resolvePromise({ code: -1, signal: null, error });
    });
    child.once("exit", (code, signal) => {
      record.exitCode = code;
      record.signal = signal;
      record.stoppedAt = new Date().toISOString();
      writeFileSync(logPath, redact(`${stdout}${stderr}`), { mode: 0o600 });
      resolvePromise({ code, signal });
    });
  });
  const managedProcess = { name, child, exited, record, stopped: false };
  managed.push(managedProcess);
  return managedProcess;
}

async function stopManaged(item, reason) {
  if (!item || item.stopped) return;
  item.stopped = true;
  let outcome = "already exited";
  if (item.child.exitCode === null && item.child.signalCode === null) {
    outcome = "SIGTERM";
    signalGroup(item.child, "SIGTERM");
    const exited = await Promise.race([
      item.exited.then(() => true),
      delay(5_000, { ignoreAbort: true }).then(() => false),
    ]);
    if (!exited) {
      outcome = "SIGTERM then SIGKILL";
      signalGroup(item.child, "SIGKILL");
      await Promise.race([item.exited, delay(2_000, { ignoreAbort: true })]);
    }
  }
  item.record.cleanup = `${reason}: ${outcome}`;
  state.cleanup.push({ resource: item.name, action: reason, result: outcome });
}

function signalGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Exit observation remains authoritative.
    }
  }
}

function delay(ms, { ignoreAbort = false } = {}) {
  if (!ignoreAbort && runAbortController.signal.aborted) {
    return Promise.reject(runAbortController.signal.reason);
  }
  return new Promise((resolvePromise, reject) => {
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      reject(runAbortController.signal.reason);
    };
    timer = setTimeout(() => {
      runAbortController.signal.removeEventListener("abort", onAbort);
      resolvePromise();
    }, ms);
    if (!ignoreAbort) {
      runAbortController.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

async function withTimeout(label, fn, timeoutMs = args.operationTimeoutMs) {
  ensureStartAllowed(label);
  let timeout;
  let onAbort;
  try {
    return await Promise.race([
      fn(runAbortController.signal),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
      new Promise((_, reject) => {
        onAbort = () => reject(runAbortController.signal.reason);
        runAbortController.signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    runAbortController.signal.removeEventListener("abort", onAbort);
  }
}

async function runCommand(
  name,
  command,
  commandArgs,
  {
    cwd = REPO,
    env = process.env,
    timeoutMs = args.operationTimeoutMs,
    logName,
    cleanup = false,
  },
) {
  ensureStartAllowed(name, { cleanup });
  const logPath = join(logDir, logName);
  writeFileSync(logPath, "", { mode: 0o600 });
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, commandArgs, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const record = {
      name,
      pid: child.pid,
      command: redact(shellJoin([command, ...commandArgs])),
      log: relative(artifactDir, logPath),
      startedAt: new Date().toISOString(),
      stoppedAt: null,
      exitCode: null,
      signal: null,
      cleanup: null,
      transient: true,
    };
    state.processes.push(record);
    let resolveExited;
    const exited = new Promise((resolveExit) => { resolveExited = resolveExit; });
    const managedProcess = { name, child, exited, record, stopped: false, cleanupCommand: cleanup };
    managed.push(managedProcess);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    let killTimer;
    let terminating = false;
    const terminate = () => {
      if (terminating) return;
      terminating = true;
      signalGroup(child, "SIGTERM");
      killTimer = setTimeout(() => signalGroup(child, "SIGKILL"), 1_000);
      killTimer.unref();
    };
    const onAbort = () => terminate();
    if (!cleanup) {
      runAbortController.signal.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(() => {
      if (settled) return;
      terminate();
      settled = true;
      const output = redact(`${stdout}${stderr}`);
      writeFileSync(logPath, output, { mode: 0o600 });
      record.cleanup = "operation timeout: SIGTERM then SIGKILL if needed";
      reject(new Error(`${name} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("error", (error) => {
      record.exitCode = -1;
      record.stoppedAt = new Date().toISOString();
      resolveExited({ code: -1, signal: null, error });
      clearTimeout(killTimer);
      runAbortController.signal.removeEventListener("abort", onAbort);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      writeFileSync(logPath, redact(`${stdout}${stderr}${error.message}\n`), { mode: 0o600 });
      reject(error);
    });
    child.once("exit", (code, signal) => {
      record.exitCode = code;
      record.signal = signal;
      record.stoppedAt = new Date().toISOString();
      resolveExited({ code, signal });
      clearTimeout(killTimer);
      runAbortController.signal.removeEventListener("abort", onAbort);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      writeFileSync(logPath, redact(`${stdout}${stderr}`), { mode: 0o600 });
      resolvePromise({ code, signal, stdout, stderr, logPath });
    });
  });
}

function scaffoldEnvironment(overrides = {}) {
  const environment = {};
  for (const name of ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TZ", "TMPDIR"]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  Object.assign(environment, overrides);
  state.configuration.scaffoldEnvironmentPolicy = {
    allowedVariableNames: Object.keys(environment).sort(),
    note: "only basic process settings and explicit loopback test configuration are injected; values are never recorded here",
  };
  return environment;
}

async function loadScenarioExtensions() {
  for (const modulePath of args.scenarioModules) {
    ensureStartAllowed("scenario extension loading");
    if (!modulePath.startsWith(`${REPO}${sep}`)) throw new Error(`scenario module must be inside the repository: ${modulePath}`);
    const loaded = await import(`file://${modulePath}`);
    const scenario = loaded.scenario;
    if (!scenario || typeof scenario.id !== "string" || typeof scenario.run !== "function" || !Array.isArray(scenario.requiredAssertions)) {
      throw new Error(`${relative(REPO, modulePath)} must export scenario { id, requiredAssertions, run }`);
    }
    if (state.configuration.scenarios.includes(scenario.id)) throw new Error(`duplicate scenario id: ${scenario.id}`);
    scenarioExtensions.push({ ...scenario, modulePath });
    state.configuration.scenarios.push(scenario.id);
    requiredAssertions.push(...scenario.requiredAssertions);
    state.harness.extensionModules ||= [];
    state.harness.extensionModules.push({
      id: scenario.id,
      path: relative(REPO, modulePath),
      sha256: fileSha256(modulePath),
    });
  }
}

function extensionContext() {
  return Object.freeze({
    repo: REPO,
    artifactDir,
    logDir,
    tempDir,
    state,
    abortSignal: runAbortController.signal,
    assertion,
    allocatePort,
    spawnManaged,
    stopManaged,
    runCommand,
    waitForHttp,
    getJson,
    withTimeout,
    delay,
    sha256,
    fileSha256,
    redact,
    registerSensitiveValues,
    registerCleanup(name, cleanup) {
      ensureStartAllowed(`cleanup registration for ${name}`);
      if (typeof cleanup !== "function") throw new Error(`cleanup for ${name} must be a function`);
      let pending;
      resourceCleanups.push({ name, run: () => (pending ||= Promise.resolve().then(cleanup)) });
    },
    registerFixture(name, path) {
      ensureStartAllowed(`fixture registration for ${name}`);
      const absolute = resolve(REPO, path);
      if (!absolute.startsWith(`${REPO}${sep}`) || !existsSync(absolute)) throw new Error(`invalid fixture path: ${path}`);
      state.fixtures.push({ name, path: relative(REPO, absolute), sha256: fileSha256(absolute) });
    },
  });
}

async function waitForHttp(url, expectedStatus, label) {
  ensureStartAllowed(label);
  let last = "no response";
  const deadline = Date.now() + args.operationTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.any([runAbortController.signal, AbortSignal.timeout(1_000)]),
        cache: "no-store",
      });
      last = `HTTP ${response.status}`;
      if (response.status === expectedStatus) return response;
    } catch (error) {
      if (runAbortController.signal.aborted) throw runAbortController.signal.reason;
      last = error.message;
    }
    await delay(100);
  }
  throw new Error(`${label} did not become available: ${redact(last)}`);
}

async function getJson(url) {
  ensureStartAllowed(`HTTP GET ${url}`);
  const response = await fetch(url, {
    signal: AbortSignal.any([
      runAbortController.signal,
      AbortSignal.timeout(args.operationTimeoutMs),
    ]),
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${url} returned malformed JSON`);
  }
  return { status: response.status, body };
}

async function captureBrowser(label, webUrl) {
  ensureStartAllowed(`Chromium ${label}`);
  const profile = join(tempDir, `chromium-${label}`);
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  const screenshot = join(browserDir, `${label}.png`);
  const domPath = join(browserDir, `${label}.html`);
  const result = await runCommand(
    `Chromium ${label}`,
    args.chromium,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-background-networking",
      "--disable-sync",
      "--metrics-recording-only",
      "--no-first-run",
      `--user-data-dir=${profile}`,
      `--screenshot=${screenshot}`,
      "--window-size=1440,1000",
      "--virtual-time-budget=8000",
      "--dump-dom",
      webUrl,
    ],
    { timeoutMs: args.operationTimeoutMs, logName: `chromium-${label}.log` },
  );
  writeFileSync(domPath, result.stdout, { mode: 0o600 });
  rmSync(profile, { recursive: true, force: true });
  state.cleanup.push({ resource: `Chromium ${label} profile`, action: "delete run-owned temporary profile", result: "removed" });
  return { ...result, dom: result.stdout, screenshot, domPath };
}

async function assertUnreachable(url) {
  try {
    await fetch(url, {
      signal: AbortSignal.any([runAbortController.signal, AbortSignal.timeout(2_000)]),
      cache: "no-store",
    });
    return false;
  } catch (error) {
    if (runAbortController.signal.aborted) throw runAbortController.signal.reason;
    return true;
  }
}

async function execute() {
  if (parseError) throw parseError;

  phase = "artifact-recovery";
  markAbandonedRuns();

  phase = "source-identity";
  recordPrerequisite("git", commandVersion("git"));
  sourceIdentity();

  phase = "scenario-extensions";
  await loadScenarioExtensions();

  phase = "prerequisites";
  recordPrerequisite("node", { ok: true, observed: process.version });
  recordPrerequisite("npm", commandVersion("npm"));
  recordPrerequisite("cargo", commandVersion("cargo"));
  recordPrerequisite("rustc", commandVersion("rustc"));
  recordPrerequisite("chromium", commandVersion(args.chromium));
  state.toolchains.chromiumExecutable = {
    path: args.chromium.replaceAll(REPO, "$REPO"),
    sha256: fileSha256(args.chromium),
  };
  if (!existsSync(join(REPO, "web", "node_modules", ".package-lock.json"))) {
    throw new Error("missing web dependencies; run npm ci --prefix web");
  }
  state.prerequisites.push({ name: "web locked dependencies", required: true, passed: true, observed: "web/node_modules/.package-lock.json present" });

  const fixturePath = join(REPO, "contracts", "v1", "version.json");
  if (!existsSync(fixturePath)) throw new Error("missing contracts/v1/version.json fixture");
  const versionFixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  state.fixtures.push({ name: "version response", path: "contracts/v1/version.json", sha256: fileSha256(fixturePath) });
  state.fixtures.push({ name: "web dependency lock", path: "web/package-lock.json", sha256: fileSha256(join(REPO, "web", "package-lock.json")) });

  phase = "build-api";
  const build = await runCommand(
    "Cargo build",
    "cargo",
    ["build", "--locked", "-p", "hostlet-control"],
    { env: { ...process.env, CARGO_TARGET_DIR: join(REPO, "target") }, timeoutMs: 120_000, logName: "cargo-build.log" },
  );
  if (build.code !== 0) throw new Error(`cargo build failed with exit ${build.code}`);
  const apiBinary = join(REPO, "target", "debug", "hostlet-control");
  if (!existsSync(apiBinary)) throw new Error("cargo build succeeded without target/debug/hostlet-control");
  state.productOutputs.apiBinarySha256 = fileSha256(apiBinary);

  const apiPort = await allocatePort();
  const webPort = await allocatePort();
  state.configuration.apiUrl = `http://127.0.0.1:${apiPort}`;
  state.configuration.webUrl = `http://127.0.0.1:${webPort}`;

  phase = "start-api";
  const api = spawnManaged(
    "hostlet-control",
    apiBinary,
    [],
    { env: scaffoldEnvironment({ HOSTLET_API_BIND: `127.0.0.1:${apiPort}` }) },
    "api.log",
  );
  await waitForHttp(`${state.configuration.apiUrl}/healthz`, 200, "control API");
  assertion("api-process-started", "api-liveness", "real API accepts HTTP on assigned loopback port", `PID ${api.child.pid}; HTTP reachable`, true);

  phase = "api-http";
  const health = await getJson(`${state.configuration.apiUrl}/healthz`);
  assertion("api-health-status", "api-liveness", 200, health.status, health.status === 200);
  assertion("api-health-body", "api-liveness", { status: "ok" }, health.body, health.body?.status === "ok");

  const version = await getJson(`${state.configuration.apiUrl}/v1/version`);
  assertion("api-version-status", "api-version", 200, version.status, version.status === 200);
  assertion("api-version-body", "api-version", versionFixture, version.body, JSON.stringify(version.body) === JSON.stringify(versionFixture));

  const ready = await getJson(`${state.configuration.apiUrl}/readyz`);
  assertion("api-ready-status", "api-not-ready", 503, ready.status, ready.status === 503);
  assertion(
    "api-ready-body",
    "api-not-ready",
    { status: "not_ready", reason: "product dependencies are not wired" },
    ready.body,
    ready.body?.status === "not_ready" && ready.body?.reason === "product dependencies are not wired",
  );
  state.productOutputs.http = { health, version, readiness: ready };

  phase = "start-web";
  const web = spawnManaged(
    "vite-web",
    "npm",
    ["run", "dev", "--prefix", "web", "--", "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"],
    { env: scaffoldEnvironment({ VITE_CONTROL_PLANE: state.configuration.apiUrl }) },
    "web.log",
  );
  await waitForHttp(state.configuration.webUrl, 200, "Vite web server");
  assertion("web-process-started", "browser-connected", "real Vite server accepts HTTP on assigned loopback port", `PID ${web.child.pid}; HTTP reachable`, true);

  phase = "browser-connected";
  const connected = await captureBrowser("connected", state.configuration.webUrl);
  assertion("browser-connected-exit", "browser-connected", "Chromium exit 0", connected.code, connected.code === 0);
  assertion("browser-connected-screenshot", "browser-connected", "non-empty PNG", existsSync(connected.screenshot) ? statSync(connected.screenshot).size : 0, existsSync(connected.screenshot) && statSync(connected.screenshot).size > 0);
  assertion("browser-connected-online", "browser-connected", "Online", connected.dom.includes(">Online<"), connected.dom.includes(">Online<"));
  assertion("browser-connected-healthy", "browser-connected", "Healthy", connected.dom.includes(">Healthy<"), connected.dom.includes(">Healthy<"));
  assertion("browser-connected-not-ready", "browser-connected", "Not ready", connected.dom.includes(">Not ready<"), connected.dom.includes(">Not ready<"));
  const expectedVersionText = args.injectFailure ? "hostlet-control · 9.9.9-injected" : `${versionFixture.service} · ${versionFixture.version}`;
  assertion("browser-connected-version", "browser-connected", expectedVersionText, connected.dom.includes(expectedVersionText), connected.dom.includes(expectedVersionText), args.injectFailure ? "expected value deliberately corrupted by --inject-failure" : null);
  assertion("browser-connected-protocol", "browser-connected", versionFixture.protocol_version, connected.dom.includes(versionFixture.protocol_version), connected.dom.includes(versionFixture.protocol_version));
  assertion("browser-connected-reason", "browser-connected", ready.body.reason, connected.dom.includes(ready.body.reason), connected.dom.includes(ready.body.reason));

  phase = "stop-api";
  await stopManaged(api, "offline scenario");
  const apiUnreachable = await withTimeout("API offline observation", () => assertUnreachable(`${state.configuration.apiUrl}/healthz`), 5_000);
  assertion("api-stopped-unreachable", "browser-offline", "connection refused after API stop", apiUnreachable ? "unreachable" : "still reachable", apiUnreachable);

  phase = "browser-offline";
  const offline = await captureBrowser("offline", state.configuration.webUrl);
  assertion("browser-offline-exit", "browser-offline", "Chromium exit 0", offline.code, offline.code === 0);
  assertion("browser-offline-screenshot", "browser-offline", "non-empty PNG", existsSync(offline.screenshot) ? statSync(offline.screenshot).size : 0, existsSync(offline.screenshot) && statSync(offline.screenshot).size > 0);
  const offlineCount = (offline.dom.match(/>Offline</g) || []).length;
  assertion("browser-offline-status-count", "browser-offline", "at least 3 Offline status pills", offlineCount, offlineCount >= 3);
  assertion("browser-offline-version-message", "browser-offline", "Control API is unreachable", offline.dom.includes("Control API is unreachable"), offline.dom.includes("Control API is unreachable"));
  assertion("browser-offline-readiness-message", "browser-offline", "Readiness endpoint is unreachable", offline.dom.includes("Readiness endpoint is unreachable"), offline.dom.includes("Readiness endpoint is unreachable"));
  assertion("browser-offline-health-message", "browser-offline", "Health endpoint is unreachable", offline.dom.includes("Health endpoint is unreachable"), offline.dom.includes("Health endpoint is unreachable"));

  phase = "cleanup";
  await stopManaged(web, "normal completion");

  for (const extension of scenarioExtensions) {
    ensureStartAllowed(`scenario extension ${extension.id}`);
    phase = `scenario-extension:${extension.id}`;
    await extension.run(extensionContext());
  }
}

async function boundedCleanup(label, operation) {
  const timeoutMs = Math.min(45_000, Math.max(2_000, args.operationTimeoutMs * 2));
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} cleanup timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function shutdown(reason) {
  shutdownStarted = true;
  const performShutdown = async () => {
    for (const item of [...managed].reverse()) {
      // An extension's finally block can already be removing its resources
      // when abort reaches this snapshot. Let its registered cleanup promise
      // finish before reaping those helpers in the second pass.
      if (item.cleanupCommand) continue;
      try {
        await boundedCleanup(item.name, () => stopManaged(item, reason));
      } catch (error) {
        state.errors.push({
          phase: "cleanup",
          kind: "failure",
          message: `${item.name}: ${redact(error.message)}`,
        });
      }
    }
    for (const cleanup of [...resourceCleanups].reverse()) {
      try {
        await boundedCleanup(cleanup.name, cleanup.run);
      } catch (error) {
        state.errors.push({
          phase: "cleanup",
          kind: "failure",
          message: `${cleanup.name}: ${redact(error.message)}`,
        });
      }
    }
    // Cleanup callbacks may start bounded helper commands. Reap any that were
    // added after the initial managed-process snapshot.
    for (const item of [...managed].reverse()) {
      if (item.stopped) continue;
      try {
        await boundedCleanup(item.name, () => stopManaged(item, `${reason}; cleanup command`));
      } catch (error) {
        state.errors.push({
          phase: "cleanup",
          kind: "failure",
          message: `${item.name}: ${redact(error.message)}`,
        });
      }
    }
  };
  shutdownChain = shutdownChain.then(performShutdown, performShutdown);
  await shutdownChain;
}

function makeReport() {
  const failed = state.assertions.filter((item) => !item.passed);
  const lines = [
    `# Hostlet E2E run ${runId}`,
    "",
    `Status: **${state.status.toUpperCase()}**`,
    "",
    `- Task / milestone: HOST-241 / ${state.milestone}`,
    `- Started: ${state.startedAt}`,
    `- Ended: ${state.endedAt}`,
    `- Source: ${state.source.commit || "unavailable"} (${state.source.dirty ? "dirty local tree" : "clean tree"})`,
    `- Harness revision: ${state.harness.revisionSha256 || "unavailable"}`,
    `- Injected failure: ${state.injectedFailure}`,
    `- Exact rerun: \`${state.command.rerun}\` from repository root`,
    "",
    "## Result",
    "",
    `${state.assertions.filter((item) => item.passed).length}/${state.assertions.length} recorded assertions passed; ${failed.length} failed. Missing required assertions are failures and appear below.`,
    "",
    "| Assertion | Scenario | Result | Expected | Observed |",
    "| --- | --- | --- | --- | --- |",
    ...state.assertions.map((item) => `| ${item.id} | ${item.scenario} | ${item.passed ? "PASS" : "FAIL"} | ${md(item.expected)} | ${md(item.observed)} |`),
    "",
    "## Evidence and cleanup",
    "",
    ...state.retained.map((path) => `- Retained: \`${path}\``),
    ...state.cleanup.map((item) => `- ${item.resource}: ${item.action} — ${item.result}`),
  ];
  if (state.errors.length) {
    lines.push("", "## Errors", "", ...state.errors.map((item) => `- ${item.phase} / ${item.kind}: ${item.message}`));
  }
  lines.push("", "`SHA256SUMS` is the external receipt and intentionally excludes itself.", "");
  return redact(lines.join("\n"));
}

function md(value) {
  return redact(typeof value === "string" ? value : JSON.stringify(value)).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function listFiles(root, prefix = "") {
  const files = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const name = join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(root, name));
    else if (entry.isFile() && name !== "SHA256SUMS") files.push(name);
  }
  return files.sort();
}

function writeChecksums(directory) {
  const files = listFiles(directory);
  const receipt = files.map((name) => `${fileSha256(join(directory, name))}  ${name}`).join("\n");
  writeFileSync(join(directory, "SHA256SUMS"), `${receipt}\n`, { mode: 0o600 });
}

function sanitizeArtifactValue(value, key = "") {
  if (
    typeof value === "string" &&
    /(?:authorization|(?:access[_-]?)?token|password|secret|api[_-]?key|database_url|recovery[_-]?key|private[_-]?key)/i.test(
      key,
    )
  ) {
    return "[REDACTED]";
  }
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeArtifactValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        sanitizeArtifactValue(childValue, childKey),
      ]),
    );
  }
  return value;
}

function artifactJson(value) {
  return `${JSON.stringify(sanitizeArtifactValue(value), null, 2)}\n`;
}

function replaceBuffer(buffer, needle, replacement) {
  const chunks = [];
  let cursor = 0;
  let matches = 0;
  for (;;) {
    const index = buffer.indexOf(needle, cursor);
    if (index === -1) break;
    chunks.push(buffer.subarray(cursor, index), replacement);
    cursor = index + needle.length;
    matches += 1;
  }
  if (matches === 0) return { buffer, matches };
  chunks.push(buffer.subarray(cursor));
  return { buffer: Buffer.concat(chunks), matches };
}

function scrubArtifactSensitiveValues(directory) {
  const secrets = [...sensitiveValues]
    .filter((value) => value.length > 0)
    .sort((left, right) => right.length - left.length)
    .map((value) => Buffer.from(value));
  const replacement = Buffer.from("[REDACTED]");
  let matches = 0;
  let filesRewritten = 0;
  for (const name of listFiles(directory)) {
    const path = join(directory, name);
    let content = readFileSync(path);
    let fileMatches = 0;
    for (const secret of secrets) {
      const result = replaceBuffer(content, secret, replacement);
      content = result.buffer;
      fileMatches += result.matches;
    }
    if (fileMatches > 0) {
      writeFileSync(path, content, { mode: 0o600 });
      filesRewritten += 1;
      matches += fileMatches;
    }
  }
  return { matches, filesRewritten };
}

function scanArtifactSensitiveValues(directory) {
  const secrets = [...sensitiveValues]
    .filter((value) => value.length > 0)
    .map((value) => Buffer.from(value));
  let matches = 0;
  let filesScanned = 0;
  const matchedFiles = [];
  for (const name of listFiles(directory)) {
    const content = readFileSync(join(directory, name));
    filesScanned += 1;
    const fileMatches = secrets.filter((secret) => content.includes(secret)).length;
    if (fileMatches > 0) {
      matches += fileMatches;
      matchedFiles.push(name);
    }
  }
  return { matches, filesScanned, matchedFiles };
}

function writeCoreArtifacts() {
  writeFileSync(
    assertionsPath,
    artifactJson({ schemaVersion: 1, runId, assertions: state.assertions }),
    { mode: 0o600 },
  );
  writeFileSync(manifestPath, artifactJson(state), { mode: 0o600 });
  writeFileSync(reportPath, makeReport(), { mode: 0o600 });
}

async function finalize() {
  if (finalized) return;
  finalized = true;
  clearTimeout(runDeadline);
  const artifactCleanup = {
    resource: "artifact bundle",
    action: "finalize manifest, report, assertions, credential scan, and external receipt",
    result: "pending",
  };
  state.cleanup.push(artifactCleanup);

  try {
    await shutdown("finalization");

    state.source.endingCommit = git("rev-parse", "HEAD");
    state.source.endingDirty = git("status", "--porcelain=v1", "--untracked-files=all").length > 0;
    if (args.requireClean) {
      assertion(
        "gate-source-stable",
        "source",
        "the recorded commit remains clean and unchanged throughout the gate run",
        { sameCommit: state.source.endingCommit === state.source.commit, dirty: state.source.endingDirty },
        state.source.endingCommit === state.source.commit && !state.source.endingDirty,
      );
    }

    const observedIds = new Set(state.assertions.map((item) => item.id));
    const missing = requiredAssertions.filter((id) => !observedIds.has(id));
    assertion(
      "required-assertions-complete",
      "runner-integrity",
      requiredAssertions,
      missing,
      missing.length === 0,
      missing.length ? "one or more required assertions did not execute" : null,
    );

    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
      state.cleanup.push({
        resource: "run temporary directory",
        action: "delete run-owned temporary files",
        result: "removed",
      });
    }

    rmSync(join(artifactDir, "SHA256SUMS"), { force: true });
    const scrubbed = scrubArtifactSensitiveValues(artifactDir);
    assertion(
      "artifact-credentials-absent",
      "runner-integrity",
      0,
      scrubbed.matches,
      scrubbed.matches === 0,
      scrubbed.matches > 0
        ? "registered credential bytes were removed before the artifact receipt"
        : null,
    );
    state.artifactSafety = {
      registeredSensitiveValueCount: sensitiveValues.size,
      scrubbedCredentialMatches: scrubbed.matches,
      filesRewritten: scrubbed.filesRewritten,
      finalCredentialMatches: 0,
    };
    state.retained = listFiles(artifactDir).filter(
      (path) => !["manifest.json", "REPORT.md", "assertions.json"].includes(path),
    );
    const anyFailure =
      state.assertions.some((item) => !item.passed)
      || state.errors.some((item) => item.kind !== "warning")
      || Boolean(fatalError)
      || Boolean(interruptedSignal);
    state.status = interruptedSignal ? "interrupted" : anyFailure ? "failed" : "passed";
    state.endedAt = new Date().toISOString();
    state.durationMs = new Date(state.endedAt).getTime() - startedAt.getTime();
    artifactCleanup.result = "complete";

    writeCoreArtifacts();
    const scan = scanArtifactSensitiveValues(artifactDir);
    state.artifactSafety.finalCredentialMatches = scan.matches;
    state.artifactSafety.filesScanned = scan.filesScanned;
    if (scan.matches > 0) {
      throw new Error(
        `credential scan found sensitive values in ${scan.matchedFiles.length} artifact file(s)`,
      );
    }
    // Persist the final zero-match scan result, then verify those exact bytes
    // once more before creating the external checksum receipt.
    writeCoreArtifacts();
    const finalScan = scanArtifactSensitiveValues(artifactDir);
    if (finalScan.matches > 0) {
      throw new Error(
        `final credential scan found sensitive values in ${finalScan.matchedFiles.length} artifact file(s)`,
      );
    }
    writeChecksums(artifactDir);
    // Finalization and receipt creation are synchronous. Signals delivered
    // after this commit belong to the finished process, not a new outcome
    // that could disagree with the immutable evidence just written.
    artifactCommitted = true;
  } catch (error) {
    finalizationIncomplete = true;
    fatalError ||= error;
    state.status = interruptedSignal ? "interrupted" : "failed";
    state.endedAt ||= new Date().toISOString();
    state.durationMs = new Date(state.endedAt).getTime() - startedAt.getTime();
    artifactCleanup.result = `incomplete: ${redact(error.message)}`;
    state.errors.push({
      phase: "artifact-finalization",
      kind: "failure",
      message: redact(error.message),
    });
    rmSync(join(artifactDir, "SHA256SUMS"), { force: true });
    try {
      scrubArtifactSensitiveValues(artifactDir);
      writeCoreArtifacts();
      scrubArtifactSensitiveValues(artifactDir);
    } catch {
      // Preserve whatever partial evidence remains. No receipt means it cannot pass.
    }
    throw error;
  }
}

try {
  await Promise.race([execute(), runAborted]);
} catch (error) {
  if (!runAbortController.signal.aborted) {
    abortRun(error, /timed out/.test(error.message) ? "timeout" : "failure");
  }
} finally {
  try {
    await finalize();
  } catch (error) {
    fatalError ||= error;
    process.stderr.write(`artifact finalization failed for ${artifactDir}: ${redact(error.message)}\n`);
  }
}

const receiptPath = join(artifactDir, "SHA256SUMS");
let receiptHash = "unavailable";
try {
  if (existsSync(receiptPath)) receiptHash = fileSha256(receiptPath);
} catch (error) {
  finalizationIncomplete = true;
  fatalError ||= error;
}
const effectiveStatus = finalizationIncomplete || fatalError
  ? interruptedSignal ? "interrupted" : "failed"
  : state.status;
process.stdout.write(`Hostlet E2E ${effectiveStatus}: ${relative(REPO, artifactDir)}\n`);
process.stdout.write(`SHA256SUMS sha256: ${receiptHash}\n`);
if (
  effectiveStatus !== "passed"
  || fatalError
  || interruptedSignal
  || finalizationIncomplete
  || !existsSync(receiptPath)
) {
  process.exitCode = 1;
}
if (runAbortController.signal.aborted) {
  // A misbehaving scenario can retain event-loop handles after ignoring abort.
  // Give synchronous artifact output a chance to flush, then honor the bounded run.
  setTimeout(() => process.exit(process.exitCode || 1), 50).unref();
}
