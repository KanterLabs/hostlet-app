import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { registerM3BuildFixtures } from "../support/m3-build.mjs";
import { runM3Context } from "../support/m3-context.mjs";
import { createM3RuntimeHarness, RUNSC_SHA256 } from "../support/m3-runtime.mjs";
import { runM3BuildScenarios } from "./m3-build.mjs";
import { M3_UPGRADE_REQUIRED_ASSERTIONS } from "./m3-upgrade.mjs";

const ASSERTION = "M3-RUNTIME-NATIVE-BASELINE-DEVELOPMENT";
const DIAGNOSIS = "diagnosis";
const REGRESSION = "regression";
const ENTRYPOINT = "/app/dist/server.mjs";
const UID = 65_532;
const ACCESS_PROBE = `const fs=require('node:fs');const paths=['/app','/app/dist','${ENTRYPOINT}'];const checks=paths.map(path=>{let stat;try{stat=fs.statSync(path);fs.accessSync(path,fs.constants.R_OK);return {path,readable:true,mode:stat.mode&0o777,uid:stat.uid,gid:stat.gid}}catch(error){return {path,readable:false,code:error.code??null}}});process.stdout.write(JSON.stringify({uid:process.getuid(),gid:process.getgid(),checks})+'\\n')`;

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function privateJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
}

function mode(path) {
  const info = lstatSync(path);
  check(!info.isSymbolicLink(), `mode probe found a symlink: ${path}`);
  return { mode: info.mode & 0o777, uid: info.uid, gid: info.gid, directory: info.isDirectory(), file: info.isFile() };
}

function shellQuote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }

function preparerWrapper(context, mask) {
  const path = join(context.tempDir, `m3-native-preparer-${mask}.sh`);
  const preparer = join(context.repo, "scripts/runtime/prepare-artifact.py");
  const content = `#!/bin/sh\nset -eu\numask ${mask}\nexec ${shellQuote(preparer)} "$@"\n`;
  writeFileSync(path, content, { mode: 0o700, flag: "wx" });
  chmodSync(path, 0o700);
  return { path, sha256: `sha256:${createHash("sha256").update(content).digest("hex")}` };
}

function scopedRuntimeContext(context, mask) {
  const artifactDir = join(context.artifactDir, `native-${mask}`);
  mkdirSync(artifactDir, { mode: 0o700 });
  chmodSync(artifactDir, 0o700);
  return Object.freeze({
    ...context,
    artifactDir,
    runCommand(name, command, args, options = {}) {
      return context.runCommand(name, command, args, {
        ...options,
        logName: options.logName ? `native-${mask}-${options.logName}` : undefined,
      });
    },
    spawnManaged(name, command, args, options, logName) {
      return context.spawnManaged(name, command, args, options, `native-${mask}-${logName}`);
    },
  });
}

function application(value) {
  const found = (Array.isArray(value) ? value : [value]).find((candidate) => candidate?.kind === "application");
  check(Boolean(found), "real Node 22 VM build emitted no application artifact");
  return found;
}

async function accessAsGuestUid(context, rootfs, mask) {
  const result = await context.runCommand(`Probe assembled ${mask} guest access as UID ${UID}`, "sudo", [
    "-n", "chroot", `--userspec=${UID}:${UID}`, rootfs, "/usr/local/bin/node", "-e", ACCESS_PROBE,
  ], { timeoutMs: 10_000, logName: `m3-native-${mask}-uid-access.log` });
  check(result.code === 0, `real UID ${UID} chroot access probe failed for ${mask}: exit ${result.code}`);
  const probe = JSON.parse(result.stdout.trim());
  check(probe.uid === UID && probe.gid === UID && probe.checks?.length === 3, `UID ${UID} chroot probe returned invalid identity for ${mask}`);
  return probe;
}

