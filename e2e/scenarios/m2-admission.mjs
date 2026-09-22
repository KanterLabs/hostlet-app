import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  assertErrorShape,
  assertStatus,
  expectScenario,
  ScenarioExpectationError,
} from "../support/http-client.mjs";

export const M2_ADMISSION_REQUIRED_ASSERTIONS = Object.freeze([
  "M2-ADMISSION-01",
  "M2-ADMISSION-02",
  "M2-ADMISSION-03",
  "M2-ADMISSION-04",
  "M2-ADMISSION-05",
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POOL_KEY = "m2-default";
const PROFILE = "m2-standard-project";
const ADMISSION_FIXTURE_MANIFEST = Object.freeze({
  schema_version: 1,
  boundary: "synthetic_internal",
  capacity_pool_key: POOL_KEY,
  capacity_profile: PROFILE,
  entitlement_period: "per-run UTC window recorded in non-secret configuration",
});

function safeObserved(error) {
  if (error instanceof ScenarioExpectationError) return error.observed;
  return { failed_checks: 1 };
}

async function admissionStep(context, id, expected, run) {
  try {
    const observed = await run();
    context.assertion(id, "M2 entitlement, capacity, slot, and build-meter admission", expected, observed, true);
    return observed;
  } catch (error) {
    context.assertion(
      id,
      "M2 entitlement, capacity, slot, and build-meter admission",
      expected,
      safeObserved(error),
      false,
      error instanceof ScenarioExpectationError ? error.check : "admission HTTP or PostgreSQL boundary failed",
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

function assertCode(response, status, code, check) {
  assertErrorShape(response, status, check);
  expectScenario(response.payload.error.code === code, `${check}: stable error code`, {
    status: response.status,
    error_code: response.payload.error.code,
  });
}

function assertNoExecution(payload, check) {
  expectScenario(
    payload?.execution_enqueued === false &&
      typeof payload?.admitted_for_later_execution === "boolean",
    check,
    {
      execution_enqueued: payload?.execution_enqueued,
      admitted_for_later_execution: payload?.admitted_for_later_execution,
    },
  );
}

function assertSyntheticEntitlement(payload, periodStart, periodEnd, check) {
  expectScenario(
    payload?.source === "synthetic_internal" &&
      Number.isInteger(payload.hosted_slot_limit) &&
      Number.isInteger(payload.hosted_slots_used) &&
      Number.isInteger(payload.active_initial_holds) &&
      Number.isInteger(payload.build_seconds_limit) &&
      Number.isInteger(payload.build_seconds_debited) &&
      Number.isInteger(payload.build_seconds_credited) &&
      Number.isInteger(payload.build_seconds_remaining) &&
      Date.parse(payload.period_starts_at) === Date.parse(periodStart) &&
      Date.parse(payload.period_ends_at) === Date.parse(periodEnd),
    check,
    { synthetic_entitlement_shape_valid: false },
  );
}

function fixtureRecord(payload, name) {
  return payload?.[name] ?? payload;
}

function projectRevision(graph) {
  return graph.project.revision;
}

export function registerM2AdmissionFixtures(context) {
  context.registerFixture("M2 admission scenario module", "e2e/scenarios/m2-admission.mjs");
  context.registerFixture("M2 admission project contract", "contracts/v1/projects/valid-standard.json");
  return ADMISSION_FIXTURE_MANIFEST;
}

export async function runM2AdmissionScenarios(m2) {
  const {
    context, postgres, call, callInternal, switchApi, currentApiBinary, retainedM1Binary, state,
  } = m2;
  const configuration = JSON.parse(
    readFileSync(join(context.repo, "contracts/v1/projects/valid-standard.json"), "utf8"),
  );
  const fixtures = m2.fixtures.admissionManifest ?? ADMISSION_FIXTURE_MANIFEST;
  expectScenario(
    fixtures.schema_version === 1 && fixtures.boundary === "synthetic_internal",
    "M2 admission fixture contract",
    fixtures,
  );
  const periodAnchor = new Date();
  const periodStart = new Date(Date.UTC(
    periodAnchor.getUTCFullYear(),
    periodAnchor.getUTCMonth(),
    periodAnchor.getUTCDate() - 1,
  )).toISOString();
  const periodEnd = new Date(Date.UTC(
    periodAnchor.getUTCFullYear(),
    periodAnchor.getUTCMonth(),
    periodAnchor.getUTCDate() + 30,
  )).toISOString();
  context.state.configuration.m2Admission = {
    fixtureBoundary: "synthetic_internal_not_github_grant",
    capacityPoolKey: POOL_KEY,
    entitlementPeriodStartsAt: periodStart,
    entitlementPeriodEndsAt: periodEnd,
  };

  let sequence = 0;
  const proofInventoryRevisions = new Map();
  const key = (label) => `m2-admission-${label}-${++sequence}`;
  const internal = async (path, body) => {
    const response = await callInternal(path, { method: "POST", body });
    return response;
  };
  const createAccount = async (label) => {
    const password = `M2-${label}-${randomUUID()}-password!`;
    context.registerSensitiveValues([password]);
    const created = await call("/v1/accounts", {
      method: "POST",
      body: {
        email: `${label}-${context.state.runId}@m2-admission.hostlet.test`,
        display_name: `M2 admission ${label}`,
        password,
      },
    });
    assertStatus(created, 201, `${label} account creation`);
    const session = await call("/v1/sessions", {
      method: "POST",
      body: { email: created.payload.email, password },
    });
    assertStatus(session, 201, `${label} session creation`);
    context.registerSensitiveValues([session.payload.token]);
    return { record: created.payload, token: session.payload.token };
  };
  const createProject = async (owner, label, sourceCommit) => {
    const created = await call("/v1/projects", {
      method: "POST",
      token: owner.token,
      headers: { "Idempotency-Key": key(`${label}-project`) },
      body: { name: `M2 admission ${label}`, configuration },
    });
    assertStatus(created, 201, `${label} project creation`);
    const deployment = await call(`/v1/projects/${created.payload.project.id}/deployment-intents`, {
      method: "POST",
      token: owner.token,
      headers: mutationHeaders(key(`${label}-deployment`), projectRevision(created.payload)),
      body: {
        configuration_revision_id: created.payload.configuration.id,
        source_commit: sourceCommit,
      },
    });
    assertStatus(deployment, 201, `${label} deployment intent`);
    const current = await call(`/v1/projects/${created.payload.project.id}`, { token: owner.token });
    assertStatus(current, 200, `${label} project revision after deployment`);
    return { graph: current.payload, deployment: deployment.payload, sourceCommit };
  };
  const createDeployment = async (owner, fixture, label, sourceCommit) => {
    const current = await call(`/v1/projects/${fixture.graph.project.id}`, { token: owner.token });
    assertStatus(current, 200, `${label} current project`);
    fixture.graph = current.payload;
    const deployment = await call(`/v1/projects/${fixture.graph.project.id}/deployment-intents`, {
      method: "POST",
      token: owner.token,
      headers: mutationHeaders(key(`${label}-deployment`), projectRevision(fixture.graph)),
      body: {
        configuration_revision_id: fixture.graph.configuration.id,
        source_commit: sourceCommit,
      },
    });
    assertStatus(deployment, 201, `${label} deployment intent`);
    fixture.graph = (await call(`/v1/projects/${fixture.graph.project.id}`, { token: owner.token })).payload;
    fixture.deployment = deployment.payload;
    fixture.sourceCommit = sourceCommit;
    return deployment.payload;
  };
  const seedEntitlement = async (
    owner,
    hostedSlotLimit,
    buildSecondsLimit,
    eventId = randomUUID(),
    entitlementState = "active",
  ) => {
    const response = await internal("/internal/v1/admission/entitlements", {
      event_id: eventId,
      account_id: owner.record.id,
      capacity_pool_key: POOL_KEY,
      hosted_slot_limit: hostedSlotLimit,
      build_seconds_limit: buildSecondsLimit,
      period_starts_at: periodStart,
      period_ends_at: periodEnd,
      state: entitlementState,
    });
    return response;
  };
  const seedCapacity = async (hostedSlotLimit, rolloutHeadroomLimit, eventId = randomUUID()) =>
    internal("/internal/v1/admission/capacity", {
      event_id: eventId,
      pool_key: POOL_KEY,
      profile: PROFILE,
      hosted_slot_limit: hostedSlotLimit,
      rollout_headroom_limit: rolloutHeadroomLimit,
    });
  const seedProof = async (owner, fixture, { expiresInMs = 900_000 } = {}) => {
    const inventoryRevision = (proofInventoryRevisions.get(fixture.deployment.id) ?? 0) + 1;
    proofInventoryRevisions.set(fixture.deployment.id, inventoryRevision);
    const response = await internal("/internal/v1/admission/source-proofs", {
      event_id: randomUUID(),
      account_id: owner.record.id,
      project_id: fixture.graph.project.id,
      deployment_id: fixture.deployment.id,
      configuration_revision_id: fixture.deployment.configuration_revision_id,
      source_commit: fixture.sourceCommit,
      inventory_revision: inventoryRevision,
      expires_at: new Date(Date.now() + expiresInMs).toISOString(),
    });
    assertStatus(
      response,
      200,
      `synthetic exact-source proof fixture inventory revision ${inventoryRevision}`,
    );
    const proof = fixtureRecord(response.payload, "proof");
    expectScenario(
      UUID.test(proof?.id ?? "") &&
        proof.project_id === fixture.graph.project.id &&
        proof.deployment_id === fixture.deployment.id &&
        proof.source_commit === fixture.sourceCommit &&
        proof.inventory_revision === inventoryRevision &&
        proof.source === "synthetic_internal",
      `source proof revision ${inventoryRevision} is explicit synthetic exact-commit boundary truth`,
      { source_proof_valid: false, inventory_revision: proof?.inventory_revision ?? null },
    );
    fixture.proof = proof;
    return proof;
  };
  const holdRequest = (owner, fixture, idempotencyKey, ttlSeconds = 120, proofId = fixture.proof.id) =>
    call(`/v1/projects/${fixture.graph.project.id}/deployments/${fixture.deployment.id}/capacity-holds`, {
      method: "POST",
      token: owner.token,
      headers: mutationHeaders(idempotencyKey, projectRevision(fixture.graph)),
      body: { source_proof_id: proofId, ttl_seconds: ttlSeconds },
    });
  const admitRequest = (owner, fixture, holdId, idempotencyKey) =>
    call(`/v1/projects/${fixture.graph.project.id}/deployments/${fixture.deployment.id}/admissions`, {
      method: "POST",
      token: owner.token,
      headers: mutationHeaders(idempotencyKey, projectRevision(fixture.graph)),
      body: { capacity_hold_id: holdId },
    });
  const observe = async (owner, fixture, reservation, outcome, overrides = {}) =>
    internal("/internal/v1/admission/resource-observations", {
      event_id: overrides.event_id ?? randomUUID(),
      account_id: owner.record.id,
      project_id: fixture.graph.project.id,
      deployment_id: overrides.deployment_id ?? fixture.deployment.id,
      reservation_id: reservation.id,
      reservation_epoch: overrides.reservation_epoch ?? reservation.reservation_epoch,
      outcome,
      resource_inventory: overrides.resource_inventory ?? (outcome === "cleanup_confirmed" ? "none" : "database"),
      proof_ref: overrides.proof_ref ?? `fixture/${outcome}/1`,
      rollout_hold_id: overrides.rollout_hold_id ?? null,
    });

  const actors = {
    owner: state.owner,
    other: state.other,
    noEntitlement: await createAccount("no-entitlement"),
    expiry: await createAccount("expiry"),
  };
  const projects = {
    ownerA: await createProject(actors.owner, "owner-a", "a".repeat(40)),
    ownerB: await createProject(actors.owner, "owner-b", "b".repeat(40)),
    otherA: await createProject(actors.other, "other-a", "c".repeat(40)),
    otherB: await createProject(actors.other, "other-b", "d".repeat(40)),
    noEntitlement: await createProject(actors.noEntitlement, "no-entitlement", "e".repeat(40)),
    expiry: await createProject(actors.expiry, "expiry", "f".repeat(40)),
  };
  for (const [name, fixture] of Object.entries(projects)) {
    await seedProof(actors[name.startsWith("owner") ? "owner" : name.startsWith("other") ? "other" : name], fixture);
  }

  const admitted = {};

  await admissionStep(
    context,
    "M2-ADMISSION-01",
    "concurrent first-deploy HTTP requests atomically obey entitlement and platform limits, exact retries are stable, foreign/stale proof use fails closed, and one slot is durable without any execution job",
    async () => {
      assertStatus(await seedCapacity(2, 1), 200, "synthetic capacity fixture");
      assertStatus(await seedEntitlement(actors.owner, 1, 360), 200, "owner synthetic entitlement");
      assertStatus(await seedEntitlement(actors.other, 2, 360), 200, "other synthetic entitlement");
      assertStatus(await seedEntitlement(actors.expiry, 1, 120), 200, "expiry synthetic entitlement");

      const validProofBeforeStaleInventory = projects.otherB.proof;
      const staleInventoryProof = await internal("/internal/v1/admission/source-proofs", {
        event_id: randomUUID(),
        account_id: actors.other.record.id,
        project_id: projects.otherB.graph.project.id,
        deployment_id: projects.otherB.deployment.id,
        configuration_revision_id: projects.otherB.deployment.configuration_revision_id,
        source_commit: projects.otherB.sourceCommit,
        inventory_revision: validProofBeforeStaleInventory.inventory_revision,
        expires_at: new Date(Date.now() + 900_000).toISOString(),
      });
      assertCode(
        staleInventoryProof,
        409,
        "source_inventory_revision_stale",
        "distinct event cannot reuse an accepted source inventory revision",
      );
      const proofAfterStaleInventory = await postgres.psqlJson(
        "m2-admission-stale-inventory-preserves-proof",
        `SELECT json_build_object(
          'valid_proof_id',(SELECT id::text FROM admission_source_proofs WHERE deployment_id=${sqlString(projects.otherB.deployment.id)} AND state='valid'),
          'valid_inventory_revision',(SELECT inventory_revision::int FROM admission_source_proofs WHERE deployment_id=${sqlString(projects.otherB.deployment.id)} AND state='valid'),
          'proof_rows',(SELECT COUNT(*)::int FROM admission_source_proofs WHERE deployment_id=${sqlString(projects.otherB.deployment.id)})
        );`,
      );
      expectScenario(
        proofAfterStaleInventory.valid_proof_id === validProofBeforeStaleInventory.id &&
          proofAfterStaleInventory.valid_inventory_revision === validProofBeforeStaleInventory.inventory_revision &&
          proofAfterStaleInventory.proof_rows === 1,
        "stale inventory rejection leaves the previously valid proof unchanged",
        proofAfterStaleInventory,
      );

      const boundDeployment = await postgres.psqlJson(
        "m2-admission-revoked-bound-source",
        `SELECT json_build_object(
          'deployment_id',d.id::text,
          'configuration_revision_id',d.configuration_revision_id::text,
          'source_commit',d.source_commit,
          'binding_history',(SELECT COUNT(*)::int FROM github_repository_bindings b WHERE b.project_id=d.project_id),
          'active_bindings',(SELECT COUNT(*)::int FROM github_repository_bindings b WHERE b.project_id=d.project_id AND b.status='active')
        ) FROM deployments d WHERE d.account_id=${sqlString(actors.owner.record.id)} AND d.project_id=${sqlString(state.graph.project.id)} ORDER BY d.created_at LIMIT 1;`,
      );
      expectScenario(
        state.github?.projectId === state.graph.project.id &&
          state.github.currentBindingStatus === "user_revalidation_required" &&
          boundDeployment.binding_history > 0 &&
          boundDeployment.active_bindings === 0,
        "prior GitHub scenario leaves binding history denied for admission integration",
        { ...boundDeployment, github_state_present: Boolean(state.github) },
      );
      const revokedBindingProof = await internal("/internal/v1/admission/source-proofs", {
        event_id: randomUUID(),
        account_id: actors.owner.record.id,
        project_id: state.graph.project.id,
        deployment_id: boundDeployment.deployment_id,
        configuration_revision_id: boundDeployment.configuration_revision_id,
        source_commit: boundDeployment.source_commit,
        inventory_revision: 1,
        expires_at: new Date(Date.now() + 900_000).toISOString(),
      });
      assertCode(
        revokedBindingProof,
        409,
        "github_source_not_authorized",
        "revoked binding history cannot fall back to a synthetic source proof",
      );
      const wrongExactSource = await internal("/internal/v1/admission/source-proofs", {
        event_id: randomUUID(),
        account_id: actors.owner.record.id,
        project_id: state.graph.project.id,
        deployment_id: boundDeployment.deployment_id,
        configuration_revision_id: boundDeployment.configuration_revision_id,
        source_commit: "9".repeat(40),
        inventory_revision: 1,
        expires_at: new Date(Date.now() + 900_000).toISOString(),
      });
      assertCode(wrongExactSource, 409, "admission_source_stale", "wrong exact source tuple is denied");

      const noEntitlement = await holdRequest(
        actors.noEntitlement,
        projects.noEntitlement,
        key("no-entitlement-hold"),
      );
      assertCode(noEntitlement, 409, "entitlement_unavailable", "account without entitlement denied");
      assertStatus(
        await seedEntitlement(actors.noEntitlement, 1, 120),
        200,
        "stale-configuration account synthetic entitlement",
      );
      const revisedConfiguration = structuredClone(projects.noEntitlement.graph.configuration.spec);
      revisedConfiguration.services.find(({ kind }) => kind === "static_frontend").build_command += ":stale-proof";
      const revised = await call(
        `/v1/projects/${projects.noEntitlement.graph.project.id}/configuration-revisions`,
        {
          method: "POST",
          token: actors.noEntitlement.token,
          headers: mutationHeaders(
            key("stale-proof-configuration"),
            projectRevision(projects.noEntitlement.graph),
          ),
          body: { configuration: revisedConfiguration },
        },
      );
      assertStatus(revised, 201, "configuration advances after source proof");
      projects.noEntitlement.graph = revised.payload;
      const staleConfigurationProof = await holdRequest(
        actors.noEntitlement,
        projects.noEntitlement,
        key("stale-configuration-proof"),
      );
      assertCode(
        staleConfigurationProof,
        409,
        "admission_source_stale",
        "proof tied to a non-current configuration is denied",
      );

      const foreignProof = await holdRequest(
        actors.owner,
        projects.ownerA,
        key("foreign-proof"),
        120,
        projects.ownerB.proof.id,
      );
      assertCode(foreignProof, 409, "admission_source_stale", "proof for another exact source denied");
      const wrongAccountHold = await call(
        `/v1/projects/${projects.ownerA.graph.project.id}/deployments/${projects.ownerA.deployment.id}/capacity-holds`,
        {
          method: "POST",
          token: actors.other.token,
          headers: mutationHeaders(key("wrong-account-hold"), projectRevision(projects.ownerA.graph)),
          body: { source_proof_id: projects.ownerA.proof.id, ttl_seconds: 120 },
        },
      );
      assertStatus(wrongAccountHold, 404, "wrong account cannot use an owned source proof");
      const publicHold = await call(
        `/v1/projects/${projects.ownerA.graph.project.id}/deployments/${projects.ownerA.deployment.id}/capacity-holds`,
        {
          method: "POST",
          headers: mutationHeaders(key("public-hold"), projectRevision(projects.ownerA.graph)),
          body: { source_proof_id: projects.ownerA.proof.id, ttl_seconds: 120 },
        },
      );
      assertStatus(publicHold, 401, "public request cannot use an internal source proof");

      const duplicateKey = key("concurrent-owner-a-hold");
      const ownerRequests = await Promise.all([
        holdRequest(actors.owner, projects.ownerA, duplicateKey),
        holdRequest(actors.owner, projects.ownerA, duplicateKey),
        holdRequest(actors.owner, projects.ownerB, key("concurrent-owner-b-hold")),
      ]);
      const ownerAccepted = ownerRequests.filter(({ status }) => status === 201);
      const ownerDenied = ownerRequests.filter(({ status }) => status === 409);
      expectScenario(
        ownerRequests[0].status === ownerRequests[1].status &&
          (ownerRequests[0].status === 201
            ? JSON.stringify(ownerRequests[0].payload) === JSON.stringify(ownerRequests[1].payload)
            : ownerRequests[0].payload?.error?.code === ownerRequests[1].payload?.error?.code) &&
          new Set(ownerAccepted.map(({ payload }) => payload.hold.project_id)).size === 1 &&
          ownerDenied.length >= 1 &&
          ownerDenied.every(({ payload }) => payload?.error?.code === "entitlement_capacity_exhausted"),
        "concurrent duplicate and distinct owner holds serialize at one entitled slot",
        { statuses: ownerRequests.map(({ status }) => status), stable_duplicate_replay: false },
      );
      const ownerFixture = ownerAccepted[0].payload.hold.project_id === projects.ownerA.graph.project.id
        ? projects.ownerA
        : projects.ownerB;
      admitted.ownerFixture = ownerFixture;
      admitted.ownerHold = ownerAccepted[0].payload.hold;
      assertNoExecution(ownerAccepted[0].payload, "capacity hold enqueues no execution");
      const ownerAdmissionKey = key("owner-first-admission");
      const ownerAdmissions = await Promise.all([
        admitRequest(actors.owner, ownerFixture, admitted.ownerHold.id, ownerAdmissionKey),
        admitRequest(actors.owner, ownerFixture, admitted.ownerHold.id, ownerAdmissionKey),
      ]);
      expectScenario(
        JSON.stringify(ownerAdmissions.map(({ status }) => status).sort()) === JSON.stringify([200, 201]) &&
          JSON.stringify(ownerAdmissions[0].payload) === JSON.stringify(ownerAdmissions[1].payload),
        "concurrent exact admission retry returns one durable reservation",
        { statuses: ownerAdmissions.map(({ status }) => status), stable_replay: false },
      );
      admitted.ownerReservation = ownerAdmissions[0].payload.reservation;
      assertNoExecution(ownerAdmissions[0].payload, "initial admission records later intent only");

      const otherHold = await holdRequest(actors.other, projects.otherA, key("other-a-hold"));
      assertStatus(otherHold, 201, "second platform capacity hold");
      assertNoExecution(otherHold.payload, "second platform hold enqueues no execution");
      const otherAdmission = await admitRequest(
        actors.other,
        projects.otherA,
        otherHold.payload.hold.id,
        key("other-a-admission"),
      );
      assertStatus(otherAdmission, 201, "second platform capacity admission");
      assertNoExecution(otherAdmission.payload, "second initial admission enqueues no execution");
      admitted.otherReservation = otherAdmission.payload.reservation;
      const platformDenied = await holdRequest(actors.other, projects.otherB, key("platform-exhausted"));
      assertCode(platformDenied, 409, "platform_capacity_exhausted", "platform capacity exhaustion");

      const wrongOwnerRead = await call(
        `/v1/projects/${ownerFixture.graph.project.id}/slot-reservation`,
        { token: actors.other.token },
      );
      assertStatus(wrongOwnerRead, 404, "cross-owner reservation read denied");

      await switchApi(currentApiBinary, "M2 admission acceptance-response restart");
      const reservationRead = await call(
        `/v1/projects/${ownerFixture.graph.project.id}/slot-reservation`,
        { token: actors.owner.token },
      );
      assertStatus(reservationRead, 200, "reservation survives API restart");
      expectScenario(
        reservationRead.payload.id === admitted.ownerReservation.id &&
          reservationRead.payload.reservation_epoch === admitted.ownerReservation.reservation_epoch,
        "restart reads the exact accepted reservation",
        { reservation_match: false },
      );
      const entitlement = await call("/v1/entitlements/current", { token: actors.owner.token });
      assertStatus(entitlement, 200, "owner entitlement read");
      assertSyntheticEntitlement(entitlement.payload, periodStart, periodEnd, "owner-visible synthetic entitlement totals");
      const sql = await postgres.psqlJson(
        "m2-admission-concurrent-first-deploy",
        `SELECT json_build_object(
          'owner_reservations',(SELECT COUNT(*)::int FROM slot_reservations WHERE account_id=${sqlString(actors.owner.record.id)} AND state='reserved'),
          'other_reservations',(SELECT COUNT(*)::int FROM slot_reservations WHERE account_id=${sqlString(actors.other.record.id)} AND state='reserved'),
          'initial_hold_rows',(SELECT COUNT(*)::int FROM capacity_holds WHERE kind='initial' AND project_id IN (${Object.values(projects).map(({ graph }) => sqlString(graph.project.id)).join(",")})),
          'active_initial_holds',(SELECT COUNT(*)::int FROM capacity_holds WHERE kind='initial' AND state='active'),
          'admission_jobs',(SELECT COUNT(*)::int FROM jobs WHERE project_id IN (${Object.values(projects).map(({ graph }) => sqlString(graph.project.id)).join(",")})),
          'github_bindings',(SELECT COUNT(*)::int FROM github_repository_bindings WHERE project_id IN (${Object.values(projects).map(({ graph }) => sqlString(graph.project.id)).join(",")})),
          'orphan_reservations',(SELECT COUNT(*)::int FROM slot_reservations r LEFT JOIN projects p ON p.id=r.project_id AND p.account_id=r.account_id WHERE p.id IS NULL),
          'orphan_holds',(SELECT COUNT(*)::int FROM capacity_holds h LEFT JOIN deployments d ON d.id=h.deployment_id AND d.project_id=h.project_id AND d.account_id=h.account_id WHERE d.id IS NULL)
        );`,
      );
      expectScenario(
        sql.owner_reservations === 1 &&
          sql.other_reservations === 1 &&
          sql.initial_hold_rows === 2 &&
          sql.active_initial_holds === 0 &&
          sql.admission_jobs === 0 &&
          sql.github_bindings === 0 &&
          sql.orphan_reservations === 0 &&
          sql.orphan_holds === 0 &&
          entitlement.payload.hosted_slots_used === 1,
        "independent SQL proves bounded reservations, referential integrity, and no job",
        { ...sql, owner_visible_slots: entitlement.payload.hosted_slots_used },
      );
      return {
        owner_request_statuses: ownerRequests.map(({ status }) => status),
        owner_reservations: sql.owner_reservations,
        platform_reservations: sql.owner_reservations + sql.other_reservations,
        no_entitlement_code: noEntitlement.payload.error.code,
        revoked_binding_code: revokedBindingProof.payload.error.code,
        wrong_exact_source_code: wrongExactSource.payload.error.code,
        stale_inventory_code: staleInventoryProof.payload.error.code,
        stale_configuration_code: staleConfigurationProof.payload.error.code,
        wrong_account_status: wrongAccountHold.status,
        public_status: publicHold.status,
        platform_exhaustion_code: platformDenied.payload.error.code,
        restart_reservation_match: true,
        execution_enqueued: false,
        source_boundary: "synthetic_internal_not_github_grant",
        admission_jobs: sql.admission_jobs,
        relationship_violations: sql.orphan_reservations + sql.orphan_holds,
      };
    },
  );

  await admissionStep(
    context,
    "M2-ADMISSION-02",
    "retained resources preserve a slot across restart, redeploy and rollback reuse it with separately accounted rollout headroom, and only exact trusted cleanup releases it idempotently",
    async () => {
      const ownerFixture = admitted.ownerFixture;
      const originalDeployment = ownerFixture.deployment;
      const originalSourceCommit = ownerFixture.sourceCommit;
      const originalHealthy = await observe(
        actors.owner,
        ownerFixture,
        admitted.ownerReservation,
        "deployment_healthy",
        { resource_inventory: "runtime", proof_ref: "fixture/synthetic-healthy/original" },
      );
      assertStatus(originalHealthy, 200, "synthetic trusted healthy lifecycle observation");

      await createDeployment(actors.owner, ownerFixture, "owner-redeploy", "1".repeat(40));
      const unrelatedHealthy = await observe(
        actors.owner,
        ownerFixture,
        admitted.ownerReservation,
        "deployment_healthy",
        { resource_inventory: "runtime", proof_ref: "fixture/unlinked-deployment/1" },
      );
      assertCode(
        unrelatedHealthy,
        409,
        "observation_generation_mismatch",
        "unadmitted same-project deployment cannot mutate the reserved generation",
      );
      await seedProof(actors.owner, ownerFixture);
      const rolloutHold = await holdRequest(actors.owner, ownerFixture, key("redeploy-rollout-hold"));
      assertStatus(rolloutHold, 201, "redeploy rollout headroom hold");
      assertNoExecution(rolloutHold.payload, "redeploy hold enqueues no execution");
      expectScenario(
        rolloutHold.payload.hold.kind === "rollout" &&
          rolloutHold.payload.reservation?.id === admitted.ownerReservation.id &&
          rolloutHold.payload.reservation.reservation_epoch === admitted.ownerReservation.reservation_epoch,
        "redeploy uses rollout headroom while returning the same purchased slot",
        rolloutHold.payload,
      );
      const rolloutAdmission = await admitRequest(
        actors.owner,
        ownerFixture,
        rolloutHold.payload.hold.id,
        key("redeploy-rollout-admission"),
      );
      assertStatus(rolloutAdmission, 200, "redeploy rollout admission");
      assertNoExecution(rolloutAdmission.payload, "redeploy admission enqueues no execution");
      expectScenario(
        rolloutAdmission.payload.reservation.id === admitted.ownerReservation.id &&
          rolloutAdmission.payload.reservation.reservation_epoch === admitted.ownerReservation.reservation_epoch &&
          rolloutAdmission.payload.hold.state === "consumed",
        "redeploy reuses reservation while headroom remains consumed",
        { reservation_reused: false, hold_state: rolloutAdmission.payload.hold?.state },
      );
      const consumedHeadroom = await postgres.psqlJson(
        "m2-admission-consumed-rollout-headroom",
        `SELECT json_build_object(
          'consumed_rollout_holds',(SELECT COUNT(*)::int FROM capacity_holds WHERE capacity_pool_key=${sqlString(POOL_KEY)} AND kind='rollout' AND state='consumed'),
          'owner_active_reservations',(SELECT COUNT(*)::int FROM slot_reservations WHERE account_id=${sqlString(actors.owner.record.id)} AND state<>'released')
        );`,
      );
      expectScenario(
        consumedHeadroom.consumed_rollout_holds === 1 && consumedHeadroom.owner_active_reservations === 1,
        "consumed rollout headroom remains separately counted until trusted release",
        consumedHeadroom,
      );
      const unrelatedRelease = await observe(
        actors.owner,
        ownerFixture,
        admitted.ownerReservation,
        "rollout_released",
        {
          deployment_id: originalDeployment.id,
          resource_inventory: "none",
          proof_ref: "fixture/unlinked-rollout-release/1",
          rollout_hold_id: rolloutHold.payload.hold.id,
        },
      );
      assertCode(
        unrelatedRelease,
        409,
        "observation_generation_mismatch",
        "unrelated same-project deployment cannot release consumed rollout headroom",
      );
      const releasedRollout = await observe(
        actors.owner,
        ownerFixture,
        admitted.ownerReservation,
        "rollout_released",
        {
          resource_inventory: "none",
          proof_ref: "fixture/rollout-released/redeploy",
          rollout_hold_id: rolloutHold.payload.hold.id,
        },
      );
      assertStatus(releasedRollout, 200, "trusted redeploy headroom release");

      const current = await call(`/v1/projects/${ownerFixture.graph.project.id}`, { token: actors.owner.token });
      assertStatus(current, 200, "project before rollback intent");
      ownerFixture.graph = current.payload;
      const rollback = await call(`/v1/projects/${ownerFixture.graph.project.id}/rollback-intents`, {
        method: "POST",
        token: actors.owner.token,
        headers: mutationHeaders(key("rollback-intent"), projectRevision(ownerFixture.graph)),
        body: { target_deployment_id: originalDeployment.id },
      });
      assertStatus(rollback, 201, "rollback lifecycle intent");
      ownerFixture.graph = (await call(`/v1/projects/${ownerFixture.graph.project.id}`, { token: actors.owner.token })).payload;
      ownerFixture.deployment = originalDeployment;
      ownerFixture.sourceCommit = originalSourceCommit;
      await seedProof(actors.owner, ownerFixture);
      const rollbackHold = await holdRequest(actors.owner, ownerFixture, key("rollback-headroom-hold"));
      assertStatus(rollbackHold, 201, "rollback rollout headroom hold");
      assertNoExecution(rollbackHold.payload, "rollback hold enqueues no execution");
      expectScenario(rollbackHold.payload.hold.kind === "rollout", "rollback uses rollout headroom", {
        hold_kind: rollbackHold.payload.hold?.kind,
      });
      const rollbackAdmission = await admitRequest(
        actors.owner,
        ownerFixture,
        rollbackHold.payload.hold.id,
        key("rollback-admission"),
      );
      assertStatus(rollbackAdmission, 200, "rollback admission reuses slot");
      assertNoExecution(rollbackAdmission.payload, "rollback admission enqueues no execution");
      expectScenario(
        rollbackAdmission.payload.reservation.id === admitted.ownerReservation.id,
        "rollback preserves purchased reservation identity",
        { reservation_reused: false },
      );
      assertStatus(await observe(
        actors.owner,
        ownerFixture,
        admitted.ownerReservation,
        "rollout_released",
        {
          resource_inventory: "none",
          proof_ref: "fixture/rollout-released/rollback",
          rollout_hold_id: rollbackHold.payload.hold.id,
        },
      ), 200, "trusted rollback headroom release");

      const retainedEvent = randomUUID();
      const retained = await observe(
        actors.owner,
        ownerFixture,
        admitted.ownerReservation,
        "resources_retained",
        { event_id: retainedEvent, proof_ref: "fixture/db-retained/1" },
      );
      assertStatus(retained, 200, "retained database observation");
      const retainedReplay = await observe(
        actors.owner,
        ownerFixture,
        admitted.ownerReservation,
        "resources_retained",
        { event_id: retainedEvent, proof_ref: "fixture/db-retained/1" },
      );
      assertStatus(retainedReplay, 200, "retained observation replay");
      expectScenario(
        JSON.stringify(retained.payload) === JSON.stringify(retainedReplay.payload),
        "retained-resource observation is idempotent",
        { stable_replay: false },
      );
      await switchApi(currentApiBinary, "M2 retained-resource API restart");
      const retainedRead = await call(
        `/v1/projects/${ownerFixture.graph.project.id}/slot-reservation`,
        { token: actors.owner.token },
      );
      assertStatus(retainedRead, 200, "retained slot after restart");
      expectScenario(
        retainedRead.payload.id === admitted.ownerReservation.id &&
          retainedRead.payload.retention_reason !== null,
        "retained resource keeps exact slot with visible reason",
        { reservation_id: retainedRead.payload?.id, retention_reason: retainedRead.payload?.retention_reason },
      );

      const cleanupEvent = randomUUID();
      const cleanup = await observe(
        actors.owner,
        ownerFixture,
        admitted.ownerReservation,
        "cleanup_confirmed",
        { event_id: cleanupEvent, proof_ref: "fixture/cleanup-confirmed/1" },
      );
      assertStatus(cleanup, 200, "exact fenced cleanup releases slot");
      const cleanupReplay = await observe(
        actors.owner,
        ownerFixture,
        admitted.ownerReservation,
        "cleanup_confirmed",
        { event_id: cleanupEvent, proof_ref: "fixture/cleanup-confirmed/1" },
      );
      assertStatus(cleanupReplay, 200, "cleanup replay is harmless");
      const releasedGenerationHealthy = await observe(
        actors.owner,
        ownerFixture,
        admitted.ownerReservation,
        "deployment_healthy",
        {
          resource_inventory: "runtime",
          proof_ref: "fixture/released-generation-healthy/1",
        },
      );
      assertCode(
        releasedGenerationHealthy,
        409,
        "slot_reservation_released",
        "released reservation generation cannot accept a later healthy observation",
      );
      ownerFixture.graph = (await call(
        `/v1/projects/${ownerFixture.graph.project.id}`,
        { token: actors.owner.token },
      )).payload;
      const freshHold = await holdRequest(actors.owner, ownerFixture, key("fresh-epoch-hold"));
      assertStatus(freshHold, 201, "fresh initial hold after confirmed cleanup");
      assertNoExecution(freshHold.payload, "fresh initial hold enqueues no execution");
      expectScenario(freshHold.payload.hold.kind === "initial", "released project requires a fresh initial slot", {
        hold_kind: freshHold.payload.hold?.kind,
      });
      const freshAdmission = await admitRequest(
        actors.owner,
        ownerFixture,
        freshHold.payload.hold.id,
        key("fresh-epoch-admission"),
      );
      assertStatus(freshAdmission, 201, "fresh reservation after confirmed cleanup");
      assertNoExecution(freshAdmission.payload, "fresh initial admission enqueues no execution");
      const freshReservation = freshAdmission.payload.reservation;
      expectScenario(
        freshReservation.id !== admitted.ownerReservation.id &&
          freshReservation.reservation_epoch !== admitted.ownerReservation.reservation_epoch,
        "new admission has a distinct reservation and fence epoch",
        { fresh_reservation_and_epoch: false },
      );
      const staleCleanup = await observe(
        actors.owner,
        ownerFixture,
        freshReservation,
        "cleanup_confirmed",
        {
          reservation_epoch: admitted.ownerReservation.reservation_epoch,
          proof_ref: "fixture/stale-old-reservation-epoch/1",
        },
      );
      assertCode(staleCleanup, 409, "reservation_epoch_stale", "old reservation fence denied");
      const stillReserved = await call(
        `/v1/projects/${ownerFixture.graph.project.id}/slot-reservation`,
        { token: actors.owner.token },
      );
      assertStatus(stillReserved, 200, "old reservation epoch cannot release fresh slot");
      expectScenario(stillReserved.payload.id === freshReservation.id, "fresh reservation remains current", {
        current_reservation_id: stillReserved.payload?.id,
      });
      const freshCleanupEvent = randomUUID();
      assertStatus(await observe(
        actors.owner,
        ownerFixture,
        freshReservation,
        "cleanup_confirmed",
        { event_id: freshCleanupEvent, proof_ref: "fixture/fresh-cleanup-confirmed/1" },
      ), 200, "exact fresh reservation cleanup");
      assertStatus(await observe(
        actors.owner,
        ownerFixture,
        freshReservation,
        "cleanup_confirmed",
        { event_id: freshCleanupEvent, proof_ref: "fixture/fresh-cleanup-confirmed/1" },
      ), 200, "fresh cleanup duplicate is harmless");
      const releasedRead = await call(
        `/v1/projects/${ownerFixture.graph.project.id}/slot-reservation`,
        { token: actors.owner.token },
      );
      assertStatus(releasedRead, 404, "released reservation absent from active read");
      const sql = await postgres.psqlJson(
        "m2-admission-lifecycle-accounting",
        `SELECT json_build_object(
          'owner_active_reservations',(SELECT COUNT(*)::int FROM slot_reservations WHERE account_id=${sqlString(actors.owner.record.id)} AND state='reserved'),
          'owner_released_reservations',(SELECT COUNT(*)::int FROM slot_reservations WHERE account_id=${sqlString(actors.owner.record.id)} AND state='released'),
          'active_rollout_holds',(SELECT COUNT(*)::int FROM capacity_holds WHERE account_id=${sqlString(actors.owner.record.id)} AND kind='rollout' AND state='active'),
          'consumed_or_released_rollout_holds',(SELECT COUNT(*)::int FROM capacity_holds WHERE account_id=${sqlString(actors.owner.record.id)} AND kind='rollout' AND state<>'active'),
          'observation_rows',(SELECT COUNT(*)::int FROM admission_resource_observations WHERE account_id=${sqlString(actors.owner.record.id)}),
          'jobs',(SELECT COUNT(*)::int FROM jobs WHERE project_id=${sqlString(ownerFixture.graph.project.id)})
        );`,
      );
      expectScenario(
        sql.owner_active_reservations === 0 &&
          sql.owner_released_reservations === 2 &&
          sql.active_rollout_holds === 0 &&
          sql.consumed_or_released_rollout_holds === 2 &&
          sql.observation_rows >= 4 &&
          sql.jobs === 0,
        "SQL lifecycle totals preserve one purchased slot and separately release rollout headroom",
        sql,
      );
      return {
        retained_after_restart: true,
        redeploy_reservation_reused: true,
        rollback_reservation_reused: true,
        unrelated_observation_code: unrelatedHealthy.payload.error.code,
        unrelated_release_code: unrelatedRelease.payload.error.code,
        released_generation_code: releasedGenerationHealthy.payload.error.code,
        rollout_holds_released: sql.consumed_or_released_rollout_holds,
        stale_cleanup_code: staleCleanup.payload.error.code,
        active_slots_after_cleanup: sql.owner_active_reservations,
        execution_enqueued: false,
      };
    },
  );

  await admissionStep(
    context,
    "M2-ADMISSION-03",
    "entitlement reduction, pool withdrawal, and hold expiry serialize against durable use; restart convergence loses no hold into a reservation and records reconciliation-only intent",
    async () => {
      const entitlementReduction = await seedEntitlement(actors.other, 0, 360);
      assertCode(entitlementReduction, 409, "entitlement_in_use", "entitlement reduction below reserved use");
      const capacityWithdrawal = await seedCapacity(0, 0);
      assertCode(capacityWithdrawal, 409, "capacity_in_use", "capacity withdrawal below reserved use");
      const changedPeriod = await internal("/internal/v1/admission/entitlements", {
        event_id: randomUUID(),
        account_id: actors.other.record.id,
        capacity_pool_key: POOL_KEY,
        hosted_slot_limit: 2,
        build_seconds_limit: 360,
        period_starts_at: periodStart,
        period_ends_at: new Date(Date.parse(periodEnd) + 86_400_000).toISOString(),
        state: "active",
      });
      assertCode(changedPeriod, 409, "entitlement_period_immutable", "entitlement period cannot be replaced");
      const alternatePool = await internal("/internal/v1/admission/capacity", {
        event_id: randomUUID(),
        pool_key: "m2-alternate",
        profile: PROFILE,
        hosted_slot_limit: 1,
        rollout_headroom_limit: 1,
      });
      assertStatus(alternatePool, 200, "alternate synthetic pool fixture");
      const changedPool = await internal("/internal/v1/admission/entitlements", {
        event_id: randomUUID(),
        account_id: actors.other.record.id,
        capacity_pool_key: "m2-alternate",
        hosted_slot_limit: 2,
        build_seconds_limit: 360,
        period_starts_at: periodStart,
        period_ends_at: periodEnd,
        state: "active",
      });
      assertCode(changedPool, 409, "entitlement_period_immutable", "entitlement pool cannot be replaced");

      const [racedHold, racedWithdrawal] = await Promise.all([
        holdRequest(actors.expiry, projects.expiry, key("raced-expiring-hold"), 5),
        seedCapacity(1, 1),
      ]);
      expectScenario(
        (racedHold.status === 201 &&
          racedWithdrawal.status === 409 &&
          racedWithdrawal.payload?.error?.code === "capacity_in_use") ||
          (racedHold.status === 409 &&
            racedHold.payload?.error?.code === "platform_capacity_exhausted" &&
            racedWithdrawal.status === 200),
        "capacity withdrawal and hold admission serialize in one durable order",
        { hold_status: racedHold.status, withdrawal_status: racedWithdrawal.status },
      );
      if (racedHold.status === 409) {
        assertCode(racedHold, 409, "platform_capacity_exhausted", "hold loses serialized capacity race");
      } else {
        assertCode(racedWithdrawal, 409, "capacity_in_use", "withdrawal loses serialized capacity race");
      }
      let expiryHold = racedHold;
      if (racedWithdrawal.status === 200) {
        assertStatus(await seedCapacity(2, 1), 200, "restore capacity after withdrawal wins race");
        expiryHold = await holdRequest(actors.expiry, projects.expiry, key("expiring-hold-after-race"), 5);
      }
      assertStatus(expiryHold, 201, "short-lived durable capacity hold");
      assertNoExecution(expiryHold.payload, "expiring hold enqueues no execution");
      await m2.stopApi("M2 hold expiry PostgreSQL restart");
      await postgres.stop();
      await postgres.start();
      await m2.startApi({ binary: currentApiBinary, label: "M2 hold expiry after PostgreSQL restart" });
      await context.delay(5_200);
      const reconcile = await internal("/internal/v1/admission/reconcile", {});
      assertStatus(reconcile, 200, "hold expiry reconciliation");
      expectScenario(
        Number.isInteger(reconcile.payload?.expired_holds) && reconcile.payload.expired_holds >= 0,
        "explicit reconciliation reports durable expiry work after startup reconciliation",
        reconcile.payload,
      );
      const expiredAdmission = await admitRequest(
        actors.expiry,
        projects.expiry,
        expiryHold.payload.hold.id,
        key("expired-hold-admission"),
      );
      assertCode(expiredAdmission, 409, "capacity_hold_expired", "expired hold cannot become a reservation");
      const expiryReservation = await call(
        `/v1/projects/${projects.expiry.graph.project.id}/slot-reservation`,
        { token: actors.expiry.token },
      );
      assertStatus(expiryReservation, 404, "expired hold creates no active reservation");
      const entitlement = await call("/v1/entitlements/current", { token: actors.other.token });
      assertStatus(entitlement, 200, "entitlement remains after rejected reduction");
      assertSyntheticEntitlement(
        entitlement.payload,
        periodStart,
        periodEnd,
        "period and pool-backed synthetic entitlement remain immutable",
      );
      const sql = await postgres.psqlJson(
        "m2-admission-contention",
        `SELECT json_build_object(
          'other_slot_limit',(SELECT hosted_slot_limit::int FROM admission_entitlements WHERE account_id=${sqlString(actors.other.record.id)} AND state='active'),
          'period_starts_at',(SELECT period_starts_at FROM admission_entitlements WHERE account_id=${sqlString(actors.other.record.id)} AND state='active'),
          'period_ends_at',(SELECT period_ends_at FROM admission_entitlements WHERE account_id=${sqlString(actors.other.record.id)} AND state='active'),
          'pool_key',(SELECT capacity_pool_key FROM admission_entitlements WHERE account_id=${sqlString(actors.other.record.id)} AND state='active'),
          'pool_limit',(SELECT hosted_slot_limit::int FROM admission_capacity_pools WHERE pool_key=${sqlString(POOL_KEY)}),
          'expired_hold_rows',(SELECT COUNT(*)::int FROM capacity_holds WHERE id=${sqlString(expiryHold.payload.hold.id)} AND state='expired'),
          'expiry_reservations',(SELECT COUNT(*)::int FROM slot_reservations WHERE project_id=${sqlString(projects.expiry.graph.project.id)} AND state='reserved'),
          'reconciliation_intents',(SELECT COUNT(*)::int FROM admission_reconciliation_intents WHERE account_id=${sqlString(actors.expiry.record.id)} AND project_id=${sqlString(projects.expiry.graph.project.id)} AND kind='refund_required' AND reason='hold_expired' AND state='pending')
        );`,
      );
      expectScenario(
        sql.other_slot_limit === 2 &&
          Date.parse(sql.period_starts_at) === Date.parse(periodStart) &&
          Date.parse(sql.period_ends_at) === Date.parse(periodEnd) &&
          sql.pool_key === POOL_KEY &&
          sql.pool_limit === 2 &&
          sql.expired_hold_rows === 1 &&
          sql.expiry_reservations === 0 &&
          sql.reconciliation_intents === 1,
        "SQL proves immutable entitlement period/pool and lost-hold reconciliation without admission",
        sql,
      );
      return {
        entitlement_reduction_code: entitlementReduction.payload.error.code,
        capacity_withdrawal_code: capacityWithdrawal.payload.error.code,
        immutable_period_code: changedPeriod.payload.error.code,
        immutable_pool_code: changedPool.payload.error.code,
        expired_holds: reconcile.payload.expired_holds,
        expiry_reservations: sql.expiry_reservations,
        reconciliation_intents: sql.reconciliation_intents,
        live_billing_operations: 0,
        live_resource_operations: 0,
      };
    },
  );

  await admissionStep(
    context,
    "M2-ADMISSION-04",
    "concurrent logical build retries debit once, one verified platform-fault credit applies exactly once, mismatched/repeated credits fail safely, and exhaustion leaves the existing slot intact without executing a build",
    async () => {
      const debitEvent = randomUUID();
      const attemptOne = randomUUID();
      const debitBody = {
        event_id: debitEvent,
        account_id: actors.other.record.id,
        project_id: projects.otherA.graph.project.id,
        deployment_id: projects.otherA.deployment.id,
        attempt_id: attemptOne,
        kind: "debit",
        seconds: 120,
        debit_event_id: null,
        platform_fault_ref: null,
      };
      const duplicateDebits = await Promise.all([
        internal("/internal/v1/admission/build-usage", debitBody),
        internal("/internal/v1/admission/build-usage", debitBody),
      ]);
      expectScenario(
        duplicateDebits.every(({ status }) => status === 200) &&
          JSON.stringify(duplicateDebits[0].payload) === JSON.stringify(duplicateDebits[1].payload),
        "concurrent exact build debit replay is stable",
        { statuses: duplicateDebits.map(({ status }) => status), stable_replay: false },
      );
      const duplicateAttemptBody = { ...debitBody, event_id: randomUUID() };
      const duplicateAttempt = await internal("/internal/v1/admission/build-usage", duplicateAttemptBody);
      assertCode(
        duplicateAttempt,
        409,
        "build_attempt_already_debited",
        "new event cannot debit the same logical attempt twice",
      );
      const duplicateAttemptReplay = await internal(
        "/internal/v1/admission/build-usage",
        duplicateAttemptBody,
      );
      assertCode(
        duplicateAttemptReplay,
        409,
        "build_attempt_already_debited",
        "duplicate-attempt conflict replay remains stable",
      );
      const mismatchedDuplicateAttempt = await internal("/internal/v1/admission/build-usage", {
        ...debitBody,
        event_id: randomUUID(),
        seconds: 119,
      });
      assertCode(
        mismatchedDuplicateAttempt,
        409,
        "build_attempt_already_debited",
        "changed duplicate attempt cannot bypass logical debit idempotency",
      );
      assertStatus(
        await seedEntitlement(actors.other, 2, 360, randomUUID(), "revoked"),
        200,
        "revoke synthetic entitlement while slot and debit remain",
      );
      const creditEvent = randomUUID();
      const creditBody = {
        event_id: creditEvent,
        account_id: actors.other.record.id,
        project_id: projects.otherA.graph.project.id,
        deployment_id: projects.otherA.deployment.id,
        attempt_id: attemptOne,
        kind: "platform_fault_credit",
        seconds: 120,
        debit_event_id: debitEvent,
        platform_fault_ref: "fixture/platform-fault/1",
      };
      const duplicateCredits = await Promise.all([
        internal("/internal/v1/admission/build-usage", creditBody),
        internal("/internal/v1/admission/build-usage", creditBody),
      ]);
      expectScenario(
        duplicateCredits.every(({ status }) => status === 200) &&
          JSON.stringify(duplicateCredits[0].payload) === JSON.stringify(duplicateCredits[1].payload),
        "verified fault credit replay applies exactly once",
        { statuses: duplicateCredits.map(({ status }) => status), stable_replay: false },
      );
      assertStatus(
        await seedEntitlement(actors.other, 2, 360),
        200,
        "reactivate immutable synthetic entitlement after fault credit",
      );
      const changedCredit = await internal("/internal/v1/admission/build-usage", {
        ...creditBody,
        seconds: 119,
      });
      assertCode(changedCredit, 409, "fixture_event_payload_changed", "same credit event with changed payload");
      const mismatchedCredit = await internal("/internal/v1/admission/build-usage", {
        ...creditBody,
        event_id: randomUUID(),
        seconds: 119,
        platform_fault_ref: "fixture/platform-fault/mismatch",
      });
      assertCode(
        mismatchedCredit,
        409,
        "platform_fault_credit_mismatch",
        "credit must exactly match its logical debit",
      );
      const secondCredit = await internal("/internal/v1/admission/build-usage", {
        ...creditBody,
        event_id: randomUUID(),
        platform_fault_ref: "fixture/platform-fault/duplicate",
      });
      assertCode(secondCredit, 409, "platform_fault_already_credited", "second credit for one debit denied");

      const debit = async (attemptId, seconds) => internal("/internal/v1/admission/build-usage", {
        event_id: randomUUID(),
        account_id: actors.other.record.id,
        project_id: projects.otherA.graph.project.id,
        deployment_id: projects.otherA.deployment.id,
        attempt_id: attemptId,
        kind: "debit",
        seconds,
        debit_event_id: null,
        platform_fault_ref: null,
      });
      assertStatus(await debit(randomUUID(), 120), 200, "separately accepted retry debit");
      assertStatus(await debit(randomUUID(), 240), 200, "remaining build allowance debit");
      const exhausted = await debit(randomUUID(), 1);
      assertCode(exhausted, 409, "build_allowance_exhausted", "exhausted allowance denies new build intent");
      const slot = await call(
        `/v1/projects/${projects.otherA.graph.project.id}/slot-reservation`,
        { token: actors.other.token },
      );
      assertStatus(slot, 200, "build exhaustion preserves existing deployment slot");
      const entitlement = await call("/v1/entitlements/current", { token: actors.other.token });
      assertStatus(entitlement, 200, "build usage owner totals");
      assertSyntheticEntitlement(
        entitlement.payload,
        periodStart,
        periodEnd,
        "build usage is synthetic and owner-visible",
      );
      const sql = await postgres.psqlJson(
        "m2-admission-build-meter",
        `SELECT json_build_object(
          'debits',(SELECT COUNT(*)::int FROM build_usage_events WHERE account_id=${sqlString(actors.other.record.id)} AND kind='debit'),
          'credits',(SELECT COUNT(*)::int FROM build_usage_events WHERE account_id=${sqlString(actors.other.record.id)} AND kind='platform_fault_credit'),
          'debited_seconds',(SELECT COALESCE(SUM(seconds),0)::int FROM build_usage_events WHERE account_id=${sqlString(actors.other.record.id)} AND kind='debit'),
          'credited_seconds',(SELECT COALESCE(SUM(seconds),0)::int FROM build_usage_events WHERE account_id=${sqlString(actors.other.record.id)} AND kind='platform_fault_credit'),
          'active_slots',(SELECT COUNT(*)::int FROM slot_reservations WHERE account_id=${sqlString(actors.other.record.id)} AND state='reserved'),
          'build_jobs',(SELECT COUNT(*)::int FROM jobs WHERE project_id=${sqlString(projects.otherA.graph.project.id)} AND operation='build')
        );`,
      );
      expectScenario(
        sql.debits === 3 &&
          sql.credits === 1 &&
          sql.debited_seconds === 480 &&
          sql.credited_seconds === 120 &&
          sql.active_slots === 1 &&
          sql.build_jobs === 0 &&
          entitlement.payload.build_seconds_debited === 480 &&
          entitlement.payload.build_seconds_credited === 120 &&
          entitlement.payload.build_seconds_remaining === 0,
        "independent SQL agrees with exactly-once owner-visible build meter",
        { ...sql, owner_visible: entitlement.payload },
      );
      return {
        debit_events: sql.debits,
        duplicate_attempt_code: duplicateAttempt.payload.error.code,
        credit_events: sql.credits,
        net_build_seconds: sql.debited_seconds - sql.credited_seconds,
        remaining_seconds: entitlement.payload.build_seconds_remaining,
        exhaustion_code: exhausted.payload.error.code,
        mismatched_credit_code: mismatchedCredit.payload.error.code,
        active_slots_after_exhaustion: sql.active_slots,
        executed_build_jobs: sql.build_jobs,
      };
    },
  );

  await admissionStep(
    context,
    "M2-ADMISSION-05",
    "duplicate and out-of-order reconciliation plus retained-M1 and current-process restarts converge from PostgreSQL to the same entitlement, capacity, slot, hold, and meter totals without a memory-only acceptance",
    async () => {
      await switchApi(retainedM1Binary, "retained M1 admission-state preservation");
      const retainedRead = await call(`/v1/projects/${projects.otherA.graph.project.id}`, {
        token: actors.other.token,
      });
      assertStatus(retainedRead, 200, "retained M1 reads project while M2 reservation remains durable");
      const retainedSql = await postgres.psqlJson(
        "m2-admission-retained-binary-state",
        `SELECT json_build_object(
          'active_slots',(SELECT COUNT(*)::int FROM slot_reservations WHERE account_id=${sqlString(actors.other.record.id)} AND state='reserved'),
          'net_build_seconds',(
            (SELECT COALESCE(SUM(seconds),0)::int FROM build_usage_events WHERE account_id=${sqlString(actors.other.record.id)} AND kind='debit') -
            (SELECT COALESCE(SUM(seconds),0)::int FROM build_usage_events WHERE account_id=${sqlString(actors.other.record.id)} AND kind='platform_fault_credit')
          )
        );`,
      );
      expectScenario(
        retainedSql.active_slots === 1 && retainedSql.net_build_seconds === 360,
        "retained M1 process leaves M2 slot and meter rows untouched",
        retainedSql,
      );
      await switchApi(currentApiBinary, "current M2 admission reconciliation resume");
      const reconciles = await Promise.all([
        internal("/internal/v1/admission/reconcile", {}),
        internal("/internal/v1/admission/reconcile", {}),
      ]);
      expectScenario(
        reconciles.every(({ status }) => status === 200),
        "duplicate reconcile requests succeed",
        { statuses: reconciles.map(({ status }) => status) },
      );
      const staleCleanup = await observe(
        actors.other,
        projects.otherA,
        admitted.otherReservation,
        "cleanup_confirmed",
        { reservation_epoch: randomUUID(), proof_ref: "fixture/out-of-order-cleanup/1" },
      );
      assertCode(staleCleanup, 409, "reservation_epoch_stale", "out-of-order old fence cannot release live slot");
      const reservation = await call(
        `/v1/projects/${projects.otherA.graph.project.id}/slot-reservation`,
        { token: actors.other.token },
      );
      assertStatus(reservation, 200, "current process observes retained live slot");
      const entitlement = await call("/v1/entitlements/current", { token: actors.other.token });
      assertStatus(entitlement, 200, "current process owner totals after convergence");
      assertSyntheticEntitlement(
        entitlement.payload,
        periodStart,
        periodEnd,
        "converged owner totals remain synthetic",
      );
      const sql = await postgres.psqlJson(
        "m2-admission-restart-convergence",
        `SELECT json_build_object(
          'active_slots',(SELECT COUNT(*)::int FROM slot_reservations WHERE account_id=${sqlString(actors.other.record.id)} AND state='reserved'),
          'active_initial_holds',(SELECT COUNT(*)::int FROM capacity_holds WHERE account_id=${sqlString(actors.other.record.id)} AND kind='initial' AND state='active'),
          'active_rollout_holds',(SELECT COUNT(*)::int FROM capacity_holds WHERE account_id=${sqlString(actors.other.record.id)} AND kind='rollout' AND state='active'),
          'debited_seconds',(SELECT COALESCE(SUM(seconds),0)::int FROM build_usage_events WHERE account_id=${sqlString(actors.other.record.id)} AND kind='debit'),
          'credited_seconds',(SELECT COALESCE(SUM(seconds),0)::int FROM build_usage_events WHERE account_id=${sqlString(actors.other.record.id)} AND kind='platform_fault_credit'),
          'orphan_slots',(SELECT COUNT(*)::int FROM slot_reservations r LEFT JOIN projects p ON p.id=r.project_id AND p.account_id=r.account_id WHERE p.id IS NULL),
          'orphan_usage',(SELECT COUNT(*)::int FROM build_usage_events u LEFT JOIN deployments d ON d.id=u.deployment_id AND d.project_id=u.project_id AND d.account_id=u.account_id WHERE d.id IS NULL),
          'audit_rows',(SELECT COUNT(*)::int FROM audit_events WHERE account_id=${sqlString(actors.other.record.id)} AND event_type LIKE 'admission.%')
        );`,
      );
      expectScenario(
        sql.active_slots === 1 &&
          sql.active_initial_holds === 0 &&
          sql.active_rollout_holds === 0 &&
          sql.debited_seconds === entitlement.payload.build_seconds_debited &&
          sql.credited_seconds === entitlement.payload.build_seconds_credited &&
          sql.active_slots === entitlement.payload.hosted_slots_used &&
          sql.orphan_slots === 0 &&
          sql.orphan_usage === 0 &&
          sql.audit_rows > 0,
        "PostgreSQL and public totals converge with complete relationships and audit trail",
        { ...sql, owner_visible: entitlement.payload },
      );
      return {
        retained_binary_project_status: retainedRead.status,
        duplicate_reconcile_statuses: reconciles.map(({ status }) => status),
        stale_cleanup_code: staleCleanup.payload.error.code,
        active_slots: sql.active_slots,
        active_holds: sql.active_initial_holds + sql.active_rollout_holds,
        debited_seconds: sql.debited_seconds,
        credited_seconds: sql.credited_seconds,
        relationship_violations: sql.orphan_slots + sql.orphan_usage,
        audit_rows: sql.audit_rows,
      };
    },
  );
}
