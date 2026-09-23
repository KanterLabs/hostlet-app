import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { registerM3BuildFixtures } from "../support/m3-build.mjs";
import { runM3Context } from "../support/m3-context.mjs";
import { createM3RuntimeHarness, RUNSC_SHA256 } from "../support/m3-runtime.mjs";
import { registerM3DataFixtures, createM3DataStage } from "./m3-data.mjs";
import { runM3BuildScenarios } from "./m3-build.mjs";
import { M3_UPGRADE_REQUIRED_ASSERTIONS } from "./m3-upgrade.mjs";

const ASSERTION = "M3-RUNTIME-ARTIFACT-IDENTITY-DEVELOPMENT";
const DIGEST = /^sha256:[0-9a-f]{64}$/;

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function application(value) {
  const found = (Array.isArray(value) ? value : [value]).find((item) => item?.kind === "application");
  if (!found) throw new Error("full-stack build has no application artifact");
  return found;
}

function requireCheck(condition, message) {
  if (!condition) throw new Error(message);
}

function canonicalInput(m3, build) {
  const casRoot = join(m3.policyClock.stateDir, "private-cas", "sha256");
  const archiveBytes = readFileSync(join(casRoot, build.archiveDigest.slice(7)));
  const manifestBytes = readFileSync(join(casRoot, build.manifestDigest.slice(7)));
  requireCheck(sha256(archiveBytes) === build.archiveDigest && sha256(manifestBytes) === build.manifestDigest, "canonical build inputs do not match their recorded SHA-256 identities");
  const manifest = JSON.parse(manifestBytes);
  requireCheck(manifest.source_commit === build.sourceCommit && manifest.service_id === build.serviceId, "canonical build manifest does not bind the source and service");
  return { archive_sha256: sha256(archiveBytes), build_manifest_sha256: sha256(manifestBytes), source_commit: manifest.source_commit, service_id: manifest.service_id, build_profile_digest: build.buildProfileDigest, build_job_id: build.buildJobId };
}

function artifactSnapshot(runtime, build) {
  const directory = join(runtime.artifactRoot, build.manifestDigest.slice(7));
  const manifestPath = join(directory, "manifest.json");
  const bytes = readFileSync(manifestPath);
  const manifest = JSON.parse(bytes);
  requireCheck(build.runtimeRootfs === join(directory, "rootfs") && existsSync(build.runtimeRootfs), "runtime rootfs does not live under the manifest identity directory");
  requireCheck(manifest.schema === "hostlet.runtime-artifact/v1" && manifest.archive_digest === build.archiveDigest && manifest.build_manifest_digest === build.manifestDigest && manifest.build_profile_digest === build.buildProfileDigest && manifest.source_commit === build.sourceCommit && manifest.service_id === build.serviceId && manifest.rootfs_tree_digest === build.runtimeTreeDigest, "runtime manifest did not bind the exact build input identity");
  return { directory, manifestPath, bytes, manifest, manifest_sha256: sha256(bytes) };
}

async function relayJson(entry, path, options, signal) {
  const response = await fetch(`http://127.0.0.1:${entry.relay.port}${path}`, {
    method: options?.method ?? "GET",
    headers: options?.body === undefined ? {} : { "Content-Type": "application/json" },
    body: options?.body === undefined ? undefined : JSON.stringify(options.body),
    cache: "no-store",
    signal: AbortSignal.any([AbortSignal.timeout(10_000), signal]),
  });
  return { status: response.status, payload: await response.json() };
}

