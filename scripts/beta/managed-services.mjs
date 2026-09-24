#!/usr/bin/env node
// Render only owned preview units. No install, migration, seed, or service mutation occurs during render.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { connect, isIP } from "node:net";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UNIT_PREFIX = "hostlet-preview-";
const STATE_ROOT = "/var/lib/hostlet-preview";
const RELEASE_ROOT = "/opt/hostlet-preview/releases";
const UNIT_ROOT = "/etc/systemd/system";
const LABEL = "Hostlet owned preview:";
const FIXED = Object.freeze(["control", "builder", "database-worker", "runtime", "publisher-worker", "publisher-static", "dashboard", "demo-gateway", "gateway", "tunnel", "provider"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TEMPLATE = readFileSync(new URL("./units/managed.service.template", import.meta.url), "utf8");

function required(value, label) {
  if (typeof value !== "string" || !value || /[\r\n\0]/.test(value)) throw new Error(`${label} is required and must be one line`);
  return value;
}
function absolute(value, label) {
  const path = required(value, label);
  if (!isAbsolute(path) || resolve(path) !== path || /[\s"'\\%]/.test(path)) throw new Error(`${label} must be a canonical absolute path without whitespace or systemd escapes`);
  return path;
}
function port(value, label) {
  if (!Number.isSafeInteger(value) || value < 1024 || value > 65535) throw new Error(`${label} must be an unprivileged TCP port`);
  return value;
}
function url(value, label) {
  const parsed = new URL(required(value, label));
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || parsed.pathname !== "/" || parsed.search || parsed.hash || !parsed.port) throw new Error(`${label} must be a literal loopback HTTP origin`);
  return parsed.origin;
}
function unitName(short) {
  if (!FIXED.includes(short) && !(short.startsWith("relay-") && UUID.test(short.slice(6)))) throw new Error(`unknown preview unit: ${short}`);
  return `${UNIT_PREFIX}${short}.service`;
}
function arg(value, label) {
  const text = required(String(value), label);
  if (/[\s"'\\%]/.test(text)) throw new Error(`${label} cannot contain spaces or systemd escapes`);
  return text;
}
function command(...parts) { return parts.map((part, index) => arg(part, `argument ${index}`)).join(" "); }
function privilegedExecutable() {
  const path = realpathSync("/usr/bin/sudo");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0) throw new Error("canonical sudo executable is unavailable");
  return absolute(path, "canonical sudo executable");
}
function renderUnit({ short, release, envFile, exec, user, group, writes = [STATE_ROOT], after = [], privilegedHelper = false, sharedHostTmp = false }) {
  let body = TEMPLATE.replaceAll("{{label}}", short).replaceAll("{{release}}", release)
    .replaceAll("{{envFile}}", envFile).replaceAll("{{command}}", exec).replaceAll("{{writePaths}}", writes.join(" "))
    .replaceAll("{{user}}", user).replaceAll("{{group}}", group)
    .replaceAll("{{noNewPrivileges}}", privilegedHelper ? "false" : "true")
    .replaceAll("{{privateTmp}}", sharedHostTmp ? "false" : "true")
    .replaceAll("{{protectSystem}}", privilegedHelper ? "full" : "strict");
  if (after.length) body = body.replace("After=network-online.target", `After=network-online.target ${after.map(unitName).join(" ")}`);
  return { name: unitName(short), short, description: `${LABEL} ${short}`, fragmentPath: join(UNIT_ROOT, unitName(short)), user, group, text: body };
}

function serviceIdentity(services) {
  const user = services.user ?? "hostlet-preview";
  const group = services.group ?? user;
  if (!(["hostlet-preview", "shane"].includes(user) && group === user)) throw new Error("services.user/group must be matching hostlet-preview or shane identity");
  return { user, group };
}

export function renderManagedServices(config, commit) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("release commit must be a full lowercase Git SHA-1");
  const release = join(RELEASE_ROOT, commit);
  const apiUrl = url(config.apiUrl, "apiUrl");
  const workerUrl = url(config.workerUrl, "workerUrl");
  const services = config.services ?? {};
  const identity = serviceIdentity(services);
  const env = services.envFiles ?? {};
  const paths = services.paths ?? {};
  const ports = services.ports ?? {};
  const e = (name) => absolute(env[name], `services.envFiles.${name}`);
  const p = (name) => absolute(paths[name], `services.paths.${name}`);
  const state = absolute(config.stateDir, "stateDir");
  if (state !== STATE_ROOT && !state.startsWith(`${STATE_ROOT}/`)) throw new Error("stateDir must be under private preview state root");
  const binary = (name) => join(release, "target", "debug", name);
  const script = (path) => join(release, path);
  const publisherPort = port(ports.publisherStatic, "services.ports.publisherStatic");
  const dashboardPort = port(ports.dashboard, "services.ports.dashboard");
  const gatewayPort = port(ports.gateway, "services.ports.gateway");
  const demoPort = port(ports.demoGateway, "services.ports.demoGateway");
  const metricsPort = port(ports.tunnelMetrics, "services.ports.tunnelMetrics");
  const expectedHost = required(services.publisherExpectedHost, "services.publisherExpectedHost");
  if (!/^[a-z0-9.-]+$/.test(expectedHost)) throw new Error("publisherExpectedHost must be a hostname");
  const projectId = required(services.projectId, "services.projectId");
  if (!/^[0-9a-f-]{36}$/.test(projectId)) throw new Error("services.projectId must be UUID");
  const managed = (options) => renderUnit({ ...identity, ...options });
  const worker = (short, binaryName, subcommand, envName, workerId, extra = [], privilegedHelper = false) => managed({
    short, release, envFile: e(envName), after: ["control"], privilegedHelper, sharedHostTmp: short === "builder",
    exec: command(binary(binaryName), subcommand, "--control-url", workerUrl, "--worker-id", workerId, ...extra),
  });
  const units = [
    managed({ short: "control", release, envFile: e("control"), exec: binary("hostlet-control") }),
    worker("builder", "hostlet-builder", "project-build-worker", "builder", "m35-owned-builder", ["--profile", p("buildProfile"), "--cas-root", join(state, "private-cas"), "--work-root", join(state, "build-work")], true),
    worker("database-worker", "hostlet-database", "worker", "database", "m35-owned-database", [
      "--kind", "provision", "--kind", "backup_daily", "--kind", "backup_pre_migration",
      "--kind", "export", "--kind", "observe_storage", "--kind", "archive_expire",
    ], true),
    managed({ short: "runtime", release, envFile: e("runtime"), after: ["control"], privilegedHelper: true, exec: command(binary("hostlet-runtime"), "release-worker", "--control-url", workerUrl, "--worker-id", "m35-owned-release-worker", "--token-file", p("runtimeTokenFile"), "--coordinator", script("scripts/release/hostlet-release-coordinator.py"), "--probe", script("scripts/runtime/hostlet-runtime-probe"), "--migration-probe", script("scripts/runtime/hostlet-runtime-migration-probe.py"), "--runtime-binary", binary("hostlet-runtime"), "--launcher", script("scripts/runtime/hostlet-runtime-launcher"), "--runsc", p("runsc"), "--peer-helper", script("scripts/runtime/hostlet-runtime-peer"), "--privileged-command", privilegedExecutable(), "--state-root", state, "--runtime-root", join(state, "runtime-state"), "--artifact-root", join(state, "private-cas"), "--runtime-artifact-root", join(state, "runtime-artifacts")) }),
    worker("publisher-worker", "hostlet-publisher", "worker", "publisher", "m35-owned-publisher"),
    managed({ short: "publisher-static", release, envFile: e("publisherStatic"), exec: command(binary("hostlet-publisher"), "serve", "--root", join(state, "publisher"), "--bind", `127.0.0.1:${publisherPort}`, "--expected-host", expectedHost) }),
    managed({ short: "dashboard", release, envFile: e("dashboard"), exec: command(p("caddy"), "file-server", "--root", join(release, "web", "dist"), "--listen", `127.0.0.1:${dashboardPort}`), writes: [STATE_ROOT] }),
    managed({ short: "demo-gateway", release, envFile: e("demoGateway"), after: ["runtime"], exec: command("/usr/bin/python3", script("scripts/release/hostlet-release-gateway.py"), "--state-root", state, "--runtime-root", join(state, "runtime-state"), "--project-id", projectId, "--hostname", arg(services.demoHostname, "services.demoHostname"), "--listen-port", demoPort, "--certificate", p("demoCertificate"), "--private-key", p("demoPrivateKey")) }),
    managed({ short: "gateway", release, envFile: e("gateway"), after: ["control", "publisher-static", "demo-gateway"], exec: command(p("caddy"), "run", "--config", p("caddyConfig"), "--adapter", "caddyfile"), writes: [STATE_ROOT] }),
    managed({ short: "tunnel", release, envFile: e("tunnel"), after: ["gateway"], exec: command(p("cloudflared"), "tunnel", "--no-autoupdate", "--metrics", `127.0.0.1:${metricsPort}`, "run") }),
  ];
  if (services.provider?.enabled === true) {
    units.push(managed({ short: "provider", release, envFile: e("provider"), exec: command("/usr/bin/node", script("scripts/beta/bootstrap.mjs"), "provider-service", "--config", p("providerConfig")) }));
  }
  const probe = [
    { short: "control", kind: "http", url: `${apiUrl}/readyz`, deadlineMs: 30000 },
    { short: "publisher-static", kind: "tcp", host: "127.0.0.1", port: publisherPort, deadlineMs: 30000 },
    { short: "dashboard", kind: "http", url: `http://127.0.0.1:${dashboardPort}/index.html`, deadlineMs: 30000 },
    { short: "demo-gateway", kind: "tcp", host: "127.0.0.1", port: demoPort, deadlineMs: 30000 },
    { short: "gateway", kind: "tcp", host: "127.0.0.1", port: gatewayPort, deadlineMs: 30000 },
    { short: "tunnel", kind: "http", url: `http://127.0.0.1:${metricsPort}/ready`, deadlineMs: 45000 },
  ];
  for (const short of ["builder", "database-worker", "runtime", "publisher-worker", ...(services.provider?.enabled === true ? ["provider"] : [])]) probe.push({ short, kind: "systemd", deadlineMs: 30000 });
  return { schema: "hostlet.beta.services/v1", commit, release, stateRoot: STATE_ROOT, identity, units, readiness: probe, external: ["platform-postgres", "project-postgres"], installedUnitRoot: UNIT_ROOT };
}

function privateOutput(directory) {
  const path = absolute(directory, "output directory");
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error("render output must be a private real directory");
  return path;
}
function writePrivateFile(path, body) {
  if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) throw new Error(`refusing non-regular output: ${path}`);
  writeFileSync(path, body, { mode: 0o600 });
}
export function writeManagedPlan(plan, directory) {
  const output = privateOutput(directory);
  for (const unit of plan.units) {
    const path = join(output, unit.name);
    writePrivateFile(path, unit.text);
  }
  writePrivateFile(join(output, "services-manifest.json"), `${JSON.stringify({ ...plan, units: plan.units.map(({ text, ...unit }) => unit) }, null, 2)}\n`);
  return output;
}

function systemctl(args, elevated = false) {
  const result = spawnSync(elevated ? "/usr/bin/sudo" : "/usr/bin/systemctl", elevated ? ["-n", "/usr/bin/systemctl", ...args] : args, { encoding: "utf8", timeout: 15000, maxBuffer: 128 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`systemctl ${args[0]} failed: ${(result.stderr || result.error?.message || "unknown").trim()}`);
  return result.stdout.trim();
}
export function inspectManagedUnit(short, expectedIdentity) {
  const name = unitName(short);
  const values = Object.fromEntries(systemctl(["show", name, "--property=Description,FragmentPath,LoadState,ActiveState,SubState,Result,User,Group", "--no-pager"]).split("\n").map((line) => line.split(/=(.*)/s).slice(0, 2)));
  if (values.FragmentPath !== join(UNIT_ROOT, name) || values.Description !== `${LABEL} ${short}` || values.LoadState !== "loaded") throw new Error(`unit ownership check failed for ${name}`);
  if (!(["hostlet-preview", "shane"].includes(values.User) && values.Group === values.User)) throw new Error(`unit identity check failed for ${name}`);
  if (expectedIdentity && (values.User !== expectedIdentity.user || values.Group !== expectedIdentity.group)) throw new Error(`unit configured identity mismatch for ${name}`);
  return { name, ...values };
}
export function operateManagedUnit(action, short, expectedIdentity) {
  if (!["start", "stop", "restart"].includes(action)) throw new Error(`unsupported unit action: ${action}`);
  const inspected = inspectManagedUnit(short, expectedIdentity);
  systemctl([action, inspected.name, "--no-pager"], true);
  return inspectManagedUnit(short, expectedIdentity);
}

function identityForManifest(manifestPath, short) {
  const plan = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (plan.schema !== "hostlet.beta.services/v1" || !plan.units?.some((unit) => unit.short === short && unit.name === unitName(short))) throw new Error("manifest does not own requested unit");
  return serviceIdentity(plan.identity ?? {});
}

function tcpProbe(host, portNumber) {
  return new Promise((resolveProbe) => {
    const socket = connect({ host, port: portNumber });
    socket.setTimeout(2000);
    socket.once("connect", () => { socket.destroy(); resolveProbe(true); });
    socket.once("timeout", () => { socket.destroy(); resolveProbe(false); });
    socket.once("error", () => { socket.destroy(); resolveProbe(false); });
  });
}
async function oneProbe(spec) {
  if (spec.kind === "systemd") return inspectManagedUnit(spec.short).ActiveState === "active";
  if (spec.kind === "tcp") return tcpProbe(spec.host, spec.port);
  if (spec.kind === "http") {
    const target = new URL(spec.url);
    if (target.hostname !== "127.0.0.1" || target.protocol !== "http:") throw new Error("readiness URL must be loopback HTTP");
    try {
      const response = await fetch(target, { signal: AbortSignal.timeout(2000), redirect: "manual" });
      return response.status === 200;
    } catch { return false; }
  }
  throw new Error(`unsupported probe kind: ${spec.kind}`);
}
export async function waitManagedReadiness(plan, short, deadlineMs) {
  const spec = plan.readiness.find((item) => item.short === short);
  if (!spec) throw new Error(`no readiness probe for ${short}`);
  const deadline = Date.now() + Math.min(Math.max(deadlineMs ?? spec.deadlineMs, 1000), 60000);
  let lastReason = "readiness probe failed";
  do {
    const inspected = inspectManagedUnit(short, plan.identity);
    if (inspected.ActiveState === "failed" || inspected.Result === "start-limit-hit") throw new Error(`${short} failed: ${inspected.Result || inspected.SubState}`);
    try { if (await oneProbe(spec)) return { name: inspected.name, ready: true, probe: spec.kind }; }
    catch (error) { lastReason = error.message; }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  } while (Date.now() < deadline);
  throw new Error(`${short} readiness deadline exceeded: ${lastReason}`);
}

export function renderRelayUnit(config, commit, tuple) {
  const base = renderManagedServices(config, commit);
  const state = absolute(config.stateDir, "stateDir");
  const uuid = (value, label) => {
    if (typeof value !== "string" || !UUID.test(value)) throw new Error(`${label} must be a canonical UUID`);
    return value;
  };
  const positive = (value, label) => {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be positive integer`);
    return value;
  };
  if (tuple.schema !== "hostlet.preview.relay-unit/v1") throw new Error("invalid relay tuple schema");
  const ip = required(tuple.target_address, "relay target_address");
  const octets = ip.split(".").map(Number);
  if (isIP(ip) !== 4 || !(
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  )) throw new Error("relay target address must be private IPv4");
  const projectId = uuid(tuple.project_id, "relay project_id");
  if (projectId !== config.services.projectId) throw new Error("relay project mismatch");
  const allocationId = uuid(tuple.allocation_id, "relay allocation_id");
  const generation = positive(tuple.generation, "relay generation");
  const fence = positive(tuple.fence, "relay fence");
  const listenPort = port(tuple.listen_port, "relay listen_port");
  const targetPort = port(tuple.target_port, "relay target_port");
  const runtimeRoot = absolute(tuple.runtime_root, "relay runtime_root");
  if (runtimeRoot !== join(state, "runtime-state")) throw new Error("relay runtime root mismatch");
  const mapPath = absolute(tuple.map_path, "relay map_path");
  if (mapPath !== join(runtimeRoot, "runtime-relays", allocationId, String(generation), `${fence}.json`)) throw new Error("relay map path does not match allocation identity");
  return renderUnit({ short: `relay-${allocationId}`, release: base.release, envFile: absolute(config.services.envFiles.runtime, "services.envFiles.runtime"), ...base.identity, after: ["runtime"], privilegedHelper: true, exec: command("/usr/bin/sudo", "-n", join(base.release, "scripts/runtime/hostlet-runtime-relay.py"), "--state-root", runtimeRoot, "--allocation-id", allocationId, "--generation", generation, "--listen-port", listenPort, "--fence", fence, "--target-address", ip, "--target-port", targetPort) });
}

function loadOwnedRelayTuple(config, tuplePath) {
  const ownedTuplePath = absolute(tuplePath, "relay tuple path");
  const tupleId = basename(ownedTuplePath, ".json");
  if (!UUID.test(tupleId) || ownedTuplePath !== join(config.stateDir, "preview-relays", `${tupleId}.json`)) throw new Error("relay tuple must be the exact owned allocation file");
  const tupleStat = lstatSync(ownedTuplePath);
  if (!tupleStat.isFile() || tupleStat.isSymbolicLink() || (tupleStat.mode & 0o077)) throw new Error("relay tuple must be a private regular file");
  const tuple = JSON.parse(readFileSync(ownedTuplePath, "utf8"));
  if (tuple.allocation_id !== tupleId) throw new Error("relay tuple path and allocation mismatch");
  return tuple;
}

function installExactUnit(unit, outputDir, identity) {
  const directory = privateOutput(outputDir);
  const source = join(directory, unit.name);
  writePrivateFile(source, unit.text);
  const destination = unit.fragmentPath;
  if (existsSync(destination)) {
    const stat = lstatSync(destination);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o022)) throw new Error(`installed unit is not a root-owned regular file: ${destination}`);
    inspectManagedUnit(unit.short, identity);
    if (readFileSync(destination, "utf8") !== unit.text) throw new Error(`installed unit differs; review populated-state change before replacing ${unit.name}`);
    return { installed: false, source, destination };
  }
  const result = spawnSync("/usr/bin/sudo", ["-n", "/usr/bin/install", "-o", "root", "-g", "root", "-m", "0644", "--", source, destination], { encoding: "utf8", timeout: 15000, maxBuffer: 128 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`exact unit install failed: ${(result.stderr || result.error?.message || "unknown").trim()}`);
  systemctl(["daemon-reload"], true);
  inspectManagedUnit(unit.short, identity);
  return { installed: true, source, destination };
}

export async function activateManagedService({ config, commit, outputDir, short }) {
  if (!FIXED.includes(short)) throw new Error(`fixed managed service required: ${short}`);
  const plan = renderManagedServices(config, commit);
  const unit = plan.units.find((item) => item.short === short);
  if (!unit) throw new Error(`service is not enabled: ${short}`);
  const install = installExactUnit(unit, outputDir, plan.identity);
  const status = operateManagedUnit("start", short, plan.identity);
  const readiness = await waitManagedReadiness(plan, short);
  return { short, name: unit.name, install, status, readiness };
}

export async function activateManagedRelay({ config, commit, tuplePath, outputDir }) {
  const tuple = loadOwnedRelayTuple(config, tuplePath);
  const unit = renderRelayUnit(config, commit, tuple);
  const identity = serviceIdentity(config.services ?? {});
  const install = installExactUnit(unit, outputDir, identity);
  const short = unit.short;
  const before = inspectManagedUnit(short, identity);
  if (before.ActiveState !== "active" && await tcpProbe("127.0.0.1", tuple.listen_port)) {
    throw new Error(`${unit.name} cannot start: exact relay port ${tuple.listen_port} is occupied before managed activation`);
  }
  const status = operateManagedUnit("start", short, identity);
  const plan = { identity, readiness: [{ short, kind: "tcp", host: "127.0.0.1", port: tuple.listen_port, deadlineMs: 30000 }] };
  const readiness = await waitManagedReadiness(plan, short);
  return { short, name: unit.name, allocationId: tuple.allocation_id, install, status, readiness };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action, ...args] = process.argv.slice(2);
    if (action === "render" && args.length === 3) {
      const [configPath, commit, output] = args;
      const plan = renderManagedServices(JSON.parse(readFileSync(configPath, "utf8")), commit);
      console.log(JSON.stringify({ output: writeManagedPlan(plan, output), units: plan.units.map((unit) => unit.name), readiness: plan.readiness }));
    } else if (action === "activate" && args.length === 4) {
      const [configPath, commit, outputDir, short] = args;
      console.log(JSON.stringify(await activateManagedService({ config: JSON.parse(readFileSync(configPath, "utf8")), commit, outputDir, short })));
    } else if (action === "activate-relay" && args.length === 4) {
      const [configPath, commit, tuplePath, outputDir] = args;
      console.log(JSON.stringify(await activateManagedRelay({ config: JSON.parse(readFileSync(configPath, "utf8")), commit, tuplePath, outputDir })));
    } else if (action === "inspect" && (args.length === 1 || args.length === 2)) console.log(JSON.stringify(inspectManagedUnit(args[0], args[1] ? identityForManifest(args[1], args[0]) : undefined)));
    else if (["start", "stop", "restart"].includes(action) && (args.length === 1 || args.length === 2)) console.log(JSON.stringify(operateManagedUnit(action, args[0], args[1] ? identityForManifest(args[1], args[0]) : undefined)));
    else if (action === "ready" && (args.length === 2 || args.length === 3)) {
      const [manifestPath, short, deadline] = args;
      const plan = JSON.parse(readFileSync(manifestPath, "utf8"));
      console.log(JSON.stringify(await waitManagedReadiness(plan, short, deadline === undefined ? undefined : Number(deadline))));
    } else if (action === "render-relay" && args.length === 4) {
      const [configPath, commit, tuplePath, output] = args;
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      const tuple = loadOwnedRelayTuple(config, tuplePath);
      const tupleId = tuple.allocation_id;
      const unit = renderRelayUnit(config, commit, tuple);
      const directory = privateOutput(output);
      writePrivateFile(join(directory, unit.name), unit.text);
      const manifestPath = join(directory, `relay-${tupleId}-manifest.json`);
      writePrivateFile(manifestPath, `${JSON.stringify({ schema: "hostlet.beta.services/v1", commit, identity: { user: unit.user, group: unit.group }, units: [{ name: unit.name, short: `relay-${tupleId}`, description: unit.description, fragmentPath: unit.fragmentPath, user: unit.user, group: unit.group }], readiness: [{ short: `relay-${tupleId}`, kind: "tcp", host: "127.0.0.1", port: tuple.listen_port, deadlineMs: 30000 }] }, null, 2)}\n`);
      console.log(JSON.stringify({ output: join(directory, unit.name), manifest: manifestPath, name: unit.name, description: unit.description }));
    } else throw new Error("usage: managed-services.mjs render CONFIG COMMIT PRIVATE_OUTPUT | activate CONFIG COMMIT PRIVATE_OUTPUT SHORT | render-relay CONFIG COMMIT OWNED_ALLOCATION_TUPLE PRIVATE_OUTPUT | activate-relay CONFIG COMMIT OWNED_ALLOCATION_TUPLE PRIVATE_OUTPUT | ready MANIFEST SHORT [DEADLINE_MS] | inspect|start|stop|restart EXACT_SHORT_NAME [MANIFEST]");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
