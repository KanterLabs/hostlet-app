import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function buildEnvironment(targetDir) {
  const environment = {};
  for (const name of [
    "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TZ",
    "RUSTUP_HOME", "CARGO_HOME", "RUSTC_WRAPPER",
  ]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  environment.CARGO_TARGET_DIR = targetDir;
  return environment;
}

export function registerRetainedM2Fixtures(context) {
  context.registerFixture("M3 retained M2 schema-v5 binary identity", "e2e/retained-m2.json");
  context.registerFixture("M3 retained M2 source/build resolver", "e2e/support/retained-m2.mjs");
  const manifest = JSON.parse(readFileSync(join(context.repo, "e2e", "retained-m2.json"), "utf8"));
  if (
    manifest.manifest_schema_version !== 1 ||
    manifest.role !== "schema-v5-retained-m2-control" ||
    manifest.database_schema_version !== 5 ||
    manifest.minimum_reader_version !== 4 ||
    !/^[0-9a-f]{40}$/.test(manifest.source_commit) ||
    !/^[0-9a-f]{64}$/.test(manifest.binary_sha256) ||
    typeof manifest.provenance !== "string" || manifest.provenance.length < 20
  ) {
    throw new Error("invalid retained M2 binary manifest");
  }
  const expectedCachePath = `.local/retained/${manifest.source_commit}/hostlet-control`;
  if (
    manifest.cache_path !== expectedCachePath ||
    manifest.cargo_package !== "hostlet-control" ||
    manifest.cargo_binary !== "hostlet-control"
  ) {
    throw new Error("retained M2 manifest contains an unexpected cache or build path");
  }
  return Object.freeze(manifest);
}

export async function resolveRetainedM2Binary(context, manifest) {
  const source = await context.runCommand(
    "Verify retained M2 source commit", "git", ["cat-file", "-e", `${manifest.source_commit}^{commit}`],
    { timeoutMs: 10_000, logName: "retained-m2-source-commit.log" },
  );
  if (source.code !== 0) throw new Error("retained M2 source commit is unavailable; full Git history is required");

  const identity = await context.runCommand(
    "Record retained M2 source identity", "git",
    ["show", "--no-patch", "--format=%H|%T|%ct", manifest.source_commit],
    { timeoutMs: 10_000, logName: "retained-m2-source-identity.log" },
  );
  if (identity.code !== 0 || !identity.stdout.startsWith(`${manifest.source_commit}|`)) {
    throw new Error("retained M2 source identity could not be verified");
  }

  const cached = join(context.repo, manifest.cache_path);
  if (
    !context.state.configuration.rebuildRetained &&
    existsSync(cached) && context.fileSha256(cached) === manifest.binary_sha256
  ) {
    context.state.toolchains.retainedM2 = {
      sourceCommit: manifest.source_commit,
      sourceIdentity: identity.stdout.trim(),
      binarySha256: manifest.binary_sha256,
      acquisition: "verified private cache",
      databaseSchemaVersion: manifest.database_schema_version,
      provenance: manifest.provenance,
    };
    return cached;
  }

  const worktree = join(context.tempDir, "retained-m2-source");
  const target = join(context.tempDir, "retained-m2-target");
  let worktreeCreated = false;
  context.registerCleanup("retained M2 detached source worktree", async () => {
    if (!worktreeCreated) return;
    const removed = await context.runCommand(
      "Remove retained M2 detached worktree", "git", ["worktree", "remove", "--force", worktree],
      { cleanup: true, timeoutMs: 30_000, logName: "retained-m2-worktree-remove.log" },
    );
    if (removed.code !== 0) throw new Error("retained M2 worktree cleanup failed");
    worktreeCreated = false;
    context.state.cleanup.push({
      resource: worktree,
      action: "remove exact run-owned retained-M2 source worktree",
      result: "removed",
    });
  });
  const added = await context.runCommand(
    "Create retained M2 detached worktree", "git", ["worktree", "add", "--detach", worktree, manifest.source_commit],
    { timeoutMs: 30_000, logName: "retained-m2-worktree-add.log" },
  );
  if (added.code !== 0) throw new Error("retained M2 detached worktree creation failed");
  worktreeCreated = true;
  const clean = await context.runCommand(
    "Verify retained M2 detached source", "git", ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: worktree, timeoutMs: 10_000, logName: "retained-m2-worktree-status.log" },
  );
  if (clean.code !== 0 || clean.stdout.trim() !== "") throw new Error("retained M2 detached source is not clean");
  const built = await context.runCommand(
    "Build retained M2 binary", "cargo",
    ["build", "--locked", "--package", manifest.cargo_package, "--bin", manifest.cargo_binary],
    { cwd: worktree, env: buildEnvironment(target), timeoutMs: 300_000, logName: "retained-m2-build.log" },
  );
  if (built.code !== 0) throw new Error("retained M2 reproducible build failed");
  const binary = join(target, "debug", manifest.cargo_binary);
  if (!existsSync(binary)) throw new Error("retained M2 rebuild produced no binary");
  const digest = context.fileSha256(binary);
  context.state.toolchains.retainedM2 = {
    sourceCommit: manifest.source_commit,
    sourceIdentity: identity.stdout.trim(),
    binarySha256: digest,
    expectedCachedBinarySha256: manifest.binary_sha256,
    acquisition: "verified detached clean source and locked-dependency rebuild",
    databaseSchemaVersion: manifest.database_schema_version,
    provenance: manifest.provenance,
  };
  return binary;
}
