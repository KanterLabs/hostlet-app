import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { registerM3BuildFixtures } from "../support/m3-build.mjs";
import { runM3Context } from "../support/m3-context.mjs";
import { createM3RuntimeHarness, RUNSC_SHA256 } from "../support/m3-runtime.mjs";
import { registerM3DataFixtures, createM3DataStage } from "./m3-data.mjs";
import { runM3BuildScenarios } from "./m3-build.mjs";
import { M3_UPGRADE_REQUIRED_ASSERTIONS } from "./m3-upgrade.mjs";

const ASSERTION = "M3-RUNTIME-DATABASE-BOOTSTRAP-DEVELOPMENT";
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function oneApplication(value) {
  const candidates = Array.isArray(value) ? value : [value];
  const application = candidates.find((candidate) => candidate?.kind === "application");
  if (!application) throw new Error("full-stack development build emitted no application artifact");
  return application;
}

function sameArray(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}

function receiptDigest(value) {
  return `sha256:${createHash("sha256").update(`${JSON.stringify(value)}\n`).digest("hex")}`;
}

function receiptHashes(entry) {
  if (entry.peerReceipt?.schema !== "hostlet.runtime.peer-receipt/v1" || entry.peerReceipt.operation !== "attach_postgres" || entry.peerReceipt.result !== "passed") {
    throw new Error("database bootstrap peer attach receipt is missing or invalid");
  }
  const hashes = {
    peer_attach: receiptDigest(entry.peerReceipt),
    prepare: entry.prepared?.digest,
    start: entry.started?.digest,
    inspect: entry.inspected?.digest,
    stop: entry.stop?.digest,
    cleanup: entry.cleanup?.digest,
  };
  for (const [name, digest] of Object.entries(hashes)) {
    if (!DIGEST.test(digest ?? "")) throw new Error(`database bootstrap ${name} receipt digest is missing`);
  }
  return hashes;
}

function peerReceiptPasses(receipt, operation, allocation, peer) {
  return receipt?.schema === "hostlet.runtime.peer-receipt/v1" && receipt.result === "passed" &&
    receipt.operation === operation && receipt.allocation_id === allocation.id && receipt.container_id === peer.containerId;
}

function runtimeIdentity(entry) {
  const network = entry.network ?? entry.allocation.network;
  const ipv4Match = /^10\.203\.0\.(\d+)$/.exec(network?.application_ipv4 ?? "");
  const ipv6Match = /^fd77:203:([0-9a-f]+)::2$/i.exec(network?.application_ipv6 ?? "");
  const ipv4Slot = ipv4Match && (Number(ipv4Match[1]) - 2) % 4 === 0 ? (Number(ipv4Match[1]) - 2) / 4 : null;
  const ipv6Slot = ipv6Match ? Number.parseInt(ipv6Match[1], 16) : null;
  return {
    allocation_id: entry.allocation.id,
    generation: entry.allocation.generation,
    fence: entry.allocation.fence,
    sandbox_id: entry.inspected.receipt.sandbox_id,
    cgroup_path: entry.inspected.receipt.observed_limits?.cgroup_path,
    relay_port: entry.relay.port,
    application_ipv4: network?.application_ipv4,
    application_ipv6: network?.application_ipv6,
    network_slot: { ipv4: ipv4Slot, ipv6: ipv6Slot, consistent: Number.isInteger(ipv4Slot) && Number.isInteger(ipv6Slot) && ipv4Slot === ipv6Slot },
    tenant_database_id: entry.databasePeer?.tenantDatabaseId,
    database_generation: entry.databasePeer?.databaseGeneration,
    peer_container_id: entry.databasePeer?.containerId,
  };
}