async function stopExact(runtime, entry) {
  const relayMapPath = entry.relay?.mapPath;
  await runtime.stopAndCleanup(entry, { cleanup: true });
  const cleanup = entry.cleanup?.receipt?.cleanup;
  const receiptHashes = Object.fromEntries(["prepare", "start", "inspect", "stop", "cleanup"].map((operation) => {
    const value = { prepare: entry.prepared, start: entry.started, inspect: entry.inspected, stop: entry.stop, cleanup: entry.cleanup }[operation];
    requireCheck(DIGEST.test(value?.digest ?? ""), `${operation} receipt digest is absent`);
    return [operation, value.digest];
  }));
  const ownershipPath = join(runtime.stateRoot, entry.allocation.id, String(entry.allocation.generation), "OWNERSHIP.json");
  requireCheck(entry.stopped === true && cleanup?.sandbox_absent === true && cleanup.application_namespace_absent === true && cleanup.gateway_namespace_absent === true && cleanup.cgroup_absent === true && cleanup.mounts_absent === true && cleanup.state_retained === false && Boolean(relayMapPath) && !existsSync(relayMapPath) && !existsSync(ownershipPath), "exact runtime cleanup was not proven by receipts and absent ownership paths");
  return { allocation_id: entry.allocation.id, generation: entry.allocation.generation, fence: entry.allocation.fence, receipt_hashes: receiptHashes, cleanup };
}

