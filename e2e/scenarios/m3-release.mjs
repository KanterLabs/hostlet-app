import { isDeepStrictEqual } from "node:util";
import { expectScenario } from "../support/http-client.mjs";
import { readActiveRoute } from "../support/m3-release.mjs";

export const M3_RELEASE_REQUIRED_ASSERTIONS = Object.freeze([
  "M3-RELEASE-01", "M3-RELEASE-02", "M3-RELEASE-03", "M3-RELEASE-03-STOPPED",
]);

function assertResult(name, condition, evidence) {
  expectScenario(condition, name, evidence);
}

const RELEASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RELEASE_DIGEST = /^sha256:[0-9a-f]{64}$/;

function exactRouteManifest(result, route, history, previousReleaseId, retainedAssets) {
  const release = result.release;
  const expectedFrontend = result.frontendDigest === null ? null : {
    archive_digest: result.frontendDigest, manifest_digest: result.frontendManifestDigest,
  };
  const expectedBackend = {
    backend_ref: `runtime-allocation:${release.runtime_allocation_id}:${release.runtime_generation}:${release.runtime_fence}`,
    allocation_id: release.runtime_allocation_id, generation: release.runtime_generation, fence: release.runtime_fence,
    artifact_digest: result.backendDigest, artifact_manifest_digest: result.backendManifestDigest,
  };
  const expectedDatabase = {
    tenant_database_id: release.tenant_database_id, database_generation: release.database_generation,
    migration_id: release.migration_id ?? null, migration_revision: release.migration_revision ?? null,
    migration_digest: release.migration_digest ?? null, migration_artifact_path: release.migration_artifact_path ?? null,
  };
  const expectedHealth = {
    staged_health_observation_id: release.staged_health_observation_id,
    staged_health_receipt_digest: release.staged_health_receipt_digest,
  };
  const expected = {
    schema: "hostlet.route-manifest/v1", project_id: result.projectId, release_id: result.releaseId,
    deployment_id: release.deployment_id, generation: history.current_route.generation,
    source_commit: release.source_commit, frontend: expectedFrontend, backend: expectedBackend,
    database: expectedDatabase, configuration_revision_id: release.configuration_revision_id,
    secret_version_refs: release.secret_version_refs, previous_release_id: previousReleaseId,
    retained_assets: retainedAssets, drain_expires_at: history.current_route.drain_expires_at,
    health: expectedHealth,
  };
  const exactTopLevel = Object.keys(route.manifest).sort().join(",") === Object.keys(expected).sort().join(",");
  const exactIdentity = route.digest === result.routeManifestDigest &&
    RELEASE_UUID.test(expected.project_id ?? "") && RELEASE_UUID.test(expected.release_id ?? "") &&
    RELEASE_UUID.test(expected.deployment_id ?? "") && Number.isSafeInteger(expected.generation) && expected.generation > 0 &&
    typeof expected.source_commit === "string" && expected.source_commit.length > 0 &&
    validDigest(expected.frontend?.archive_digest) && validDigest(expected.frontend?.manifest_digest) &&
    validDigest(expected.backend?.artifact_digest) && validDigest(expected.backend?.artifact_manifest_digest) &&
    RELEASE_UUID.test(expected.backend?.allocation_id ?? "") && Number.isSafeInteger(expected.backend?.generation) && expected.backend.generation > 0 &&
    Number.isSafeInteger(expected.backend?.fence) && expected.backend.fence > 0 &&
    expected.backend.backend_ref === `runtime-allocation:${expected.backend.allocation_id}:${expected.backend.generation}:${expected.backend.fence}` &&
    RELEASE_UUID.test(expected.database?.tenant_database_id ?? "") && RELEASE_UUID.test(expected.database?.database_generation ?? "") &&
    (expected.database.migration_id === null || RELEASE_UUID.test(expected.database.migration_id)) &&
    (expected.database.migration_digest === null || validDigest(expected.database.migration_digest)) &&
    RELEASE_UUID.test(expected.configuration_revision_id ?? "") && Array.isArray(expected.secret_version_refs) &&
    (expected.previous_release_id === null || RELEASE_UUID.test(expected.previous_release_id)) &&
    Array.isArray(expected.retained_assets) && expected.retained_assets.every((asset) => RELEASE_UUID.test(asset.release_id ?? "") &&
      validDigest(asset.archive_digest) && validDigest(asset.manifest_digest)) &&
    typeof expected.drain_expires_at === "string" && Date.parse(expected.drain_expires_at) > Date.now() &&
    RELEASE_UUID.test(expected.health.staged_health_observation_id ?? "") && validDigest(expected.health.staged_health_receipt_digest);
  return exactTopLevel && exactIdentity && isDeepStrictEqual(route.manifest, expected);
}

