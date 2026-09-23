import { createHash } from "node:crypto";
import { accessSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const M3_BUILD_PROFILE_ID = "m3-owned-node24-v1";
export const M3_BUILD_PROFILE_IDS = Object.freeze([
  "m3-owned-node24-v1", "m3-owned-node22-v1", "m3-owned-node24-cache-miss-v1",
]);

export class M3BuildSetupError extends Error {
  constructor(code, message, observed = {}) {
    super(message);
    this.name = "M3BuildSetupError";
    this.code = code;
    this.observed = Object.freeze({ ...observed });
  }
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function regularReadable(path, label) {
  try {
    const canonical = realpathSync(path);
    const stat = statSync(canonical);
    accessSync(canonical, constants.R_OK);
    if (!stat.isFile()) throw new Error("not a regular file");
    return canonical;
  } catch (error) {
    throw new M3BuildSetupError("m3_build_asset_unavailable", `${label} is unavailable`, {
      asset: label,
      reason: error.message,
    });
  }
}

function profileCandidate(assetRoot, id, explicit) {
  if (explicit) return resolve(explicit);
  const candidates = [
    join(assetRoot, "profiles", `${id}.json`),
    join(assetRoot, `${id}.json`),
  ];
  return candidates.find(existsSync) ?? candidates[0];
}

export function resolveM3BuildSetup(m3, options = {}) {
  const assetRoot = resolve(options.assetRoot ?? join(m3.context.repo, ".local", "m3-assets"));
  if (!existsSync(assetRoot) || !statSync(assetRoot).isDirectory()) {
    throw new M3BuildSetupError(
      "m3_build_assets_unavailable",
      "trusted M3 build assets have not been prepared",
      { asset_root: assetRoot },
    );
  }
  const builderBinary = regularReadable(
    resolve(options.builderBinary ?? join(m3.context.repo, "target", "debug", "hostlet-builder")),
    "hostlet-builder",
  );
  try {
    accessSync(builderBinary, constants.X_OK);
  } catch {
    throw new M3BuildSetupError("m3_build_builder_unavailable", "hostlet-builder is not executable");
  }
  const profiles = {};
  for (const id of M3_BUILD_PROFILE_IDS) {
    const profilePath = regularReadable(profileCandidate(assetRoot, id, options.profilePaths?.[id]), `M3 build profile ${id}`);
    let profile;
    let profileBytes;
    try {
      profileBytes = readFileSync(profilePath);
      profile = JSON.parse(profileBytes.toString("utf8"));
    } catch (error) {
      throw new M3BuildSetupError("m3_build_profile_invalid", `M3 build profile ${id} is malformed`, { reason: error.message });
    }
    if (profile?.schema !== "hostlet.build-profile/v1" || profile?.id !== id) {
      throw new M3BuildSetupError("m3_build_profile_invalid", `M3 build profile ${id} has the wrong identity`, { schema: profile?.schema ?? null, profile_id: profile?.id ?? null });
    }
    for (const [label, value] of [
      ["QEMU", profile.qemu_binary], ["kernel", profile.kernel?.path], ["initrd", profile.initrd?.path],
      ["rootfs", profile.rootfs?.path], ["dependency cache", profile.dependency_cache?.path],
      ["mkfs.ext4", profile.mkfs_ext4], ["sudo", profile.sudo], ["systemd-run", profile.systemd_run], ["systemctl", profile.systemctl],
    ]) regularReadable(value, `${id} ${label}`);
    profiles[id] = Object.freeze({
      id, path: profilePath, bytes: profileBytes, digest: sha256(profileBytes),
      qemuDigest: profile.qemu_digest, kernelDigest: profile.kernel.digest,
      initrdDigest: profile.initrd.digest, rootfsDigest: profile.rootfs.digest,
      dependencyCacheDigest: profile.dependency_cache.digest,
      sudo: profile.sudo, systemdRun: profile.systemd_run, systemctl: profile.systemctl,
    });
  }
  const kvmPath = resolve(options.kvmPath ?? "/dev/kvm");
  try {
    const kvm = statSync(kvmPath);
    if (!kvm.isCharacterDevice()) throw new Error("not a character device");
  } catch (error) {
    throw new M3BuildSetupError("m3_build_kvm_unavailable", "usable hardware KVM is required", {
      reason: error.message,
    });
  }
  return Object.freeze({
    assetRoot: realpathSync(assetRoot),
    builderBinary,
    profiles: Object.freeze(profiles),
    profile(id = M3_BUILD_PROFILE_ID) {
      const profile = profiles[id];
      if (!profile) throw new M3BuildSetupError("m3_build_profile_unavailable", `M3 build profile is unavailable: ${id}`);
      return profile;
    },
    kvmPath,
  });
}

export async function verifyM3BuildBroker(m3, setup) {
  const profile = setup.profile();
  const unit = `hostlet-build-preflight-${process.pid}-${Date.now()}`;
  const result = await m3.context.runCommand(
    "M3 build KVM broker preflight", profile.sudo,
    [
      "-n", profile.systemdRun, "--wait", "--collect", "--quiet", "--pipe", "--unit", unit,
      `--uid=${process.getuid()}`, "--property", "SupplementaryGroups=kvm",
      "--property", "NoNewPrivileges=yes", "--property", "DevicePolicy=closed",
      "--property", `DeviceAllow=${setup.kvmPath} rw`, "--", "/bin/bash", "-c",
      'exec 3<>"$1"; /usr/bin/id -u; /usr/bin/id -G', "hostlet-kvm-preflight", setup.kvmPath,
    ],
    { env: m3.componentEnvironment("build"), timeoutMs: 15_000, logName: "m3-build-kvm-broker-preflight.log" },
  );
  if (result.code !== 0) {
    throw new M3BuildSetupError("m3_build_kvm_broker_unavailable", "the configured systemd broker cannot open KVM read-write", {
      exit_code: result.code,
      signal: result.signal,
    });
  }
  const lines = result.stdout.trim().split("\n");
  if (lines[0] !== String(process.getuid()) || lines.length < 2) {
    throw new M3BuildSetupError("m3_build_kvm_broker_identity_invalid", "the KVM broker did not preserve the requested execution identity");
  }
  const evidence = Object.freeze({
    unit, uid: Number(lines[0]), supplementaryGroupCount: lines[1].trim().split(/\s+/).filter(Boolean).length,
    device: setup.kvmPath, openedReadWrite: true,
  });
  m3.context.state.toolchains.m3BuildKvmBroker = evidence;
  return evidence;
}

export function installM3BuildControlProfiles(m3, setup, dependencyFailureCommit) {
  const directory = join(m3.policyClock.stateDir, "profiles");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  for (const profile of Object.values(setup.profiles)) {
    const target = join(directory, `${profile.id}.json`);
    copyFileSync(profile.path, target, constants.COPYFILE_EXCL);
    chmodSync(target, 0o600);
    if (sha256(readFileSync(target)) !== profile.digest) throw new M3BuildSetupError("m3_build_profile_copy_mismatch", `control profile copy changed bytes: ${profile.id}`);
  }
  const admissions = {
    schema: "hostlet.build-profile-admissions/v1",
    cache_miss_source_commits: [dependencyFailureCommit],
  };
  writeFileSync(join(directory, "admissions.json"), `${JSON.stringify(admissions)}\n`, { mode: 0o600, flag: "wx" });
  return Object.freeze({ directory, admissions });
}

export function registerM3BuildFixtures(context) {
  context.registerFixture("M3 disposable build scenario", "e2e/scenarios/m3-build.mjs");
  context.registerFixture("M3 build setup resolver", "e2e/support/m3-build.mjs");
  context.registerFixture("M3 build worker contract", "docs/M3-BUILD-WORKER.md");
  context.registerFixture("M3 build queue contract", "docs/M3-BUILD-CONTRACT.md");
  context.registerFixture("M3 build cache preparation", "scripts/build/prepare-cache.sh");
  context.registerFixture("M3 build rootfs preparation", "scripts/build/prepare-rootfs.sh");
  context.registerFixture("M3 build kernel preparation", "scripts/build/prepare-kernel-initrd.sh");
  context.registerFixture("M3 build profile writer", "scripts/build/write-profile.sh");
  return Object.freeze({
    profileIds: M3_BUILD_PROFILE_IDS,
    defaultAssetRoot: ".local/m3-assets",
  });
}
