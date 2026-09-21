"use strict";

// Intentional runner-integrity fault. Preload this module to prove recovery of
// the real crash window after terminal artifacts exist but before SHA256SUMS
// commits. It must never be used by an acceptance run.
const fs = require("node:fs");
const path = require("node:path");
const { syncBuiltinESMExports } = require("node:module");

const originalWriteFileSync = fs.writeFileSync;
const terminalStatuses = new Set(["passed", "failed", "interrupted"]);
let armed = true;

fs.writeFileSync = function crashBeforeReceipt(target, ...rest) {
  if (armed && typeof target === "string" && path.basename(target) === "SHA256SUMS") {
    const artifactDirectory = path.dirname(path.resolve(target));
    const manifestPath = path.join(artifactDirectory, "manifest.json");
    let manifest = null;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch {
      // A missing or malformed neighboring manifest is outside this fault's
      // exact trigger. Preserve normal filesystem behavior in that case.
    }
    if (
      manifest?.runner?.pid === process.pid
      && manifest.runId === path.basename(artifactDirectory)
      && terminalStatuses.has(manifest.status)
    ) {
      armed = false;
      process.kill(process.pid, "SIGKILL");
      throw new Error("crash-before-receipt fault did not terminate the runner");
    }
  }
  return originalWriteFileSync.call(fs, target, ...rest);
};

syncBuiltinESMExports();