function validDigest(value) {
  return typeof value === "string" && RELEASE_DIGEST.test(value);
}

/**
 * Exercise HOST-226 over the real build/runtime/database/control/gateway
 * boundaries. The composite M3 harness supplies the already-started workers
 * and fixture-specific build/runtime/database operations; this scenario owns
 * the release assertions and never fabricates an internal completion.
 */
export async function runM3ReleaseScenarios(context, m3, harness) {
  context.registerFixture("M3 coordinated release scenario", "e2e/scenarios/m3-release.mjs");
  context.registerFixture("M3 release worker support", "e2e/support/m3-release.mjs");
  context.registerFixture("M3 release Chromium driver", "e2e/support/interactive-browser.mjs");
  for (const path of ["scripts/release/hostlet-release-coordinator.py", "scripts/release/hostlet-release-gateway.py"]) {
    context.registerFixture(`M3 release executable: ${path}`, path);
  }
  if (!harness || typeof harness.promote !== "function" || typeof harness.rollback !== "function") {
    throw new Error("M3 release scenario requires the composite real build/runtime/database harness");
  }

  const first = await harness.promote("fullstack_v1");
  const route1 = readActiveRoute(m3.policyClock.stateDir, first.projectId);
  const history1 = await harness.releaseHistory(first.projectId);
  assertResult("m3-release-exact-artifacts",
    route1.manifest.release_id === first.releaseId &&
      route1.manifest.frontend?.archive_digest === first.frontendDigest &&
      route1.manifest.backend?.artifact_digest === first.backendDigest &&
      route1.digest === first.routeManifestDigest,
    { release_id: first.releaseId, source_commit: first.sourceCommit, frontend_digest: first.frontendDigest,
      backend_digest: first.backendDigest, route_manifest_digest: route1.digest });
  assertResult("m3-release-exact-manifest-v1",
    exactRouteManifest(first, route1, history1, null, []),
    { manifest: route1.manifest, release: first.release, route_manifest_digest: route1.digest });
  assertResult("m3-release-managed-https",
    first.gateway.origin.startsWith("https://") && first.gateway.hostname.endsWith(".localowned.test") && first.gateway.address === "127.0.0.1",
    { scheme: "https", hostname: first.gateway.hostname, address: first.gateway.address });

  const oldClient = harness.client(first.gateway);
  const oldPage = await oldClient.request("/");
  const oldItems = await oldClient.request("/api/items");
  const oldBrowser = await harness.openBrowser("m3-release-v1-client");
  const oldBrowserInitial = await oldBrowser.observe("m3-release-v1-initial");
  const initialPairPassed = oldPage.status === 200 && oldItems.status === 200 && oldItems.json().api_version === "api-v1";
  assertResult("m3-release-atomic-coordination", initialPairPassed,
    { route_generation: route1.manifest.generation, frontend_release: "frontend-v1", backend_release: oldItems.json().api_version });
  const initialBrowserPairPassed = oldBrowserInitial.release === "frontend-v1 using api-v1" && oldBrowserInitial.resources.some(({ name }) => name.endsWith("/api/items"));
  assertResult("m3-release-browser-initial-pair", initialBrowserPairPassed,
    { release: oldBrowserInitial.release, screenshot: oldBrowserInitial.screenshot, dom: oldBrowserInitial.dom, network: oldBrowserInitial.network });

  await oldBrowser.createItem("before-v2");
  const populated = await oldClient.request("/api/items");
  const beforeMigration = populated.json().items.find((item) => item.name === "before-v2");
  assertResult("m3-release-browser-populates-database", Boolean(beforeMigration?.id), { item_id: beforeMigration?.id ?? null });
  const second = await harness.promote("fullstack_v2");
  const route2 = readActiveRoute(m3.policyClock.stateDir, first.projectId);
  const history2 = await harness.releaseHistory(first.projectId);
  const newClient = harness.client(second.gateway);
  const newPage = await newClient.request("/");
  const newAgainstNew = await newClient.request("/api/items");
  const newBrowser = await harness.openBrowser("m3-release-v2-client");
  const newBrowserEvidence = await newBrowser.observe("m3-release-v2-active");
  await oldBrowser.selectRelease(second.releaseId);
  const cachedOldAgainstNew = await oldBrowser.createItem("cached-v1-against-v2");
  await newBrowser.selectRelease(first.releaseId);
  const newAgainstRetained = await newBrowser.createItem("new-v2-against-retained-v1");
  const activeApiAfterCross = await newClient.request("/api/items");
  const retainedApi = await harness.requestRetainedApi(second, first.releaseId, "/api/items");
  const newAgainstNewPayload = newAgainstNew.status === 200 ? newAgainstNew.json() : null;
  const activeApiAfterCrossPayload = activeApiAfterCross.status === 200 ? activeApiAfterCross.json() : null;
  const retainedApiPayload = retainedApi.status === 200 ? retainedApi.json() : null;
  const overlapPassed =
    oldPage.status === 200 && oldPage.text().includes("frontend-v1") &&
      cachedOldAgainstNew.release === "frontend-v1 using api-v2" &&
      cachedOldAgainstNew.rows.some(({ text }) => text === "cached-v1-against-v2") &&
      newPage.status === 200 && newPage.text().includes("frontend-v2") && newAgainstNewPayload?.api_version === "api-v2" &&
      newAgainstRetained.release === "frontend-v2 using api-v1" &&
      newAgainstRetained.rows.some(({ text }) => text === "new-v2-against-retained-v1") &&
      activeApiAfterCross.status === 200 && activeApiAfterCrossPayload?.api_version === "api-v2" &&
      Array.isArray(activeApiAfterCrossPayload?.items) && activeApiAfterCrossPayload.items.some(({ name }) => name === "cached-v1-against-v2") &&
      retainedApi.status === 200 && retainedApiPayload?.api_version === "api-v1" &&
      Array.isArray(retainedApiPayload?.items) && retainedApiPayload.items.some(({ name }) => name === "new-v2-against-retained-v1") &&
      Date.parse(route2.manifest.drain_expires_at) > Date.now() &&
      newBrowserEvidence.release === "frontend-v2 using api-v2";
  assertResult("m3-release-client-overlap", overlapPassed,
    { cached_old_frontend: cachedOldAgainstNew, cached_old_frontend_api: cachedOldAgainstNew.release,
      new_frontend_api: newAgainstNewPayload?.api_version ?? null,
      new_frontend_retained_api: newAgainstRetained, retained_api_version: retainedApiPayload?.api_version ?? null,
      active_api_after_cross: activeApiAfterCrossPayload, retained_api_after_cross: retainedApiPayload,
      drain_expires_at: route2.manifest.drain_expires_at,
      active_browser_release: newBrowserEvidence.release,
      cached_old_frontend_screenshot: cachedOldAgainstNew.screenshot, active_browser_screenshot: newBrowserEvidence.screenshot,
      cached_old_frontend_dom: cachedOldAgainstNew.dom, active_browser_dom: newBrowserEvidence.dom,
      cached_old_frontend_network: cachedOldAgainstNew.network, active_browser_network: newBrowserEvidence.network,
      new_frontend_retained_screenshot: newAgainstRetained.screenshot,
      new_frontend_retained_dom: newAgainstRetained.dom, new_frontend_retained_network: newAgainstRetained.network });
  const exactManifestV2Passed = exactRouteManifest(second, route2, history2, first.releaseId, [{
      release_id: first.releaseId, archive_digest: first.frontendDigest, manifest_digest: first.frontendManifestDigest,
    }]);
  assertResult("m3-release-exact-manifest-v2", exactManifestV2Passed,
    { manifest: route2.manifest, release: second.release, route_manifest_digest: route2.digest });
  const release01Passed = exactRouteManifest(first, route1, history1, null, []) && exactManifestV2Passed &&
    initialPairPassed && initialBrowserPairPassed && overlapPassed;
  context.assertion("M3-RELEASE-01", "M3 coordinated releases",
    "exact frontend/backend artifacts become one durable route only after real health checks; old/new clients remain compatible through bounded drain",
      { first_release_id: first.releaseId, second_release_id: second.releaseId, route_generation: route2.manifest.generation,
      managed_origin: second.gateway.origin, cached_old_frontend_api: cachedOldAgainstNew.release,
      new_frontend_api: newAgainstNewPayload?.api_version ?? null,
      new_frontend_retained_api: newAgainstRetained.release, retained_api_version: retainedApiPayload?.api_version ?? null,
      active_browser_release: newBrowserEvidence.release }, release01Passed);
  await oldBrowser.close();
  await newBrowser.close();
  const populatedMigrationPassed = second.backupVerified === true && second.backupReceiptPassed === true &&
      second.migrationPopulatedTrialPassed === true &&
      second.migrationTrialOperationCount === 1 && second.migrationTrialSucceededCount === 1 &&
      second.migrationLiveOperationCount === 1 && second.migrationLiveSucceededCount === 1 && second.migrationApplyCount === 1 &&
      validDigest(second.migrationTrialReceiptDigest) && validDigest(second.migrationApplyReceiptDigest) &&
      second.migrationDuplicateSafe === true && second.migrationCompetingWorkerFenced === true &&
      second.currentBinaryCompatible === true &&
      second.retainedBinariesCompatible === true && Array.isArray(newAgainstNewPayload?.items) &&
      newAgainstNewPayload.items.some((item) => item.id === beforeMigration.id);
  assertResult("m3-release-populated-migration", populatedMigrationPassed,
    { backup_archive_digest: second.backupArchiveDigest, migration_id: second.migrationId,
      trial_receipt_digest: second.migrationTrialReceiptDigest, live_apply_receipt_digest: second.migrationApplyReceiptDigest,
      trial_operation_count: second.migrationTrialOperationCount, live_operation_count: second.migrationLiveOperationCount,
      apply_count: second.migrationApplyCount, retained_binary_receipts: second.retainedBinaryReceiptDigests });

  const beforeArtifactCorruptionRoute = readActiveRoute(m3.policyClock.stateDir, first.projectId);
  const beforeArtifactCorruptionData = await harness.client(second.gateway).request("/api/items");
  const beforeArtifactCorruptionPayload = beforeArtifactCorruptionData.status === 200 ? beforeArtifactCorruptionData.json() : null;
  const corruptedCandidate = await harness.promote("fullstack_v1", { expectFailure: true, rebuild: true, corruptArtifact: true });
  const afterArtifactCorruptionRoute = readActiveRoute(m3.policyClock.stateDir, first.projectId);
  const afterArtifactCorruptionData = await harness.client(second.gateway).request("/api/items");
  const afterArtifactCorruptionPayload = afterArtifactCorruptionData.status === 200 ? afterArtifactCorruptionData.json() : null;
  const corruptionEvidence = corruptedCandidate.artifactCorruptionEvidence;
  const corruptedCandidatePassed = corruptedCandidate.state === "failed" && corruptedCandidate.code === "release_artifact_digest_mismatch" &&
    corruptedCandidate.failureEvidence?.release?.state === "failed" &&
    corruptedCandidate.failureEvidence?.release?.failure_code === "release_artifact_digest_mismatch" &&
    corruptedCandidate.failureEvidence?.reconciliation?.state === "failed" &&
    corruptedCandidate.failureEvidence?.reconciliation?.terminal_code === "release_artifact_digest_mismatch" &&
    corruptedCandidate.failureEvidence?.probe_receipt_count === 0 &&
    corruptionEvidence?.artifact_kind === "static" && corruptionEvidence.artifact_digest === corruptedCandidate.failureEvidence?.release?.frontend_digest &&
    validDigest(corruptionEvidence.artifact_digest) &&
    validDigest(corruptionEvidence.corrupted_digest) && corruptionEvidence.artifact_digest !== corruptionEvidence.corrupted_digest &&
    corruptionEvidence.restored === true && corruptionEvidence.restored_digest === corruptionEvidence.artifact_digest &&
    afterArtifactCorruptionRoute.digest === beforeArtifactCorruptionRoute.digest &&
    afterArtifactCorruptionRoute.manifest.release_id === beforeArtifactCorruptionRoute.manifest.release_id &&
    beforeArtifactCorruptionData.status === 200 && afterArtifactCorruptionData.status === 200 &&
    JSON.stringify(afterArtifactCorruptionPayload) === JSON.stringify(beforeArtifactCorruptionPayload);
  assertResult("m3-release-artifact-cas-corruption", corruptedCandidatePassed,
    { failed_release_id: corruptedCandidate.releaseId, failure_code: corruptedCandidate.code,
      failure_evidence: corruptedCandidate.failureEvidence, corruption: corruptionEvidence,
      before_route_manifest_digest: beforeArtifactCorruptionRoute.digest,
      after_route_manifest_digest: afterArtifactCorruptionRoute.digest,
      before_data: beforeArtifactCorruptionPayload, after_data: afterArtifactCorruptionPayload });

  const negativeAdmission = await harness.exerciseNegativeReleaseCases(second, first.releaseId);
  assertResult("m3-release-negative-admission",
    negativeAdmission.missingBackupQueued === true && negativeAdmission.missingBackupRejected === true &&
      negativeAdmission.artifactDigestMismatchRejected === true && negativeAdmission.migrationReferenceMismatchRejected === true &&
      negativeAdmission.expiredSecretRejected === true && negativeAdmission.routePreserved === true &&
      negativeAdmission.beforeRouteDigest === route2.digest && negativeAdmission.afterRouteDigest === route2.digest,
    negativeAdmission);
  const incompatibleMigration = await harness.promote("incompatible_migration", { expectFailure: true });
  const afterMigrationFailure = readActiveRoute(m3.policyClock.stateDir, first.projectId);
  const afterMigrationFailureData = await harness.client(second.gateway).request("/api/items");
  const incompatibleTrialCode = incompatibleMigration.migrationFailureEvidence?.trialFailureCode;
  const incompatibleMigrationPassed = incompatibleMigration.state === "failed" &&
    incompatibleMigration.failureEvidence?.reconciliation?.state === "failed" &&
    incompatibleMigration.failureEvidence?.reconciliation?.terminal_code === "migration_trial_failed" &&
    incompatibleMigration.migrationFailureEvidence?.passed === true &&
    incompatibleTrialCode === "migration_sql_not_admitted" &&
    afterMigrationFailure.digest === route2.digest && afterMigrationFailure.manifest.release_id === second.releaseId &&
    afterMigrationFailureData.status === 200 && afterMigrationFailureData.json().api_version === "api-v2" &&
    afterMigrationFailureData.json().items.some((item) => item.id === beforeMigration.id);
  assertResult("m3-release-incompatible-migration-trial", incompatibleMigrationPassed,
    { failed_release_id: incompatibleMigration.releaseId, failure_code: incompatibleMigration.code,
      trial_failure_code: incompatibleTrialCode, migration: incompatibleMigration.migrationFailureEvidence,
      active_release_id: afterMigrationFailure.manifest.release_id, route_manifest_digest: afterMigrationFailure.digest,
      current_data_api: afterMigrationFailureData.json().api_version, preserved_item_id: beforeMigration.id });
  const failed = await harness.promote("incompatible_api", { expectFailure: true });
  const afterFailure = readActiveRoute(m3.policyClock.stateDir, first.projectId);
  const afterFailureClient = harness.client(failed.gateway);
  const afterFailureData = await afterFailureClient.request("/api/items");
  const failedCandidatePassed = failed.state === "failed" && failed.failureEvidence?.release?.state === "failed" &&
      failed.failureEvidence?.reconciliation?.state === "failed" && failed.failureEvidence?.reconciliation?.terminal_code === "release_probe_failed" &&
      failed.failureEvidence?.probe_receipt_count > 0 && validDigest(failed.failureEvidence?.release?.staged_health_receipt_digest) &&
      afterFailure.manifest.release_id === second.releaseId && afterFailure.digest === route2.digest &&
      afterFailureData.status === 200 && afterFailureData.json().api_version === "api-v2" &&
      afterFailureData.json().items.some((item) => item.id === beforeMigration.id);
  assertResult("m3-release-rejection-preserves-last-good", failedCandidatePassed,
    { failed_release_id: failed.releaseId, failure_code: failed.code, failure_evidence: failed.failureEvidence,
      active_release_id: afterFailure.manifest.release_id, current_data_status: afterFailureData.status,
      current_data_api: afterFailureData.json().api_version, preserved_item_id: beforeMigration.id });
  const release02Passed = populatedMigrationPassed && corruptedCandidatePassed && incompatibleMigrationPassed && negativeAdmission.missingBackupQueued === true &&
    negativeAdmission.missingBackupRejected === true && negativeAdmission.artifactDigestMismatchRejected === true &&
    negativeAdmission.migrationReferenceMismatchRejected === true && negativeAdmission.expiredSecretRejected === true &&
    negativeAdmission.routePreserved === true && failedCandidatePassed;
  context.assertion("M3-RELEASE-02", "M3 coordinated releases",
    "fresh verified backup, exactly-once additive migration and current/retained application checks gate promotion; CAS corruption, independent admission negatives and incompatible candidates preserve the last good route",
    { backup_archive_digest: second.backupArchiveDigest, migration_id: second.migrationId,
      migration_apply_count: second.migrationApplyCount, retained_binary_receipts: second.retainedBinaryReceiptDigests,
      artifact_corruption: { passed: corruptedCandidatePassed, release_id: corruptedCandidate.releaseId, evidence: corruptionEvidence },
      negative_admission: negativeAdmission, incompatible_migration: incompatibleMigration.migrationFailureEvidence,
      incompatible_migration_release_id: incompatibleMigration.releaseId, rejected_release_id: failed.releaseId, failure_evidence: failed.failureEvidence,
      active_release_id: afterFailure.manifest.release_id, current_data_api: afterFailureData.json().api_version }, release02Passed);

  const third = await harness.promote("fullstack_v1", { rebuild: true });
  const history = await harness.releaseHistory(first.projectId);
  const rebuildMigration = third.migration;
  const rebuildNoDdlPassed = rebuildMigration?.id === null && rebuildMigration?.existingSchemaUnchanged === true &&
    rebuildMigration.existingSchemaMigrationId === second.migrationId &&
    rebuildMigration.existingSchemaTrialOperationCount === second.migrationTrialOperationCount &&
    rebuildMigration.existingSchemaLiveOperationCount === second.migrationLiveOperationCount &&
    Number.isSafeInteger(rebuildMigration.existingSchemaDataGenerationBefore) &&
    rebuildMigration.existingSchemaDataGenerationBefore === rebuildMigration.existingSchemaDataGenerationAfter &&
    rebuildMigration.existingSchemaEvidence?.before?.trial_operation_count === rebuildMigration.existingSchemaEvidence?.after?.trial_operation_count &&
    rebuildMigration.existingSchemaEvidence?.before?.live_operation_count === rebuildMigration.existingSchemaEvidence?.after?.live_operation_count;
  assertResult("m3-release-rebuild-no-ddl", rebuildNoDdlPassed,
    { migration_id: rebuildMigration?.existingSchemaMigrationId ?? null,
      trial_operation_count_before: rebuildMigration?.existingSchemaEvidence?.before?.trial_operation_count ?? null,
      trial_operation_count_after: rebuildMigration?.existingSchemaEvidence?.after?.trial_operation_count ?? null,
      live_operation_count_before: rebuildMigration?.existingSchemaEvidence?.before?.live_operation_count ?? null,
      live_operation_count_after: rebuildMigration?.existingSchemaEvidence?.after?.live_operation_count ?? null,
      data_generation_before: rebuildMigration?.existingSchemaDataGenerationBefore ?? null,
      data_generation_after: rebuildMigration?.existingSchemaDataGenerationAfter ?? null });
  assertResult("m3-release-retention",
    rebuildNoDdlPassed && history.successful.slice(0, 3).map(({ id }) => id).join(",") === [third.releaseId, second.releaseId, first.releaseId].join(",") &&
      !history.successful.some(({ id }) => id === failed.releaseId),
    { successful_release_ids: history.successful.map(({ id }) => id), failed_release_id: failed.releaseId,
      rebuild_no_ddl: rebuildMigration?.existingSchemaEvidence ?? null });

  const sincePromotion = await harness.writeItem(harness.client(third.gateway), { name: "after-v3" });
  const rollback = await harness.rollback(first.projectId, second.releaseId);
  const rolledClient = harness.client(rollback.gateway);
  const currentData = await rolledClient.request("/api/items");
  assertResult("m3-release-rollback-current-data",
    rollback.releaseId === second.releaseId && currentData.status === 200 && currentData.json().items.some((item) => item.id === sincePromotion.id),
    { rollback_release_id: rollback.releaseId, preserved_item_id: sincePromotion.id, data_restore_performed: rollback.dataRestorePerformed });
  assertResult("m3-release-no-live-restore", rollback.dataRestorePerformed === false && rollback.databaseGeneration === second.databaseGeneration,
    { data_restore_performed: rollback.dataRestorePerformed, database_generation: rollback.databaseGeneration });

  const beforeCrossOwner = await harness.releaseHistory(first.projectId);
  const crossOwnerAttempt = await m3.call(`/v1/projects/${first.projectId}/releases/${first.releaseId}/rollback`, {
    method: "POST", token: m3.state.other.token, headers: { "Idempotency-Key": "m3-release-cross-owner-rollback" }, body: {},
  });
  const afterCrossOwner = await harness.releaseHistory(first.projectId);
  const crossOwnerPassed = crossOwnerAttempt.status === 404 &&
    afterCrossOwner.current_route?.release_id === beforeCrossOwner.current_route?.release_id &&
    afterCrossOwner.current_route?.generation === beforeCrossOwner.current_route?.generation &&
    afterCrossOwner.releases.length === beforeCrossOwner.releases.length &&
    afterCrossOwner.releases.every((release, index) => release.id === beforeCrossOwner.releases[index].id && release.state === beforeCrossOwner.releases[index].state);
  assertResult("m3-release-cross-owner", crossOwnerPassed,
    { status: crossOwnerAttempt.status, error_code: crossOwnerAttempt.payload?.error?.code ?? null,
      before_route: beforeCrossOwner.current_route, after_route: afterCrossOwner.current_route });
  const fenced = await harness.exerciseRestartAndStaleCompletion(first.projectId);
  assertResult("m3-release-fencing-restart",
    fenced.staleCompletionRejected === true && fenced.concurrentWinnerCount === 1 && fenced.routeAfterRestart.release_id === fenced.winnerReleaseId,
    fenced);
  const concurrent = await harness.exerciseConcurrentPromotion(first.projectId);
  assertResult("m3-release-concurrent-promotion", concurrent.passed === true, concurrent);
  const release03Passed = rebuildNoDdlPassed && crossOwnerPassed && fenced.staleCompletionRejected === true && fenced.concurrentWinnerCount === 1 &&
    fenced.routeAfterRestart.release_id === fenced.winnerReleaseId && concurrent.passed === true;
  context.assertion("M3-RELEASE-03", "M3 coordinated releases",
    "current plus two successful predecessors are retained and an eligible prior binary rolls back against current data without restore; cross-owner, concurrent, stale and restart work remains fenced",
    { successful_release_ids: history.successful.map(({ id }) => id), rollback_release_id: rollback.releaseId,
      preserved_item_id: sincePromotion.id, data_restore_performed: rollback.dataRestorePerformed,
      cross_owner: { passed: crossOwnerPassed, status: crossOwnerAttempt.status },
      stale_completion_rejected: fenced.staleCompletionRejected, concurrent_winner_count: fenced.concurrentWinnerCount,
      concurrent_promotion: concurrent }, release03Passed);
}

export const scenario = Object.freeze({
  id: "m3-release",
  description: "HOST-226 actual coordinated release, overlap, failed candidate and rollback against current populated data",
  requiredAssertions: M3_RELEASE_REQUIRED_ASSERTIONS,
  async run(context) {
    const { runM3Context } = await import("../support/m3-context.mjs");
    await runM3Context(context, async (m3) => runM3ReleaseScenarios(context, m3, m3.state.releaseHarness));
  },
});
