// Trusted toolchain preparation only: download locked public package tarballs.
// Repository lifecycle/build scripts are never executed by this program.
import { mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const repo = resolve(import.meta.dirname, "../..");
const major = process.argv[2];
if (!new Set(["22", "24", "24-cache-miss"]).has(major)) {
  throw new Error("usage: node scripts/m3/prepare-npm-cache.mjs 22|24|24-cache-miss");
}
const image = major === "22"
  ? "node:22-bookworm-slim@sha256:43aeff40f4afc22e83f7589a2f37e111cff5ca84529571f1c8415bcc5fcc21b2"
  : "node:24-bookworm-slim@sha256:5cbc7caba8c2c0f0bca675d1b61b9f2857e1cf1853c6164ee9dd409501a936e7";
const packages = new Map();
const locks = [];
function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("fixture lock source contains a symlink");
    if (entry.isDirectory()) visit(path);
    else if (entry.name === "package-lock.json") {
      const bytes = readFileSync(path);
      const lock = JSON.parse(bytes);
      locks.push({ path: path.slice(repo.length + 1), sha256: createHash("sha256").update(bytes).digest("hex") });
      for (const value of Object.values(lock.packages ?? {})) {
        if (!value.resolved) continue;
        const allowed = (values, wanted) => !values || (!values.includes(`!${wanted}`) && (values.every(v => v.startsWith("!")) || values.includes(wanted)));
        if (!allowed(value.os, "linux") || !allowed(value.cpu, "x64") || !allowed(value.libc, "glibc")) continue;
        const url = new URL(value.resolved);
        if (url.protocol !== "https:" || url.hostname !== "registry.npmjs.org" || url.username || url.password || url.search || url.hash || !url.pathname.endsWith(".tgz")) {
          throw new Error("fixture dependency is outside the pinned public npm tarball boundary");
        }
        if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value.integrity ?? "")) throw new Error("fixture tarball lacks SHA-512 integrity");
        if (packages.has(value.resolved) && packages.get(value.resolved).integrity !== value.integrity) throw new Error("conflicting fixture dependency integrity");
        packages.set(value.resolved, { resolved: value.resolved, integrity: value.integrity });
      }
    }
  }
}
const fixtures = join(repo, "e2e/fixtures/m3");
if (major === "22") visit(join(fixtures, "node22-api"));
else if (major === "24") {
  for (const name of ["fullstack-v1", "fullstack-v2", "next16"]) visit(join(fixtures, name));
}
// The cache-miss profile intentionally has no packages, including is-number.
const assetRoot = join(repo, ".local/m3-assets", `node${major}`);
const cache = join(assetRoot, "npm");
mkdirSync(cache, { recursive: true, mode: 0o700 });
if (!statSync(cache).isDirectory()) throw new Error("cache root is not a directory");
const input = join(assetRoot, "cache-input.json");
writeFileSync(input, JSON.stringify({ image, locks: locks.sort((a,b) => a.path.localeCompare(b.path)), packages: [...packages.values()].sort((a,b) => a.resolved.localeCompare(b.resolved)) }, null, 2) + "\n", { mode: 0o600 });
const script = `
const fs=require('node:fs'); const crypto=require('node:crypto'); const cp=require('node:child_process');
const cacache=require('/usr/local/lib/node_modules/npm/node_modules/cacache');
const input=JSON.parse(fs.readFileSync('/input.json','utf8'));
(async()=>{for(const item of input.packages){
 cp.execFileSync('npm',['cache','add',item.resolved,'--ignore-scripts','--cache=/cache','--no-audit','--no-fund'],{stdio:['ignore','ignore','pipe'],timeout:120000});
 const hash=crypto.createHash('sha512');let size=0;
 for await(const chunk of cacache.get.stream.byDigest('/cache/_cacache',item.integrity)){size+=chunk.length;if(size>268435456)throw Error('package tarball exceeded 256 MiB');hash.update(chunk);}
 if('sha512-'+hash.digest('base64')!==item.integrity)throw Error('locked tarball integrity mismatch');
 item.bytes=size;
}
const result={schema:'hostlet.offline-npm-cache/v1',image:input.image,node:process.version,npm:require('/usr/local/lib/node_modules/npm/package.json').version,locks:input.locks,packages:input.packages};
fs.writeFileSync('/cache/cache-metadata.json',JSON.stringify(result,null,2)+'\\n',{mode:0o600});
process.stdout.write(JSON.stringify({node:result.node,npm:result.npm,verified_packages:result.packages.length})+'\\n');
})().catch(()=>{process.stderr.write('offline cache preparation failed\\n');process.exitCode=1;});
`;
const result = spawnSync("docker", [
  "run", "--rm", "--user", `${process.getuid()}:${process.getgid()}`, "--cap-drop", "ALL",
  "--security-opt", "no-new-privileges", "--pids-limit", "128", "--memory", "768m", "--cpus", "2",
  "--label", "io.hostlet.scope=m3-offline-cache-preparation", "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m",
  "-v", `${input}:/input.json:ro`, "-v", `${cache}:/cache:rw`, "-w", "/tmp",
  "-e", "npm_config_update_notifier=false", image, "node", "-e", script,
], { stdio: "inherit", timeout: 900_000 });
if (result.error || result.status !== 0) throw new Error("offline package cache preparation failed");
