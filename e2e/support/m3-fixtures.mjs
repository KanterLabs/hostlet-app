import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export const M3_FIXTURE_ROOT = resolve(import.meta.dirname, "../fixtures/m3");
export const M3_PROVIDER_IDENTITY = Object.freeze({
  fixtureName: "hostlet-owned-m3-github-repositories",
  owner: Object.freeze({ id: 22001, login: "hostlet-owned-fixtures" }),
  installation: Object.freeze({ id: 42001, account_id: 22001, repository_selection: "selected" }),
  primaryUser: Object.freeze({ id: 22001, login: "hostlet-owned-fixtures" }),
  secondaryUser: Object.freeze({ id: 22002, login: "hostlet-owned-collaborator" }),
});

const DEFINITIONS = Object.freeze([
  Object.freeze({ key: "fullstack_v1", repositoryId: 62001, repository: "fullstack-journal", branch: "release-v1", directory: "fullstack-v1", profile: "m3-owned-node24-v1", message: "owned full-stack release v1", advisory: "looks_compatible", reasons: ["vite_static_export", "single_node_http_service", "postgresql_connection_required"] }),
  Object.freeze({ key: "fullstack_v2", repositoryId: 62001, repository: "fullstack-journal", branch: "main", baseDirectory: "fullstack-v1", directory: "fullstack-v2", parent: "fullstack_v1", profile: "m3-owned-node24-v1", message: "owned additive full-stack release v2", advisory: "looks_compatible", reasons: ["vite_static_export", "single_node_http_service", "postgresql_connection_required"] }),
  Object.freeze({ key: "next16", repositoryId: 62002, repository: "next16-standalone", branch: "main", directory: "next16", profile: "m3-owned-node24-v1", message: "owned Next 16 standalone fixture", advisory: "looks_compatible", reasons: ["nextjs_16_standalone"] }),
  Object.freeze({ key: "node22_api", repositoryId: 62003, repository: "node22-api", branch: "main", directory: "node22-api", profile: "m3-owned-node24-v1", toolchainProfile: "m3-owned-node22-v1", message: "owned Node 22 API fixture", advisory: "looks_compatible", reasons: ["single_node_http_service", "health_endpoint_declared"] }),
  Object.freeze({ key: "dependency_failure", repositoryId: 62012, repository: "dependency-cache-miss", branch: "main", directory: "dependency-failure", profile: "m3-owned-node24-v1", toolchainProfile: "m3-owned-node24-cache-miss-v1", message: "owned offline dependency cache miss", advisory: "looks_compatible", reasons: ["single_node_http_service"] }),
  Object.freeze({ key: "build_failure", repositoryId: 62004, repository: "build-failure", branch: "main", directory: "build-failure", profile: "m3-owned-node24-v1", message: "owned deterministic build failure", advisory: "looks_compatible", reasons: ["single_node_http_service"] }),
  Object.freeze({ key: "build_timeout", repositoryId: 62005, repository: "build-timeout", branch: "main", directory: "build-timeout", profile: "m3-owned-node24-v1", message: "owned deterministic build timeout", advisory: "looks_compatible", reasons: ["single_node_http_service"] }),
  Object.freeze({ key: "oversized_output", repositoryId: 62006, repository: "oversized-output", branch: "main", directory: "oversized-output", profile: "m3-owned-node24-v1", message: "owned sparse oversized output probe", advisory: "looks_compatible", reasons: ["vite_static_export"] }),
  Object.freeze({ key: "workspace_exhaustion", repositoryId: 62013, repository: "workspace-exhaustion", branch: "main", directory: "workspace-exhaustion", profile: "m3-owned-node24-v1", message: "owned real workspace ENOSPC probe", advisory: "looks_compatible", reasons: ["static_export"] }),
  Object.freeze({ key: "unsafe_output_symlink", repositoryId: 62014, repository: "unsafe-output-symlink", branch: "main", directory: "unsafe-output-symlink", profile: "m3-owned-node24-v1", message: "owned symlink output rejection probe", advisory: "looks_compatible", reasons: ["static_export"] }),
  Object.freeze({ key: "unsafe_output_special", repositoryId: 62015, repository: "unsafe-output-special", branch: "main", directory: "unsafe-output-special", profile: "m3-owned-node24-v1", message: "owned special output rejection probe", advisory: "looks_compatible", reasons: ["static_export"] }),
  Object.freeze({ key: "unhealthy_runtime", repositoryId: 62007, repository: "unhealthy-runtime", branch: "main", directory: "unhealthy-runtime", profile: "m3-owned-node24-v1", message: "owned unhealthy runtime fixture", advisory: "looks_compatible", reasons: ["single_node_http_service", "health_endpoint_declared"] }),
  Object.freeze({ key: "crash_runtime", repositoryId: 62008, repository: "crash-runtime", branch: "main", directory: "crash-runtime", profile: "m3-owned-node24-v1", message: "owned crashing runtime fixture", advisory: "looks_compatible", reasons: ["single_node_http_service", "health_endpoint_declared"] }),
  Object.freeze({ key: "policy_probes", repositoryId: 62009, repository: "policy-probes", branch: "main", directory: "policy-probes", profile: "m3-owned-node24-v1", message: "owned isolation and resource policy probes", advisory: "looks_compatible", reasons: ["single_node_http_service", "health_endpoint_declared"] }),
  Object.freeze({ key: "incompatible_api", repositoryId: 62010, repository: "incompatible-api", branch: "main", baseDirectory: "fullstack-v1", directory: "incompatible-api", profile: "m3-owned-node24-v1", message: "owned backwards-incompatible API candidate", advisory: "looks_compatible", reasons: ["vite_static_export", "single_node_http_service", "postgresql_connection_required"] }),
  Object.freeze({ key: "incompatible_migration", repositoryId: 62011, repository: "incompatible-migration", branch: "main", baseDirectory: "fullstack-v1", directory: "incompatible-migration", profile: "m3-owned-node24-v1", message: "owned destructive migration rejection candidate", advisory: "database_needed", reasons: ["vite_static_export", "single_node_http_service", "postgresql_connection_required"] }),
]);

