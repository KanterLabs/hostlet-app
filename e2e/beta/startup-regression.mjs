#!/usr/bin/env node
// Focused real-process regression: consume two starts, then exercise recovery.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, lstatSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => { if (v.startsWith("--")) a.push([v.slice(2), all[i + 1]]); return a; }, []));
const id = args["run-id"];
if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}$/.test(id ?? "")) throw new Error("invalid run ID");
const dir = join(root, "artifacts/e2e/M3.5", id);
mkdirSync(dir, { mode: 0o700 });
const privateJson = path => { const s = lstatSync(path); if (!s.isFile() || s.isSymbolicLink() || (s.mode & 0o077)) throw new Error("private input required"); return JSON.parse(readFileSync(path)); };
const state = { scope: "focused startup regression; not a full gate", phase: "startup-regression", status: "incomplete", startedAt: new Date().toISOString(), assertions: [], observations: {}, cleanup: [] };
const persist = () => writeFileSync(join(dir, "manifest.json"), JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
const check = (name, passed, details = {}) => { state.assertions.push({ name, passed, details }); persist(); if (!passed) throw new Error(name); };
const run = (program, argv, timeout = 30000) => {
  const result = spawnSync(program, argv, { cwd: root, encoding: "utf8", timeout, maxBuffer: 1024 * 1024 });
  if (result.status !== 0 || result.error) {
    if (argv[0] === "e2e/beta/operations.mjs") {
      try { const d = JSON.parse(result.stderr.trim().split("\n").at(-1)); state.observations.failure = { code: d.code, operation: d.operation, substep: d.substep, unit: d.unit, waitedMs: d.waitedMs, policy: d.policy }; persist(); } catch { /* no raw errors */ }
    }
    throw new Error("child_operation_failed");
  }
  return result.stdout.trim();
};
let cfg, token, before;
const api = async (path, method = "GET", body) => {
  // Deliberate synchronous restarts invalidate any idle pooled API connection.
  const response = await fetch(new URL(path, cfg.apiUrl), { method, headers: { Connection: "close", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  return { status: response.status, payload: await response.json().catch(() => null) };
};
const service = (verb, short) => JSON.parse(run("node", ["scripts/beta/managed-services.mjs", verb, ...(verb === "ready" ? [args["services-manifest"], short, "10000"] : [short, args["services-manifest"]])]));
const policy = () => Object.fromEntries(run("systemctl", ["show", "hostlet-preview-control.service", "--property=Restart,StartLimitBurst,StartLimitIntervalUSec,ActiveEnterTimestampMonotonic", "--no-pager"]).split("\n").map(x => x.split(/=(.*)/s).slice(0, 2)));
const op = (name, params) => JSON.parse(run("node", ["e2e/beta/operations.mjs", name, ...["config", "edge-credentials", "cloudflare-config", "cloudflare-before", "ready-proof", "services-manifest", "run-id"].flatMap(k => ["--" + k, args[k]]), "--params", JSON.stringify(params)], 180000));
persist();
try {
  cfg = privateJson(args.config);
  state.source = { commit: run("git", ["rev-parse", "HEAD"]), dirty: Boolean(run("git", ["status", "--porcelain"])), installedCommit: cfg.releaseCommit, node: process.version };
  state.rerun = ["node", "e2e/beta/startup-regression.mjs", ...process.argv.slice(2)];
  const plan = privateJson(args["services-manifest"]);
  for (const unit of plan.units) service("ready", unit.short);
  const auth = await api("/v1/sessions", "POST", { email: cfg.owner.email, password: readFileSync(cfg.owner.passwordFile, "utf8").trim() });
  check("owner_login", auth.status === 201 && Boolean(auth.payload?.token)); token = auth.payload.token;
  const draft = await api("/v1/portfolio/draft-revisions/latest"), publication = await api("/v1/portfolio/publications/latest");
  const item = op("queryProjectRow", { itemId: Number(args["item-id"]) });
  before = { draftId: draft.payload?.id, publicationId: publication.payload?.id, item, policy: policy() };
  state.observations.before = before; persist();
  check("populated_preconditions", draft.status === 200 && publication.status === 200 && publication.payload?.state === "published" && Boolean(item.id));
  check("unchanged_manager_policy", before.policy.Restart === "on-failure" && before.policy.StartLimitBurst === "3" && before.policy.StartLimitIntervalUSec === "1min");
  // Preflight refuses a recent start; an operator may run later with a fresh ID.
  const uptimeUs = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]) * 1000000;
  check("initial_start_window_clear", uptimeUs - Number(before.policy.ActiveEnterTimestampMonotonic) > 61000000);
  const consumed = [];
  for (let i = 0; i < 2; i++) { service("restart", "control"); service("ready", "control"); consumed.push(policy().ActiveEnterTimestampMonotonic); }
  check("two_real_preconsumed_starts", Number(consumed[1]) > Number(consumed[0]), { timestamps: consumed });
  const observed = op("boundedStartupFailure", { publicationId: publication.payload.id, slug: publication.payload.slug, itemId: item.id });
  state.observations.startup = observed; persist();
  check("bounded_failure_and_recovery", observed.observedReadinessAttempts === 1 && observed.readinessExitStatus !== 0 && observed.readinessElapsedMs <= observed.readinessDeadlineMs && observed.ownerVisibleReason === true && observed.unhealthyAdvertised === false);
  check("budget_respected", observed.startBudget?.quietWindowObserved === true && observed.startBudget.waitedMs >= 60000 && observed.startBudget.startLimitBurst === 3 && observed.startBudget.startLimitIntervalMs === 60000);
  check("two_actual_restart_probes", observed.observedManagedRestarts === 2 && Number(observed.restartTimestamps?.[1]) > Number(observed.restartTimestamps?.[0]));
  check("affected_services_recovered", observed.recoveredUnits?.length === 7 && observed.recoveredUnits.every(x => x.ready === true));
  check("independent_static_and_data", observed.staticStatusWhilePublisherDown === 200 && observed.publicationId === before.publicationId && String(observed.itemId) === String(item.id));
  const afterDraft = await api("/v1/portfolio/draft-revisions/latest"), afterPublication = await api("/v1/portfolio/publications/latest");
  check("entry_content_retained", afterDraft.payload?.id === before.draftId && afterPublication.payload?.id === before.publicationId && JSON.stringify(op("queryProjectRow", { itemId: item.id })) === JSON.stringify(item));
  const afterPolicy = policy();
  check("policy_still_unchanged", ["Restart", "StartLimitBurst", "StartLimitIntervalUSec"].every(k => afterPolicy[k] === before.policy[k]));
  for (const unit of plan.units) service("ready", unit.short);
  check("all_services_ready", true, { count: plan.units.length });
  state.status = "passed";
} catch (error) {
  state.status = "failed";
  state.error = /^[a-zA-Z0-9_]{1,100}$/.test(error.message) ? error.message : "focused_operation_failed";
  const safeCode = value => typeof value === "string" && /^[A-Za-z0-9_]{1,100}$/.test(value) ? value : null;
  state.failure = { name: safeCode(error.name), code: safeCode(error.code), causeCode: safeCode(error.cause?.code) };
}
finally {
  if (token) { try { const r = await api("/v1/sessions/current", "DELETE"); state.cleanup.push({ sessionRevoked: r.status === 204 }); if (r.status !== 204) state.status = "failed"; } catch { state.status = "failed"; state.cleanup.push({ sessionRevoked: false }); } }
  state.endedAt = new Date().toISOString(); persist();
  writeFileSync(join(dir, "REPORT.md"), `# Focused startup regression\n\nStatus: ${state.status}. This is not a full M3.5 gate.\n\nTwo real control starts precede the shared startup operation. Assertions observe manager policy, finite failure, a real quiet interval, two more successful starts, service readiness and unchanged populated state. No narrative/publication/route writes.\n\nUse manifest.rerun with a fresh run ID and current item ID.\n`, { mode: 0o600 });
  copyFileSync(fileURLToPath(import.meta.url), join(dir, "runner.mjs")); copyFileSync(join(root, "e2e/beta/operations.mjs"), join(dir, "operations.mjs"));
  const files = ["manifest.json", "REPORT.md", "runner.mjs", "operations.mjs"];
  writeFileSync(join(dir, "SHA256SUMS"), files.map(n => createHash("sha256").update(readFileSync(join(dir, n))).digest("hex") + "  " + n).join("\n") + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ status: state.status, assertions: state.assertions.length, error: state.error ?? null, artifact: dir }));
  if (state.status !== "passed") process.exitCode = 1;
}
