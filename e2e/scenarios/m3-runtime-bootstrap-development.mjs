import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { registerM3BuildFixtures } from "../support/m3-build.mjs";
import { runM3Context } from "../support/m3-context.mjs";
import { createM3RuntimeHarness, RUNSC_SHA256 } from "../support/m3-runtime.mjs";
import { runM3BuildScenarios } from "./m3-build.mjs";
import { M3_UPGRADE_REQUIRED_ASSERTIONS } from "./m3-upgrade.mjs";

const ASSERTION = "M3-RUNTIME-BOOTSTRAP-DEVELOPMENT";

function oneApplication(value) {
  const candidates = Array.isArray(value) ? value : [value];
  const application = candidates.find((candidate) => candidate?.kind === "application");
  if (!application) throw new Error("Node 22 development build emitted no application artifact");
  return application;
}

async function runRuntimeBootstrapDevelopment(context) {
  context.registerFixture("M3 partial runtime bootstrap development scenario", "e2e/scenarios/m3-runtime-bootstrap-development.mjs");
  context.registerFixture("M3 runtime support", "e2e/support/m3-runtime.mjs");
  for (const path of ["scripts/runtime/hostlet-runtime-launcher", "scripts/runtime/hostlet-runtime-cleanup", "scripts/runtime/hostlet-runtime-relay.py", "scripts/runtime/prepare-artifact.py"]) context.registerFixture(`M3 runtime bootstrap boundary: ${path}`, path);
  registerM3BuildFixtures(context);

  await runM3Context(context, async (m3) => {
    // This intentionally runs only the retained upgrade, BUILD-01/02 development
    // subset, one extra Node 22 build, and one disposable owned-fixture sandbox.
    // It is diagnostic evidence and cannot satisfy M3-RUNTIME-01..05.
    await runM3BuildScenarios(m3, { developmentBuildsOnly: true });
    const built = await m3.state.m3Build.buildFixture("node22_api");
    const buildOutput = oneApplication(built.outputs ?? m3.state.buildOutputs.node22_api);
    const nodeBaseRoots = { 22: join(context.repo, ".local/m3-assets/node22/runtime-base/rootfs") };
    const runtime = createM3RuntimeHarness(context, m3);
    await runtime.initialize();

    let entry;
    let observations;
    try {
      const assembled = await runtime.assembleArtifacts(new Map([["node22_api", buildOutput]]), nodeBaseRoots);
      const runtimeBuild = assembled.get("node22_api");
      if (runtimeBuild?.runtimeManifest?.schema !== "hostlet.runtime-artifact/v1" || !existsSync(runtimeBuild.runtimeRootfs)) throw new Error("verified Node 22 runtime artifact was not assembled through the private HCA/base boundary");
      entry = await runtime.launchDiagnosticBootstrap({ buildOutput: runtimeBuild, index: 1 });
      const response = await fetch(`http://127.0.0.1:${entry.relay.port}${entry.allocation.health_path}`, {
        cache: "no-store",
        signal: AbortSignal.any([AbortSignal.timeout(5_000), context.abortSignal]),
      });
      const body = await response.text();
      if (response.status !== 200 || !entry.inspected.receipt.health?.passing) throw new Error("actual owned Node 22 gVisor bootstrap did not pass health and relay HTTP checks");
      const relayMapPath = entry.relay.mapPath;
      observations = {
        diagnostic_only: true,
        production_capability_registered: false,
        runsc_sha256: RUNSC_SHA256,
        build_job_id: runtimeBuild.buildJobId,
        artifact_id: runtimeBuild.artifactId,
        archive_digest: runtimeBuild.archiveDigest,
        build_manifest_digest: runtimeBuild.manifestDigest,
        runtime_tree_digest: runtimeBuild.runtimeTreeDigest,
        base_rootfs_digest: runtimeBuild.runtimeManifest.base_rootfs_digest,
        secret_env_shim_digest: runtimeBuild.runtimeManifest.secret_env_shim_digest,
        allocation_id: entry.allocation.id,
        generation: entry.allocation.generation,
        fence: entry.allocation.fence,
        profile: entry.allocation.profile,
        prepare_receipt_digest: entry.prepared.digest,
        start_receipt_digest: entry.started.digest,
        inspect_receipt_digest: entry.inspected.digest,
        health_passing: entry.inspected.receipt.health.passing,
        relay_http_status: response.status,
        relay_body_bytes: Buffer.byteLength(body),
      };
      await runtime.stopAndCleanup(entry, { cleanup: true });
      if (!entry.stopped || existsSync(relayMapPath) || entry.cleanup?.receipt?.cleanup?.state_retained !== false) throw new Error("diagnostic runtime did not prove exact stop and cleanup");
      observations.cleanup_receipt_digest = entry.cleanup.digest;
      observations.cleanup = entry.cleanup.receipt.cleanup;
      writeFileSync(join(context.artifactDir, "m3-runtime-bootstrap-development.json"), `${JSON.stringify({ schema: "hostlet.m3-runtime-bootstrap-development/v1", ...observations }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      context.assertion(ASSERTION, "M3 diagnostic runtime bootstrap", "the actual Node 22 HCA plus pinned base launches inside the owned gVisor profile, passes relay HTTP health, and cleans completely without registering a production capability", observations, true);
    } catch (error) {
      let cleanupError = null;
      if (entry && !entry.stopped) {
        try { await runtime.stopAndCleanup(entry, { cleanup: true }); } catch (caught) { cleanupError = caught; }
      }
      context.assertion(ASSERTION, "M3 diagnostic runtime bootstrap", "the actual Node 22 HCA plus pinned base launches inside the owned gVisor profile, passes relay HTTP health, and cleans completely without registering a production capability", { diagnostic_only: true, production_capability_registered: false, failed_checks: 1 }, false, error.message);
      if (cleanupError) throw new AggregateError([error, cleanupError], "runtime bootstrap diagnostic and cleanup both failed");
      throw error;
    }
  });
}

export const scenario = Object.freeze({
  id: "m3-runtime-bootstrap-development",
  description: "Diagnostic-only retained-upgrade, BUILD-01/02 and actual Node 22 gVisor first-start check; excludes M3 runtime acceptance and production capability registration",
  requiredAssertions: Object.freeze([...M3_UPGRADE_REQUIRED_ASSERTIONS, "M3-BUILD-01", "M3-BUILD-02", ASSERTION]),
  run: runRuntimeBootstrapDevelopment,
});