export const M3_SOURCE_KEYS = Object.freeze(DEFINITIONS.map((definition) => definition.key));

export const M3_BUILD_SERVICES = Object.freeze({
  fullstack_v1: Object.freeze([
    Object.freeze({ service_id: "owned-web", kind: "static_frontend", root: "apps/web", node_major: 24, framework: "vite_static", lockfile_path: "package-lock.json", build_command: "npm run build", output_directory: "dist" }),
    Object.freeze({ service_id: "owned-api", kind: "application", root: "apps/api", node_major: 24, framework: "node_http", lockfile_path: "package-lock.json", build_command: "npm run build", output_directory: "dist", start_command: "npm run start", health_path: "/healthz" }),
  ]),
  fullstack_v2: Object.freeze([
    Object.freeze({ service_id: "owned-web", kind: "static_frontend", root: "apps/web", node_major: 24, framework: "vite_static", lockfile_path: "package-lock.json", build_command: "npm run build", output_directory: "dist" }),
    Object.freeze({ service_id: "owned-api", kind: "application", root: "apps/api", node_major: 24, framework: "node_http", lockfile_path: "package-lock.json", build_command: "npm run build", output_directory: "dist", start_command: "npm run start", health_path: "/healthz" }),
  ]),
  next16: Object.freeze([Object.freeze({ service_id: "owned-next", kind: "application", root: ".", node_major: 24, framework: "nextjs16_standalone", lockfile_path: "package-lock.json", build_command: "npm run build", output_directory: ".next/standalone", start_command: "npm run start", health_path: "/api/release" })]),
  node22_api: Object.freeze([Object.freeze({ service_id: "owned-node22", kind: "application", root: ".", node_major: 22, framework: "node_http", lockfile_path: "package-lock.json", build_command: "npm run build", output_directory: "dist", start_command: "npm run start", health_path: "/healthz" })]),
  dependency_failure: Object.freeze([Object.freeze({ service_id: "owned-dependency-failure", kind: "static_frontend", root: ".", node_major: 24, framework: "static_export", lockfile_path: "package-lock.json", build_command: "npm run build", output_directory: "dist" })]),
  build_failure: Object.freeze([Object.freeze({ service_id: "owned-build-failure", kind: "static_frontend", root: ".", node_major: 24, framework: "static_export", lockfile_path: "package-lock.json", build_command: "npm run build", output_directory: "dist" })]),
  build_timeout: Object.freeze([Object.freeze({ service_id: "owned-build-timeout", kind: "static_frontend", root: ".", node_major: 24, framework: "static_export", lockfile_path: "package-lock.json", build_command: "npm run build", output_directory: "dist" })]),
  oversized_output: Object.freeze([Object.freeze({ service_id: "owned-oversized-output", kind: "static_frontend", root: ".", node_major: 24, framework: "static_export", lockfile_path: "package-lock.json", build_command: "npm run build", output_directory: "dist" })]),
  workspace_exhaustion: Object.freeze([Object.freeze({ service_id: "owned-workspace-exhaustion", kind: "static_frontend", root: ".", node_major: 24, framework: "static_export", lockfile_path: "package-lock.json", build_command: "npm run build", output_directory: "dist" })]),
  unsafe_output_symlink: Object.freeze([Object.freeze({ service_id: "owned-unsafe-output-symlink", kind: "static_frontend", root: ".", node_major: 24, framework: "static_export", lockfile_path: "package-lock.json", build_command: "npm run build", output_directory: "dist" })]),
  unsafe_output_special: Object.freeze([Object.freeze({ service_id: "owned-unsafe-output-special", kind: "static_frontend", root: ".", node_major: 24, framework: "static_export", lockfile_path: "package-lock.json", build_command: "npm run build", output_directory: "dist" })]),
  unhealthy_runtime: Object.freeze([Object.freeze({ service_id: "owned-unhealthy", kind: "application", root: ".", node_major: 24, framework: "node_http", lockfile_path: "package-lock.json", build_command: "npm run build", output_directory: "dist", start_command: "npm run start", health_path: "/healthz" })]),
  crash_runtime: Object.freeze([Object.freeze({ service_id: "owned-crash", kind: "application", root: ".", node_major: 24, framework: "node_http", lockfile_path: "package-lock.json", build_command: "npm run build", output_directory: "dist", start_command: "npm run start", health_path: "/healthz" })]),
  policy_probes: Object.freeze([Object.freeze({ service_id: "owned-policy-probes", kind: "application", root: ".", node_major: 24, framework: "node_http", lockfile_path: "package-lock.json", build_command: "npm run build", output_directory: "dist", start_command: "npm run start", health_path: "/healthz" })]),
  incompatible_api: Object.freeze([
    Object.freeze({ service_id: "owned-web", kind: "static_frontend", root: "apps/web", node_major: 24, framework: "vite_static", lockfile_path: "package-lock.json", build_command: "npm run build", output_directory: "dist" }),
    Object.freeze({ service_id: "owned-api", kind: "application", root: "apps/api", node_major: 24, framework: "node_http", lockfile_path: "package-lock.json", build_command: "npm run build", output_directory: "dist", start_command: "npm run start", health_path: "/healthz" }),
  ]),
  incompatible_migration: Object.freeze([
    Object.freeze({ service_id: "owned-web", kind: "static_frontend", root: "apps/web", node_major: 24, framework: "vite_static", lockfile_path: "package-lock.json", build_command: "npm run build", output_directory: "dist" }),
    Object.freeze({ service_id: "owned-api", kind: "application", root: "apps/api", node_major: 24, framework: "node_http", lockfile_path: "package-lock.json", build_command: "npm run build", output_directory: "dist", start_command: "npm run start", health_path: "/healthz" }),
  ]),
});

