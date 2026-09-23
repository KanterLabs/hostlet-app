import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";

import { expectScenario } from "../support/http-client.mjs";
import { registerM3BuildFixtures } from "../support/m3-build.mjs";
import { runM3Context } from "../support/m3-context.mjs";
import { runM3BuildScenarios } from "./m3-build.mjs";
import { M3_UPGRADE_REQUIRED_ASSERTIONS } from "./m3-upgrade.mjs";

export const M3_RELEASE_STATIC_REQUIRED_ASSERTIONS = Object.freeze([
  ...M3_UPGRADE_REQUIRED_ASSERTIONS,
  "M3-BUILD-01",
  "M3-BUILD-02",
  "M3-RELEASE-STATIC-DEVELOPMENT",
]);

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_COMPARE_BYTES = 250 * 1024 * 1024;

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function casPath(casRoot, digest) {
  if (!DIGEST.test(digest)) throw new Error("static release diagnostic received an invalid CAS digest");
  return join(casRoot, "sha256", digest.slice("sha256:".length));
}

function ensureOwnedRoot(root, markerName, markerValue) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const info = lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700) {
    throw new Error(`static release diagnostic root is not a private directory: ${markerName}`);
  }
  const marker = join(root, markerName);
  try {
    writeFileSync(marker, `${markerValue}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST" || readFileSync(marker, "utf8") !== `${markerValue}\n`) throw error;
  }
  chmodSync(marker, 0o600);
}

function collectTree(root, { skipRootMarker = false } = {}) {
  const entries = new Map();
  let totalBytes = 0;
  const visit = (directory, prefix = "") => {
    const children = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    for (const entry of children) {
      if (skipRootMarker && prefix === "" && entry.name === ".hostlet-release-static-owned") continue;
      const absolute = join(directory, entry.name);
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`static release tree contains a symlink: ${path}`);
      if (entry.isDirectory()) {
        visit(absolute, path);
        continue;
      }
      if (!entry.isFile()) throw new Error(`static release tree contains a special file: ${path}`);
      const info = lstatSync(absolute);
      const bytes = readFileSync(absolute);
      totalBytes += bytes.length;
      if (totalBytes > MAX_COMPARE_BYTES) throw new Error("static release tree exceeds diagnostic comparison bound");
      entries.set(path, { mode: info.mode & 0o7777, bytes });
    }
  };
  visit(root);
  return Object.freeze({ entries, totalBytes });
}

function treeDigest(tree) {
  const lines = [...tree.entries].sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
    .map(([path, value]) => `${path}\0${value.mode.toString(8).padStart(4, "0")}\0${value.bytes.length}\0${createHash("sha256").update(value.bytes).digest("hex")}\n`);
  return sha256(Buffer.from(lines.join("")));
}

function compareTrees(source, extracted) {
  if (source.entries.size !== extracted.entries.size) return { bytesMatch: false, entriesMatch: false };
  let bytesMatch = true;
  for (const [path, expected] of source.entries) {
    const actual = extracted.entries.get(path);
    if (!actual || actual.mode !== expected.mode || !actual.bytes.equals(expected.bytes)) {
      bytesMatch = false;
      break;
    }
  }
  return { bytesMatch, entriesMatch: source.entries.size === extracted.entries.size && [...source.entries.keys()].every((path) => extracted.entries.has(path)) };
}

function boundedText(value, repo) {
  return String(value ?? "").replaceAll(repo, "$REPO").slice(0, 4096);
}

function commandEvidence(result, context) {
  return {
    exit_code: result.code,
    signal: result.signal,
    log: relative(context.artifactDir, result.logPath),
    stdout: boundedText(result.stdout, context.repo),
    stderr: boundedText(result.stderr, context.repo),
  };
}

function parseReceipt(result) {
  if (result.code !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function stableReceipt(value) {
  return value && {
    schema: value.schema,
    result: value.result,
    release_id: value.release_id,
    project_id: value.project_id,
    frontend: value.frontend && {
      archive_digest: value.frontend.archive_digest,
      tree_digest: value.frontend.tree_digest,
      relative_root: value.frontend.relative_root,
    },
    migration_materialized_ref: value.migration_materialized_ref ?? null,
  };
}

async function runStaticReleaseDiagnostic(context, m3) {
  const evidence = {
    schema: "hostlet.e2e-m3-static-release-stage/v1",
    build_prerequisite_assertions: ["M3-BUILD-01", "M3-BUILD-02"],
    assertion_id: "M3-RELEASE-STATIC-DEVELOPMENT",
    coordinator: "scripts/release/hostlet-release-coordinator.py",
    commands: [],
  };
  const evidencePath = join(context.artifactDir, "m3-release-static-stage-receipt.json");
  let passed = false;
  try {
    const buildStage = await runM3BuildScenarios(m3, { developmentBuildsOnly: true });
    const v1 = buildStage?.jobs?.get("fullstack_v1") ?? m3.state.m3Build?.jobs?.get("fullstack_v1");
    const outputs = Array.isArray(v1?.outputs) ? v1.outputs : [v1?.outputs];
    const frontend = outputs.find((output) => output?.kind === "static");
    expectScenario(
      v1?.detail?.build?.state === "succeeded" && frontend?.outputRoot && DIGEST.test(frontend.archiveDigest) && DIGEST.test(frontend.manifestDigest),
      "real full-stack build provides a static archive and manifest for coordinator staging",
      {
        build_state: v1?.detail?.build?.state ?? null,
        static_output_present: Boolean(frontend),
        archive_digest: frontend?.archiveDigest ?? null,
        manifest_digest: frontend?.manifestDigest ?? null,
      },
    );

    const stateRoot = m3.policyClock.stateDir;
    const artifactRoot = join(stateRoot, "private-cas");
    ensureOwnedRoot(stateRoot, ".hostlet-release-owned", "hostlet-release-state-v1");
    ensureOwnedRoot(artifactRoot, ".hostlet-cas-owned", "hostlet-private-cas-v1");
    const archivePath = casPath(artifactRoot, frontend.archiveDigest);
    const manifestPath = casPath(artifactRoot, frontend.manifestDigest);
    expectScenario(
      lstatSync(archivePath).isFile() && !lstatSync(archivePath).isSymbolicLink() &&
        lstatSync(manifestPath).isFile() && !lstatSync(manifestPath).isSymbolicLink(),
      "real build archive and manifest are present in the owned CAS",
      { archive_present: existsSync(archivePath), manifest_present: existsSync(manifestPath) },
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expectScenario(
      manifest.schema === "hostlet.build-artifact/v1" && manifest.kind === "static" && manifest.archive_digest === frontend.archiveDigest,
      "real static artifact manifest binds its archive digest",
      { schema: manifest.schema ?? null, kind: manifest.kind ?? null, archive_digest: manifest.archive_digest ?? null },
    );

    const candidate = {
      release_id: randomUUID(),
      project_id: v1.detail.build.project_id,
      frontend: { archive_digest: frontend.archiveDigest, manifest_digest: frontend.manifestDigest },
    };
    expectScenario(UUID.test(candidate.release_id) && UUID.test(candidate.project_id), "static stage candidate carries exact release and project identities", {
      release_id: candidate.release_id,
      project_id: candidate.project_id,
    });
    const inputPath = join(context.tempDir, "m3-release-static-stage-input.json");
    writeFileSync(inputPath, `${JSON.stringify({ candidate })}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const coordinator = join(context.repo, "scripts", "release", "hostlet-release-coordinator.py");
    const environment = m3.componentEnvironment("runtime", {
      LANG: "C",
      LC_ALL: "C",
      TZ: "UTC",
      PYTHONHASHSEED: "0",
    });
    const commandArgs = ["stage", "--input-file", inputPath, "--state-root", stateRoot, "--artifact-root", artifactRoot];
    const first = await context.runCommand(
      "M3 static release coordinator stage",
      coordinator,
      commandArgs,
      { cwd: context.repo, env: environment, timeoutMs: 30_000, logName: "m3-release-static-coordinator-01.log" },
    );
    evidence.commands.push(commandEvidence(first, context));
    const firstReceipt = parseReceipt(first);
    evidence.first_receipt = firstReceipt;
    expectScenario(
      first.code === 0 && firstReceipt?.schema === "hostlet.release-stage-receipt/v1" && firstReceipt.result === "staged",
      "actual release coordinator stages the real static artifact",
      { exit_code: first.code, receipt_schema: firstReceipt?.schema ?? null, result: firstReceipt?.result ?? null },
    );

    const second = await context.runCommand(
      "M3 static release coordinator repeated stage",
      coordinator,
      commandArgs,
      { cwd: context.repo, env: environment, timeoutMs: 30_000, logName: "m3-release-static-coordinator-02.log" },
    );
    evidence.commands.push(commandEvidence(second, context));
    const secondReceipt = parseReceipt(second);
    evidence.second_receipt = secondReceipt;
    expectScenario(
      second.code === 0 && secondReceipt?.schema === "hostlet.release-stage-receipt/v1" && secondReceipt.result === "staged" &&
        JSON.stringify(stableReceipt(firstReceipt)) === JSON.stringify(stableReceipt(secondReceipt)),
      "repeating actual coordinator stage is idempotent for the same immutable artifact",
      { exit_code: second.code, stable_receipt_match: JSON.stringify(stableReceipt(firstReceipt)) === JSON.stringify(stableReceipt(secondReceipt)) },
    );

    const destination = join(stateRoot, "release-static", frontend.archiveDigest.slice("sha256:".length));
    const sourceTree = collectTree(frontend.outputRoot);
    const extractedTree = collectTree(destination, { skipRootMarker: true });
    const comparison = compareTrees(sourceTree, extractedTree);
    const sourceDigest = treeDigest(sourceTree);
    const extractedDigest = treeDigest(extractedTree);
    const marker = readFileSync(join(destination, ".hostlet-release-static-owned"), "utf8").trim();
    const temporaryStages = existsSync(join(stateRoot, "release-static"))
      ? readdirSync(join(stateRoot, "release-static")).filter((name) => name.startsWith(".stage-"))
      : [];
    evidence.source_tree_digest = sourceDigest;
    evidence.extracted_tree_digest = extractedDigest;
    evidence.source_bytes = sourceTree.totalBytes;
    evidence.extracted_bytes = extractedTree.totalBytes;
    evidence.tree_comparison = comparison;
    evidence.destination = relative(stateRoot, destination);
    evidence.temporary_stage_entries = temporaryStages;
    expectScenario(
      comparison.bytesMatch && comparison.entriesMatch && sourceDigest === extractedDigest &&
        firstReceipt.frontend?.archive_digest === frontend.archiveDigest && firstReceipt.frontend?.tree_digest === extractedDigest &&
        secondReceipt.frontend?.tree_digest === extractedDigest && marker === frontend.archiveDigest && temporaryStages.length === 0,
      "coordinator extraction preserves real static bytes, modes, tree digest, and clean idempotent state",
      {
        bytes_match: comparison.bytesMatch,
        entries_match: comparison.entriesMatch,
        source_tree_digest: sourceDigest,
        extracted_tree_digest: extractedDigest,
        coordinator_tree_digest: firstReceipt.frontend?.tree_digest ?? null,
        ownership_marker_match: marker === frontend.archiveDigest,
        temporary_stage_count: temporaryStages.length,
      },
    );
    evidence.passed = true;
    passed = true;
  } catch (error) {
    evidence.failure = {
      message: boundedText(error?.message ?? error, context.repo),
      name: error?.name ?? "Error",
    };
  } finally {
    evidence.passed = passed;
    context.assertion(
      "M3-RELEASE-STATIC-DEVELOPMENT",
      "M3 static release coordinator diagnostic",
      "real build CAS static archive stages through the actual coordinator, preserves bytes/tree identity, and repeats idempotently",
      evidence,
      passed,
      passed ? null : "static release coordinator integration diagnostic failed; inspect retained coordinator logs and receipt",
    );
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  }
}

export const scenario = Object.freeze({
  id: "m3-release-static-development",
  description: "Non-gating real build to release-coordinator static artifact integration diagnostic",
  requiredAssertions: M3_RELEASE_STATIC_REQUIRED_ASSERTIONS,
  async run(context) {
    registerM3BuildFixtures(context);
    context.registerFixture("M3 static release coordinator", "scripts/release/hostlet-release-coordinator.py");
    context.registerFixture("M3 static release contract", "docs/M3-RELEASE-CONTRACT.md");
    await runM3Context(context, async (m3) => runStaticReleaseDiagnostic(context, m3));
  },
});
