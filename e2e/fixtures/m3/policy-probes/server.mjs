import { createServer } from "node:http";
import { connect, isIP } from "node:net";
import { Resolver } from "node:dns/promises";
import { hostname } from "node:os";
import { open, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";

const forbiddenUrls = (process.env.PUBLIC_HOSTLET_PROBE_FORBIDDEN_URLS || "http://169.254.169.254/latest/meta-data/,http://127.0.0.1:2375/version,http://[::1]:2375/version").split(",").filter(Boolean);
const allowedUrls = (process.env.PUBLIC_HOSTLET_PROBE_ALLOWED_URLS || "").split(",").filter(Boolean);
const hostPaths = (process.env.PUBLIC_HOSTLET_PROBE_HOST_PATHS || "/etc/hostlet-owner,/var/run/docker.sock,/run/containerd/containerd.sock").split(",").filter(Boolean);

async function networkProbe(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return { target: url, connected: true, status: response.status };
  } catch (error) {
    return { target: url, connected: false, error: error.name };
  } finally { clearTimeout(timeout); }
}

function boundedTargets(input) {
  if (input.targets === undefined) return null;
  if (!Array.isArray(input.targets) || input.targets.length > 48) throw new Error("invalid_probe_targets");
  return input.targets.map((target) => {
    if (!target || !/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(target.name ?? "") || !["deny", "allow"].includes(target.expect)) throw new Error("invalid_probe_target");
    if (target.type === "http") {
      const url = new URL(target.url);
      if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password || target.url.length > 512) throw new Error("invalid_http_probe");
      return { name: target.name, type: target.type, expect: target.expect, url: url.href };
    }
    if (target.type === "tcp") {
      if (typeof target.host !== "string" || target.host.length > 253 || /[/\s]/.test(target.host) || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535) throw new Error("invalid_tcp_probe");
      return { name: target.name, type: target.type, expect: target.expect, host: target.host, port: target.port };
    }
    if (target.type === "dns") {
      if (typeof target.server !== "string" || target.server.length > 253 || /[/\s]/.test(target.server) ||
          typeof target.hostname !== "string" || target.hostname.length > 253 || /[/\s]/.test(target.hostname) ||
          ![4, 6].includes(target.family)) throw new Error("invalid_dns_probe");
      return { name: target.name, type: target.type, expect: target.expect, server: target.server, hostname: target.hostname, family: target.family };
    }
    if (target.type === "path") {
      if (typeof target.path !== "string" || !target.path.startsWith("/") || target.path.includes("\0") || target.path.length > 256) throw new Error("invalid_path_probe");
      return { name: target.name, type: target.type, expect: target.expect, path: target.path };
    }
    throw new Error("invalid_probe_type");
  });
}

function tcpProbe(target) {
  return new Promise((resolve) => {
    const socket = connect({ host: target.host, port: target.port });
    const done = (connected, code) => { socket.destroy(); resolve({ ...target, connected, code }); };
    socket.setTimeout(1_500, () => done(false, "timeout"));
    socket.once("connect", () => done(true, null));
    socket.once("error", (error) => done(false, error.code || error.name));
  });
}

async function dnsProbe(target) {
  const resolver = new Resolver();
  resolver.setServers([target.server.includes(":") ? `[${target.server}]:53` : target.server]);
  try {
    const addresses = await Promise.race([
      target.family === 4 ? resolver.resolve4(target.hostname) : resolver.resolve6(target.hostname),
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "ETIMEOUT" })), 1_500)),
    ]);
    return { ...target, connected: true, addresses };
  } catch (error) {
    return { ...target, connected: false, addresses: [], error: error.code || error.name };
  }
}

async function isolation(input) {
  const descriptors = boundedTargets(input);
  if (descriptors) {
    const results = [];
    for (const target of descriptors) {
      if (target.type === "http") results.push({ ...target, ...(await networkProbe(target.url)) });
      else if (target.type === "tcp") results.push(await tcpProbe(target));
      else if (target.type === "dns") results.push(await dnsProbe(target));
      else {
        try { await readFile(target.path); results.push({ ...target, readable: true, code: null }); }
        catch (error) { results.push({ ...target, readable: false, code: error.code || error.name }); }
      }
    }
    return { schema: "hostlet.owned-runtime-isolation/v1", results, hostname: hostname() };
  }
  const network = [];
  for (const url of [...forbiddenUrls, ...allowedUrls]) network.push(await networkProbe(url));
  const paths = [];
  for (const path of hostPaths) {
    try { await readFile(path); paths.push({ path, readable: true }); }
    catch (error) { paths.push({ path, readable: false, code: error.code }); }
  }
  return { network, paths, hostname: hostname() };
}