function gitHash(type, bytes) {
  const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return createHash("sha1").update(Buffer.from(`${type} ${content.length}\0`)).update(content).digest("hex");
}

function readTree(directory) {
  const files = {};
  function visit(current) {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      const absolute = join(current, entry.name);
      const path = relative(directory, absolute).split(sep).join("/");
      if (entry.isSymbolicLink()) throw new Error(`M3 fixture source cannot contain a symlink: ${path}`);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files[path] = readFileSync(absolute, "utf8");
      else throw new Error(`M3 fixture source must contain regular files only: ${path}`);
    }
  }
  visit(directory);
  return files;
}

function treeSha(files) {
  const root = { files: new Map(), directories: new Map() };
  for (const [path, content] of Object.entries(files)) {
    const parts = path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.directories.has(part)) node.directories.set(part, { files: new Map(), directories: new Map() });
      node = node.directories.get(part);
    }
    node.files.set(parts.at(-1), content);
  }
  function hashNode(node) {
    const entries = [];
    for (const [name, content] of node.files) entries.push({ name, sortName: name, mode: "100644", sha: gitHash("blob", content) });
    for (const [name, child] of node.directories) entries.push({ name, sortName: `${name}/`, mode: "40000", sha: hashNode(child) });
    entries.sort((left, right) => Buffer.compare(Buffer.from(left.sortName), Buffer.from(right.sortName)));
    const bytes = Buffer.concat(entries.flatMap((entry) => [Buffer.from(`${entry.mode} ${entry.name}\0`), Buffer.from(entry.sha, "hex")]));
    return gitHash("tree", bytes);
  }
  return hashNode(root);
}

