#!/usr/bin/env node
import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const templatePath = join(dirname(fileURLToPath(import.meta.url)), "Caddyfile.template");
const destination = process.argv[2];
if (process.argv.length !== 3 || !destination || !isAbsolute(destination)) {
  throw new Error("usage: node scripts/beta/render-edge.mjs /absolute/private/Caddyfile");
}

function required(name, pattern) {
  const value = process.env[name];
  if (!value || !pattern.test(value)) throw new Error(`${name} is missing or invalid`);
  return value;
}

function port(name) {
  const value = required(name, /^[0-9]{1,5}$/);
  if (Number(value) < 1 || Number(value) > 65535) throw new Error(`${name} is outside the TCP port range`);
  return value;
}

function absolutePath(name) {
  const value = required(name, /^\/[A-Za-z0-9_./-]+$/);
  if (!isAbsolute(value) || value.includes("..")) throw new Error(`${name} must be a simple absolute path`);
  return value;
}

const values = {
  EDGE_PORT: port("HOSTLET_BETA_EDGE_PORT"),
  CONTROL_PORT: port("HOSTLET_BETA_CONTROL_PORT"),
  DEMO_PORT: port("HOSTLET_BETA_DEMO_PORT"),
  DEMO_HOST: required("HOSTLET_BETA_DEMO_HOST", /^[A-Za-z0-9][A-Za-z0-9.-]*\.localowned\.test$/),
  DEMO_CA_FILE: absolutePath("HOSTLET_BETA_DEMO_CA_FILE"),
  STATIC_PORT: port("HOSTLET_BETA_STATIC_PORT"),
  STATIC_EXPECTED_HOST: required("HOSTLET_BETA_STATIC_EXPECTED_HOST", /^(?:[A-Za-z0-9][A-Za-z0-9.-]*|127\.0\.0\.1)(?::[0-9]{1,5})?$/),
  WEB_PORT: port("HOSTLET_BETA_WEB_PORT"),
  AUTH_INCLUDE: absolutePath("HOSTLET_BETA_AUTH_INCLUDE"),
};

// Fail before writing if the private gate snippet is absent or is not the
// intended single Basic Authentication directive. Never print its contents.
const auth = readFileSync(values.AUTH_INCLUDE, "utf8").trim();
if (!/^basic_auth\s*\{\s*[A-Za-z][A-Za-z0-9_-]*\s+\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}\s*\}$/s.test(auth)) {
  throw new Error("HOSTLET_BETA_AUTH_INCLUDE must contain one basic_auth user with a bcrypt hash");
}

let config = readFileSync(templatePath, "utf8");
for (const [name, value] of Object.entries(values)) {
  config = config.replaceAll(`@@${name}@@`, value);
}
if (/@@[A-Z_]+@@/.test(config)) throw new Error("unrendered Caddyfile placeholder");

const temporary = `${destination}.tmp-${process.pid}`;
try {
  writeFileSync(temporary, config, { mode: 0o600, flag: "wx" });
  renameSync(temporary, destination);
} catch (error) {
  try { unlinkSync(temporary); } catch { /* no temporary file to remove */ }
  throw error;
}