function snapshot(context, runtime, build, mask, wrapper) {
  const rootfs = build.runtimeRootfs;
  const paths = {
    host_artifact_root: mode(runtime.artifactRoot),
    host_manifest_parent: mode(join(runtime.artifactRoot, build.manifestDigest.slice(7))),
    host_rootfs_parent: mode(rootfs),
    guest_app: mode(join(rootfs, "app")),
    guest_dist: mode(join(rootfs, "app", "dist")),
    guest_entrypoint: mode(join(rootfs, "app", "dist", "server.mjs")),
    host_state_root: mode(runtime.stateRoot),
    host_artifact_directory: mode(context.artifactDir),
  };
  check(paths.host_artifact_root.mode === 0o700 && paths.host_state_root.mode === 0o700 && paths.host_artifact_directory.mode === 0o700, `private host roots lost mode 0700 under ${mask}`);
  check(paths.guest_entrypoint.file && paths.guest_app.directory && paths.guest_dist.directory, `assembled ${mask} guest layout is invalid`);
  return {
    mask, wrapper_sha256: wrapper.sha256, runtime_tree_digest: build.runtimeTreeDigest,
    archive_digest: build.archiveDigest, build_manifest_digest: build.manifestDigest,
    base_rootfs_digest: build.runtimeManifest.base_rootfs_digest,
    paths,
  };
}

function assertNativeCleanup(evidence, runtime, label) {
  check(evidence?.cleanup_succeeded === true && evidence?.metadata_absent === true, `${label} native helper cleanup was not proven`);
  check(!existsSync(join(runtime.stateRoot, "requests", ".native-baseline.json")), `${label} left native metadata behind`);
  if (evidence.cgroup_path) check(evidence.cgroup_absent === true, `${label} left its exact cgroup behind`);
}

async function expectNativeFailure(runtime, build, label, options, verify) {
  let failure = null;
  try { await runtime.runNativeBaseline(build, { measure: false, ...options }); }
  catch (error) { failure = error; }
  check(failure && !failure.cleanupError && !failure.evidenceError && failure.nativeBaselineEvidence, `${label} did not return a clean, observed native rejection`);
  const evidence = failure.nativeBaselineEvidence;
  assertNativeCleanup(evidence, runtime, label);
  verify(failure, evidence);
  return { message: failure.message, evidence };
}

async function negativeNativeReadiness(runtime, healthyBuild, crashBuild) {
  const crash = await expectNativeFailure(runtime, crashBuild, "real crash fixture", {}, (_error, evidence) => {
    check(evidence.helper_exit?.code === 42 && Number.isFinite(evidence.exit_to_failure_ms) &&
      evidence.exit_to_failure_ms >= 0 && evidence.exit_to_failure_ms <= 2_000,
    "real crash fixture did not expose helper exit 42 within two seconds");
  });
  const wrongHealthBuild = { ...healthyBuild, healthPath: "/m3-declared-missing-health" };
  const unhealthy = await expectNativeFailure(runtime, wrongHealthBuild, "live HTTP 404 fixture", {}, (error, evidence) => {
    check(error.message.includes("did not become healthy") && evidence.last_health === "HTTP 404" && evidence.readiness_elapsed_ms >= 9_500 && evidence.readiness_elapsed_ms <= 10_500 && evidence.node_pid > 0, "live real helper did not reject observed HTTP 404 at the native deadline");
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("m3_declared_native_abort")), 500);
  let aborted;
  try {
    aborted = await expectNativeFailure(runtime, wrongHealthBuild, "declared native abort", { abortSignal: controller.signal }, (error, evidence) => {
      check(error.message.includes("m3_declared_native_abort") && evidence.ready === false && evidence.total_elapsed_ms < 5_000, "abort did not win the actual native readiness wait");
    });
  } finally { clearTimeout(timer); }
  return { crash, unhealthy, aborted };
}