function commitSha(tree, message, parent) {
  const identity = "Hostlet Owned Fixture <fixture@hostlet.invalid> 1790035200 +0000";
  const body = `tree ${tree}\n${parent ? `parent ${parent}\n` : ""}author ${identity}\ncommitter ${identity}\n\n${message}\n`;
  return gitHash("commit", body);
}

function mergedFiles(definition) {
  const result = definition.baseDirectory ? readTree(join(M3_FIXTURE_ROOT, definition.baseDirectory)) : {};
  return Object.assign(result, readTree(join(M3_FIXTURE_ROOT, definition.directory)));
}

export function createM3FixtureSources({ requireLockfiles = true } = {}) {
  const sources = new Map();
  for (const definition of DEFINITIONS) {
    const files = mergedFiles(definition);
    if (requireLockfiles) {
      const packages = Object.keys(files).filter((path) => path.endsWith("package.json"));
      for (const packagePath of packages) {
        const lockPath = `${packagePath.slice(0, -"package.json".length)}package-lock.json`;
        if (!(lockPath in files)) throw new Error(`M3 fixture lockfile is missing: ${definition.key}/${lockPath}`);
      }
    }
    const tree = treeSha(files);
    const parent = definition.parent ? sources.get(definition.parent)?.commitSha : null;
    const sha = commitSha(tree, definition.message, parent);
    const byteCounts = Object.values(files).map((content) => Buffer.byteLength(content));
    sources.set(definition.key, Object.freeze({
      ...definition,
      files: Object.freeze(files),
      treeSha: tree,
      commitSha: sha,
      parentCommitSha: parent || null,
      metrics: Object.freeze({ fileCount: byteCounts.length, totalBytes: byteCounts.reduce((sum, bytes) => sum + bytes, 0), maxFileBytes: Math.max(0, ...byteCounts) }),
    }));
  }
  return sources;
}

