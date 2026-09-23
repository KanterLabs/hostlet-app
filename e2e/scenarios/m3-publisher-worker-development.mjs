import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { runM3Context } from "../support/m3-context.mjs";
import { M3_UPGRADE_REQUIRED_ASSERTIONS } from "./m3-upgrade.mjs";

const ASSERTION = "M3-PUBLISHER-WORKER-DEVELOPMENT";

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function requireCheck(condition, message) {
  if (!condition) throw new Error(message);
}

async function publicationCounts(m3, label) {
  return m3.postgres.psqlJson(label, `SELECT json_build_object(
    'publications',(SELECT COUNT(*)::int FROM portfolio_publications),
    'attempts',(SELECT COUNT(*)::int FROM portfolio_publication_attempts));`);
}

async function runPublisherWorkerDevelopment(context) {
  context.registerFixture("M3 focused publisher worker empty-queue diagnostic", "e2e/scenarios/m3-publisher-worker-development.mjs");
  context.registerFixture("M3 real publisher worker entrypoint", "crates/publisher/src/main.rs");
  context.registerFixture("M3 real publisher worker lease client", "crates/publisher/src/worker.rs");
  context.registerFixture("M3 control publisher lease boundary", "crates/control/src/portfolio_publish.rs");

  await runM3Context(context, async (m3) => {
    let worker = null;
    let before = null;
    let after = null;
    let leaseStatus = null;
    let latestBeforeStatus = null;
    let latestAfterStatus = null;
    let primaryError = null;
    try {
      before = await publicationCounts(m3, "m3-publisher-empty-before");
      requireCheck(before.publications === 0 && before.attempts === 0, "publisher diagnostic requires an actual empty publication queue");
      const latestBefore = await m3.ownerHTTP("/v1/portfolio/publications/latest");
      latestBeforeStatus = latestBefore.status;
      requireCheck(latestBefore.status === 404, "owner publication head was not empty before worker launch");

      const lease = await m3.roleInternal("publisher", "/internal/v1/portfolio-publications/lease", {
        method: "POST", body: { worker_id: `publisher-empty-probe-${randomUUID()}` },
      });
      leaseStatus = lease.status;
      requireCheck(lease.status === 204, "real publisher role lease endpoint did not return an empty queue");

      worker = await context.runCommand("M3 publisher --once empty-queue worker", join(context.repo, "target", "debug", "hostlet-publisher"), [
        "worker", "--control-url", m3.workerUrl, "--worker-id", `publisher-empty-${randomUUID()}`, "--once",
      ], { cwd: context.repo, env: m3.componentEnvironment("publisher"), timeoutMs: 30_000, logName: "m3-publisher-worker-empty-queue.log" });
      requireCheck(worker.code === 0 && worker.signal === null && worker.stdout.trim() === "" && worker.stderr.trim() === "", "publisher --once did not exit cleanly after the empty real lease response");

      after = await publicationCounts(m3, "m3-publisher-empty-after");
      const latestAfter = await m3.ownerHTTP("/v1/portfolio/publications/latest");
      latestAfterStatus = latestAfter.status;
      requireCheck(after.publications === before.publications && after.attempts === before.attempts && latestAfter.status === 404, "empty-queue publisher worker changed publication or attempt state");
    } catch (error) {
      primaryError = error;
      if (!after) {
        try { after = await publicationCounts(m3, "m3-publisher-empty-after-failure"); } catch { /* original failure remains authoritative */ }
      }
    }

    const observation = {
      diagnostic_only: true, production_capability_registered: false, m3_gate_satisfied: false,
      queue_before: before, queue_after: after, owner_latest_before_status: latestBeforeStatus,
      owner_latest_after_status: latestAfterStatus, publisher_role_empty_lease_status: leaseStatus,
      worker: worker && {
        exit_code: worker.code, signal: worker.signal,
        stdout_empty: worker.stdout.trim() === "", stderr_empty: worker.stderr.trim() === "",
        log: relative(context.artifactDir, worker.logPath), log_sha256: sha256(readFileSync(worker.logPath)),
      },
      ...(primaryError ? { failure: context.redact(primaryError.message) } : {}),
    };
    writeFileSync(join(context.artifactDir, "m3-publisher-worker-development.json"), `${JSON.stringify({ schema: "hostlet.m3-publisher-worker-development/v1", ...observation }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    const expected = "the real publisher role sees an empty control lease, the actual --once worker exits cleanly, and PostgreSQL retains zero publications and attempts";
    context.assertion(ASSERTION, "M3 focused publisher worker bootstrap", expected, observation, !primaryError, primaryError?.message ?? null);
    if (primaryError) throw primaryError;
  });
}

export const scenario = Object.freeze({
  id: "m3-publisher-worker-development",
  description: "Diagnostic-only real publisher --once empty-queue HTTP lease and clean-exit check; excludes approval, publication, and M3 gate acceptance",
  requiredAssertions: Object.freeze([...M3_UPGRADE_REQUIRED_ASSERTIONS, ASSERTION]),
  run: runPublisherWorkerDevelopment,
});
