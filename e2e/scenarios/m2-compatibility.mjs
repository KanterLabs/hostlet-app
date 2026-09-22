import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { basename, join } from "node:path";

import {
  assertErrorShape,
  assertNoCredentialValue,
  assertStatus,
  expectScenario,
  ScenarioExpectationError,
} from "../support/http-client.mjs";

export const M2_COMPATIBILITY_REQUIRED_ASSERTIONS = Object.freeze([
  "M2-COMPAT-01",
  "M2-COMPAT-02",
  "M2-COMPAT-03",
  "M2-COMPAT-04",
]);

const INSTALLATION_ID = 41001;
const INITIAL_COMMIT = "1111111111111111111111111111111111111111";
const MOVED_COMMIT = "1111111111111111111111111111111111111112";
const HEADLINES = Object.freeze({
  candidate: "Looks compatible — deployment not yet verified",
  configuration_needed: "Configuration needed",
  database_needed: "Database needed",
  secrets_needed: "Secrets needed",
  showcase_only: "Showcase-only unsupported",
});

function safeObserved(error) {
  if (error instanceof ScenarioExpectationError) return error.observed;
  return { failed_checks: 1 };
}

async function compatibilityStep(context, id, expected, run) {
  try {
    const observed = await run();
    context.assertion(id, "M2 bounded static compatibility", expected, observed, true);
    return observed;
  } catch (error) {
    context.assertion(
      id,
      "M2 bounded static compatibility",
      expected,
      safeObserved(error),
      false,
      error instanceof ScenarioExpectationError ? error.check : "compatibility HTTP or persistence boundary failed",
    );
    throw error;
  }
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function mutationHeaders(key, revision) {
  return { "Idempotency-Key": key, "If-Match": `"${revision}"` };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function syntheticBlob(path, content, index) {
  return {
    path,
    mode: "100644",
    type: "blob",
    sha: (10_000 + index).toString(16).padStart(40, "0"),
    content,
  };
}

function fixtureMethod(fixture, name) {
  const method = fixture.controls?.[name];
  expectScenario(typeof method === "function", `GitHub fixture exposes ${name}`, {
    missing_fixture_control: name,
  });
  return method.bind(fixture.controls);
}

async function reconnectOwner(m2) {
  const attempt = await m2.call("/v1/github/oauth-attempts", {
    method: "POST",
    token: m2.state.owner.token,
  });
  assertStatus(attempt, 201, "compatibility owner OAuth attempt");
  fixtureMethod(m2.state.githubFixture, "authorizeNext")({ mode: "success" });
  const authorization = await fetch(attempt.payload.authorization_url, {
    redirect: "manual",
    signal: AbortSignal.any([AbortSignal.timeout(10_000), m2.context.abortSignal]),
  });
  expectScenario(authorization.status >= 300 && authorization.status < 400, "compatibility provider OAuth redirect", {
    provider_authorization_status: authorization.status,
  });
  const location = authorization.headers.get("location");
  expectScenario(typeof location === "string", "compatibility provider callback location", {
    callback_location_present: false,
  });
  const callback = new URL(location);
  const code = callback.searchParams.get("code");
  const state = callback.searchParams.get("state");
  expectScenario(Boolean(code && state), "compatibility provider callback credentials", {
    callback_code_and_state_present: false,
  });
  m2.context.registerSensitiveValues([code, state]);
  const completed = await m2.call("/v1/github/oauth-completions", {
    method: "POST",
    token: m2.state.owner.token,
    body: { code, state },
  });
  assertStatus(completed, 200, "compatibility owner OAuth completion");
  return completed.payload;
}

function staticSpec(template, { root = ".", layout = "single_project" } = {}) {
  const spec = clone(template);
  spec.repositories[0].layout = layout;
  spec.services[0].root = root;
  return spec;
}

function applicationSpec(template, {
  framework = "node_http",
  root = ".",
  buildCommand = null,
  healthPath = "/healthz",
  durable = false,
  database = false,
  layout = "single_project",
  nodeMajor = 24,
  startCommand = "npm run start",
} = {}) {
  const spec = clone(template);
  spec.repositories[0].layout = layout;
  const application = spec.services.find(({ kind }) => kind === "application");
  application.root = root;
  application.framework = framework;
  application.node.major = nodeMajor;
  application.build_command = buildCommand;
  application.start_command = startCommand;
  application.health_check = { protocol: "http", path: healthPath };
  application.uses_durable_data = durable;
  spec.services = database
    ? [application, spec.services.find(({ kind }) => kind === "postgres")]
    : [application];
  return spec;
}

function rootedApplicationSpec(template, root, options = {}) {
  const spec = applicationSpec(template, { ...options, root, layout: "monorepo" });
  spec.repositories[0].lockfile_path = `${root}/package-lock.json`;
  return spec;
}

async function createBoundProject(m2, sequence, repository, configuration, label) {
  const created = await m2.call("/v1/projects", {
    method: "POST",
    token: m2.state.owner.token,
    headers: { "Idempotency-Key": `m2-compat-project-${sequence}-${repository.id}` },
    body: { name: `M2 compatibility ${label}`, configuration },
  });
  assertStatus(created, 201, `${label} project creation`);
  const bound = await m2.call(`/v1/projects/${created.payload.project.id}/github-source`, {
    method: "PUT",
    token: m2.state.owner.token,
    headers: mutationHeaders(`m2-compat-bind-${sequence}-${repository.id}`, created.payload.project.revision),
    body: {
      installation_id: INSTALLATION_ID,
      repository_id: repository.id,
      ref: "refs/heads/main",
    },
  });
  assertStatus(bound, 200, `${label} exact source binding`);
  expectScenario(
    bound.payload.source_revision?.resolved_commit === repository.commits[0] &&
      typeof bound.payload.source_revision?.id === "string",
    `${label} binding resolved the fixture exact commit`,
    {
      expected_commit: repository.commits[0],
      observed_commit: bound.payload.source_revision?.resolved_commit ?? null,
    },
  );
  const graph = await m2.call(`/v1/projects/${created.payload.project.id}`, { token: m2.state.owner.token });
  assertStatus(graph, 200, `${label} current project graph`);
  return Object.freeze({
    label,
    repository,
    graph: graph.payload,
    source: bound.payload,
    configuration,
  });
}

async function analyze(m2, fixture, key, { sourceRevisionId, configurationRevisionId } = {}) {
  return m2.call(`/v1/projects/${fixture.graph.project.id}/compatibility-reports`, {
    method: "POST",
    token: m2.state.owner.token,
    headers: mutationHeaders(key, fixture.graph.project.revision),
    body: {
      source_revision_id: sourceRevisionId ?? fixture.source.source_revision.id,
      configuration_revision_id: configurationRevisionId ?? fixture.graph.configuration.id,
    },
    timeoutMs: 25_000,
  });
}

function assertSafeReport(m2, response, fixture, expectedStatus, check) {
  assertStatus(response, 201, check);
  const report = response.payload;
  expectScenario(
    typeof report?.id === "string" &&
      report.project_id === fixture.graph.project.id &&
      report.configuration_revision_id === fixture.graph.configuration.id &&
      report.source_revision_id === fixture.source.source_revision.id &&
      typeof report.analyzer_revision === "string" &&
      report.analyzer_revision.startsWith("hostlet.compatibility/v1+") &&
      report.status === expectedStatus &&
      report.headline === HEADLINES[expectedStatus] &&
      report.advisory === "deployment_not_verified" &&
      report.deployment_verified === false &&
      report.facts?.contract_version === "hostlet.compatibility-report/v1" &&
      report.facts?.inspection?.limits_revision === "hostlet.compatibility-bounds/v1" &&
      Number.isInteger(report.facts?.inspection?.files_considered) &&
      report.facts.inspection.files_considered <= 2_000 &&
      Number.isInteger(report.facts?.inspection?.files_read) &&
      report.facts.inspection.files_read <= 40 &&
      Number.isInteger(report.facts?.inspection?.bytes_read) &&
      report.facts.inspection.bytes_read <= 512 * 1024,
    `${check}: complete versioned advisory report`,
    {
      report_id_present: typeof report?.id === "string",
      status: report?.status ?? null,
      advisory: report?.advisory ?? null,
      deployment_verified: report?.deployment_verified ?? null,
      contract_version: report?.facts?.contract_version ?? null,
      limits_revision: report?.facts?.inspection?.limits_revision ?? null,
    },
  );
  const retained = JSON.stringify(report);
  for (const forbidden of [
    "document.querySelector('#root')",
    "writeFileSync(join(process.env.HOSTLET_E2E_SENTINEL_DIR",
    "synthetic private fixture metadata",
    "throw new Error(`sentinel ${name} executed`)",
  ]) {
    expectScenario(!retained.includes(forbidden), `${check}: report omits private source bodies`, {
      private_source_body_retained: true,
    });
  }
  assertNoCredentialValue(report, Object.values(m2.credentials), `${check}: report omits Hostlet credentials`);
  assertNoCredentialValue(
    report,
    [fixtureMethod(m2.state.githubFixture, "webhookSecret")()],
    `${check}: report omits provider credentials`,
  );
  return report;
}

async function reportCount(m2, projectId, label, databaseName = null) {
  const sql = `SELECT COUNT(*)::int FROM compatibility_reports WHERE project_id=${sqlString(projectId)}::uuid;`;
  return databaseName
    ? m2.postgres.psqlJsonDatabase(label, databaseName, sql)
    : m2.postgres.psqlJson(label, sql);
}

async function reportSourceCommit(m2, reportId, label) {
  return m2.postgres.psqlJson(
    label,
    `SELECT json_build_object(
       'report_id',cr.id::text,
       'source_revision_id',cr.source_revision_id::text,
       'commit',gsr.commit_sha,
       'tree',gsr.tree_sha,
       'configuration_revision_id',cr.configuration_revision_id::text
     )
     FROM compatibility_reports cr
     JOIN github_source_revisions gsr
       ON gsr.account_id=cr.account_id AND gsr.project_id=cr.project_id AND gsr.id=cr.source_revision_id
     WHERE cr.id=${sqlString(reportId)}::uuid;`,
  );
}

async function reportRows(m2, ids, label, databaseName = null) {
  const sql = `SELECT COALESCE(json_agg(json_build_object(
      'id',id::text,'project_id',project_id::text,
      'configuration_revision_id',configuration_revision_id::text,
      'source_revision_id',source_revision_id::text,
      'analyzer_revision',analyzer_revision,'status',status,
      'advisory',advisory,'report_digest',report_digest,'report',report
    ) ORDER BY id),'[]'::json)
    FROM compatibility_reports WHERE id = ANY(ARRAY[${ids.map(sqlString).join(",")}]::uuid[]);`;
  return databaseName
    ? m2.postgres.psqlJsonDatabase(label, databaseName, sql)
    : m2.postgres.psqlJson(label, sql);
}

async function nonEffectCounts(m2, label) {
  return m2.postgres.psqlJson(
    label,
    `SELECT json_build_object(
      'deployments',(SELECT COUNT(*)::int FROM deployments),
      'jobs',(SELECT COUNT(*)::int FROM jobs),
      'secret_versions',(SELECT COUNT(*)::int FROM secret_versions),
      'capacity_pools',(SELECT COUNT(*)::int FROM admission_capacity_pools),
      'entitlements',(SELECT COUNT(*)::int FROM admission_entitlements),
      'source_proofs',(SELECT COUNT(*)::int FROM admission_source_proofs),
      'capacity_holds',(SELECT COUNT(*)::int FROM capacity_holds),
      'slot_reservations',(SELECT COUNT(*)::int FROM slot_reservations),
      'build_usage_events',(SELECT COUNT(*)::int FROM build_usage_events),
      'portfolio_drafts',(SELECT COUNT(*)::int FROM portfolio_draft_revisions),
      'portfolio_project_references',(SELECT COUNT(*)::int FROM portfolio_project_references),
      'preview_contexts',(SELECT COUNT(*)::int FROM portfolio_preview_contexts),
      'preview_project_contexts',(SELECT COUNT(*)::int FROM portfolio_preview_project_contexts),
      'hosted_slots',(SELECT COALESCE(SUM(hosted_slots),0)::int FROM projects)
    );`,
  );
}

function expectRejectedWithoutReport(response, expectedStatus, expectedCode, before, after, check) {
  assertErrorShape(response, expectedStatus, `${check}: safe bounded-source error`);
  expectScenario(response.payload.error.code === expectedCode, `${check}: stable bounded-source error code`, {
    status: response.status,
    error_code: response.payload.error.code,
  });
  expectScenario(after === before, `${check}: no partial compatibility report`, {
    reports_before: before,
    reports_after: after,
  });
}

function processDescendants(rootPid) {
  const pending = [rootPid];
  const seen = new Set([rootPid]);
  const descendants = [];
  let rootObserved = false;
  while (pending.length > 0) {
    const pid = pending.shift();
    let taskIds;
    try {
      taskIds = readdirSync(`/proc/${pid}/task`);
      if (pid === rootPid) rootObserved = true;
    } catch {
      continue;
    }
    for (const taskId of taskIds) {
      let children = "";
      try {
        children = readFileSync(`/proc/${pid}/task/${taskId}/children`, "utf8");
      } catch {
        continue;
      }
      for (const raw of children.trim().split(/\s+/).filter(Boolean)) {
        const childPid = Number(raw);
        if (!Number.isSafeInteger(childPid) || seen.has(childPid)) continue;
        seen.add(childPid);
        let command = "unknown";
        try {
          command = basename(readFileSync(`/proc/${childPid}/comm`, "utf8").trim());
        } catch {
          // A short-lived child is still a child-process observation.
        }
        descendants.push({ pid: childPid, command });
        pending.push(childPid);
      }
    }
  }
  return { rootObserved, descendants };
}

async function startNetworkSink(context) {
  const paths = [];
  const port = await context.allocatePort();
  const server = createServer((request, response) => {
    paths.push(new URL(request.url, `http://127.0.0.1:${port}`).pathname);
    response.writeHead(204, { "Content-Length": "0", "Cache-Control": "no-store" });
    response.end();
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolvePromise);
  });
  return {
    url: `http://127.0.0.1:${port}`,
    paths,
    close: () => new Promise((resolvePromise) => server.close(resolvePromise)),
  };
}

export function registerM2CompatibilityFixtures(context) {
  context.registerFixture("M2 compatibility HTTP and SQL scenario module", "e2e/scenarios/m2-compatibility.mjs");
  context.registerFixture("M2 owned synthetic compatibility repositories", "e2e/fixtures/m2-repositories.json");
  context.registerFixture("M2 compatibility acceptance inventory", "docs/M2-SCENARIOS.md");
  context.registerFixture("M2 Vite standard project contract", "contracts/v1/projects/valid-static-only.json");
  context.registerFixture("M2 Node standard project contract", "contracts/v1/projects/valid-api-only.json");
  return Object.freeze({
    schema_version: 1,
    boundary: "real Hostlet HTTP and PostgreSQL with owned synthetic GitHub HTTP source",
  });
}

export async function runM2CompatibilityScenarios(m2) {
  const { context, postgres, call, currentApiBinary, switchApi, state } = m2;
  const fixture = state.githubFixture;
  expectScenario(Boolean(fixture), "M2 compatibility uses the prepared GitHub HTTP fixture", {
    github_fixture_prepared: false,
  });
  const repositories = fixture.repositories;
  expectScenario(repositories.length >= 10, "M2 compatibility repository fixture coverage", {
    repository_fixture_count: repositories.length,
  });
  const repository = (id) => {
    const found = repositories.find((candidate) => candidate.id === id);
    expectScenario(Boolean(found), `compatibility repository ${id} exists`, { missing_repository_id: id });
    return found;
  };
  const staticTemplate = JSON.parse(
    readFileSync(join(context.repo, "contracts", "v1", "projects", "valid-static-only.json"), "utf8"),
  );
  const apiTemplate = JSON.parse(
    readFileSync(join(context.repo, "contracts", "v1", "projects", "valid-api-only.json"), "utf8"),
  );
  const sentinelDirectory = join(context.tempDir, `m2-compat-sentinels-${randomUUID()}`);
  mkdirSync(sentinelDirectory, { recursive: true, mode: 0o700 });
  const networkSink = await startNetworkSink(context);
  Object.assign(m2.extraEnvironment, {
    [fixture.sentinels.directoryEnvironment]: sentinelDirectory,
    [fixture.sentinels.networkEnvironment]: networkSink.url,
  });
  let apiHandle = null;
  let completed = false;
  let sequence = 0;
  const projects = new Map();
  const retainedReports = [];
  const key = (label) => `m2-compat-${label}-${++sequence}`;

  try {
    apiHandle = await switchApi(currentApiBinary, "M2 compatibility sentinel observation");
    fixture.controls.setGrant({
      installationId: INSTALLATION_ID,
      repositoryIds: repositories.map(({ id }) => id),
      contentsPermission: "read",
      suspended: false,
    });
    fixture.controls.moveBranch(61001, "main", INITIAL_COMMIT);
    await reconnectOwner(m2);

    const specs = new Map([
      [61001, staticSpec(staticTemplate)],
      [61002, applicationSpec(apiTemplate)],
      [61003, applicationSpec(apiTemplate, {
        framework: "nextjs16_standalone",
        root: "apps/web",
        buildCommand: "npm run build",
        healthPath: "/api/health",
        layout: "monorepo",
      })],
      [61004, applicationSpec(apiTemplate)],
      [61005, staticSpec(staticTemplate)],
      [61006, staticSpec(staticTemplate)],
      [61007, staticSpec(staticTemplate)],
      [61008, applicationSpec(apiTemplate, {
        framework: "nextjs16_standalone",
        buildCommand: "npm run build",
      })],
      [61009, applicationSpec(apiTemplate)],
      [61010, applicationSpec(apiTemplate, { buildCommand: "npm run build" })],
    ]);
    for (const [repositoryId, spec] of specs) {
      const source = repository(repositoryId);
      projects.set(
        repositoryId,
        await createBoundProject(m2, ++sequence, source, spec, source.name),
      );
    }
    const databaseConfigured = await createBoundProject(
      m2,
      ++sequence,
      repository(61004),
      applicationSpec(apiTemplate, { durable: true, database: true }),
      "postgres-service-configured",
    );
    const regressionProjects = Object.freeze({
      rootCaseMismatch: await createBoundProject(
        m2,
        ++sequence,
        repository(61003),
        applicationSpec(apiTemplate, {
          framework: "nextjs16_standalone",
          root: "Apps/Web",
          buildCommand: "npm run build",
          healthPath: "/api/health",
          layout: "monorepo",
        }),
        "root-case-mismatch",
      ),
      wrongHealthPath: await createBoundProject(
        m2,
        ++sequence,
        repository(61002),
        applicationSpec(apiTemplate, { healthPath: "/readyz" }),
        "wrong-health-path",
      ),
      nodeExact22: await createBoundProject(
        m2,
        ++sequence,
        repository(61006),
        rootedApplicationSpec(apiTemplate, "cases/node-exact-22", { healthPath: "/healthz", nodeMajor: 22 }),
        "node-exact-22",
      ),
      nodeExact22Mismatch: await createBoundProject(
        m2,
        ++sequence,
        repository(61006),
        rootedApplicationSpec(apiTemplate, "cases/node-exact-22", { healthPath: "/healthz", nodeMajor: 24 }),
        "node-exact-22-runtime-mismatch",
      ),
      nodeBroadRange: await createBoundProject(
        m2,
        ++sequence,
        repository(61006),
        rootedApplicationSpec(apiTemplate, "cases/node-broad-range", { healthPath: "/healthz", nodeMajor: 22 }),
        "node-broad-range",
      ),
      nextVersion160: await createBoundProject(
        m2,
        ++sequence,
        repository(61006),
        rootedApplicationSpec(apiTemplate, "cases/next-version-160", {
          framework: "nextjs16_standalone",
          buildCommand: "npm run build",
          healthPath: "/api/health",
        }),
        "next-version-160",
      ),
      nextCommentOnly: await createBoundProject(
        m2,
        ++sequence,
        repository(61006),
        rootedApplicationSpec(apiTemplate, "cases/next-comment-only", {
          framework: "nextjs16_standalone",
          buildCommand: "npm run build",
          healthPath: "/api/health",
        }),
        "next-comment-only",
      ),
      nextStringOnly: await createBoundProject(
        m2,
        ++sequence,
        repository(61006),
        rootedApplicationSpec(apiTemplate, "cases/next-string-only", {
          framework: "nextjs16_standalone",
          buildCommand: "npm run build",
          healthPath: "/api/health",
        }),
        "next-string-only",
      ),
      nextNestedStandalone: await createBoundProject(
        m2,
        ++sequence,
        repository(61006),
        rootedApplicationSpec(apiTemplate, "cases/next-nested-standalone", {
          framework: "nextjs16_standalone",
          buildCommand: "npm run build",
          healthPath: "/api/health",
        }),
        "next-nested-standalone",
      ),
      nextUnclosedConfig: await createBoundProject(
        m2,
        ++sequence,
        repository(61006),
        rootedApplicationSpec(apiTemplate, "cases/next-unclosed-config", {
          framework: "nextjs16_standalone",
          buildCommand: "npm run build",
          healthPath: "/api/health",
        }),
        "next-unclosed-config",
      ),
      nextUppercaseConfig: await createBoundProject(
        m2,
        ++sequence,
        repository(61006),
        rootedApplicationSpec(apiTemplate, "cases/next-uppercase-config", {
          framework: "nextjs16_standalone",
          buildCommand: "npm run build",
          healthPath: "/api/health",
        }),
        "next-uppercase-config",
      ),
      healthDocumentationOnly: await createBoundProject(
        m2,
        ++sequence,
        repository(61006),
        rootedApplicationSpec(apiTemplate, "cases/health-documentation-only", { healthPath: "/healthz" }),
        "health-documentation-only",
      ),
      missingStartTarget: await createBoundProject(
        m2,
        ++sequence,
        repository(61006),
        rootedApplicationSpec(apiTemplate, "cases/missing-start-target", {
          healthPath: "/healthz",
          startCommand: "node missing.mjs",
        }),
        "missing-start-target",
      ),
    });

    await compatibilityStep(
      context,
      "M2-COMPAT-01",
      "analysis reads only one authorized immutable exact commit within every source bound, and malformed, escaping, excessive, inconsistent, or unavailable provider source creates no partial report",
      async () => {
        const immutable = projects.get(61001);
        const initial = await analyze(m2, immutable, key("immutable-initial"));
        const initialReport = assertSafeReport(m2, initial, immutable, "candidate", "initial immutable Vite analysis");
        retainedReports.push(initialReport);
        const exactInput = await reportSourceCommit(m2, initialReport.id, "m2-compat-exact-report-input");
        expectScenario(
          exactInput.source_revision_id === immutable.source.source_revision.id &&
            exactInput.configuration_revision_id === immutable.graph.configuration.id &&
            exactInput.commit === INITIAL_COMMIT &&
            typeof exactInput.tree === "string",
          "compatibility report durably references the authorized exact commit, tree and configuration",
          exactInput,
        );
        fixture.controls.moveBranch(61001, "main", MOVED_COMMIT);
        const savedSource = await call(`/v1/projects/${immutable.graph.project.id}/github-source`, {
          token: state.owner.token,
        });
        assertStatus(savedSource, 200, "saved source after compatibility branch movement");
        expectScenario(
          savedSource.payload.source_revision.resolved_commit === INITIAL_COMMIT,
          "branch movement does not mutate the selected exact source",
          { selected_commit: savedSource.payload.source_revision.resolved_commit },
        );
        const reread = await call(
          `/v1/projects/${immutable.graph.project.id}/compatibility-reports/${initialReport.id}`,
          { token: state.owner.token },
        );
        assertStatus(reread, 200, "immutable compatibility report read after branch movement");
        expectScenario(
          reread.payload.source_revision_id === initialReport.source_revision_id &&
            JSON.stringify(reread.payload.facts) === JSON.stringify(initialReport.facts),
          "branch movement leaves the compatibility report immutable",
          { report_immutable: false },
        );

        const bounded = projects.get(61006);
        const before = await reportCount(m2, bounded.graph.project.id, "m2-compat-bounds-before");
        const controls = [
          ["truncated tree", 422, "github_provider_limit_exceeded", "tree_read", () => fixture.controls.setTreeTruncated(true), () => fixture.controls.setTreeTruncated(false)],
          ["invalid blob encoding", 503, "github_provider_unavailable", "blob_read", () => fixture.controls.setInvalidBlobEncoding(true), () => fixture.controls.setInvalidBlobEncoding(false)],
          ["binary content where text is required", 422, "unsupported_github_source", "blob_read", () => fixtureMethod(fixture, "setBinaryBlob")(true), () => fixtureMethod(fixture, "setBinaryBlob")(false)],
          ["oversized source file", 422, "github_provider_limit_exceeded", "tree_read", () => fixture.controls.setOversize({ repositoryId: 61006, path: "package.json", bytes: 65 * 1024 }), () => fixture.controls.clearOversize()],
          ["provider rate limit", 503, "github_provider_unavailable", "injected_rate_limit", () => fixture.controls.setRateLimit({ path: "/repos/*", count: 1, retryAfterSeconds: 1 }), () => {}],
          ["provider timeout", 503, "github_provider_unavailable", "commit_read", () => fixture.controls.setTimeout({ path: "/repos/*", count: 1, delayMs: 5_500 }), () => {}],
          ["traversal tree entry", 422, "unsupported_github_source", "tree_read", () => fixtureMethod(fixture, "setExtraTreeEntries")([{ path: "../escape.ts", mode: "100644", type: "blob", sha: "e".repeat(40), size: 1 }]), () => fixtureMethod(fixture, "clearExtraTreeEntries")()],
          ["overlong tree path", 422, "unsupported_github_source", "tree_read", () => fixtureMethod(fixture, "setExtraTreeEntries")([{ path: `${"a".repeat(1_100)}.js`, mode: "100644", type: "blob", sha: "b".repeat(40), size: 1 }]), () => fixtureMethod(fixture, "clearExtraTreeEntries")()],
          ["symlink tree entry", 422, "unsupported_github_source", "tree_read", () => fixtureMethod(fixture, "setExtraTreeEntries")([{ path: "escape", mode: "120000", type: "blob", sha: "d".repeat(40), size: 8 }]), () => fixtureMethod(fixture, "clearExtraTreeEntries")()],
          ["submodule tree entry", 422, "unsupported_github_source", "tree_read", () => fixtureMethod(fixture, "setExtraTreeEntries")([{ path: "vendor/external", mode: "160000", type: "commit", sha: "c".repeat(40), size: 0 }]), () => fixtureMethod(fixture, "clearExtraTreeEntries")()],
          ["excessive allowlisted source files", 422, "github_provider_limit_exceeded", "tree_read", () => fixtureMethod(fixture, "setExtraTreeEntries")(
            Array.from({ length: 41 }, (_, index) => ({
              path: `extra-${String(index).padStart(2, "0")}.js`,
              mode: "100644",
              type: "blob",
              sha: (index + 1).toString(16).padStart(40, "0"),
              size: 1,
            })),
          ), () => fixtureMethod(fixture, "clearExtraTreeEntries")()],
          ["excessive aggregate source bytes", 422, "github_provider_limit_exceeded", "blob_read", () => fixtureMethod(fixture, "setExtraTreeEntries")(
            Array.from({ length: 9 }, (_, index) => ({
              path: `aggregate-${index}.js`,
              mode: "100644",
              type: "blob",
              sha: (index + 101).toString(16).padStart(40, "0"),
              content: "x".repeat(60 * 1024),
            })),
          ), () => fixtureMethod(fixture, "clearExtraTreeEntries")()],
          ["excessive tree entries", 422, "github_provider_limit_exceeded", "tree_read", () => fixtureMethod(fixture, "setExtraTreeEntries")(
            Array.from({ length: 2_001 }, (_, index) => ({
              path: `generated/file-${String(index).padStart(4, "0")}.txt`,
              mode: "100644",
              type: "blob",
              sha: index.toString(16).padStart(40, "0"),
              size: 1,
            })),
          ), () => fixtureMethod(fixture, "clearExtraTreeEntries")()],
          ["provider blob inconsistency", 422, "github_provider_limit_exceeded", "blob_read", () => fixtureMethod(fixture, "setBlobShaMismatch")(true), () => fixtureMethod(fixture, "setBlobShaMismatch")(false)],
        ];
        const failures = [];
        for (const [label, expectedStatus, expectedCode, expectedOutcome, enable, disable] of controls) {
          const observationStart = fixture.safeObservations().length;
          enable();
          try {
            const response = await analyze(m2, bounded, key(`bound-${label.replaceAll(" ", "-")}`));
            if (label === "provider timeout") await context.delay(750);
            const after = await reportCount(m2, bounded.graph.project.id, `m2-compat-bound-${label}-after`);
            expectRejectedWithoutReport(response, expectedStatus, expectedCode, before, after, label);
            const observations = fixture.safeObservations().slice(observationStart);
            expectScenario(
              observations.some(({ outcome }) => outcome === expectedOutcome),
              `${label}: provider fixture reached the injected source boundary`,
              { expected_provider_outcome: expectedOutcome, observed_outcomes: observations.map(({ outcome }) => outcome) },
            );
            failures.push({ case: label, status: response.status, error_code: response.payload.error.code });
          } finally {
            disable();
          }
        }
        const recovered = await analyze(m2, bounded, key("bounds-recovered"));
        const recoveredReport = assertSafeReport(m2, recovered, bounded, "configuration_needed", "bounded-source recovery analysis");
        retainedReports.push(recoveredReport);
        return {
          immutable_commit: immutable.source.source_revision.resolved_commit,
          moved_branch_commit: MOVED_COMMIT,
          bounded_rejections: failures,
          partial_reports_from_failures: 0,
          recovered_report_id: recoveredReport.id,
        };
      },
    );

    await compatibilityStep(
      context,
      "M2-COMPAT-02",
      "package lifecycle, build, start and migration scripts plus application modules remain inert; no child workload, sentinel file, outbound request, command output, entitlement, slot, deployment, job, secret, preview, or build debit is created",
      async () => {
        const sentinel = projects.get(61010);
        const before = await nonEffectCounts(m2, "m2-compat-no-execution-before");
        const observedChildren = new Map();
        let rootObservations = 0;
        let processSamples = 0;
        let sampling = true;
        const sampler = (async () => {
          while (sampling) {
            const sample = processDescendants(apiHandle.child.pid);
            processSamples += 1;
            if (sample.rootObserved) rootObservations += 1;
            for (const child of sample.descendants) observedChildren.set(child.pid, child.command);
            await context.delay(5);
          }
        })();
        let response;
        try {
          response = await analyze(m2, sentinel, key("execution-sentinel"));
          await context.delay(250);
        } finally {
          sampling = false;
          await sampler;
        }
        const report = assertSafeReport(m2, response, sentinel, "configuration_needed", "execution sentinel analysis");
        retainedReports.push(report);
        const after = await nonEffectCounts(m2, "m2-compat-no-execution-after");
        const files = existsSync(sentinelDirectory) ? readdirSync(sentinelDirectory).sort() : [];
        const expectedFiles = new Set(fixture.sentinels.expectedFiles);
        const expectedPaths = new Set(fixture.sentinels.expectedNetworkPaths);
        const childProcesses = [...observedChildren.entries()].map(([pid, command]) => ({ pid, command }));
        expectScenario(
          files.every((name) => !expectedFiles.has(name)) &&
            networkSink.paths.every((path) => !expectedPaths.has(path)) &&
            processSamples > 0 &&
            rootObservations === processSamples &&
            childProcesses.length === 0 &&
            JSON.stringify(after) === JSON.stringify(before),
          "compatibility inspection executes no repository code and creates no purchase or runtime effect",
          {
            sentinel_files: files,
            sentinel_network_paths: [...networkSink.paths],
            process_samples: processSamples,
            root_process_observations: rootObservations,
            observed_child_processes: childProcesses,
            durable_non_effects_unchanged: JSON.stringify(after) === JSON.stringify(before),
          },
        );
        return {
          report_id: report.id,
          sentinel_files_created: files.filter((name) => expectedFiles.has(name)).length,
          sentinel_network_requests: networkSink.paths.filter((path) => expectedPaths.has(path)).length,
          process_samples: processSamples,
          observed_child_processes: childProcesses.length,
          durable_non_effects_unchanged: true,
        };
      },
    );

    await compatibilityStep(
      context,
      "M2-COMPAT-03",
      "Vite, Node HTTP, Next.js standalone, PostgreSQL, environment, missing-lockfile and unsupported fixtures produce the five ordered advisory statuses; root case, exact versions, broad ranges, comments, strings and health paths cannot widen evidence",
      async () => {
        const cases = [
          [61001, "candidate"],
          [61002, "candidate"],
          [61003, "candidate"],
          [61004, "database_needed"],
          [61005, "secrets_needed"],
          [61007, "showcase_only"],
          [61008, "showcase_only"],
          [61009, "showcase_only"],
        ];
        const missingLockReport = retainedReports.find(
          (report) => report.project_id === projects.get(61006).graph.project.id,
        );
        const outcomes = [{
          repository_id: 61006,
          status: missingLockReport.status,
          reason_codes: missingLockReport.facts.reasons.map(({ code }) => code),
        }];
        for (const [repositoryId, status] of cases) {
          const project = projects.get(repositoryId);
          const response = await analyze(m2, project, key(`status-${repositoryId}`));
          const report = assertSafeReport(m2, response, project, status, `${project.label} advisory`);
          retainedReports.push(report);
          const reasonCodes = report.facts.reasons.map(({ code }) => code);
          expectScenario(
            project.repository.expectedReasons.every((code) => reasonCodes.includes(code)),
            `${project.label}: fixture reason codes are retained in deterministic safe facts`,
            { expected_reason_codes: project.repository.expectedReasons, observed_reason_codes: reasonCodes },
          );
          outcomes.push({ repository_id: repositoryId, status, reason_codes: reasonCodes });
        }
        const configuredDatabaseResponse = await analyze(m2, databaseConfigured, key("database-configured"));
        const configuredDatabaseReport = assertSafeReport(
          m2,
          configuredDatabaseResponse,
          databaseConfigured,
          "candidate",
          "PostgreSQL-configured application advisory",
        );
        retainedReports.push(configuredDatabaseReport);
        outcomes.push({ repository_id: 61004, configuration: "postgresql18", status: "candidate" });

        const injectedRegressionSources = [
          syntheticBlob(
            "cases/node-exact-22/package.json",
            JSON.stringify({
              name: "node-exact-22",
              private: true,
              scripts: { start: "node server.mjs" },
              engines: { node: "22.13.1" },
            }),
            1,
          ),
          syntheticBlob("cases/node-exact-22/package-lock.json", JSON.stringify({
            name: "node-exact-22", lockfileVersion: 3, packages: {},
          }), 2),
          syntheticBlob("cases/node-exact-22/hostlet.json", JSON.stringify({ healthPath: "/healthz" }), 3),
          syntheticBlob("cases/node-exact-22/server.mjs", "export const healthPath = '/healthz';\n", 4),
          syntheticBlob(
            "cases/node-broad-range/package.json",
            JSON.stringify({
              name: "node-broad-range",
              private: true,
              scripts: { start: "node server.mjs" },
              engines: { node: ">=22 <25" },
            }),
            5,
          ),
          syntheticBlob("cases/node-broad-range/package-lock.json", JSON.stringify({
            name: "node-broad-range", lockfileVersion: 3, packages: {},
          }), 6),
          syntheticBlob("cases/node-broad-range/hostlet.json", JSON.stringify({ healthPath: "/healthz" }), 7),
          syntheticBlob("cases/node-broad-range/server.mjs", "export const healthPath = '/healthz';\n", 8),
          syntheticBlob(
            "cases/next-version-160/package.json",
            JSON.stringify({
              name: "next-version-160",
              private: true,
              scripts: { build: "next build", start: "node .next/standalone/server.js" },
              dependencies: { next: "160.0.0" },
            }),
            9,
          ),
          syntheticBlob("cases/next-version-160/package-lock.json", JSON.stringify({
            name: "next-version-160", lockfileVersion: 3, packages: {},
          }), 10),
          syntheticBlob(
            "cases/next-version-160/next.config.mjs",
            "export default { output: 'standalone' };\n",
            11,
          ),
          syntheticBlob(
            "cases/next-version-160/app/api/health/route.ts",
            "export function GET() { return Response.json({ ok: true }); }\n",
            12,
          ),
          syntheticBlob(
            "cases/next-comment-only/package.json",
            JSON.stringify({
              name: "next-comment-only",
              private: true,
              scripts: { build: "next build", start: "node .next/standalone/server.js" },
              dependencies: { next: "16.0.0" },
            }),
            13,
          ),
          syntheticBlob("cases/next-comment-only/package-lock.json", JSON.stringify({
            name: "next-comment-only", lockfileVersion: 3, packages: {},
          }), 14),
          syntheticBlob(
            "cases/next-comment-only/next.config.mjs",
            "// output: 'standalone' is documentation only\nexport default {};\n",
            15,
          ),
          syntheticBlob(
            "cases/next-comment-only/app/api/health/route.ts",
            "export function GET() { return Response.json({ ok: true }); }\n",
            16,
          ),
          syntheticBlob(
            "cases/next-string-only/package.json",
            JSON.stringify({
              name: "next-string-only",
              private: true,
              scripts: { build: "next build", start: "node .next/standalone/server.js" },
              dependencies: { next: "16.0.0" },
            }),
            17,
          ),
          syntheticBlob("cases/next-string-only/package-lock.json", JSON.stringify({
            name: "next-string-only", lockfileVersion: 3, packages: {},
          }), 18),
          syntheticBlob(
            "cases/next-string-only/next.config.mjs",
            "const documentation = \"output: 'standalone'\";\nexport default { documentation };\n",
            19,
          ),
          syntheticBlob(
            "cases/next-string-only/app/api/health/route.ts",
            "export function GET() { return Response.json({ ok: true }); }\n",
            20,
          ),
          syntheticBlob(
            "cases/next-nested-standalone/package.json",
            JSON.stringify({
              name: "next-nested-standalone",
              private: true,
              scripts: { build: "next build", start: "node .next/standalone/server.js" },
              dependencies: { next: "16.0.0" },
            }),
            21,
          ),
          syntheticBlob("cases/next-nested-standalone/package-lock.json", JSON.stringify({
            name: "next-nested-standalone", lockfileVersion: 3, packages: {},
          }), 22),
          syntheticBlob(
            "cases/next-nested-standalone/next.config.mjs",
            "export default { experimental: { output: 'standalone' } };\n",
            23,
          ),
          syntheticBlob(
            "cases/next-nested-standalone/app/api/health/route.ts",
            "export function GET() { return Response.json({ ok: true }); }\n",
            24,
          ),
          syntheticBlob(
            "cases/next-unclosed-config/package.json",
            JSON.stringify({
              name: "next-unclosed-config",
              private: true,
              scripts: { build: "next build", start: "node .next/standalone/server.js" },
              dependencies: { next: "16.0.0" },
            }),
            25,
          ),
          syntheticBlob("cases/next-unclosed-config/package-lock.json", JSON.stringify({
            name: "next-unclosed-config", lockfileVersion: 3, packages: {},
          }), 26),
          syntheticBlob(
            "cases/next-unclosed-config/next.config.mjs",
            "export default { output: 'standalone'\n",
            27,
          ),
          syntheticBlob(
            "cases/next-unclosed-config/app/api/health/route.ts",
            "export function GET() { return Response.json({ ok: true }); }\n",
            28,
          ),
          syntheticBlob(
            "cases/next-uppercase-config/package.json",
            JSON.stringify({
              name: "next-uppercase-config",
              private: true,
              scripts: { build: "next build", start: "node .next/standalone/server.js" },
              dependencies: { next: "16.0.0" },
            }),
            29,
          ),
          syntheticBlob("cases/next-uppercase-config/package-lock.json", JSON.stringify({
            name: "next-uppercase-config", lockfileVersion: 3, packages: {},
          }), 30),
          syntheticBlob(
            "cases/next-uppercase-config/Next.Config.mjs",
            "export default { output: 'standalone' };\n",
            31,
          ),
          syntheticBlob(
            "cases/next-uppercase-config/app/api/health/route.ts",
            "export function GET() { return Response.json({ ok: true }); }\n",
            32,
          ),
          syntheticBlob(
            "cases/health-documentation-only/package.json",
            JSON.stringify({
              name: "health-documentation-only",
              private: true,
              scripts: { start: "node server.mjs" },
              engines: { node: "24.1.0" },
            }),
            33,
          ),
          syntheticBlob("cases/health-documentation-only/package-lock.json", JSON.stringify({
            name: "health-documentation-only", lockfileVersion: 3, packages: {},
          }), 34),
          syntheticBlob(
            "cases/health-documentation-only/server.mjs",
            "export const documentation = \"app.get('/healthz')\";\n",
            35,
          ),
          syntheticBlob(
            "cases/missing-start-target/package.json",
            JSON.stringify({
              name: "missing-start-target",
              private: true,
              scripts: { start: "node missing.mjs" },
              engines: { node: "24.1.0" },
            }),
            36,
          ),
          syntheticBlob("cases/missing-start-target/package-lock.json", JSON.stringify({
            name: "missing-start-target", lockfileVersion: 3, packages: {},
          }), 37),
          syntheticBlob(
            "cases/missing-start-target/hostlet.json",
            JSON.stringify({ healthPath: "/healthz" }),
            38,
          ),
        ];
        const regressionBatches = [
          {
            sources: injectedRegressionSources.slice(0, 20),
            cases: [
            [regressionProjects.rootCaseMismatch, "configuration_needed", ["service_root_missing"], ["nextjs_16_standalone"]],
            [regressionProjects.wrongHealthPath, "configuration_needed", ["health_endpoint_missing"], ["health_endpoint_declared"]],
            [regressionProjects.nodeExact22, "candidate", ["single_node_http_service", "health_endpoint_declared"], []],
            [regressionProjects.nodeExact22Mismatch, "configuration_needed", ["node_version_mismatch"], []],
            [regressionProjects.nodeBroadRange, "configuration_needed", ["node_version_ambiguous"], []],
            [regressionProjects.nextVersion160, "configuration_needed", ["nextjs_standalone_configuration_missing"], ["nextjs_16_standalone"]],
            [regressionProjects.nextCommentOnly, "configuration_needed", ["nextjs_standalone_configuration_missing"], ["nextjs_16_standalone"]],
            [regressionProjects.nextStringOnly, "configuration_needed", ["nextjs_standalone_configuration_missing"], ["nextjs_16_standalone"]],
            ],
          },
          {
            sources: injectedRegressionSources.slice(20),
            cases: [
            [regressionProjects.nextNestedStandalone, "configuration_needed", ["nextjs_standalone_configuration_missing"], ["nextjs_16_standalone"]],
            [regressionProjects.nextUnclosedConfig, "configuration_needed", ["nextjs_standalone_configuration_missing"], ["nextjs_16_standalone"]],
            [regressionProjects.nextUppercaseConfig, "configuration_needed", ["nextjs_standalone_configuration_missing"], ["nextjs_16_standalone"]],
            [regressionProjects.healthDocumentationOnly, "configuration_needed", ["health_endpoint_missing"], ["health_endpoint_declared"]],
            [regressionProjects.missingStartTarget, "configuration_needed", ["start_command_missing"], []],
            ],
          },
        ];
        for (const batch of regressionBatches) {
          fixtureMethod(fixture, "setExtraTreeEntries")(batch.sources);
          try {
            for (const [project, expectedStatus, expectedReasons, forbiddenReasons] of batch.cases) {
              const response = await analyze(m2, project, key(`regression-${project.label}`));
              const report = assertSafeReport(
                m2,
                response,
                project,
                expectedStatus,
                `${project.label} compatibility regression`,
              );
              const reasons = report.facts.reasons.map(({ code }) => code);
              expectScenario(
                expectedReasons.every((reason) => reasons.includes(reason)) &&
                  forbiddenReasons.every((reason) => !reasons.includes(reason)),
                `${project.label}: bounded evidence cannot be widened by case, version range, comment, or wrong-path text`,
                { expected_reason_codes: expectedReasons, observed_reason_codes: reasons },
              );
              if (project === regressionProjects.nodeExact22) {
                expectScenario(
                  report.facts.services.some(({ kind, node_major: nodeMajor }) =>
                    kind === "application" && nodeMajor === 22
                  ),
                  "exact Node 22.13.1 evidence agrees with the selected tested Node 22 runtime",
                  { services: report.facts.services },
                );
              }
              if (project === regressionProjects.nodeExact22Mismatch) {
                expectScenario(
                  report.facts.configuration_questions.some((question) =>
                    question.id === "service-0-node-major" &&
                    question.required === true &&
                    JSON.stringify(question.allowed_options) === JSON.stringify(["22"])
                  ),
                  "a selected Node 24 runtime cannot override exact source evidence for tested Node 22",
                  { configuration_questions: report.facts.configuration_questions },
                );
              }
              if (project === regressionProjects.missingStartTarget) {
                expectScenario(
                  report.facts.services.some(({ kind, start_command_present: startPresent }) =>
                    kind === "application" && startPresent === false
                  ),
                  "a direct Node start command targeting an absent source file is not accepted as runnable evidence",
                  { services: report.facts.services },
                );
              }
              retainedReports.push(report);
              outcomes.push({ regression: project.label, status: expectedStatus, reason_codes: reasons });
            }
          } finally {
            fixtureMethod(fixture, "clearExtraTreeEntries")();
          }
        }

        const missingLock = missingLockReport;
        expectScenario(
          missingLock.facts.configuration_questions.some(({ required }) => required === true) &&
            missingLock.facts.reasons.some(({ code }) => code === "lockfile_missing"),
          "missing lockfile produces a required safe configuration question",
          {
            required_question_count: missingLock.facts.configuration_questions.filter(({ required }) => required).length,
            reason_codes: missingLock.facts.reasons.map(({ code }) => code),
          },
        );
        const environmentReport = retainedReports.find((report) => report.project_id === projects.get(61005).graph.project.id);
        const environmentNames = environmentReport.facts.environment_requirements.map(({ name }) => name).sort();
        expectScenario(
          environmentNames.includes("VITE_PUBLIC_SITE_NAME") &&
            environmentNames.includes("SESSION_SIGNING_KEY") &&
            environmentNames.includes("EXTERNAL_API_TOKEN") &&
            environmentReport.facts.environment_requirements.some(
              ({ name, classification }) => name === "VITE_PUBLIC_SITE_NAME" && classification === "public_build_value",
            ) &&
            environmentReport.facts.environment_requirements.filter(
              ({ classification }) => classification === "server_secret",
            ).length === 2,
          "public build variable names stay distinct from unresolved server secret names",
          { environment_names: environmentNames, classifications_valid: false },
        );
        expectScenario(
          JSON.stringify([...new Set(outcomes.map(({ status }) => status))].sort()) ===
            JSON.stringify(Object.keys(HEADLINES).sort()),
          "supported fixtures exercise every ordered compatibility advisory status",
          { observed_statuses: [...new Set(outcomes.map(({ status }) => status))].sort() },
        );
        return {
          outcomes,
          advisory: "deployment_not_verified",
          deployment_verified_reports: retainedReports.filter(({ deployment_verified }) => deployment_verified).length,
          environment_values_retained: 0,
        };
      },
    );

    await compatibilityStep(
      context,
      "M2-COMPAT-04",
      "reports are owner-scoped, idempotent, immutable and exact-source/configuration bound; malformed, stale, mismatched, inactive and revoked requests fail without partial reports while private reads survive",
      async () => {
        const target = projects.get(61002);
        const original = retainedReports.find((report) => report.project_id === target.graph.project.id);
        const replayKey = key("idempotent");
        const first = await analyze(m2, target, replayKey);
        const firstReport = assertSafeReport(m2, first, target, "candidate", "idempotent report creation");
        retainedReports.push(firstReport);
        const replay = await analyze(m2, target, replayKey);
        assertStatus(replay, 201, "exact compatibility replay");
        expectScenario(replay.payload.id === firstReport.id, "exact compatibility replay returns the same report", {
          first_report_id: firstReport.id,
          replay_report_id: replay.payload?.id ?? null,
        });
        const changedReplay = await analyze(m2, target, replayKey, { sourceRevisionId: randomUUID() });
        assertErrorShape(changedReplay, 409, "changed compatibility idempotency replay");

        const latest = await call(
          `/v1/projects/${target.graph.project.id}/compatibility-reports/latest?source_revision_id=${encodeURIComponent(target.source.source_revision.id)}&configuration_revision_id=${encodeURIComponent(target.graph.configuration.id)}`,
          { token: state.owner.token },
        );
        assertStatus(latest, 200, "exact filtered latest compatibility report");
        expectScenario(
          latest.payload.id === firstReport.id || latest.payload.id === original.id,
          "latest report stays within the requested exact source and configuration tuple",
          { latest_report_id: latest.payload?.id ?? null },
        );
        const otherRead = await call(
          `/v1/projects/${target.graph.project.id}/compatibility-reports/${firstReport.id}`,
          { token: state.other.token },
        );
        assertErrorShape(otherRead, 404, "cross-owner compatibility report read");
        const malformed = await call(`/v1/projects/not-a-uuid/compatibility-reports/${firstReport.id}`, {
          token: state.owner.token,
        });
        expectScenario(malformed.status >= 400 && malformed.status < 500, "malformed compatibility identifier is rejected", {
          status: malformed.status,
        });

        const beforeFailures = await reportCount(m2, target.graph.project.id, "m2-compat-freshness-before");
        const stale = await m2.call(`/v1/projects/${target.graph.project.id}/compatibility-reports`, {
          method: "POST",
          token: state.owner.token,
          headers: mutationHeaders(key("stale-project"), target.graph.project.revision - 1),
          body: {
            source_revision_id: target.source.source_revision.id,
            configuration_revision_id: target.graph.configuration.id,
          },
        });
        assertErrorShape(stale, 412, "stale project revision compatibility request");
        const mismatched = await analyze(m2, target, key("mismatched-source"), {
          sourceRevisionId: projects.get(61003).source.source_revision.id,
        });
        expectScenario(mismatched.status >= 400 && mismatched.status < 500, "cross-project source/configuration pair is rejected", {
          status: mismatched.status,
        });
        const afterFailures = await reportCount(m2, target.graph.project.id, "m2-compat-freshness-after");
        expectScenario(afterFailures === beforeFailures, "stale and mismatched requests create no report", {
          reports_before: beforeFailures,
          reports_after: afterFailures,
        });

        const configurationTarget = projects.get(61009);
        const changedConfiguration = await call(
          `/v1/projects/${configurationTarget.graph.project.id}/configuration-revisions`,
          {
            method: "POST",
            token: state.owner.token,
            headers: mutationHeaders(key("configuration-change"), configurationTarget.graph.project.revision),
            body: { configuration: configurationTarget.configuration },
          },
        );
        assertStatus(changedConfiguration, 201, "compatibility freshness configuration revision");
        const staleConfigurationBefore = await reportCount(
          m2,
          configurationTarget.graph.project.id,
          "m2-compat-stale-configuration-before",
        );
        const staleConfiguration = await m2.call(
          `/v1/projects/${configurationTarget.graph.project.id}/compatibility-reports`,
          {
            method: "POST",
            token: state.owner.token,
            headers: mutationHeaders(key("stale-configuration"), changedConfiguration.payload.project.revision),
            body: {
              source_revision_id: configurationTarget.source.source_revision.id,
              configuration_revision_id: configurationTarget.graph.configuration.id,
            },
          },
        );
        assertErrorShape(staleConfiguration, 409, "stale compatibility source/configuration pairing");
        expectScenario(
          new Set(["github_source_configuration_stale", "compatibility_configuration_stale", "compatibility_source_stale"])
            .has(staleConfiguration.payload.error.code),
          "configuration change returns a stable stale-source or stale-configuration reason",
          { error_code: staleConfiguration.payload.error.code },
        );
        const staleConfigurationAfter = await reportCount(
          m2,
          configurationTarget.graph.project.id,
          "m2-compat-stale-configuration-after",
        );
        expectScenario(
          staleConfigurationAfter === staleConfigurationBefore,
          "configuration freshness rejection creates no partial report",
          { reports_before: staleConfigurationBefore, reports_after: staleConfigurationAfter },
        );
        const oldConfigurationReport = retainedReports.find(
          ({ project_id }) => project_id === configurationTarget.graph.project.id,
        );
        const oldConfigurationRead = await call(
          `/v1/projects/${configurationTarget.graph.project.id}/compatibility-reports/${oldConfigurationReport.id}`,
          { token: state.owner.token },
        );
        assertStatus(oldConfigurationRead, 200, "immutable old-configuration compatibility report read");

        const concurrentTarget = await createBoundProject(
          m2,
          ++sequence,
          repository(61002),
          applicationSpec(apiTemplate),
          "concurrent-analysis-probe",
        );
        const [concurrentA, concurrentB] = await Promise.all([
          analyze(m2, concurrentTarget, key("concurrent-a")),
          analyze(m2, concurrentTarget, key("concurrent-b")),
        ]);
        const concurrentReport = assertSafeReport(
          m2,
          concurrentA,
          concurrentTarget,
          "candidate",
          "first concurrent identical analysis",
        );
        assertStatus(concurrentB, 201, "second concurrent identical analysis");
        expectScenario(
          concurrentB.payload.id === concurrentReport.id &&
            await reportCount(m2, concurrentTarget.graph.project.id, "m2-compat-concurrent-count") === 1,
          "concurrent identical analysis converges on one immutable report",
          { first_report_id: concurrentReport.id, second_report_id: concurrentB.payload?.id ?? null },
        );
        retainedReports.push(concurrentReport);

        const revokedTarget = await createBoundProject(
          m2,
          ++sequence,
          repository(61002),
          applicationSpec(apiTemplate),
          "revoked-authorization-probe",
        );
        fixture.controls.revokeUserTokens();
        const revokedBefore = await reportCount(m2, revokedTarget.graph.project.id, "m2-compat-revoked-before");
        const revoked = await analyze(m2, revokedTarget, key("revoked-provider"));
        expectScenario(revoked.status >= 400 && revoked.status < 500, "revoked provider authorization fails closed", {
          status: revoked.status,
        });
        const revokedAfter = await reportCount(m2, revokedTarget.graph.project.id, "m2-compat-revoked-after");
        expectScenario(revokedAfter === revokedBefore, "revoked provider authorization creates no report", {
          reports_before: revokedBefore,
          reports_after: revokedAfter,
        });
        const preserved = await call(
          `/v1/projects/${target.graph.project.id}/compatibility-reports/${firstReport.id}`,
          { token: state.owner.token },
        );
        assertStatus(preserved, 200, "private compatibility report preserved after provider revocation");
        await reconnectOwner(m2);

        const durableRows = await reportRows(
          m2,
          [...new Set(retainedReports.map(({ id }) => id))],
          "m2-compat-durable-reports",
        );
        expectScenario(
          durableRows.length === new Set(retainedReports.map(({ id }) => id)).size &&
            durableRows.every(({ advisory }) => advisory === "deployment_not_verified"),
          "every retained compatibility report is complete and immutable in PostgreSQL",
          { retained_report_count: durableRows.length, expected_report_count: retainedReports.length },
        );
        fixture.controls.assertNoUnexpectedRequests();
        state.compatibility = Object.freeze({
          reports: Object.freeze(retainedReports.map((report) => Object.freeze({
            id: report.id,
            projectId: report.project_id,
            configurationRevisionId: report.configuration_revision_id,
            sourceRevisionId: report.source_revision_id,
            status: report.status,
          }))),
          projects: Object.freeze(Object.fromEntries([...projects.entries()].map(([id, project]) => [id, project]))),
        });
        const restoredExpected = durableRows;
        state.restoreReadChecks.push({
          name: "immutable compatibility reports and exact source/configuration relationships",
          run: async (restored) => {
            const rows = await reportRows(
              restored,
              restoredExpected.map(({ id }) => id),
              "m2-restored-compatibility-reports",
              restored.postgres.recoveryDatabaseName,
            );
            expectScenario(
              JSON.stringify(rows) === JSON.stringify(restoredExpected),
              "restored compatibility reports retain exact immutable safe facts and digests",
              { expected_report_count: restoredExpected.length, restored_report_count: rows.length },
            );
          },
        });
        context.state.productOutputs.m2Compatibility = {
          reportCount: durableRows.length,
          statuses: [...new Set(durableRows.map(({ status }) => status))].sort(),
          retainedPrivateSourceBodies: 0,
          retainedCredentialValues: 0,
          deploymentVerifiedReports: 0,
        };
        return {
          durable_reports: durableRows.length,
          exact_replay_same_report: true,
          changed_replay_rejected: true,
          cross_owner_read_rejected: true,
          stale_and_mismatched_partial_reports: 0,
          revoked_partial_reports: 0,
          preserved_private_report_after_revocation: true,
        };
      },
    );
    completed = true;
  } finally {
    delete m2.extraEnvironment[fixture.sentinels.directoryEnvironment];
    delete m2.extraEnvironment[fixture.sentinels.networkEnvironment];
    try {
      if (completed) await switchApi(currentApiBinary, "M2 compatibility sentinel environment cleanup");
    } finally {
      await networkSink.close();
    }
  }
}