export function createM3GitHubFixture(options = {}) {
  const sources = createM3FixtureSources(options);
  const grouped = new Map();
  for (const source of sources.values()) {
    let repository = grouped.get(source.repositoryId);
    if (!repository) {
      repository = { id: source.repositoryId, name: source.repository, private: true, default_branch: "main", grant: "default", expected_advisory: source.advisory, expected_reasons: source.reasons, branches: {}, commits: {}, m3_sources: {} };
      grouped.set(source.repositoryId, repository);
    }
    repository.branches[source.branch] = source.commitSha;
    repository.commits[source.commitSha] = { tree: source.treeSha, message: source.message, files: source.files, ...(source.parentCommitSha ? { parents: [source.parentCommitSha] } : {}) };
    repository.m3_sources[source.key] = { commit: source.commitSha, profile: source.profile };
  }
  return Object.freeze({
    schema_version: 2,
    fixture_name: M3_PROVIDER_IDENTITY.fixtureName,
    owner: M3_PROVIDER_IDENTITY.owner,
    installation: M3_PROVIDER_IDENTITY.installation,
    oauth_users: { primary: M3_PROVIDER_IDENTITY.primaryUser, secondary: M3_PROVIDER_IDENTITY.secondaryUser },
    sentinels: { directory_environment: "HOSTLET_E2E_SENTINEL_DIR", network_environment: "HOSTLET_E2E_SENTINEL_URL", expected_files: [], expected_network_paths: [] },
    repositories: [...grouped.values()],
  });
}

export function loadM3FixtureRepositories(options = {}) {
  const sources = createM3FixtureSources(options);
  const fixtureData = createM3GitHubFixture(options);
  const commits = Object.freeze(Object.fromEntries([...sources].map(([key, source]) => [key, Object.freeze({
    repositoryId: source.repositoryId,
    repository: source.repository,
    branch: source.branch,
    commitSha: source.commitSha,
    treeSha: source.treeSha,
    profile: source.profile,
    toolchainProfile: source.toolchainProfile ?? source.profile,
    metrics: source.metrics,
  })])));
  return Object.freeze({ fixtureData, sources, commits, buildServices: M3_BUILD_SERVICES });
}

export function createM3StandardProjectConfiguration(key = "fullstack_v1") {
  if (!new Set(["fullstack_v1", "fullstack_v2"]).has(key)) throw new Error(`no standard-project configuration for M3 source: ${key}`);
  const configuration = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../contracts/v1/projects/valid-standard.json"), "utf8"));
  const application = configuration.services.find((service) => service.kind === "application");
  if (!application || application.root !== "apps/api") throw new Error("M3 standard-project fixture is missing its owned API service");
  application.build_command = "npm run build";
  application.output_directory = "dist";
  application.start_command = "npm run start";
  return configuration;
}

export function registerM3FixtureSources(context) {
  if (!context || typeof context.registerFixture !== "function") throw new Error("M3 fixtures require an E2E context with fixture registration");
  context.registerFixture("M3 fixture source loader", "e2e/support/m3-fixtures.mjs");
  context.registerFixture("M3 Node 24 cache metadata", "e2e/fixtures/m3/cache/node24-cache-metadata.json");
  context.registerFixture("M3 Node 22 cache metadata", "e2e/fixtures/m3/cache/node22-cache-metadata.json");
  const registered = new Set();
  for (const definition of DEFINITIONS) {
    for (const directoryName of [definition.baseDirectory, definition.directory].filter(Boolean)) {
      const directory = join(M3_FIXTURE_ROOT, directoryName);
      for (const path of Object.keys(readTree(directory))) {
        const fixturePath = relative(resolve(import.meta.dirname, "../.."), join(directory, path));
        if (registered.has(fixturePath)) continue;
        registered.add(fixturePath);
        context.registerFixture(`M3 ${definition.key} source: ${path}`, fixturePath);
      }
    }
  }
  return Object.freeze({ schemaVersion: 2, providerIdentity: M3_PROVIDER_IDENTITY, definitions: DEFINITIONS });
}

export function m3Source(sources, key) {
  if (!(sources instanceof Map)) throw new Error("M3 source selection requires the map returned by createM3FixtureSources");
  const source = sources.get(key);
  if (!source) throw new Error(`unknown M3 fixture source: ${key}`);
  return source;
}