async function stopExact(runtime, entry) {
  const relayMapPath = entry.relay?.mapPath;
  await runtime.stopAndCleanup(entry, { cleanup: true });
  const cleanup = entry.cleanup?.receipt?.cleanup;
  check(entry.stopped && cleanup?.sandbox_absent === true && cleanup.application_namespace_absent === true && cleanup.gateway_namespace_absent === true && cleanup.cgroup_absent === true && cleanup.mounts_absent === true && cleanup.state_retained === false && !existsSync(relayMapPath), "actual gVisor runtime did not clean up its exact owned resources");
  return { allocation_id: entry.allocation.id, generation: entry.allocation.generation, fence: entry.allocation.fence, cleanup_receipt_digest: entry.cleanup.digest, cleanup };
}

async function gvisorBootstrap(context, runtime, build, mask) {
  let entry;
  try {
    entry = await runtime.launchDiagnosticBootstrap({ buildOutput: build, index: 1 });
    const response = await fetch(`http://127.0.0.1:${entry.relay.port}${entry.allocation.health_path}`, {
      signal: AbortSignal.any([context.abortSignal, AbortSignal.timeout(5_000)]), cache: "no-store",
    });
    const body = await response.json();
    check(response.status === 200 && entry.inspected.receipt.health?.passing === true && body.status === "ok" && body.fixture === "node22-api", `actual ${mask} gVisor HTTP health failed`);
    const cleanup = await stopExact(runtime, entry);
    return { status: response.status, body, runsc_sha256: RUNSC_SHA256, ...cleanup };
  } catch (error) {
    if (entry && !entry.stopped) {
      try { await stopExact(runtime, entry); } catch (cleanupError) { throw new AggregateError([error, cleanupError], `${mask} gVisor bootstrap and cleanup failed`); }
    }
    throw error;
  }
}

async function cachedArtifactReplay(context, m3, runtime, build, wrapper, mask, baseRoots) {
  const directory = join(runtime.artifactRoot, build.manifestDigest.slice(7));
  const manifestPath = join(directory, "manifest.json");
  const distPath = join(build.runtimeRootfs, "app", "dist");
  const baseRootfs = baseRoots[build.nodeMajor];
  const args = [
    "--archive-file", join(m3.policyClock.stateDir, "private-cas", "sha256", build.archiveDigest.slice(7)),
    "--archive-digest", build.archiveDigest,
    "--build-manifest", join(m3.policyClock.stateDir, "private-cas", "sha256", build.manifestDigest.slice(7)),
    "--build-manifest-digest", build.manifestDigest,
    "--build-profile-digest", build.buildProfileDigest,
    "--base-rootfs", baseRootfs,
    "--base-rootfs-digest", build.runtimeManifest.base_rootfs_digest,
    "--base-manifest", join(baseRootfs, "..", "base.json"),
    "--base-manifest-digest", build.runtimeManifest.base_manifest_digest,
    "--artifact-root", runtime.artifactRoot,
  ];
  const replay = async (label) => context.runCommand(label, wrapper.path, args, {
    env: m3.componentEnvironment("runtime"), timeoutMs: 180_000,
    logName: `m3-native-${mask}-cached-artifact-${label === "valid cached replay" ? "valid" : "invalid"}.log`,
  });
  const manifestBefore = readFileSync(manifestPath);
  const valid = await replay("valid cached replay");
  check(valid.code === 0 && JSON.parse(valid.stdout).rootfs_tree_digest === build.runtimeTreeDigest && readFileSync(manifestPath).equals(manifestBefore), `${mask} valid immutable replay changed or rejected the real artifact`);
  check(mode(distPath).mode === 0o755, `${mask} real cached app directory lacks canonical mode before corruption`);
  chmodSync(distPath, 0o700);
  const corrupted = statSync(distPath);
  const tree = await context.runCommand(`Measure ${mask} deliberately corrupted cached tree`, wrapper.path,
    ["--tree-digest", build.runtimeRootfs], { env: m3.componentEnvironment("runtime"), timeoutMs: 120_000,
      logName: `m3-native-${mask}-corrupted-tree-digest.log` });
  const corruptedDigest = tree.stdout.trim();
  check(tree.code === 0 && /^sha256:[0-9a-f]{64}$/.test(corruptedDigest) && corruptedDigest !== build.runtimeTreeDigest,
    `${mask} real cached artifact corruption did not change its measured tree digest`);
  const corruptedManifest = { ...JSON.parse(manifestBefore), rootfs_tree_digest: corruptedDigest };
  chmodSync(manifestPath, 0o600);
  writeFileSync(manifestPath, `${JSON.stringify(corruptedManifest)}\n`);
  chmodSync(manifestPath, 0o444);
  const corruptedManifestBytes = readFileSync(manifestPath);
  const corruptedManifestInode = statSync(manifestPath).ino;
  const invalid = await replay("invalid cached replay");
  const after = statSync(distPath);
  check(invalid.code !== 0 && invalid.stderr.includes("runtime_artifact_collision") &&
    after.ino === corrupted.ino && (after.mode & 0o777) === 0o700 &&
    statSync(manifestPath).ino === corruptedManifestInode && mode(manifestPath).mode === 0o444 &&
    readFileSync(manifestPath).equals(corruptedManifestBytes), `${mask} invalid immutable cached artifact was accepted or rewritten`);
  return { valid_tree_digest: build.runtimeTreeDigest, corrupted_tree_digest: corruptedDigest,
    invalid_exit_code: invalid.code,
    invalid_reason: "runtime_artifact_collision", corrupted_mode: after.mode & 0o777,
    directory_inode_unchanged: after.ino === corrupted.ino, manifest_unchanged: true };
}