async function inspectCredentialScope(context, runtime, entry, database, projectId, label) {
  const ownershipPath = join(runtime.stateRoot, entry.allocation.id, String(entry.allocation.generation), "OWNERSHIP.json");
  const ownershipResult = await context.runCommand(`Inspect ${label} owned diagnostic runtime identity`, "sudo", [
    "-n", "cat", "--", ownershipPath,
  ], { timeoutMs: 10_000, logName: `m3-runtime-database-bootstrap-${label}-ownership.log` });
  if (ownershipResult.code !== 0) throw new Error(`${label} diagnostic runtime ownership metadata is unavailable`);
  const ownership = JSON.parse(ownershipResult.stdout);
  const secretRef = entry.secretVersionRefs?.[0];
  const secretMount = ownership.mounts?.secret;
  const expectedSecretTarget = `/run/hostlet-owned-fixture-mounts/${entry.allocation.id}-${entry.allocation.generation}-${entry.allocation.fence}/secrets`;
  const mountedCredentialControlScope =
    ownership.allocation_id === entry.allocation.id &&
    ownership.generation === entry.allocation.generation &&
    ownership.fence === entry.allocation.fence &&
    entry.databasePeer?.tenantDatabaseId === database.record.id &&
    entry.databasePeer?.databaseGeneration === database.record.generation &&
    entry.databasePeer?.databaseName === database.peer.databaseName &&
    entry.environment?.length === 1 && entry.environment[0]?.name === "DATABASE_URL" &&
    secretRef?.name === "DATABASE_URL" && UUID.test(secretRef.version_id ?? "") &&
    secretRef.version_id === database.peer.credentialVersionId &&
    secretMount?.source === "tmpfs" &&
    secretMount.target === expectedSecretTarget &&
    secretMount.readonly === false &&
    sameArray(secretMount.options, ["nodev", "nosuid", "noexec"]) &&
    Number.isInteger(secretMount.target_inode) && secretMount.target_inode > 0 &&
    typeof secretMount.identity === "string" && secretMount.identity.length > 0;
  if (!mountedCredentialControlScope) throw new Error(`${label} runtime credential was not mounted in the exact control-scoped allocation secret target`);

  const mounted = await context.runCommand(`Inspect ${label} diagnostic runtime credential mount`, "sudo", [
    "-n", "findmnt", "-n", "-o", "ID,SOURCE,FSROOT,TARGET,FSTYPE,OPTIONS", "--mountpoint", secretMount.target,
  ], { timeoutMs: 10_000, logName: `m3-runtime-database-bootstrap-${label}-secret-mount.log` });
  const mountFields = mounted.stdout.trim().split(/\s+/);
  const mountOptions = new Set(mountFields[5]?.split(",") ?? []);
  const mountObserved = mounted.code === 0 && mountFields[3] === secretMount.target && mountFields[4] === "tmpfs" &&
    ["rw", "nosuid", "nodev", "noexec"].every((option) => mountOptions.has(option));
  if (!mountObserved) throw new Error(`${label} runtime credential secret target is not the expected mounted tmpfs`);
  return { ownershipPath, ownership, secretRef, secretMount, mountedCredentialControlScope, mountObserved, relayMapPath: entry.relay.mapPath };
}

async function cleanupDiagnosticRuntime(runtime, entry, scope, label) {
  await runtime.stopAndCleanup(entry, { cleanup: true });
  const cleanup = entry.cleanup?.receipt?.cleanup;
  const hashes = receiptHashes(entry);
  const passed = entry.stopped === true && cleanup?.sandbox_absent === true &&
    cleanup.application_namespace_absent === true && cleanup.gateway_namespace_absent === true &&
    cleanup.cgroup_absent === true && cleanup.mounts_absent === true && cleanup.state_retained === false &&
    !existsSync(scope.relayMapPath) && !existsSync(scope.ownershipPath);
  if (!passed) throw new Error(`${label} diagnostic runtime did not prove complete stop and cleanup receipts`);
  return { label, allocation_id: entry.allocation.id, generation: entry.allocation.generation, fence: entry.allocation.fence, receipt_hashes: hashes, cleanup };
}

