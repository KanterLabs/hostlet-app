import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  assertErrorShape,
  assertStatus,
  expectScenario,
  ScenarioExpectationError,
} from "../support/http-client.mjs";

export const GRAPH_REQUIRED_ASSERTIONS = Object.freeze([
  "M1-CONTRACT-01",
  "M1-CONTRACT-02",
  "M1-GRAPH-01",
  "M1-GRAPH-02",
  "M1-GRAPH-03",
  "M1-GRAPH-04",
  "M1-GRAPH-05",
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function readJson(repo, path) {
  return JSON.parse(readFileSync(join(repo, path), "utf8"));
}

function clone(value) {
  return structuredClone(value);
}

function ifMatch(revision) {
  return `"${revision}"`;
}

function mutationHeaders(key, revision) {
  return { "Idempotency-Key": key, "If-Match": ifMatch(revision) };
}

function createHeaders(key) {
  return { "Idempotency-Key": key };
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function safeObserved(error) {
  if (error instanceof ScenarioExpectationError) return error.observed;
  return { failed_checks: 1 };
}

async function graphStep(context, id, expected, run) {
  try {
    const observed = await run();
    context.assertion(id, "M1 project graph and typed portfolio persistence", expected, observed, true);
    return observed;
  } catch (error) {
    context.assertion(
      id,
      "M1 project graph and typed portfolio persistence",
      expected,
      safeObserved(error),
      false,
      error instanceof ScenarioExpectationError ? error.check : "scenario setup or process boundary failed",
    );
    throw error;
  }
}

function assertProjectRecord(project, ownerId, check) {
  expectScenario(
    UUID.test(project?.id ?? "") &&
      project.owner_account_id === ownerId &&
      typeof project.name === "string" &&
      typeof project.mode === "string" &&
      Number.isInteger(project.revision) &&
      project.revision > 0 &&
      Number.isInteger(project.slot?.hosted_slots) &&
      typeof project.slot?.state === "string",
    check,
    { project_shape_valid: false },
  );
}

function assertGraph(payload, ownerId, check) {
  assertProjectRecord(payload?.project, ownerId, `${check}: project record`);
  expectScenario(
    UUID.test(payload?.configuration?.id ?? "") &&
      payload.configuration.project_id === payload.project.id &&
      Number.isInteger(payload.configuration.revision) &&
      payload.configuration.revision > 0 &&
      payload.configuration.spec?.contract_version === "hostlet.project/v1" &&
      Array.isArray(payload.repositories) &&
      payload.repositories.length === 1 &&
      payload.repositories.every(
        (record) => UUID.test(record?.id ?? "") && record.project_id === payload.project.id,
      ) &&
      Array.isArray(payload.services) &&
      payload.services.every(
        (record) => UUID.test(record?.id ?? "") && record.project_id === payload.project.id,
      ),
    `${check}: configuration, repository, and service graph`,
    { graph_shape_valid: false },
  );
}

function assertEmptyRelease(deployment, projectId, configurationId, check) {
  expectScenario(
    UUID.test(deployment?.id ?? "") &&
      deployment.project_id === projectId &&
      deployment.configuration_revision_id === configurationId &&
      deployment.lifecycle === "admission_required" &&
      deployment.release?.static_artifact === null &&
      deployment.release?.application_artifact === null &&
      deployment.release?.health_result_ref === null &&
      deployment.release?.database_migration_revision === null &&
      Array.isArray(deployment.release?.secret_version_refs) &&
      deployment.release.secret_version_refs.length === 0,
    check,
    { deployment_shape_valid: false },
  );
}

function assertValidation(response, topCode, expectedCodes, check) {
  assertErrorShape(response, 422, check);
  const issues = response.payload?.error?.details?.issues;
  expectScenario(
    response.payload.error.code === topCode &&
      Array.isArray(issues) &&
      JSON.stringify(issues.map((issue) => issue.code)) === JSON.stringify(expectedCodes) &&
      issues.every(
        (issue) =>
          typeof issue.path === "string" &&
          typeof issue.message === "string" &&
          issue.message.length > 0,
      ),
    `${check}: ordered validation issues`,
    { status: response.status, issue_codes: issues?.map((issue) => issue.code) ?? [] },
  );
}

function assertConflictCode(response, code, check) {
  assertErrorShape(response, 409, check);
  expectScenario(response.payload.error.code === code, `${check}: stable error code`, {
    error_code: response.payload.error.code,
  });
}

function adaptPortfolioDraft(rawDraft, hostedProjectId) {
  const draft = clone(rawDraft);
  for (const project of draft.projects) {
    if (project.kind.type === "hosted_project") project.kind.project_id = hostedProjectId;
    project.authorized_deployment_facts_id = null;
    project.displayed_status = {
      deployment_timestamp: false,
      availability: false,
      release_identifier: false,
      source_commit: false,
      demo_readiness: false,
    };
    project.demo_readiness = {
      state: "needs_recheck",
      previous_attestation: null,
      reason: "never_checked",
    };
  }
  return draft;
}

function mutateAtPath(value, dottedPath, replacement) {
  const segments = dottedPath.replaceAll("[", ".").replaceAll("]", "").split(".");
  let target = value;
  for (const segment of segments.slice(0, -1)) target = target[segment];
  target[segments.at(-1)] = replacement;
}

export function registerGraphFixtures(context) {
  const manifest = readJson(context.repo, "e2e/support/graph-fixtures.json");
  context.registerFixture("M1 graph scenario module", "e2e/scenarios/graph.mjs");
  context.registerFixture("M1 graph scenario inventory", "e2e/support/graph-fixtures.json");
  for (const fixture of manifest.project_contract.positive) {
    context.registerFixture(`M1 project positive contract: ${fixture.path}`, fixture.path);
  }
  for (const fixture of manifest.project_contract.negative) {
    context.registerFixture(`M1 project negative contract: ${fixture.path}`, fixture.path);
    context.registerFixture(`M1 project expected issues: ${fixture.expected_path}`, fixture.expected_path);
  }
  for (const [name, path] of Object.entries(manifest.portfolio_contract)) {
    context.registerFixture(`M1 portfolio contract ${name}`, path);
  }
  return manifest;
}

export async function runGraphScenarios({
  context,
  manifest,
  postgres,
  call,
  restartApi,
  owner,
  other,
}) {
  expectScenario(manifest.schema_version === 1, "graph fixture schema version", {
    fixture_schema_version: manifest.schema_version,
  });

  const state = {
    ownerGraphs: new Map(),
    mainGraph: null,
    initialConfiguration: null,
    replayedRename: null,
    otherGraph: null,
    deploymentOne: null,
    deploymentTwo: null,
    portfolio: null,
    acceptedDraft: null,
  };

  await graphStep(
    context,
    "M1-CONTRACT-01",
    "normal project creation accepts the three supported project shapes and rejects every prewritten invalid fixture with its ordered issue codes",
    async () => {
      const positives = manifest.project_contract.positive.map((fixture) => ({
        fixture,
        configuration: readJson(context.repo, fixture.path),
      }));
      const standardBody = { name: positives[0].fixture.name, configuration: positives[0].configuration };
      const duplicateCreates = await Promise.all([
        call("/v1/projects", {
          method: "POST",
          token: owner.token,
          headers: createHeaders(positives[0].fixture.idempotency_key),
          body: standardBody,
        }),
        call("/v1/projects", {
          method: "POST",
          token: owner.token,
          headers: createHeaders(positives[0].fixture.idempotency_key),
          body: standardBody,
        }),
      ]);
      expectScenario(
        duplicateCreates.every(({ status }) => status === 201),
        "concurrent same-key project creation replay statuses",
        { statuses: duplicateCreates.map(({ status }) => status) },
      );
      duplicateCreates.forEach(({ payload }) => assertGraph(payload, owner.record.id, "standard project"));
      expectScenario(
        JSON.stringify(duplicateCreates[0].payload) === JSON.stringify(duplicateCreates[1].payload),
        "concurrent same-key project creation returns one stable graph",
        { stable_graphs: false },
      );
      state.mainGraph = duplicateCreates[0].payload;
      state.initialConfiguration = clone(state.mainGraph);
      state.ownerGraphs.set("standard", state.mainGraph);

      for (const positive of positives.slice(1)) {
        const response = await call("/v1/projects", {
          method: "POST",
          token: owner.token,
          headers: createHeaders(positive.fixture.idempotency_key),
          body: { name: positive.fixture.name, configuration: positive.configuration },
        });
        assertStatus(response, 201, `${positive.fixture.name} creation`);
        assertGraph(response.payload, owner.record.id, positive.fixture.name);
        state.ownerGraphs.set(positive.configuration.services[0].kind, response.payload);
      }

      const otherConfiguration = readJson(context.repo, positives[1].fixture.path);
      const otherCreate = await call("/v1/projects", {
        method: "POST",
        token: other.token,
        headers: createHeaders("m1-graph-other-project"),
        body: { name: "Other owner fixture project", configuration: otherConfiguration },
      });
      assertStatus(otherCreate, 201, "other owner project fixture");
      assertGraph(otherCreate.payload, other.record.id, "other owner project fixture");
      state.otherGraph = otherCreate.payload;

      const rejectedCodes = [];
      for (const negative of manifest.project_contract.negative) {
        const expected = readJson(context.repo, negative.expected_path).expected_issue_codes;
        const response = await call("/v1/projects", {
          method: "POST",
          token: owner.token,
          headers: createHeaders(negative.idempotency_key),
          body: { name: negative.name, configuration: readJson(context.repo, negative.path) },
        });
        assertValidation(response, "invalid_project_configuration", expected, negative.name);
        rejectedCodes.push(...expected);
      }

      const counts = await postgres.psqlJson(
        "contract-project-counts",
        `SELECT json_build_object(
           'projects', (SELECT COUNT(*)::int FROM projects),
           'configurations', (SELECT COUNT(*)::int FROM configuration_revisions),
           'repositories', (SELECT COUNT(*)::int FROM repositories),
           'services', (SELECT COUNT(*)::int FROM services)
         );`,
      );
      expectScenario(counts.projects === 4 && counts.configurations === 4, "invalid fixtures create no project rows", counts);
      expectScenario(
        state.mainGraph.project.slot.hosted_slots === 0 && state.mainGraph.project.slot.state === "no_slot",
        "draft project consumes no hosted slot",
        { hosted_slots: state.mainGraph.project.slot.hosted_slots, slot_state: state.mainGraph.project.slot.state },
      );
      return {
        accepted_project_shapes: 3,
        same_key_create_statuses: duplicateCreates.map(({ status }) => status),
        rejected_fixture_count: manifest.project_contract.negative.length,
        ordered_issue_code_count: rejectedCodes.length,
        persisted_project_rows: counts.projects,
        draft_hosted_slots: 0,
      };
    },
  );

  await graphStep(
    context,
    "M1-GRAPH-01",
    "owner-scoped HTTP returns a durable project, immutable configuration snapshot, repository, typed services, and admission-required deployment with independently verified references",
    async () => {
      const projectId = state.mainGraph.project.id;
      const initialConfigId = state.mainGraph.configuration.id;
      const read = await call(`/v1/projects/${projectId}`, { token: owner.token });
      assertStatus(read, 200, "project graph read");
      assertGraph(read.payload, owner.record.id, "project graph read");

      const revisedSpec = clone(state.mainGraph.configuration.spec);
      revisedSpec.services.find((service) => service.kind === "static_frontend").build_command =
        "npm run build:e2e";
      const configurationRequest = {
        method: "POST",
        token: owner.token,
        headers: mutationHeaders("m1-graph-configuration-two", read.payload.project.revision),
        body: { configuration: revisedSpec },
      };
      const revisedReplays = await Promise.all([
        call(`/v1/projects/${projectId}/configuration-revisions`, configurationRequest),
        call(`/v1/projects/${projectId}/configuration-revisions`, configurationRequest),
      ]);
      expectScenario(
        revisedReplays.every(({ status }) => status === 201) &&
          JSON.stringify(revisedReplays[0].payload) === JSON.stringify(revisedReplays[1].payload),
        "concurrent same-key configuration creation returns one stable snapshot",
        { statuses: revisedReplays.map(({ status }) => status), stable_results: false },
      );
      const revised = revisedReplays[0];
      assertStatus(revised, 201, "configuration revision creation");
      assertGraph(revised.payload, owner.record.id, "configuration revision creation");
      expectScenario(
        revised.payload.configuration.id !== initialConfigId &&
          revised.payload.configuration.revision === state.mainGraph.configuration.revision + 1 &&
          revised.payload.project.revision === read.payload.project.revision + 1,
        "new configuration and project revisions advance once",
        { configuration_revision_advanced: false, project_revision_advanced: false },
      );
      state.mainGraph = revised.payload;

      const oldConfig = await call(
        `/v1/projects/${projectId}/configuration-revisions/${initialConfigId}`,
        { token: owner.token },
      );
      assertStatus(oldConfig, 200, "immutable prior configuration read");
      expectScenario(
        oldConfig.payload?.configuration?.id === initialConfigId &&
          oldConfig.payload.configuration.spec.services.find((service) => service.kind === "static_frontend")
            .build_command !== "npm run build:e2e",
        "prior configuration snapshot remains immutable",
        { immutable_snapshot: false },
      );

      const services = await call(`/v1/projects/${projectId}/services`, { token: owner.token });
      assertStatus(services, 200, "current services list");
      expectScenario(
        JSON.stringify(services.payload?.services) === JSON.stringify(state.mainGraph.services),
        "current services match configuration graph",
        { services_match: false },
      );
      for (const service of state.mainGraph.services) {
        const serviceRead = await call(`/v1/projects/${projectId}/services/${service.id}`, {
          token: owner.token,
        });
        assertStatus(serviceRead, 200, "typed service read");
        expectScenario(
          JSON.stringify(serviceRead.payload) === JSON.stringify(service),
          "typed service read is stable",
          { stable_service: false },
        );
      }

      const deploymentRequest = {
        method: "POST",
        token: owner.token,
        headers: mutationHeaders("m1-graph-deployment-one", state.mainGraph.project.revision),
        body: {
          configuration_revision_id: state.mainGraph.configuration.id,
          source_commit: manifest.graph.source_commit,
        },
      };
      const deploymentReplays = await Promise.all([
        call(`/v1/projects/${projectId}/deployment-intents`, deploymentRequest),
        call(`/v1/projects/${projectId}/deployment-intents`, deploymentRequest),
      ]);
      expectScenario(
        deploymentReplays.every(({ status }) => status === 201) &&
          JSON.stringify(deploymentReplays[0].payload) === JSON.stringify(deploymentReplays[1].payload),
        "concurrent same-key deployment creation returns one stable snapshot",
        { statuses: deploymentReplays.map(({ status }) => status), stable_results: false },
      );
      const deployment = deploymentReplays[0];
      assertStatus(deployment, 201, "first deployment intent");
      assertEmptyRelease(
        deployment.payload,
        projectId,
        state.mainGraph.configuration.id,
        "first deployment intent has no observed release facts",
      );
      state.deploymentOne = deployment.payload;
      const afterIntent = await call(`/v1/projects/${projectId}`, { token: owner.token });
      assertStatus(afterIntent, 200, "project after deployment intent");
      assertGraph(afterIntent.payload, owner.record.id, "project after deployment intent");
      expectScenario(
        afterIntent.payload.project.mode === "deployment_intent" &&
          afterIntent.payload.project.slot.hosted_slots === 0 &&
          afterIntent.payload.project.slot.state === "admission_required",
        "M1 deployment intent requires admission and allocates no slot",
        {
          mode: afterIntent.payload.project.mode,
          hosted_slots: afterIntent.payload.project.slot.hosted_slots,
          slot_state: afterIntent.payload.project.slot.state,
        },
      );
      state.mainGraph = afterIntent.payload;

      const duplicateAdmission = await call(`/v1/projects/${projectId}/deployment-intents`, {
        method: "POST",
        token: owner.token,
        headers: mutationHeaders("m1-graph-deployment-before-admission", state.mainGraph.project.revision),
        body: {
          configuration_revision_id: state.mainGraph.configuration.id,
          source_commit: "abcdef0123456789abcdef0123456789abcdef01",
        },
      });
      assertConflictCode(
        duplicateAdmission,
        "deployment_intent_pending",
        "distinct deployment while admission is pending",
      );

      const deploymentRead = await call(
        `/v1/projects/${projectId}/deployments/${state.deploymentOne.id}`,
        { token: owner.token },
      );
      assertStatus(deploymentRead, 200, "deployment snapshot read");
      expectScenario(
        JSON.stringify(deploymentRead.payload) === JSON.stringify(state.deploymentOne),
        "deployment snapshot read is stable",
        { stable_deployment: false },
      );

      const sql = await postgres.psqlJson(
        "graph-owner-references",
        `SELECT json_build_object(
           'project_owner_rows', (SELECT COUNT(*)::int FROM projects WHERE id = ${sqlString(projectId)} AND account_id = ${sqlString(owner.record.id)}),
           'configuration_owner_rows', (SELECT COUNT(*)::int FROM configuration_revisions WHERE project_id = ${sqlString(projectId)} AND account_id = ${sqlString(owner.record.id)}),
           'repository_snapshot_rows', (SELECT COUNT(*)::int FROM repository_configurations WHERE project_id = ${sqlString(projectId)}),
           'service_snapshot_rows', (SELECT COUNT(*)::int FROM service_configurations WHERE project_id = ${sqlString(projectId)}),
           'deployment_reference_rows', (SELECT COUNT(*)::int FROM deployments WHERE id = ${sqlString(state.deploymentOne.id)} AND project_id = ${sqlString(projectId)} AND configuration_revision_id = ${sqlString(state.mainGraph.configuration.id)}),
           'project_deployment_rows', (SELECT COUNT(*)::int FROM deployments WHERE project_id = ${sqlString(projectId)}),
           'orphan_service_snapshots', (SELECT COUNT(*)::int FROM service_configurations sc LEFT JOIN configuration_revisions cr ON cr.account_id=sc.account_id AND cr.project_id=sc.project_id AND cr.id=sc.configuration_revision_id WHERE cr.id IS NULL)
         );`,
      );
      expectScenario(
        sql.project_owner_rows === 1 &&
          sql.configuration_owner_rows === 2 &&
          sql.repository_snapshot_rows === 2 &&
          sql.service_snapshot_rows === state.mainGraph.services.length * 2 &&
          sql.deployment_reference_rows === 1 &&
          sql.project_deployment_rows === 1 &&
          sql.orphan_service_snapshots === 0,
        "independent project graph ownership and reference SQL",
        sql,
      );
      return {
        project_read_status: read.status,
        configuration_revisions: sql.configuration_owner_rows,
        typed_service_count: state.mainGraph.services.length,
        deployment_read_status: deploymentRead.status,
        deployment_lifecycle: deploymentRead.payload.lifecycle,
        configuration_replay_statuses: revisedReplays.map(({ status }) => status),
        deployment_replay_statuses: deploymentReplays.map(({ status }) => status),
        pending_admission_status: duplicateAdmission.status,
        hosted_slots: state.mainGraph.project.slot.hosted_slots,
        orphan_service_snapshots: sql.orphan_service_snapshots,
      };
    },
  );

  await graphStep(
    context,
    "M1-GRAPH-02",
    "same-key concurrent project updates replay one result, changed payload reuse conflicts, and distinct keys at one revision commit one winner while the stale write fails",
    async () => {
      const projectId = state.mainGraph.project.id;
      const replayRevision = state.mainGraph.project.revision;
      const replayBody = { name: manifest.graph.renamed_project };
      const replayed = await Promise.all([
        call(`/v1/projects/${projectId}`, {
          method: "PATCH",
          token: owner.token,
          headers: mutationHeaders("m1-graph-project-rename", replayRevision),
          body: replayBody,
        }),
        call(`/v1/projects/${projectId}`, {
          method: "PATCH",
          token: owner.token,
          headers: mutationHeaders("m1-graph-project-rename", replayRevision),
          body: replayBody,
        }),
      ]);
      expectScenario(replayed.every(({ status }) => status === 200), "same-key project update statuses", {
        statuses: replayed.map(({ status }) => status),
      });
      replayed.forEach(({ payload }) => assertGraph(payload, owner.record.id, "same-key project update"));
      expectScenario(
        JSON.stringify(replayed[0].payload) === JSON.stringify(replayed[1].payload) &&
          replayed[0].payload.project.revision === replayRevision + 1,
        "same-key project update commits one stable revision",
        { stable_results: false },
      );
      state.replayedRename = clone(replayed[0].payload);
      state.mainGraph = replayed[0].payload;

      const changed = await call(`/v1/projects/${projectId}`, {
        method: "PATCH",
        token: owner.token,
        headers: mutationHeaders("m1-graph-project-rename", replayRevision),
        body: { name: "Changed replay must fail" },
      });
      assertErrorShape(changed, 409, "changed-payload project replay");

      const contenderRevision = state.mainGraph.project.revision;
      const contenders = await Promise.all([
        call(`/v1/projects/${projectId}`, {
          method: "PATCH",
          token: owner.token,
          headers: mutationHeaders("m1-graph-contender-a", contenderRevision),
          body: { name: manifest.graph.contender_a },
        }),
        call(`/v1/projects/${projectId}`, {
          method: "PATCH",
          token: owner.token,
          headers: mutationHeaders("m1-graph-contender-b", contenderRevision),
          body: { name: manifest.graph.contender_b },
        }),
      ]);
      const statuses = contenders.map(({ status }) => status).sort((a, b) => a - b);
      expectScenario(JSON.stringify(statuses) === JSON.stringify([200, 412]), "distinct-key revision contention", {
        statuses,
      });
      const winner = contenders.find(({ status }) => status === 200);
      const loser = contenders.find(({ status }) => status === 412);
      assertGraph(winner.payload, owner.record.id, "project contention winner");
      assertErrorShape(loser, 412, "project contention stale loser");
      state.mainGraph = winner.payload;
      const committed = await call(`/v1/projects/${projectId}`, { token: owner.token });
      assertStatus(committed, 200, "committed project after contention");
      expectScenario(
        committed.payload.project.revision === state.mainGraph.project.revision &&
          committed.payload.project.name === state.mainGraph.project.name,
        "one contender commits without a lost update",
        { committed_rows: 0 },
      );
      return {
        replay_statuses: replayed.map(({ status }) => status),
        replayed_project_revision: state.replayedRename.project.revision,
        changed_payload_status: changed.status,
        contender_statuses: statuses,
        committed_project_rows: 1,
      };
    },
  );

  await graphStep(
    context,
    "M1-CONTRACT-02",
    "the normal owner-scoped route persists the typed portfolio draft boundary, rejects unavailable deployment facts, unverified readiness, and unsafe URLs, and consumes no hosted slot",
    async () => {
      const rawDraft = readJson(context.repo, manifest.portfolio_contract.draft_path);
      const adapted = adaptPortfolioDraft(rawDraft, state.mainGraph.project.id);
      const slotsBefore = await postgres.psqlJson(
        "portfolio-slots-before",
        `SELECT json_build_object('hosted_slots', COALESCE(SUM(hosted_slots),0)::int) FROM projects;`,
      );

      const factsDraft = clone(adapted);
      factsDraft.projects[0].authorized_deployment_facts_id = "facts-e2e-unavailable";
      const facts = await call("/v1/portfolio/draft-revisions", {
        method: "POST",
        token: owner.token,
        headers: createHeaders("m1-contract-portfolio-facts"),
        body: { draft: factsDraft },
      });
      assertValidation(facts, "invalid_portfolio_draft", ["unauthorized_deployment_facts"], "unavailable deployment facts");

      const missingFactsDraft = clone(adapted);
      missingFactsDraft.projects[0].displayed_status.deployment_timestamp = true;
      const missingFacts = await call("/v1/portfolio/draft-revisions", {
        method: "POST",
        token: owner.token,
        headers: createHeaders("m1-contract-portfolio-missing-facts"),
        body: { draft: missingFactsDraft },
      });
      assertValidation(
        missingFacts,
        "invalid_portfolio_draft",
        ["missing_authorized_facts"],
        "displayed deployment status without authorized facts",
      );

      const readinessDraft = clone(adapted);
      readinessDraft.projects[0].demo_readiness = clone(rawDraft.projects[0].demo_readiness);
      const readiness = await call("/v1/portfolio/draft-revisions", {
        method: "POST",
        token: owner.token,
        headers: createHeaders("m1-contract-portfolio-readiness"),
        body: { draft: readinessDraft },
      });
      assertValidation(readiness, "invalid_portfolio_draft", ["readiness_unverified"], "unverified ready-to-share claim");

      const urlScenario = readJson(context.repo, manifest.portfolio_contract.negative_url_path);
      const unsafeDraft = clone(adapted);
      mutateAtPath(unsafeDraft, urlScenario.mutation.path, urlScenario.mutation.value);
      const unsafe = await call("/v1/portfolio/draft-revisions", {
        method: "POST",
        token: owner.token,
        headers: createHeaders("m1-contract-portfolio-unsafe-url"),
        body: { draft: unsafeDraft },
      });
      assertValidation(unsafe, "invalid_portfolio_draft", [urlScenario.expected.code], "unsafe portfolio URL");

      const accepted = await call("/v1/portfolio/draft-revisions", {
        method: "POST",
        token: owner.token,
        headers: createHeaders("m1-contract-portfolio-accepted"),
        body: { draft: adapted },
      });
      assertStatus(accepted, 201, "typed portfolio draft creation");
      expectScenario(
        UUID.test(accepted.payload?.id ?? "") &&
          accepted.payload.owner_account_id === owner.record.id &&
          Number.isInteger(accepted.payload.revision) &&
          accepted.payload.revision > 0 &&
          JSON.stringify(accepted.payload.draft) === JSON.stringify(adapted) &&
          Number.isFinite(Date.parse(accepted.payload.created_at)),
        "typed portfolio draft response",
        { portfolio_shape_valid: false },
      );
      state.portfolio = accepted.payload;
      state.acceptedDraft = adapted;
      const read = await call(`/v1/portfolio/draft-revisions/${state.portfolio.id}`, {
        token: owner.token,
      });
      assertStatus(read, 200, "typed portfolio draft read");
      expectScenario(JSON.stringify(read.payload) === JSON.stringify(state.portfolio), "portfolio draft read is stable", {
        stable_portfolio: false,
      });

      const slotsAfter = await postgres.psqlJson(
        "portfolio-slots-after",
        `SELECT json_build_object(
           'hosted_slots', COALESCE(SUM(hosted_slots),0)::int,
           'draft_rows', (SELECT COUNT(*)::int FROM portfolio_draft_revisions),
           'hosted_refs', (SELECT COUNT(*)::int FROM portfolio_project_references WHERE hosted_project_id IS NOT NULL),
           'external_refs', (SELECT COUNT(*)::int FROM portfolio_project_references WHERE external_reference_id IS NOT NULL)
         ) FROM projects;`,
      );
      expectScenario(
        slotsAfter.hosted_slots === slotsBefore.hosted_slots &&
          slotsAfter.draft_rows === 1 &&
          slotsAfter.hosted_refs === 1 &&
          slotsAfter.external_refs === 1,
        "portfolio and external case study references reserve no slot",
        slotsAfter,
      );
      return {
        unavailable_facts_status: facts.status,
        missing_authorized_facts_status: missingFacts.status,
        readiness_status: readiness.status,
        unsafe_url_status: unsafe.status,
        accepted_status: accepted.status,
        persisted_draft_rows: slotsAfter.draft_rows,
        hosted_reference_rows: slotsAfter.hosted_refs,
        external_reference_rows: slotsAfter.external_refs,
        hosted_slots_delta: slotsAfter.hosted_slots - slotsBefore.hosted_slots,
      };
    },
  );

  await graphStep(
    context,
    "M1-GRAPH-04",
    "cross-owner and missing graph references remain hidden, invalid lifecycle transitions and public fact spoofing fail, composite database ownership is enforced, and no secret value enters release metadata",
    async () => {
      const projectId = state.mainGraph.project.id;
      const missingId = randomUUID();
      const hidden = [
        await call(`/v1/projects/${projectId}`, { token: other.token }),
        await call(`/v1/projects/${projectId}/configuration-revisions/${state.mainGraph.configuration.id}`, { token: other.token }),
        await call(`/v1/projects/${projectId}/services/${state.mainGraph.services[0].id}`, { token: other.token }),
        await call(`/v1/projects/${projectId}/deployments/${state.deploymentOne.id}`, { token: other.token }),
        await call(`/v1/portfolio/draft-revisions/${state.portfolio.id}`, { token: other.token }),
      ];
      hidden.forEach((response) => assertErrorShape(response, 404, "cross-owner graph read"));

      const crossWrite = await call(`/v1/projects/${projectId}`, {
        method: "PATCH",
        token: other.token,
        headers: mutationHeaders("m1-graph-cross-owner-write", state.mainGraph.project.revision),
        body: { name: "Cross-owner write must not commit" },
      });
      assertErrorShape(crossWrite, 404, "cross-owner project write");
      const missing = await call(`/v1/projects/${missingId}`, { token: owner.token });
      assertErrorShape(missing, 404, "missing project read");
      const missingWrite = await call(`/v1/projects/${missingId}/configuration-revisions`, {
        method: "POST",
        token: owner.token,
        headers: mutationHeaders("m1-graph-missing-project-write", 1),
        body: { configuration: state.mainGraph.configuration.spec },
      });
      assertErrorShape(missingWrite, 404, "missing project configuration write");
      const wrongConfig = await call(`/v1/projects/${state.otherGraph.project.id}/deployment-intents`, {
        method: "POST",
        token: other.token,
        headers: mutationHeaders("m1-graph-cross-project-config", state.otherGraph.project.revision),
        body: {
          configuration_revision_id: state.mainGraph.configuration.id,
          source_commit: manifest.graph.source_commit,
        },
      });
      assertErrorShape(wrongConfig, 404, "cross-project configuration reference");

      const ineligibleRollback = await call(`/v1/projects/${projectId}/rollback-intents`, {
        method: "POST",
        token: owner.token,
        headers: mutationHeaders("m1-graph-ineligible-rollback", state.mainGraph.project.revision),
        body: { target_deployment_id: state.deploymentOne.id },
      });
      assertErrorShape(ineligibleRollback, 409, "rollback target before trusted healthy observation");
      expectScenario(
        ineligibleRollback.payload.error.code === "rollback_target_ineligible",
        "ineligible rollback error code",
        { error_code: ineligibleRollback.payload.error.code },
      );
      const unnecessaryRemoval = await call(
        `/v1/projects/${state.ownerGraphs.get("static_frontend").project.id}/removal-intents`,
        {
          method: "POST",
          token: owner.token,
          headers: mutationHeaders(
            "m1-graph-unnecessary-removal",
            state.ownerGraphs.get("static_frontend").project.revision,
          ),
          body: {},
        },
      );
      assertErrorShape(unnecessaryRemoval, 409, "removal without reserved or retained resources");
      expectScenario(
        unnecessaryRemoval.payload.error.code === "removal_not_required",
        "unnecessary removal error code",
        { error_code: unnecessaryRemoval.payload.error.code },
      );

      const secretValue = `m1-release-secret-${randomBytes(24).toString("base64url")}`;
      context.registerSensitiveValues([secretValue]);
      const spoofed = await call(`/v1/projects/${projectId}/deployment-intents`, {
        method: "POST",
        token: owner.token,
        headers: mutationHeaders("m1-graph-spoofed-facts", state.mainGraph.project.revision),
        body: {
          configuration_revision_id: state.mainGraph.configuration.id,
          source_commit: manifest.graph.source_commit,
          lifecycle: "healthy",
          hosted_slots: 1,
          health_result_ref: "owner-spoofed",
          secret_value: secretValue,
        },
      });
      assertErrorShape(spoofed, 400, "public deployment fact spoofing");
      expectScenario(spoofed.payload.error.code === "malformed_json", "unknown lifecycle fields fail as malformed JSON", {
        error_code: spoofed.payload.error.code,
      });

      const crossPortfolio = clone(state.acceptedDraft);
      crossPortfolio.projects[0].kind.project_id = projectId;
      const hiddenPortfolio = await call("/v1/portfolio/draft-revisions", {
        method: "POST",
        token: other.token,
        headers: createHeaders("m1-graph-cross-owner-portfolio"),
        body: { draft: crossPortfolio },
      });
      assertErrorShape(hiddenPortfolio, 404, "cross-owner hosted portfolio reference");

      const ownerStatic = state.mainGraph.services.find(
        (service) => service.configuration.kind === "static_frontend",
      );
      const otherStatic = state.otherGraph.services.find(
        (service) => service.configuration.kind === "static_frontend",
      );
      const fkFailure = await postgres.psqlExpectFailure(
        "graph-cross-owner-service-fk",
        `UPDATE service_configurations
            SET service_id=${sqlString(otherStatic.id)}, name='cross-owner-e2e'
          WHERE account_id=${sqlString(owner.record.id)}
            AND project_id=${sqlString(projectId)}
            AND configuration_revision_id=${sqlString(state.mainGraph.configuration.id)}
            AND service_id=${sqlString(ownerStatic.id)};`,
        "23503",
      );
      const noPartial = await postgres.psqlJson(
        "graph-negative-no-partial",
        `SELECT json_build_object(
           'spoofed_deployments', (SELECT COUNT(*)::int FROM deployments WHERE health_result_ref = 'owner-spoofed'),
           'cross_owner_service_snapshots', (SELECT COUNT(*)::int FROM service_configurations WHERE name = 'cross-owner-e2e'),
           'original_service_snapshot', (SELECT COUNT(*)::int FROM service_configurations WHERE configuration_revision_id=${sqlString(state.mainGraph.configuration.id)} AND service_id=${sqlString(ownerStatic.id)}),
           'unexpected_secret_keys', (SELECT COUNT(*)::int FROM deployments WHERE row_to_json(deployments)::text LIKE '%secret_value%')
         );`,
      );
      expectScenario(
        noPartial.spoofed_deployments === 0 &&
          noPartial.cross_owner_service_snapshots === 0 &&
          noPartial.original_service_snapshot === 1 &&
          noPartial.unexpected_secret_keys === 0,
        "invalid graph requests persist no partial fact or secret rows",
        noPartial,
      );
      return {
        cross_owner_read_statuses: hidden.map(({ status }) => status),
        cross_owner_write_status: crossWrite.status,
        missing_parent_status: missing.status,
        missing_parent_write_status: missingWrite.status,
        cross_reference_status: wrongConfig.status,
        invalid_transition_status: ineligibleRollback.status,
        unnecessary_removal_status: unnecessaryRemoval.status,
        public_fact_spoof_status: spoofed.status,
        cross_owner_portfolio_status: hiddenPortfolio.status,
        composite_fk_exit_status: fkFailure.exitStatus,
        composite_fk_sqlstate: fkFailure.sqlState,
        partial_rows: 0,
      };
    },
  );

  await graphStep(
    context,
    "M1-GRAPH-03",
    "owner intents allocate no capacity; explicitly labeled trusted SQL observations record reservation, retained-resource failure, rollback, removal pending, and confirmed release without claiming M2 capacity work",
    async () => {
      const projectId = state.mainGraph.project.id;
      const staticService = state.mainGraph.services.find(
        (service) => service.configuration.kind === "static_frontend",
      );
      const applicationService = state.mainGraph.services.find(
        (service) => service.configuration.kind === "application",
      );
      const staticDigest = `sha256:${"1".repeat(64)}`;
      const applicationDigest = `sha256:${"2".repeat(64)}`;
      await postgres.psqlCommand(
        "trusted-observation-first-reservation",
        `BEGIN;
         UPDATE deployments SET lifecycle='healthy', health_result_ref='health/e2e/verified', database_migration_revision='migration/e2e/1'
          WHERE id=${sqlString(state.deploymentOne.id)} AND account_id=${sqlString(owner.record.id)} AND project_id=${sqlString(projectId)};
         INSERT INTO deployment_artifact_refs(id,account_id,project_id,deployment_id,configuration_revision_id,service_id,kind,service_kind,digest)
          VALUES
           (${sqlString(randomUUID())},${sqlString(owner.record.id)},${sqlString(projectId)},${sqlString(state.deploymentOne.id)},${sqlString(state.mainGraph.configuration.id)},${sqlString(staticService.id)},'static','static_frontend',${sqlString(staticDigest)}),
           (${sqlString(randomUUID())},${sqlString(owner.record.id)},${sqlString(projectId)},${sqlString(state.deploymentOne.id)},${sqlString(state.mainGraph.configuration.id)},${sqlString(applicationService.id)},'application','application',${sqlString(applicationDigest)});
         INSERT INTO hosting_state_events(id,account_id,project_id,deployment_id,state,source,reason)
          VALUES (${sqlString(randomUUID())},${sqlString(owner.record.id)},${sqlString(projectId)},${sqlString(state.deploymentOne.id)},'reserved','trusted_observation','E2E persistence-boundary fixture: simulated M2 reservation observation');
         UPDATE projects SET hosted_slots=1,slot_state='reserved',updated_at=transaction_timestamp() WHERE id=${sqlString(projectId)};
         COMMIT;`,
      );
      const trustedReservation = await postgres.psqlJson(
        "trusted-observation-first-reservation-counts",
        `SELECT json_build_object(
           'healthy', (SELECT COUNT(*)::int FROM deployments WHERE id=${sqlString(state.deploymentOne.id)} AND lifecycle='healthy'),
           'artifact_refs', (SELECT COUNT(*)::int FROM deployment_artifact_refs WHERE deployment_id=${sqlString(state.deploymentOne.id)}),
           'trusted_observations', (SELECT COUNT(*)::int FROM hosting_state_events WHERE project_id=${sqlString(projectId)} AND source='trusted_observation'),
           'hosted_slots', (SELECT hosted_slots::int FROM projects WHERE id=${sqlString(projectId)}),
           'slot_state', (SELECT slot_state FROM projects WHERE id=${sqlString(projectId)})
         );`,
      );
      expectScenario(
        trustedReservation.healthy === 1 &&
          trustedReservation.artifact_refs === 2 &&
          trustedReservation.trusted_observations === 1 &&
          trustedReservation.hosted_slots === 1 &&
          trustedReservation.slot_state === "reserved",
        "trusted observation SQL fixture establishes first reservation boundary",
        trustedReservation,
      );

      const observedHealthy = await call(`/v1/projects/${projectId}/deployments/${state.deploymentOne.id}`, {
        token: owner.token,
      });
      assertStatus(observedHealthy, 200, "trusted-observed healthy deployment read");
      expectScenario(
        observedHealthy.payload.lifecycle === "healthy" &&
          observedHealthy.payload.release.static_artifact?.digest === staticDigest &&
          observedHealthy.payload.release.application_artifact?.digest === applicationDigest &&
          observedHealthy.payload.release.health_result_ref === "health/e2e/verified" &&
          observedHealthy.payload.release.database_migration_revision === "migration/e2e/1",
        "FK-valid trusted release references assemble through normal API",
        { lifecycle: observedHealthy.payload.lifecycle, release_reference_count: 2 },
      );
      const reservedProject = await call(`/v1/projects/${projectId}`, { token: owner.token });
      assertStatus(reservedProject, 200, "project after trusted reservation");
      expectScenario(
        reservedProject.payload.project.slot.hosted_slots === 1 &&
          reservedProject.payload.project.slot.state === "reserved",
        "trusted reservation observation allocates one slot",
        reservedProject.payload.project.slot,
      );
      state.mainGraph = reservedProject.payload;

      const second = await call(`/v1/projects/${projectId}/deployment-intents`, {
        method: "POST",
        token: owner.token,
        headers: mutationHeaders("m1-graph-deployment-two", state.mainGraph.project.revision),
        body: {
          configuration_revision_id: state.mainGraph.configuration.id,
          source_commit: "abcdef0123456789abcdef0123456789abcdef01",
        },
      });
      assertStatus(second, 201, "replacement deployment intent");
      assertEmptyRelease(second.payload, projectId, state.mainGraph.configuration.id, "replacement deployment intent");
      state.deploymentTwo = second.payload;
      const afterSecond = await call(`/v1/projects/${projectId}`, { token: owner.token });
      assertStatus(afterSecond, 200, "project after replacement deployment intent");
      expectScenario(
        afterSecond.payload.project.slot.hosted_slots === 1 &&
          afterSecond.payload.project.slot.state === "reserved",
        "replacement deployment preserves the existing allocation",
        afterSecond.payload.project.slot,
      );
      state.mainGraph = afterSecond.payload;

      await postgres.psqlCommand(
        "trusted-observation-retained-failure",
        `BEGIN;
         UPDATE deployments SET lifecycle='failed_resources_retained'
          WHERE id=${sqlString(state.deploymentTwo.id)} AND project_id=${sqlString(projectId)};
         INSERT INTO hosting_state_events(id,account_id,project_id,deployment_id,state,source,reason)
          VALUES (${sqlString(randomUUID())},${sqlString(owner.record.id)},${sqlString(projectId)},${sqlString(state.deploymentTwo.id)},'failed_resources_retained','trusted_observation','E2E persistence-boundary fixture: simulated retained-resource failure observation');
         UPDATE projects SET hosted_slots=1,slot_state='resources_retained',updated_at=transaction_timestamp() WHERE id=${sqlString(projectId)};
         COMMIT;`,
      );
      const trustedRetained = await postgres.psqlJson(
        "trusted-observation-retained-failure-counts",
        `SELECT json_build_object(
           'retained', (SELECT COUNT(*)::int FROM deployments WHERE id=${sqlString(state.deploymentTwo.id)} AND lifecycle='failed_resources_retained'),
           'trusted_observations', (SELECT COUNT(*)::int FROM hosting_state_events WHERE project_id=${sqlString(projectId)} AND source='trusted_observation'),
           'hosted_slots', (SELECT hosted_slots::int FROM projects WHERE id=${sqlString(projectId)}),
           'slot_state', (SELECT slot_state FROM projects WHERE id=${sqlString(projectId)})
         );`,
      );
      expectScenario(
        trustedRetained.retained === 1 &&
          trustedRetained.trusted_observations === 2 &&
          trustedRetained.hosted_slots === 1 &&
          trustedRetained.slot_state === "resources_retained",
        "trusted retained-resource failure observation preserves the allocated slot",
        trustedRetained,
      );
      const observedRetained = await call(`/v1/projects/${projectId}/deployments/${state.deploymentTwo.id}`, {
        token: owner.token,
      });
      assertStatus(observedRetained, 200, "trusted-observed retained deployment read");
      expectScenario(observedRetained.payload.lifecycle === "failed_resources_retained", "retained-resource failure visible", {
        lifecycle: observedRetained.payload.lifecycle,
      });
      const retainedProject = await call(`/v1/projects/${projectId}`, { token: owner.token });
      assertStatus(retainedProject, 200, "project with retained resources");
      expectScenario(
        retainedProject.payload.project.slot.hosted_slots === 1 &&
          retainedProject.payload.project.slot.state === "resources_retained",
        "trusted retained-resource observation consumes one slot",
        retainedProject.payload.project.slot,
      );
      state.mainGraph = retainedProject.payload;

      const rollback = await call(`/v1/projects/${projectId}/rollback-intents`, {
        method: "POST",
        token: owner.token,
        headers: mutationHeaders("m1-graph-rollback", state.mainGraph.project.revision),
        body: { target_deployment_id: state.deploymentOne.id },
      });
      assertStatus(rollback, 201, "rollback intent targeting trusted healthy deployment");
      expectScenario(
        UUID.test(rollback.payload?.id ?? "") &&
          rollback.payload.project_id === projectId &&
          rollback.payload.kind === "rollback" &&
          rollback.payload.target_deployment_id === state.deploymentOne.id &&
          rollback.payload.state === "requested" &&
          Number.isInteger(rollback.payload.project_revision),
        "rollback intent response",
        { rollback_shape_valid: false },
      );
      const rollbackPending = await call(`/v1/projects/${projectId}`, { token: owner.token });
      assertStatus(rollbackPending, 200, "project with rollback intent pending");
      state.mainGraph = rollbackPending.payload;
      const repeatedRollback = await call(`/v1/projects/${projectId}/rollback-intents`, {
        method: "POST",
        token: owner.token,
        headers: mutationHeaders("m1-graph-rollback-while-pending", state.mainGraph.project.revision),
        body: { target_deployment_id: state.deploymentOne.id },
      });
      assertConflictCode(repeatedRollback, "lifecycle_intent_pending", "second rollback while rollback is pending");
      const deploymentDuringRollback = await call(`/v1/projects/${projectId}/deployment-intents`, {
        method: "POST",
        token: owner.token,
        headers: mutationHeaders("m1-graph-deploy-while-rollback", state.mainGraph.project.revision),
        body: {
          configuration_revision_id: state.mainGraph.configuration.id,
          source_commit: "fedcba9876543210fedcba9876543210fedcba98",
        },
      });
      assertConflictCode(deploymentDuringRollback, "lifecycle_intent_pending", "deployment while rollback is pending");
      const removalDuringRollback = await call(`/v1/projects/${projectId}/removal-intents`, {
        method: "POST",
        token: owner.token,
        headers: mutationHeaders("m1-graph-removal-while-rollback", state.mainGraph.project.revision),
        body: {},
      });
      assertConflictCode(removalDuringRollback, "lifecycle_intent_pending", "removal while rollback is pending");
      const rollbackGuarded = await call(`/v1/projects/${projectId}`, { token: owner.token });
      assertStatus(rollbackGuarded, 200, "project after rejected operations during rollback");
      expectScenario(
        rollbackGuarded.payload.project.revision === state.mainGraph.project.revision &&
          rollbackGuarded.payload.project.slot.state === state.mainGraph.project.slot.state,
        "pending rollback guards create no revision or slot-state change",
        { stable_project_state: false },
      );
      const rollbackRows = await postgres.psqlJson(
        "rollback-pending-guard-counts",
        `SELECT json_build_object(
           'requested_intents', (SELECT COUNT(*)::int FROM project_lifecycle_intents WHERE project_id=${sqlString(projectId)} AND state='requested'),
           'deployment_rows', (SELECT COUNT(*)::int FROM deployments WHERE project_id=${sqlString(projectId)})
         );`,
      );
      expectScenario(
        rollbackRows.requested_intents === 1 && rollbackRows.deployment_rows === 2,
        "pending rollback guards persist no duplicate intent or deployment",
        rollbackRows,
      );
      await postgres.psqlCommand(
        "trusted-observation-complete-rollback",
        `UPDATE project_lifecycle_intents SET state='completed'
          WHERE id=${sqlString(rollback.payload.id)} AND project_id=${sqlString(projectId)} AND state='requested';`,
      );

      const removal = await call(`/v1/projects/${projectId}/removal-intents`, {
        method: "POST",
        token: owner.token,
        headers: mutationHeaders("m1-graph-removal", state.mainGraph.project.revision),
        body: {},
      });
      assertStatus(removal, 201, "removal intent");
      expectScenario(
        removal.payload?.kind === "removal" &&
          removal.payload.project_id === projectId &&
          removal.payload.target_deployment_id === null &&
          removal.payload.state === "requested",
        "removal intent response",
        { removal_shape_valid: false },
      );
      const pending = await call(`/v1/projects/${projectId}`, { token: owner.token });
      assertStatus(pending, 200, "release-pending project");
      expectScenario(pending.payload.project.slot.state === "release_pending", "removal intent records release pending only", {
        slot_state: pending.payload.project.slot.state,
        hosted_slots: pending.payload.project.slot.hosted_slots,
      });
      state.mainGraph = pending.payload;
      const repeatedRemoval = await call(`/v1/projects/${projectId}/removal-intents`, {
        method: "POST",
        token: owner.token,
        headers: mutationHeaders("m1-graph-removal-while-pending", state.mainGraph.project.revision),
        body: {},
      });
      assertConflictCode(repeatedRemoval, "lifecycle_intent_pending", "second removal while removal is pending");
      const deploymentDuringRemoval = await call(`/v1/projects/${projectId}/deployment-intents`, {
        method: "POST",
        token: owner.token,
        headers: mutationHeaders("m1-graph-deploy-while-removal", state.mainGraph.project.revision),
        body: {
          configuration_revision_id: state.mainGraph.configuration.id,
          source_commit: "fedcba9876543210fedcba9876543210fedcba98",
        },
      });
      assertConflictCode(deploymentDuringRemoval, "lifecycle_intent_pending", "deployment while removal is pending");
      const rollbackDuringRemoval = await call(`/v1/projects/${projectId}/rollback-intents`, {
        method: "POST",
        token: owner.token,
        headers: mutationHeaders("m1-graph-rollback-while-removal", state.mainGraph.project.revision),
        body: { target_deployment_id: state.deploymentOne.id },
      });
      assertConflictCode(rollbackDuringRemoval, "lifecycle_intent_pending", "rollback while removal is pending");
      const removalGuarded = await call(`/v1/projects/${projectId}`, { token: owner.token });
      assertStatus(removalGuarded, 200, "project after rejected operations during removal");
      expectScenario(
        removalGuarded.payload.project.revision === state.mainGraph.project.revision &&
          removalGuarded.payload.project.slot.state === "release_pending",
        "pending removal guards preserve release-pending state and revision",
        { stable_project_state: false },
      );
      const removalRows = await postgres.psqlJson(
        "removal-pending-guard-counts",
        `SELECT json_build_object(
           'requested_intents', (SELECT COUNT(*)::int FROM project_lifecycle_intents WHERE project_id=${sqlString(projectId)} AND state='requested'),
           'completed_intents', (SELECT COUNT(*)::int FROM project_lifecycle_intents WHERE project_id=${sqlString(projectId)} AND state='completed'),
           'deployment_rows', (SELECT COUNT(*)::int FROM deployments WHERE project_id=${sqlString(projectId)})
         );`,
      );
      expectScenario(
        removalRows.requested_intents === 1 &&
          removalRows.completed_intents === 1 &&
          removalRows.deployment_rows === 2,
        "pending removal guards persist no duplicate intent or deployment",
        removalRows,
      );

      await postgres.psqlCommand(
        "trusted-observation-confirmed-removal",
        `BEGIN;
         UPDATE deployments SET lifecycle='removed' WHERE project_id=${sqlString(projectId)};
         UPDATE project_lifecycle_intents SET state='completed'
          WHERE id=${sqlString(removal.payload.id)} AND project_id=${sqlString(projectId)} AND state='requested';
         INSERT INTO hosting_state_events(id,account_id,project_id,deployment_id,state,source,reason)
          VALUES (${sqlString(randomUUID())},${sqlString(owner.record.id)},${sqlString(projectId)},${sqlString(state.deploymentTwo.id)},'removed','trusted_observation','E2E persistence-boundary fixture: simulated confirmed removal observation');
         UPDATE projects SET hosted_slots=0,slot_state='released',updated_at=transaction_timestamp() WHERE id=${sqlString(projectId)};
         COMMIT;`,
      );
      const removed = await postgres.psqlJson(
        "trusted-observation-confirmed-removal-counts",
        `SELECT json_build_object(
           'removed_deployments', (SELECT COUNT(*)::int FROM deployments WHERE project_id=${sqlString(projectId)} AND lifecycle='removed'),
           'confirmed_removed_events', (SELECT COUNT(*)::int FROM hosting_state_events WHERE project_id=${sqlString(projectId)} AND state='removed' AND source='trusted_observation'),
           'completed_lifecycle_intents', (SELECT COUNT(*)::int FROM project_lifecycle_intents WHERE project_id=${sqlString(projectId)} AND state='completed'),
           'hosted_slots', (SELECT hosted_slots::int FROM projects WHERE id=${sqlString(projectId)}),
           'slot_state', (SELECT slot_state FROM projects WHERE id=${sqlString(projectId)})
         );`,
      );
      expectScenario(
        removed.removed_deployments === 2 &&
          removed.confirmed_removed_events === 1 &&
          removed.completed_lifecycle_intents === 2 &&
          removed.hosted_slots === 0 &&
          removed.slot_state === "released",
        "trusted confirmed removal releases the observed slot",
        removed,
      );
      state.mainGraph = (await call(`/v1/projects/${projectId}`, { token: owner.token })).payload;
      return {
        capacity_resources_created: 0,
        persistence_boundary_fixture: "trusted_observation_sql",
        admission_intent_hosted_slots: 0,
        trusted_reserved_hosted_slots: trustedReservation.hosted_slots,
        replacement_intent_hosted_slots: afterSecond.payload.project.slot.hosted_slots,
        observed_release_reference_count: 2,
        rollback_status: rollback.status,
        repeated_rollback_status: repeatedRollback.status,
        deployment_during_rollback_status: deploymentDuringRollback.status,
        removal_status: removal.status,
        repeated_removal_status: repeatedRemoval.status,
        deployment_during_removal_status: deploymentDuringRemoval.status,
        lifecycle_intents_completed: removed.completed_lifecycle_intents,
        final_hosted_slots: removed.hosted_slots,
        final_slot_state: removed.slot_state,
      };
    },
  );

  await graphStep(
    context,
    "M1-GRAPH-05",
    "after concurrent writes and lifecycle observations, an API restart preserves project IDs, immutable configurations, service and deployment references, portfolio content, row counts, and idempotent replay results",
    async () => {
      const projectId = state.mainGraph.project.id;
      const before = await postgres.psqlJson(
        "graph-counts-before-restart",
        `SELECT json_build_object(
           'projects', (SELECT COUNT(*)::int FROM projects),
           'configurations', (SELECT COUNT(*)::int FROM configuration_revisions),
           'repositories', (SELECT COUNT(*)::int FROM repositories),
           'repository_configurations', (SELECT COUNT(*)::int FROM repository_configurations),
           'services', (SELECT COUNT(*)::int FROM services),
           'service_configurations', (SELECT COUNT(*)::int FROM service_configurations),
           'deployments', (SELECT COUNT(*)::int FROM deployments),
           'artifact_refs', (SELECT COUNT(*)::int FROM deployment_artifact_refs),
           'hosting_events', (SELECT COUNT(*)::int FROM hosting_state_events),
           'lifecycle_intents', (SELECT COUNT(*)::int FROM project_lifecycle_intents),
           'portfolio_revisions', (SELECT COUNT(*)::int FROM portfolio_draft_revisions),
           'portfolio_references', (SELECT COUNT(*)::int FROM portfolio_project_references)
         );`,
      );
      await restartApi("M1 graph restart durability scenario");

      const graph = await call(`/v1/projects/${projectId}`, { token: owner.token });
      assertStatus(graph, 200, "project graph after API restart");
      assertGraph(graph.payload, owner.record.id, "project graph after API restart");
      expectScenario(
        graph.payload.project.id === state.mainGraph.project.id &&
          graph.payload.project.name === state.mainGraph.project.name &&
          graph.payload.project.revision === state.mainGraph.project.revision &&
          graph.payload.project.slot.hosted_slots === 0 &&
          graph.payload.project.slot.state === "released" &&
          graph.payload.configuration.id === state.mainGraph.configuration.id &&
          JSON.stringify(graph.payload.services.map(({ id }) => id)) ===
            JSON.stringify(state.mainGraph.services.map(({ id }) => id)),
        "current graph IDs, winner, revision, and released state survive restart",
        { stable_graph: false },
      );
      const oldConfig = await call(
        `/v1/projects/${projectId}/configuration-revisions/${state.initialConfiguration.configuration.id}`,
        { token: owner.token },
      );
      assertStatus(oldConfig, 200, "old configuration after restart");
      expectScenario(
        oldConfig.payload?.configuration?.id === state.initialConfiguration.configuration.id,
        "immutable old configuration ID survives restart",
        { stable_old_configuration: false },
      );
      for (const deployment of [state.deploymentOne, state.deploymentTwo]) {
        const read = await call(`/v1/projects/${projectId}/deployments/${deployment.id}`, {
          token: owner.token,
        });
        assertStatus(read, 200, "deployment after API restart");
        expectScenario(
          read.payload.id === deployment.id &&
            read.payload.configuration_revision_id === deployment.configuration_revision_id &&
            read.payload.lifecycle === "removed",
          "deployment identity and configuration reference survive restart",
          { stable_deployment: false },
        );
      }
      const firstDeployment = await call(
        `/v1/projects/${projectId}/deployments/${state.deploymentOne.id}`,
        { token: owner.token },
      );
      expectScenario(
        firstDeployment.payload.release.static_artifact?.digest === `sha256:${"1".repeat(64)}` &&
          firstDeployment.payload.release.application_artifact?.digest === `sha256:${"2".repeat(64)}`,
        "trusted artifact references survive restart",
        { stable_artifact_references: false },
      );
      const portfolio = await call(`/v1/portfolio/draft-revisions/${state.portfolio.id}`, {
        token: owner.token,
      });
      assertStatus(portfolio, 200, "portfolio after API restart");
      expectScenario(
        JSON.stringify(portfolio.payload) === JSON.stringify(state.portfolio),
        "typed portfolio content and references survive restart",
        { stable_portfolio: false },
      );

      const replay = await call(`/v1/projects/${projectId}`, {
        method: "PATCH",
        token: owner.token,
        headers: mutationHeaders(
          "m1-graph-project-rename",
          state.replayedRename.project.revision - 1,
        ),
        body: { name: manifest.graph.renamed_project },
      });
      assertStatus(replay, 200, "idempotent update replay after API restart");
      expectScenario(
        JSON.stringify(replay.payload) === JSON.stringify(state.replayedRename),
        "stored idempotent response survives restart and precedes stale revision evaluation",
        { stable_replay: false },
      );
      const after = await postgres.psqlJson(
        "graph-counts-after-restart",
        `SELECT json_build_object(
           'projects', (SELECT COUNT(*)::int FROM projects),
           'configurations', (SELECT COUNT(*)::int FROM configuration_revisions),
           'repositories', (SELECT COUNT(*)::int FROM repositories),
           'repository_configurations', (SELECT COUNT(*)::int FROM repository_configurations),
           'services', (SELECT COUNT(*)::int FROM services),
           'service_configurations', (SELECT COUNT(*)::int FROM service_configurations),
           'deployments', (SELECT COUNT(*)::int FROM deployments),
           'artifact_refs', (SELECT COUNT(*)::int FROM deployment_artifact_refs),
           'hosting_events', (SELECT COUNT(*)::int FROM hosting_state_events),
           'lifecycle_intents', (SELECT COUNT(*)::int FROM project_lifecycle_intents),
           'portfolio_revisions', (SELECT COUNT(*)::int FROM portfolio_draft_revisions),
           'portfolio_references', (SELECT COUNT(*)::int FROM portfolio_project_references)
         );`,
      );
      expectScenario(JSON.stringify(after) === JSON.stringify(before), "graph row counts stable across restart and replay", {
        stable_counts: false,
      });
      return {
        restart_project_status: graph.status,
        stable_current_configuration_id: true,
        stable_service_ids: graph.payload.services.length,
        stable_deployment_ids: 2,
        stable_release_references: 2,
        stable_portfolio_references: after.portfolio_references,
        stable_row_counts: true,
        replay_status: replay.status,
      };
    },
  );
}