async function connectionPressure(count, target) {
  if (!Number.isInteger(count) || count < 1 || count > 256 || !target || isIP(target.host) === 0 ||
      !Number.isInteger(target.port) || target.port < 1 || target.port > 65535) throw new Error("invalid_connection_pressure");
  const sockets = [];
  const results = await Promise.all(Array.from({ length: count }, () => new Promise((resolve) => {
    const socket = connect({ host: target.host, port: target.port });
    sockets.push(socket);
    let settled = false;
    const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
    socket.setTimeout(1_500, () => finish("timeout"));
    socket.once("connect", () => finish("connected"));
    socket.once("error", (error) => finish(error.code || error.name));
  })));
  await new Promise((resolve) => setTimeout(resolve, 250));
  for (const socket of sockets) socket.destroy();
  return results;
}

async function resourceProbe(mode, amount, target) {
  if (mode === "cpu") {
    const until = Date.now() + amount;
    let value = 0;
    while (Date.now() < until) value = Math.imul(value + 1, 2654435761);
    return { mode, completed_ms: amount, value };
  }
  if (mode === "memory") {
    const held = [];
    for (let index = 0; index < amount; index += 1) held.push(Buffer.alloc(1024 * 1024, index & 255));
    return { mode, allocated_mib: held.length };
  }
  if (mode === "scratch_cleanup") {
    if (amount !== 0) throw new Error("invalid_scratch_cleanup_amount");
    const path = `/tmp/hostlet-owned-scratch-${process.pid}`;
    await rm(path);
    return { mode, removed: true };
  }
  if (mode === "scratch") {
    const path = `/tmp/hostlet-owned-scratch-${process.pid}`;
    const file = await open(path, "w");
    const block = Buffer.alloc(1024 * 1024, 0x5a);
    try { for (let index = 0; index < amount; index += 1) await file.write(block); }
    catch (error) { return { mode, written_mib: null, failed: true, code: error.code || error.name }; }
    finally { await file.close(); }
    await rm(path, { force: true });
    return { mode, written_mib: amount };
  }
  if (mode === "processes") {
    const failures = [];
    const children = [];
    const cleanupFailures = [];
    const errorCode = (error) => error?.code || error?.name || "unknown";
    let attempted = 0;
    for (let index = 0; index < amount; index += 1) {
      attempted += 1;
      try {
        const child = spawn("/bin/sleep", ["5"], { stdio: "ignore" });
        children.push(child);
        child.once("error", (error) => failures.push({ phase: "async", code: errorCode(error) }));
      } catch (error) {
        failures.push({ phase: "sync", code: errorCode(error) });
        break;
      }
      // Give a returned child one event-loop turn so an asynchronous spawn
      // error is observed before another child is attempted. This prevents a
      // PID-limit failure cascade from killing the fixture before cleanup.
      await new Promise((resolve) => setImmediate(resolve));
      if (failures.length > 0) break;
    }
    for (const child of children) {
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      } catch (error) {
        cleanupFailures.push({ code: errorCode(error) });
      }
    }
    // Drain already queued child error events after every returned child has
    // been signalled. The pressure amount remains 160; attempted is the exact
    // bounded number of spawn calls made before the first observed failure.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const codes = [...new Set(failures.map(({ code }) => code))];
    return {
      mode,
      requested: amount,
      attempted,
      spawned: children.length - failures.filter(({ phase }) => phase === "async").length,
      returned_children: children.length,
      failed: failures.length,
      codes,
      spawn_failure_counts: {
        sync: failures.filter(({ phase }) => phase === "sync").length,
        async: failures.filter(({ phase }) => phase === "async").length,
      },
      spawn_failure_samples: failures.slice(0, 16),
      cleanup: { attempted_children: children.length, error_count: cleanupFailures.length, errors: cleanupFailures.slice(0, 16) },
    };
  }
  if (mode === "connections") return { mode, target: { host: target?.host, port: target?.port }, results: await connectionPressure(amount, target) };
  throw new Error("unknown_probe_mode");
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const server = createServer(async (request, response) => {
  try {
    let result;
    if (request.method === "GET" && request.url === "/healthz") result = { status: "ok", fixture: "policy-probes" };
    else if (request.method === "POST" && request.url === "/probe/isolation") result = await isolation(await readJson(request));
    else if (request.method === "POST" && request.url === "/probe/resource") { const input = await readJson(request); result = await resourceProbe(input.mode, Number(input.amount), input.target); }
    else if (request.method === "POST" && request.url === "/probe/crash") { response.writeHead(202); response.end(); setImmediate(() => process.abort()); return; }
    else { response.writeHead(404); response.end(); return; }
    const bytes = Buffer.from(JSON.stringify(result)); response.writeHead(200, { "Content-Type": "application/json", "Content-Length": bytes.length }); response.end(bytes);
  } catch (error) { const bytes = Buffer.from(JSON.stringify({ error: error.message })); response.writeHead(500, { "Content-Type": "application/json", "Content-Length": bytes.length }); response.end(bytes); }
});
server.listen(Number(process.env.PORT || 3000), "0.0.0.0");