async function runNativeBaselineDevelopment(context) {
  const selected = process.env.HOSTLET_M3_NATIVE_BASELINE_MODE ?? DIAGNOSIS;
  check(selected === DIAGNOSIS || selected === REGRESSION, "HOSTLET_M3_NATIVE_BASELINE_MODE must be diagnosis or regression");
  context.registerFixture("M3 native baseline diagnostic", "e2e/scenarios/m3-runtime-native-baseline-development.mjs");
  context.registerFixture("M3 runtime support", "e2e/support/m3-runtime.mjs");
  for (const path of ["scripts/runtime/prepare-artifact.py", "scripts/runtime/hostlet-runtime-native-baseline", "scripts/runtime/hostlet-runtime-launcher", "scripts/runtime/hostlet-runtime-cleanup", "scripts/runtime/hostlet-runtime-relay.py"]) context.registerFixture(`M3 native baseline boundary: ${path}`, path);
  registerM3BuildFixtures(context);
  const runnerUmask = process.umask().toString(8).padStart(4, "0");
  const rerun = `umask ${runnerUmask} && HOSTLET_M3_NATIVE_BASELINE_MODE=${selected} ${context.state.command.effective}`;
  context.state.command.rerun = rerun;
  context.state.configuration.m3NativeBaselineDevelopment = { mode: selected, runner_umask: runnerUmask, assembly_umasks: ["0022", "0077"], native_measurement: false, diagnosis_is_gate: false, rerun_command: rerun };

  await runM3Context(context, async (m3) => {
    await runM3BuildScenarios(m3, { developmentBuildsOnly: true });
    const output = application((await m3.state.m3Build.buildFixture("node22_api")).outputs);
    const crashOutput = selected === REGRESSION ? application((await m3.state.m3Build.buildFixture("crash_runtime")).outputs) : null;
    const baseRoots = {
      22: join(context.repo, ".local/m3-assets/node22/runtime-base/rootfs"),
      24: join(context.repo, ".local/m3-assets/node24/runtime-base/rootfs"),
    };
    const observations = { schema: "hostlet.m3-native-baseline-development/v1", mode: selected, runner_umask: context.state.configuration.m3NativeBaselineDevelopment.runner_umask, rerun_command: rerun, masks: [] };
    let passed = false;
    try {
      for (const mask of ["0022", "0077"]) {
        const wrapper = preparerWrapper(context, mask);
        const runtimeContext = scopedRuntimeContext(context, mask);
        const runtime = createM3RuntimeHarness(runtimeContext, m3, {
          artifactPreparer: wrapper.path,
          artifactRoot: join(context.tempDir, `m3-native-artifacts-${mask}`),
          stateRoot: join(context.tempDir, `m3-native-state-${mask}`),
        });
        await runtime.initialize();
        const build = (await runtime.assembleArtifacts(new Map([["node22_api", output]]), baseRoots)).get("node22_api");
        const observation = snapshot(context, runtime, build, mask, wrapper);
        observations.masks.push(observation);
        observation.uid_access = await accessAsGuestUid(context, build.runtimeRootfs, mask);
        const accessible = observation.uid_access.checks.every(({ readable }) => readable === true);
        let nativeError = null;
        try {
          observation.native = await runtime.runNativeBaseline(build, { measure: false });
        } catch (error) {
          nativeError = error;
          observation.native_failure = { message: error.message, evidence: error.nativeBaselineEvidence ?? null };
        }
        if (selected === DIAGNOSIS && mask === "0077") {
          check(!accessible && observation.paths.guest_app.mode === 0o700 && observation.paths.guest_dist.mode === 0o700, "0077 did not reproduce the declared guest app directory permission defect");
          const exit = observation.native_failure?.evidence?.helper_exit;
          const helperLog = readFileSync(join(context.artifactDir, observation.native_failure?.evidence?.helper_log), "utf8");
          observation.native_failure.module_not_found = helperLog.includes("MODULE_NOT_FOUND");
          check(nativeError && Number.isInteger(exit?.code) && exit.code > 0 && observation.native_failure.module_not_found, "0077 did not reproduce an exact nonzero native helper exit with MODULE_NOT_FOUND");
        } else {
          let healthBody = null;
          try { healthBody = JSON.parse(observation.native?.health_body ?? "null"); } catch { /* assertion below records the real response */ }
          check(accessible && !nativeError && observation.native?.health_status === 200 && healthBody?.status === "ok" && healthBody?.fixture === "node22-api", `${mask} actual native HTTP startup failed`);
          assertNativeCleanup(observation.native, runtime, `${mask} healthy Node 22`);
        }
        if (selected === REGRESSION) observation.gvisor = await gvisorBootstrap(context, runtime, build, mask);
        if (selected === REGRESSION && mask === "0022") {
          const crashBuild = (await runtime.assembleArtifacts(new Map([["crash_runtime", crashOutput]]), baseRoots)).get("crash_runtime");
          observation.negative_readiness = await negativeNativeReadiness(runtime, build, crashBuild);
        }
        if (selected === REGRESSION) observation.cached_replay = await cachedArtifactReplay(context, m3, runtime, build, wrapper, mask, baseRoots);
      }
      if (selected === REGRESSION) check(observations.masks[0].runtime_tree_digest === observations.masks[1].runtime_tree_digest, "canonical assembled tree digest differs between umasks");
      passed = true;
    } finally {
      privateJson(join(context.artifactDir, `m3-runtime-native-baseline-${selected}.json`), observations);
      context.assertion(ASSERTION, "M3 native baseline focused development", selected === DIAGNOSIS ? "real 0022 native HTTP health and observed 0077 guest permission/startup defect under fresh roots" : "real native and gVisor Node 22 HTTP health under both masks, identical canonical tree identity, private host roots and exact cleanup", { mode: selected, masks: observations.masks.map(({ mask, runtime_tree_digest, uid_access, native, native_failure, gvisor }) => ({ mask, runtime_tree_digest, uid_access, native, native_failure, gvisor })) }, passed);
    }
  });
}

export const scenario = Object.freeze({
  id: "m3-runtime-native-baseline-development",
  description: "Focused real Node 22 disposable VM, HCA, native helper and gVisor baseline under controlled assembly umasks",
  requiredAssertions: Object.freeze([...M3_UPGRADE_REQUIRED_ASSERTIONS, "M3-BUILD-01", "M3-BUILD-02", ASSERTION]),
  run: runNativeBaselineDevelopment,
});
