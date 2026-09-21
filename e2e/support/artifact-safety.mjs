import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function filesUnder(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

export function scanArtifactForCredentials(artifactDir, credentialValues) {
  const credentials = credentialValues
    .filter((value) => typeof value === "string" && value.length > 0)
    .map((value) => Buffer.from(value));
  let matches = 0;
  let filesScanned = 0;

  for (const path of filesUnder(artifactDir)) {
    const content = readFileSync(path);
    filesScanned += 1;
    for (const credential of credentials) {
      if (content.includes(credential)) matches += 1;
    }
  }

  return { filesScanned, credentialMatches: matches };
}

export function scrubArtifactCredentials(artifactDir, credentialValues) {
  const credentials = credentialValues.filter(
    (value) => typeof value === "string" && value.length > 0,
  );
  let credentialMatches = 0;
  let filesRewritten = 0;

  for (const path of filesUnder(artifactDir)) {
    const original = readFileSync(path);
    let text = original.toString("utf8");
    let matchesInFile = 0;
    for (const credential of credentials) {
      const pieces = text.split(credential);
      if (pieces.length > 1) {
        matchesInFile += pieces.length - 1;
        text = pieces.join("[REDACTED]");
      }
    }
    if (matchesInFile > 0) {
      credentialMatches += matchesInFile;
      filesRewritten += 1;
      writeFileSync(path, text, { mode: 0o600 });
    }
  }

  return { credentialMatches, filesRewritten };
}