async function runArtifactIdentityDevelopment(context) {
  context.registerFixture("M3 runtime artifact identity diagnostic", "e2e/scenarios/m3-runtime-artifact-identity-development.mjs");
  context.registerFixture("M3 runtime support", "e2e/support/m3-runtime.mjs");
  for (const path of ["scripts/runtime/hostlet-runtime-launcher", "scripts/runtime/hostlet-runtime-peer", "scripts/runtime/hostlet-runtime-cleanup", "scripts/runtime/hostlet-runtime-relay.py", "scripts/runtime/prepare-artifact.py"]) context.registerFixture(`M3 artifact identity boundary: ${path}`, path);
  registerM3BuildFixtures(context);
  registerM3DataFixtures(context);

  await runM3Context(context, async (m3) => {
    await runM3BuildScenarios(m3, { developmentBuildsOnly: true });
    const firstRecord = m3.state.m3Build.fullstackV1;
    const firstBuild = application(firstRecord.outputs);
    const data = createM3DataStage(m3, { mainProject: { graph: firstRecord.prepared.graph, deployment: firstRecord.prepared.deployment, reservation: firstRecord.prepared.admission.reservation } });
    m3.state.dataStage = data;
    const provisioned = await data.provision();
    const projectId = firstRecord.prepared.project.project.id;
    const database = provisioned.databases.find((candidate) => candidate.project.projectId === projectId);
    requireCheck(Boolean(database?.peer), "exact primary tenant PostgreSQL peer is unavailable");

    const runtime = createM3RuntimeHarness(context, m3);
    await runtime.initialize();
    const nodeBaseRoots = { 24: join(context.repo, ".local/m3-assets/node24/runtime-base/rootfs") };
    const liveEntries = [];
    try {
      const firstInput = canonicalInput(m3, firstBuild);
      const firstAssembled = (await runtime.assembleArtifacts(new Map([["first", firstBuild]]), nodeBaseRoots)).get("first");
      const firstSnapshot = artifactSnapshot(runtime, firstAssembled);

      const secondRecord = await m3.state.m3Build.buildFixture("fullstack_v1", { existingPrepared: firstRecord.prepared, storeAs: "artifact_identity_repeat" });
      const secondBuild = application(secondRecord.outputs);
      const secondInput = canonicalInput(m3, secondBuild);
      requireCheck(secondRecord.prepared.project.project.id === projectId && secondBuild.serviceId === firstBuild.serviceId && secondBuild.sourceCommit === firstBuild.sourceCommit && secondBuild.buildProfileDigest === firstBuild.buildProfileDigest && secondBuild.buildJobId !== firstBuild.buildJobId, "repeated real VM build did not retain the same project, service, source, and profile with a new job");
      requireCheck(secondBuild.archiveDigest === firstBuild.archiveDigest && secondBuild.manifestDigest !== firstBuild.manifestDigest, "two real builds did not produce identical HCA bytes with distinct build manifests");
      const secondAssembled = (await runtime.assembleArtifacts(new Map([["second", secondBuild]]), nodeBaseRoots)).get("second");
      const secondSnapshot = artifactSnapshot(runtime, secondAssembled);
      requireCheck(secondSnapshot.directory !== firstSnapshot.directory && existsSync(firstSnapshot.manifestPath) && readFileSync(firstSnapshot.manifestPath).equals(firstSnapshot.bytes), "second assembly replaced or changed the first manifest-key artifact");

      const replay = (await runtime.assembleArtifacts(new Map([["first_replay", firstBuild]]), nodeBaseRoots)).get("first_replay");
      const replaySnapshot = artifactSnapshot(runtime, replay);
      requireCheck(replaySnapshot.directory === firstSnapshot.directory && replaySnapshot.bytes.equals(firstSnapshot.bytes) && replay.runtimeTreeDigest === firstAssembled.runtimeTreeDigest, "same-identity assembly replay changed the immutable first artifact");

      const wrongProfile = `sha256:${firstBuild.buildProfileDigest.slice(7) === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64)}`;
      const casRoot = join(m3.policyClock.stateDir, "private-cas", "sha256");
      const baseRootfs = nodeBaseRoots[24];
      const baseManifest = join(context.repo, ".local/m3-assets/node24/runtime-base/base.json");
      const rejected = await context.runCommand("Reject conflicting existing runtime artifact profile", join(context.repo, "scripts/runtime/prepare-artifact.py"), [
        "--archive-file", join(casRoot, firstBuild.archiveDigest.slice(7)), "--archive-digest", firstBuild.archiveDigest,
        "--build-manifest", join(casRoot, firstBuild.manifestDigest.slice(7)), "--build-manifest-digest", firstBuild.manifestDigest,
        "--build-profile-digest", wrongProfile,
        "--base-rootfs", baseRootfs, "--base-rootfs-digest", firstSnapshot.manifest.base_rootfs_digest,
        "--base-manifest", baseManifest, "--base-manifest-digest", firstSnapshot.manifest.base_manifest_digest,
        "--artifact-root", runtime.artifactRoot,
      ], { env: m3.componentEnvironment("runtime"), timeoutMs: 180_000, logName: "m3-runtime-artifact-identity-collision.log" });
      requireCheck(rejected.code !== 0 && `${rejected.stderr}\n${rejected.stdout}`.includes("runtime_artifact_collision") && readFileSync(firstSnapshot.manifestPath).equals(firstSnapshot.bytes), "conflicting profile under an existing manifest key was not rejected without mutation");

      const first = await runtime.launchDiagnosticBootstrap({ buildOutput: firstAssembled, databasePeer: database.peer, index: 1 });
      liveEntries.push(first);
      const second = await runtime.launchDiagnosticBootstrap({ buildOutput: secondAssembled, databasePeer: database.peer, index: 1 });
      liveEntries.push(second);
      requireCheck(first.allocation.profile === "owned_fixture_evaluation" && second.allocation.profile === "owned_fixture_evaluation" && first.allocation.capability_digest === null && second.allocation.capability_digest === null && first.allocation.id !== second.allocation.id && first.allocation.artifact_manifest_digest === firstBuild.manifestDigest && second.allocation.artifact_manifest_digest === secondBuild.manifestDigest && first.allocation.build_profile_digest === firstBuild.buildProfileDigest && second.allocation.build_profile_digest === secondBuild.buildProfileDigest, "real diagnostic runtimes did not retain separate exact artifact identities without production capability");
      const firstName = `artifact-identity-first-${context.state.runId}`;
      const secondName = `artifact-identity-second-${context.state.runId}`;
      const firstHealth = await relayJson(first, first.allocation.health_path, {}, context.abortSignal);
      const firstWrite = await relayJson(first, "/api/items", { method: "POST", body: { name: firstName } }, context.abortSignal);
      const secondRead = await relayJson(second, "/api/items", {}, context.abortSignal);
      const secondWrite = await relayJson(second, "/api/items", { method: "POST", body: { name: secondName } }, context.abortSignal);
      const firstRead = await relayJson(first, "/api/items", {}, context.abortSignal);
      requireCheck(firstHealth.status === 200 && first.inspected.receipt.health?.passing === true && second.inspected.receipt.health?.passing === true && firstWrite.status === 201 && firstWrite.payload?.item?.name === firstName && secondRead.status === 200 && secondRead.payload?.items?.some((item) => item.name === firstName) && secondWrite.status === 201 && secondWrite.payload?.item?.name === secondName && firstRead.status === 200 && firstRead.payload?.items?.some((item) => item.name === firstName) && firstRead.payload?.items?.some((item) => item.name === secondName), "two exact artifact runtimes did not read and write through the shared durable tenant database");

      const secondCleanup = await stopExact(runtime, second);
      const firstCleanup = await stopExact(runtime, first);
      requireCheck(readFileSync(firstSnapshot.manifestPath).equals(firstSnapshot.bytes) && readFileSync(secondSnapshot.manifestPath).equals(secondSnapshot.bytes), "runtime execution or cleanup mutated an immutable artifact manifest");
      const observations = {
        diagnostic_only: true, production_capability_registered: false, m3_gate_satisfied: false,
        runsc_sha256: RUNSC_SHA256, project_id: projectId, tenant_database_id: database.record.id,
        first: { ...firstInput, artifact_directory: firstSnapshot.directory, runtime_manifest_sha256: firstSnapshot.manifest_sha256, runtime_tree_digest: firstAssembled.runtimeTreeDigest, allocation_id: first.allocation.id, prepare_receipt_digest: first.prepared.digest, start_receipt_digest: first.started.digest, inspect_receipt_digest: first.inspected.digest, cleanup: firstCleanup },
        second: { ...secondInput, artifact_directory: secondSnapshot.directory, runtime_manifest_sha256: secondSnapshot.manifest_sha256, runtime_tree_digest: secondAssembled.runtimeTreeDigest, allocation_id: second.allocation.id, prepare_receipt_digest: second.prepared.digest, start_receipt_digest: second.started.digest, inspect_receipt_digest: second.inspected.digest, cleanup: secondCleanup },
        same_archive_bytes: firstBuild.archiveDigest === secondBuild.archiveDigest,
        distinct_manifest_keys: firstBuild.manifestDigest !== secondBuild.manifestDigest,
        replay_preserved_first_manifest: replaySnapshot.bytes.equals(firstSnapshot.bytes),
        conflicting_profile_rejected: true,
        shared_database: { first_write_status: firstWrite.status, second_read_status: secondRead.status, second_write_status: secondWrite.status, first_read_status: firstRead.status, second_read_first_row: true, first_read_second_row: true },
      };
      writeFileSync(join(context.artifactDir, "m3-runtime-artifact-identity-development.json"), `${JSON.stringify({ schema: "hostlet.m3-runtime-artifact-identity-development/v1", ...observations }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      context.assertion(ASSERTION, "M3 diagnostic runtime artifact identity", "two real VM builds with identical HCA bytes retain distinct immutable manifest-key runtime artifacts, launch exact gVisor runtimes that share durable tenant PostgreSQL, and prove owned cleanup", observations, true);
    } catch (error) {
      const cleanupErrors = [];
      for (const entry of [...liveEntries].reverse()) {
        if (entry && !entry.stopped) {
          try { await runtime.stopAndCleanup(entry, { cleanup: true }); } catch (caught) { cleanupErrors.push(caught); }
        }
      }
      context.assertion(ASSERTION, "M3 diagnostic runtime artifact identity", "two real VM builds with identical HCA bytes retain distinct immutable manifest-key runtime artifacts, launch exact gVisor runtimes that share durable tenant PostgreSQL, and prove owned cleanup", { diagnostic_only: true, production_capability_registered: false, failed_checks: 1 }, false, error.message);
      if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], "artifact identity diagnostic and owned cleanup both failed");
      throw error;
    }
  });
}

export const scenario = Object.freeze({
  id: "m3-runtime-artifact-identity-development",
  description: "Diagnostic-only real VM and gVisor artifact-manifest identity regression; cannot satisfy M3 runtime acceptance or register a production capability",
  requiredAssertions: Object.freeze([...M3_UPGRADE_REQUIRED_ASSERTIONS, "M3-BUILD-01", "M3-BUILD-02", ASSERTION]),
  run: runArtifactIdentityDevelopment,
});