async function relayJson(relay, path, { method = "GET", body } = {}, signal) {
  const response = await fetch(`http://127.0.0.1:${relay.port}${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.any([AbortSignal.timeout(10_000), signal]),
  });
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch {}
  return { status: response.status, payload, text };
}

async function runRuntimeDatabaseBootstrapDevelopment(context) {
  context.registerFixture("M3 runtime database bootstrap development scenario", "e2e/scenarios/m3-runtime-database-bootstrap-development.mjs");
  context.registerFixture("M3 runtime support", "e2e/support/m3-runtime.mjs");
  for (const path of [
    "scripts/runtime/hostlet-runtime-launcher",
    "scripts/runtime/hostlet-runtime-peer",
    "scripts/runtime/hostlet-runtime-cleanup",
    "scripts/runtime/hostlet-runtime-relay.py",
    "scripts/runtime/prepare-artifact.py",
  ]) context.registerFixture(`M3 runtime database bootstrap boundary: ${path}`, path);
  registerM3BuildFixtures(context);
  registerM3DataFixtures(context);

  await runM3Context(context, async (m3) => {
    /*
     * Failure inventory recorded before extending this diagnostic:
     * - the previous full runtime RUNTIME01-05 path passed, then DATA01's
     *   second attach against the same tenant peer failed with
     *   peer_endpoint_collision;
     * - the two-runtime check therefore requires the second attach to succeed
     *   without disturbing the first, both runtimes to read/write shared rows,
     *   stopping one to leave the other healthy and writable, and both exact
     *   cleanup receipts to prove ownership absence;
     * - this remains diagnostic evidence and cannot satisfy M3-RUNTIME-01..05.
     */
    await runM3BuildScenarios(m3, { developmentBuildsOnly: true });
    const prepared = m3.state.m3Build.fullstackV1.prepared;
    const data = createM3DataStage(m3, {
      mainProject: {
        graph: prepared.graph,
        deployment: prepared.deployment,
        reservation: prepared.admission.reservation,
      },
    });
    m3.state.dataStage = data;
    const provisioned = await data.provision();
    const projectId = prepared.project.project.id;
    const database = provisioned.databases.find((candidate) => candidate.project.projectId === projectId);
    if (!database?.peer) throw new Error("database bootstrap diagnostic lacks the exact primary tenant peer");

    const buildOutput = oneApplication(m3.state.buildOutputs.fullstack_v1);
    const nodeBaseRoots = { 24: join(context.repo, ".local/m3-assets/node24/runtime-base/rootfs") };
    const runtime = createM3RuntimeHarness(context, m3);
    await runtime.initialize();

    const liveEntries = [];
    try {
      const assembled = await runtime.assembleArtifacts(new Map([["fullstack_v1", buildOutput]]), nodeBaseRoots);
      const runtimeBuild = assembled.get("fullstack_v1");
      if (runtimeBuild?.nodeMajor !== 24 || runtimeBuild.framework !== "node_http" || runtimeBuild.runtimeManifest?.schema !== "hostlet.runtime-artifact/v1" || !existsSync(runtimeBuild.runtimeRootfs)) {
        throw new Error("verified Node 24 full-stack runtime artifact was not assembled through the private HCA/base boundary");
      }

      const preferredNetworkIndex = 1;
      const first = await runtime.launchDiagnosticBootstrap({ buildOutput: runtimeBuild, databasePeer: database.peer, index: preferredNetworkIndex });
      liveEntries.push(first);
      const firstScope = await inspectCredentialScope(context, runtime, first, database, projectId, "first");
      const firstName = `database-bootstrap-first-${context.state.runId}`;
      const firstHealth = await relayJson(first.relay, first.allocation.health_path, {}, context.abortSignal);
      const firstBefore = await relayJson(first.relay, "/api/items", {}, context.abortSignal);
      const firstWrite = await relayJson(first.relay, "/api/items", { method: "POST", body: { name: firstName } }, context.abortSignal);
      const firstAfter = await relayJson(first.relay, "/api/items", {}, context.abortSignal);
      const firstReadWriteObserved =
        firstHealth.status === 200 && first.inspected.receipt.health?.passing === true &&
        firstBefore.status === 200 && firstWrite.status === 201 && firstWrite.payload?.item?.name === firstName &&
        firstAfter.status === 200 && firstAfter.payload?.items?.some((item) => item.name === firstName);
      if (!firstReadWriteObserved) throw new Error("first database-backed Node 24 runtime did not pass health and application read/write checks");

      const second = await runtime.launchDiagnosticBootstrap({ buildOutput: runtimeBuild, databasePeer: database.peer, index: preferredNetworkIndex });
      liveEntries.push(second);
      const secondScope = await inspectCredentialScope(context, runtime, second, database, projectId, "second");
      const firstIdentity = runtimeIdentity(first);
      const secondIdentity = runtimeIdentity(second);
      const simultaneous =
        first.stopped === false && second.stopped === false &&
        firstIdentity.allocation_id !== secondIdentity.allocation_id &&
        firstIdentity.generation === secondIdentity.generation &&
        firstIdentity.fence === secondIdentity.fence &&
        firstIdentity.sandbox_id !== secondIdentity.sandbox_id &&
        firstIdentity.cgroup_path !== secondIdentity.cgroup_path &&
        firstIdentity.relay_port !== secondIdentity.relay_port &&
        firstIdentity.application_ipv4 !== secondIdentity.application_ipv4 &&
        firstIdentity.application_ipv6 !== secondIdentity.application_ipv6 &&
        firstIdentity.network_slot.consistent && secondIdentity.network_slot.consistent &&
        firstIdentity.network_slot.ipv4 !== secondIdentity.network_slot.ipv4 &&
        firstIdentity.network_slot.ipv6 !== secondIdentity.network_slot.ipv6 &&
        firstIdentity.tenant_database_id === database.record.id &&
        secondIdentity.tenant_database_id === database.record.id &&
        firstIdentity.database_generation === database.record.generation &&
        secondIdentity.database_generation === database.record.generation &&
        firstIdentity.peer_container_id === secondIdentity.peer_container_id &&
        firstIdentity.tenant_database_id === secondIdentity.tenant_database_id &&
        firstScope.secretMount.target !== secondScope.secretMount.target;
      if (!simultaneous) throw new Error("two concurrent database runtimes did not retain distinct allocation, sandbox, cgroup, relay, and secret identities");

      const secondName = `database-bootstrap-second-${context.state.runId}`;
      const secondHealth = await relayJson(second.relay, second.allocation.health_path, {}, context.abortSignal);
      const secondBefore = await relayJson(second.relay, "/api/items", {}, context.abortSignal);
      const secondWrite = await relayJson(second.relay, "/api/items", { method: "POST", body: { name: secondName } }, context.abortSignal);
      const secondAfter = await relayJson(second.relay, "/api/items", {}, context.abortSignal);
      const secondReadWriteObserved =
        secondHealth.status === 200 && second.inspected.receipt.health?.passing === true &&
        secondBefore.status === 200 && secondBefore.payload?.items?.some((item) => item.name === firstName) &&
        secondWrite.status === 201 && secondWrite.payload?.item?.name === secondName &&
        secondAfter.status === 200 && secondAfter.payload?.items?.some((item) => item.name === firstName) &&
        secondAfter.payload?.items?.some((item) => item.name === secondName);
      if (!secondReadWriteObserved) throw new Error("second concurrent runtime did not read the first row and write/read its shared tenant row");

      const firstAfterSecond = await relayJson(first.relay, "/api/items", {}, context.abortSignal);
      const firstSawSecond = firstAfterSecond.status === 200 && firstAfterSecond.payload?.items?.some((item) => item.name === secondName);
      if (!firstSawSecond) throw new Error("first concurrent runtime did not observe the second runtime's shared tenant write");

      const firstAttachReplay = await runtime.attachPostgres(first.allocation, database.peer);
      if (!peerReceiptPasses(firstAttachReplay, "attach_postgres", first.allocation, database.peer)) throw new Error("exact PostgreSQL attach replay did not preserve the first runtime tuple");
      const firstReplayRead = await relayJson(first.relay, "/api/items", {}, context.abortSignal);
      const secondReplayRead = await relayJson(second.relay, "/api/items", {}, context.abortSignal);
      const replaySharedRows =
        firstReplayRead.status === 200 && firstReplayRead.payload?.items?.some((item) => item.name === firstName) &&
        firstReplayRead.payload?.items?.some((item) => item.name === secondName) &&
        secondReplayRead.status === 200 && secondReplayRead.payload?.items?.some((item) => item.name === firstName) &&
        secondReplayRead.payload?.items?.some((item) => item.name === secondName);
      if (!replaySharedRows) throw new Error("attach replay did not preserve shared-row reads through both live runtime relays");
      const firstDetachReplay = await runtime.attachPostgres(first.allocation, database.peer, "detach_postgres");
      if (!peerReceiptPasses(firstDetachReplay, "detach_postgres", first.allocation, database.peer)) throw new Error("explicit PostgreSQL detach replay did not preserve the first runtime tuple");

      const firstCleanup = await cleanupDiagnosticRuntime(runtime, first, firstScope, "first");
      const survivorName = `database-bootstrap-survivor-${context.state.runId}`;
      const survivorHealth = await relayJson(second.relay, second.allocation.health_path, {}, context.abortSignal);
      const survivorWrite = await relayJson(second.relay, "/api/items", { method: "POST", body: { name: survivorName } }, context.abortSignal);
      const survivorAfter = await relayJson(second.relay, "/api/items", {}, context.abortSignal);
      const survivorObserved =
        second.stopped === false && survivorHealth.status === 200 && survivorWrite.status === 201 &&
        survivorWrite.payload?.item?.name === survivorName && survivorAfter.status === 200 &&
        survivorAfter.payload?.items?.some((item) => item.name === survivorName) &&
        survivorAfter.payload?.items?.some((item) => item.name === firstName) &&
        survivorAfter.payload?.items?.some((item) => item.name === secondName);
      if (!survivorObserved) throw new Error("stopping the first runtime did not leave the second runtime healthy and writable");
      const secondCleanup = await cleanupDiagnosticRuntime(runtime, second, secondScope, "second");

      const third = await runtime.launchDiagnosticBootstrap({ buildOutput: runtimeBuild, databasePeer: database.peer, index: preferredNetworkIndex });
      liveEntries.push(third);
      const thirdScope = await inspectCredentialScope(context, runtime, third, database, projectId, "third");
      const thirdIdentity = runtimeIdentity(third);
      const thirdHealth = await relayJson(third.relay, third.allocation.health_path, {}, context.abortSignal);
      const thirdRead = await relayJson(third.relay, "/api/items", {}, context.abortSignal);
      const thirdObserved =
        thirdHealth.status === 200 && third.inspected.receipt.health?.passing === true &&
        thirdRead.status === 200 && thirdRead.payload?.items?.some((item) => item.name === firstName) &&
        thirdRead.payload?.items?.some((item) => item.name === secondName) &&
        thirdRead.payload?.items?.some((item) => item.name === survivorName);
      if (!thirdObserved) throw new Error("third runtime did not reactivate the preferred slot and read all shared tenant rows after both prior cleanups");
      const thirdCleanup = await cleanupDiagnosticRuntime(runtime, third, thirdScope, "third");

      const firstReceiptHashes = {
        ...firstCleanup.receipt_hashes,
        postgres_attach_replay: receiptDigest(firstAttachReplay),
        postgres_detach_replay: receiptDigest(firstDetachReplay),
      };
      const secondReceiptHashes = secondCleanup.receipt_hashes;
      const thirdReceiptHashes = thirdCleanup.receipt_hashes;
      const secretRef = firstScope.secretRef;
      const secretMount = firstScope.secretMount;
      const cleanup = firstCleanup.cleanup;

      const observations = {
        diagnostic_only: true,
        production_capability_registered: false,
        runsc_sha256: RUNSC_SHA256,
        preferred_network_index: preferredNetworkIndex,
        build_job_id: runtimeBuild.buildJobId,
        artifact_id: runtimeBuild.artifactId,
        archive_digest: runtimeBuild.archiveDigest,
        build_manifest_digest: runtimeBuild.manifestDigest,
        runtime_tree_digest: runtimeBuild.runtimeTreeDigest,
        base_rootfs_digest: runtimeBuild.runtimeManifest.base_rootfs_digest,
        secret_env_shim_digest: runtimeBuild.runtimeManifest.secret_env_shim_digest,
        allocation_id: firstIdentity.allocation_id,
        generation: firstIdentity.generation,
        fence: firstIdentity.fence,
        profile: first.allocation.profile,
        capability_digest: first.allocation.capability_digest,
        credential_scope: {
          project_id: projectId,
          tenant_database_id: database.record.id,
          database_generation: database.record.generation,
          secret_name: secretRef.name,
          secret_version_id: secretRef.version_id,
          mount_target: secretMount.target,
          mount_source: secretMount.source,
          mount_options: secretMount.options,
        },
        prepare_receipt_digest: firstReceiptHashes.prepare,
        start_receipt_digest: firstReceiptHashes.start,
        inspect_receipt_digest: firstReceiptHashes.inspect,
        stop_receipt_digest: firstReceiptHashes.stop,
        cleanup_receipt_digest: firstReceiptHashes.cleanup,
        health_passing: first.inspected.receipt.health.passing,
        health_status: firstHealth.status,
        read_status: firstBefore.status,
        write_status: firstWrite.status,
        after_status: firstAfter.status,
        read_write_observed: firstReadWriteObserved,
        mounted_credential_control_scope: firstScope.mountedCredentialControlScope && firstScope.mountObserved,
        cleanup: cleanup,
        concurrent: {
          diagnostic_only: true,
          simultaneous,
          distinct_allocation_ids: firstIdentity.allocation_id !== secondIdentity.allocation_id,
          distinct_sandbox_ids: firstIdentity.sandbox_id !== secondIdentity.sandbox_id,
          distinct_cgroup_paths: firstIdentity.cgroup_path !== secondIdentity.cgroup_path,
          distinct_relay_ports: firstIdentity.relay_port !== secondIdentity.relay_port,
          preferred_network_index: preferredNetworkIndex,
          observed_network_slots: { first: firstIdentity.network_slot, second: secondIdentity.network_slot },
          application_addresses: {
            first: { ipv4: firstIdentity.application_ipv4, ipv6: firstIdentity.application_ipv6 },
            second: { ipv4: secondIdentity.application_ipv4, ipv6: secondIdentity.application_ipv6 },
          },
          same_tenant_database: firstIdentity.tenant_database_id === secondIdentity.tenant_database_id && firstIdentity.tenant_database_id === database.record.id && firstIdentity.database_generation === secondIdentity.database_generation && firstIdentity.peer_container_id === secondIdentity.peer_container_id,
          first: {
            allocation_id: firstIdentity.allocation_id,
            generation: firstIdentity.generation,
            fence: firstIdentity.fence,
            sandbox_id: firstIdentity.sandbox_id,
            cgroup_path: firstIdentity.cgroup_path,
            relay_port: firstIdentity.relay_port,
            application_ipv4: firstIdentity.application_ipv4,
            application_ipv6: firstIdentity.application_ipv6,
            network_slot: firstIdentity.network_slot,
            receipt_hashes: firstReceiptHashes,
            postgres_replay: {
              allocation_id: first.allocation.id,
              generation: first.allocation.generation,
              fence: first.allocation.fence,
              attach: { digest: firstReceiptHashes.postgres_attach_replay, operation: firstAttachReplay.operation, result: firstAttachReplay.result, container_id: firstAttachReplay.container_id },
              shared_rows: {
                first_status: firstReplayRead.status,
                second_status: secondReplayRead.status,
                first_read_both: firstReplayRead.status === 200 && firstReplayRead.payload?.items?.some((item) => item.name === firstName) && firstReplayRead.payload?.items?.some((item) => item.name === secondName),
                second_read_both: secondReplayRead.status === 200 && secondReplayRead.payload?.items?.some((item) => item.name === firstName) && secondReplayRead.payload?.items?.some((item) => item.name === secondName),
                passed: replaySharedRows,
              },
              detach: { digest: firstReceiptHashes.postgres_detach_replay, operation: firstDetachReplay.operation, result: firstDetachReplay.result, container_id: firstDetachReplay.container_id },
            },
            read_write_observed: firstReadWriteObserved,
            mounted_credential_control_scope: firstScope.mountedCredentialControlScope && firstScope.mountObserved,
            cleanup: firstCleanup,
          },
          second: {
            allocation_id: secondIdentity.allocation_id,
            generation: secondIdentity.generation,
            fence: secondIdentity.fence,
            sandbox_id: secondIdentity.sandbox_id,
            cgroup_path: secondIdentity.cgroup_path,
            relay_port: secondIdentity.relay_port,
            application_ipv4: secondIdentity.application_ipv4,
            application_ipv6: secondIdentity.application_ipv6,
            network_slot: secondIdentity.network_slot,
            receipt_hashes: secondReceiptHashes,
            read_write_observed: secondReadWriteObserved,
            mounted_credential_control_scope: secondScope.mountedCredentialControlScope && secondScope.mountObserved,
            cleanup: secondCleanup,
          },
          shared_database: {
            tenant_database_id: database.record.id,
            database_generation: database.record.generation,
            first_row_name: firstName,
            second_row_name: secondName,
            survivor_row_name: survivorName,
            second_saw_first: secondBefore.payload?.items?.some((item) => item.name === firstName) === true,
            first_saw_second: firstSawSecond,
            survivor_healthy: survivorHealth.status === 200,
            survivor_writable: survivorWrite.status === 201,
            survivor_readback: survivorObserved,
          },
          reactivation: {
            preferred_network_index: preferredNetworkIndex,
            allocation_id: thirdIdentity.allocation_id,
            generation: thirdIdentity.generation,
            fence: thirdIdentity.fence,
            sandbox_id: thirdIdentity.sandbox_id,
            cgroup_path: thirdIdentity.cgroup_path,
            relay_port: thirdIdentity.relay_port,
            application_ipv4: thirdIdentity.application_ipv4,
            application_ipv6: thirdIdentity.application_ipv6,
            network_slot: thirdIdentity.network_slot,
            same_tenant_database: thirdIdentity.tenant_database_id === database.record.id && thirdIdentity.database_generation === database.record.generation && thirdIdentity.peer_container_id === firstIdentity.peer_container_id,
            mounted_credential_control_scope: thirdScope.mountedCredentialControlScope && thirdScope.mountObserved,
            health_status: thirdHealth.status,
            read_status: thirdRead.status,
            read_first_row: thirdRead.payload?.items?.some((item) => item.name === firstName) === true,
            read_second_row: thirdRead.payload?.items?.some((item) => item.name === secondName) === true,
            read_survivor_row: thirdRead.payload?.items?.some((item) => item.name === survivorName) === true,
            read_all_prior_rows: thirdObserved,
            receipt_hashes: thirdReceiptHashes,
            cleanup: thirdCleanup,
          },
          cleanup: { first: firstCleanup, second: secondCleanup },
        },
      };
      if (first.allocation.profile !== "owned_fixture_evaluation" || first.allocation.capability_digest !== null || second.allocation.profile !== "owned_fixture_evaluation" || second.allocation.capability_digest !== null || third.allocation.profile !== "owned_fixture_evaluation" || third.allocation.capability_digest !== null) throw new Error("diagnostic runtime unexpectedly registered a production capability");
      writeFileSync(join(context.artifactDir, "m3-runtime-database-bootstrap-development.json"), `${JSON.stringify({ schema: "hostlet.m3-runtime-database-bootstrap-development/v1", ...observations }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      context.assertion(ASSERTION, "M3 diagnostic database runtime bootstrap", "two actual concurrent Node 24 HCA runtimes share one control-scoped tenant database, one zero-member reactivation reads prior rows, and all prove complete cleanup without registering production capability", observations, true);
    } catch (error) {
      const cleanupErrors = [];
      for (const entry of [...liveEntries].reverse()) {
        if (entry && !entry.stopped) {
          try { await runtime.stopAndCleanup(entry, { cleanup: true }); } catch (caught) { cleanupErrors.push(caught); }
        }
      }
      context.assertion(ASSERTION, "M3 diagnostic database runtime bootstrap", "two actual concurrent Node 24 HCA runtimes share one control-scoped tenant database, one zero-member reactivation reads prior rows, and all prove complete cleanup without registering production capability", { diagnostic_only: true, production_capability_registered: false, failed_checks: 1 }, false, error.message);
      if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors], "database runtime bootstrap diagnostic and cleanup both failed");
      throw error;
    }
  });
}

export const scenario = Object.freeze({
  id: "m3-runtime-database-bootstrap-development",
  description: "Diagnostic-only Node 24 gVisor database bootstrap with a control-scoped tenant credential; excludes M3 runtime acceptance and production capability registration",
  requiredAssertions: Object.freeze([...M3_UPGRADE_REQUIRED_ASSERTIONS, "M3-BUILD-01", "M3-BUILD-02", ASSERTION]),
  run: runRuntimeDatabaseBootstrapDevelopment,
});
