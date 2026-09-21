import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function buildEnvironment(targetDir) {
  const environment = {};
  for (const name of [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "TZ",
    "RUSTUP_HOME",
    "CARGO_HOME",
    "RUSTC_WRAPPER",
  ]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  environment.CARGO_TARGET_DIR = targetDir;
  return environment;
}

export function registerRetainedFoundationFixtures(context) {
  context.registerFixture("M1 retained schema-v3 binary identity", "e2e/retained-foundation.json");
  context.registerFixture(
    "M1 retained schema-v3 source/build resolver",
    "e2e/support/retained-foundation.mjs",
  );
  const manifest = JSON.parse(
    readFileSync(join(context.repo, "e2e", "retained-foundation.json"), "utf8"),
  );
  if (
    manifest.manifest_schema_version !== 1 ||
    manifest.database_schema_version !== 3 ||
    !/^[0-9a-f]{40}$/.test(manifest.source_commit) ||
    !/^[0-9a-f]{64}$/.test(manifest.binary_sha256)
  ) {
    throw new Error("invalid retained foundation binary manifest");
  }
  const expectedCachePath = `.local/retained/${manifest.source_commit}/hostlet-control`;
  if (
    manifest.cache_path !== expectedCachePath ||
    manifest.cargo_package !== "hostlet-control" ||
    manifest.cargo_binary !== "hostlet-control"
  ) {
    throw new Error("retained foundation manifest contains an unexpected cache or build path");
  }
  return Object.freeze(manifest);
}

export async function resolveRetainedFoundationBinary(context, manifest) {
  const source = await context.runCommand(
    "Verify retained foundation source commit",
    "git",
    ["cat-file", "-e", `${manifest.source_commit}^{commit}`],
    { timeoutMs: 10_000, logName: "retained-foundation-source-commit.log" },
  );
  if (source.code !== 0) {
    throw new Error("retained foundation source commit is unavailable; full Git history is required");
  }

  const sourceIdentity = await context.runCommand(
    "Record retained foundation source identity",
    "git",
    ["show", "--no-patch", "--format=%H|%T|%ct", manifest.source_commit],
    { timeoutMs: 10_000, logName: "retained-foundation-source-identity.log" },
  );
  if (sourceIdentity.code !== 0 || !sourceIdentity.stdout.startsWith(`${manifest.source_commit}|`)) {
    throw new Error("retained foundation source identity could not be verified");
  }

  const cached = join(context.repo, manifest.cache_path);
  if (
    !context.state.configuration.rebuildRetained &&
    existsSync(cached) &&
    context.fileSha256(cached) === manifest.binary_sha256
  ) {
    context.state.toolchains.retainedFoundation = {
      sourceCommit: manifest.source_commit,
      sourceIdentity: sourceIdentity.stdout.trim(),
      binarySha256: manifest.binary_sha256,
      acquisition: "verified private cache",
      databaseSchemaVersion: manifest.database_schema_version,
    };
    return cached;
  }

  const worktree = join(context.tempDir, "retained-foundation-source");
  const target = join(context.tempDir, "retained-foundation-target");
  let worktreeCreated = false;
  context.registerCleanup("retained foundation detached source worktree", async () => {
    if (!worktreeCreated) return;
    const removed = await context.runCommand(
      "Remove retained foundation detached worktree",
      "git",
      ["worktree", "remove", "--force", worktree],
      {
        cleanup: true,
        timeoutMs: 30_000,
        logName: "retained-foundation-worktree-remove.log",
      },
    );
    if (removed.code !== 0) throw new Error("retained foundation worktree cleanup failed");
    worktreeCreated = false;
    context.state.cleanup.push({
      resource: worktree,
      action: "remove exact run-owned retained-source worktree",
      result: "removed",
    });
  });

  const added = await context.runCommand(
    "Create retained foundation detached worktree",
    "git",
    ["worktree", "add", "--detach", worktree, manifest.source_commit],
    { timeoutMs: 30_000, logName: "retained-foundation-worktree-add.log" },
  );
  if (added.code !== 0) throw new Error("retained foundation detached worktree creation failed");
  worktreeCreated = true;

  const cleanSource = await context.runCommand(
    "Verify retained foundation detached source",
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: worktree, timeoutMs: 10_000, logName: "retained-foundation-worktree-status.log" },
  );
  if (cleanSource.code !== 0 || cleanSource.stdout.trim() !== "") {
    throw new Error("retained foundation detached source is not clean");
  }

  const built = await context.runCommand(
    "Build retained foundation binary",
    "cargo",
    [
      "build",
      "--locked",
      "--package",
      manifest.cargo_package,
      "--bin",
      manifest.cargo_binary,
    ],
    {
      cwd: worktree,
      env: buildEnvironment(target),
      timeoutMs: 300_000,
      logName: "retained-foundation-build.log",
    },
  );
  if (built.code !== 0) throw new Error("retained foundation reproducible build failed");
  const binary = join(target, "debug", manifest.cargo_binary);
  if (!existsSync(binary)) throw new Error("retained foundation rebuild produced no binary");
  const rebuiltDigest = context.fileSha256(binary);
  context.state.toolchains.retainedFoundation = {
    sourceCommit: manifest.source_commit,
    sourceIdentity: sourceIdentity.stdout.trim(),
    binarySha256: rebuiltDigest,
    expectedCachedBinarySha256: manifest.binary_sha256,
    acquisition: "verified detached clean source and locked-dependency rebuild",
    databaseSchemaVersion: manifest.database_schema_version,
  };
  return binary;
}
