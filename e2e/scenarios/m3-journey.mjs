import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { runM3Context } from "../support/m3-context.mjs";
import { registerM3BuildFixtures } from "../support/m3-build.mjs";
import { prepareM3Tls } from "../support/m3-tls.mjs";
import { createM3ReleaseHarness } from "../support/m3-release.mjs";
import { expectScenario } from "../support/http-client.mjs";
import { M3_UPGRADE_REQUIRED_ASSERTIONS } from "./m3-upgrade.mjs";
import { M3_BUILD_REQUIRED_ASSERTIONS, runM3BuildScenarios } from "./m3-build.mjs";
import { M3_DATA_REQUIRED_ASSERTIONS, createM3DataStage, registerM3DataFixtures } from "./m3-data.mjs";
import { M3_RUNTIME_REQUIRED_ASSERTIONS, runM3RuntimeScenarios } from "./m3-runtime.mjs";
import { M3_RELEASE_REQUIRED_ASSERTIONS, runM3ReleaseScenarios } from "./m3-release.mjs";
import { M3_APPROVAL_PUBLISH_REQUIRED_ASSERTIONS, runM3ApprovalPublishScenarios } from "./m3-approval-publish.mjs";

async function currentPresentation(m3) {
  const projectId = m3.state.graph.project.id;
  const history = await m3.ownerHTTP(`/v1/projects/${projectId}/releases`);
  const draft = await m3.ownerHTTP("/v1/portfolio/draft-revisions/latest");
  const activeId = history.payload?.current_route?.release_id;
  const release = history.payload?.releases?.find(({ id }) => id === activeId);
  const reference = draft.payload?.draft?.projects?.find((project) =>
    project.kind?.type === "hosted_project" && project.kind.project_id === projectId);
  expectScenario(history.status === 200 && draft.status === 200 && release?.state === "healthy" &&
    release.project_id === projectId && reference?.project_reference_id && release.managed_demo_url,
  "portfolio presentation references the actual current healthy release and saved project",
  { history_status: history.status, draft_status: draft.status, active_release_id: activeId ?? null,
    saved_reference_found: Boolean(reference), release_state: release?.state ?? null });
  return Object.freeze({ projectId, projectReferenceId: reference.project_reference_id,
    sourceReleaseId: release.id, managedDemoUrl: release.managed_demo_url, sourceCommit: release.source_commit });
}

export async function runM3Journey(context, { developmentBuildsOnly = false } = {}) {
  if (developmentBuildsOnly && context.state.configuration.scenarios.includes("m3-journey")) {
    throw new Error("the full M3 journey cannot omit build acceptance cases");
  }
  context.registerFixture("M3 full journey compositor", "e2e/scenarios/m3-journey.mjs");
  registerM3BuildFixtures(context);
  registerM3DataFixtures(context);
  const phases = [];
  async function phase(name, run) {
    const entry = { name, started_at: new Date().toISOString(), status: "running" };
    phases.push(entry);
    const save = () => writeFileSync(join(context.artifactDir, "m3-phases.json"),
      `${JSON.stringify({ schema: "hostlet.m3-phases/v1", phases }, null, 2)}\n`, { mode: 0o600 });
    save();
    try { const value = await run(); entry.status = "passed"; return value; }
    catch (error) { entry.status = "failed"; throw error; }
    finally { entry.finished_at = new Date().toISOString(); save(); }
  }

  await runM3Context(context, async (m3) => {
    await phase("disposable VM builds", () => runM3BuildScenarios(m3, { developmentBuildsOnly }));
    const prepared = m3.state.m3Build.fullstackV1.prepared;
    const data = createM3DataStage(m3, { mainProject: {
      graph: prepared.graph, deployment: prepared.deployment, reservation: prepared.admission.reservation,
    } });
    m3.state.dataStage = data;
    await phase("tenant PostgreSQL provisioning", () => data.provision());
    m3.state.runtimeEvaluationInputs = {
      nodeBaseRoots: {
        22: join(context.repo, ".local/m3-assets/node22/runtime-base/rootfs"),
        24: join(context.repo, ".local/m3-assets/node24/runtime-base/rootfs"),
      },
      tenantPeers: m3.state.tenantPeers,
    };
    await phase("actual runtime isolation and continuity", () => runM3RuntimeScenarios(context, m3));
    await phase("application database access", () => data.verifyProvisioning());

    const tls = await prepareM3Tls(context);
    const releases = createM3ReleaseHarness(context, m3, { ...tls, dataStage: data });
    data.bindIntegrations({ migrationCompatibility: (inputs) => releases.migrationCompatibility(inputs) });
    await phase("coordinated releases and rollback", () => runM3ReleaseScenarios(context, m3, releases));
    await phase("migration compatibility evidence", () => data.runMigrationCompatibility());
    await phase("owner approval and independent publishing", () => runM3ApprovalPublishScenarios(context, m3, {
      prepareCurrentRelease: () => currentPresentation(m3),
      promoteReplacementRelease: async ({ beforeStage } = {}) => {
        const previous = await currentPresentation(m3);
        await releases.promote("fullstack_v2", { rebuild: true, beforeStage });
        const current = await currentPresentation(m3);
        expectScenario(current.sourceReleaseId !== previous.sourceReleaseId,
          "approved fact refresh follows a newly activated release", { previous: previous.sourceReleaseId, current: current.sourceReleaseId });
        return current;
      },
      withUpstreamsStopped: async (_inputs, runStaticChecks) => releases.withEndpointsPaused(() =>
        m3.state.runtime.withEndpointsPaused(() => data.withEndpointsPaused(async () => {
          await m3.stopApi("M3 independent static portfolio outage");
          await m3.state.githubFixture.pause();
          try { return await runStaticChecks(); }
          finally {
            await m3.state.githubFixture.resume();
            await m3.startApi({ binary: m3.currentApiBinary, label: "M3 upstreams resumed after static outage" });
          }
        }))),
    }));
    // Policy advancement happens after runtime capability/real-time release checks.
    // Hourly storage growth is last so daily archive tests do not duplicate 1 GiB.
    await phase("portable export and isolated recovery", () => data.runExportRestore());
    await phase("daily backups and monthly restore coverage", () => data.runBackupPolicy());
    await phase("observed database allowance enforcement", () => data.verifyStorageOverage());
    // Stop a retained predecessor only after the final promotion, clone probe,
    // and restore check, so earlier cases still exercise every eligible binary.
    await phase("stopped retained rollback rejection", () => releases.exerciseStoppedRetainedRollback());
  });
}

export const scenario = Object.freeze({
  id: "m3-journey",
  description: "HOST-233 owned source to real VM, isolated runtime/database, coordinated release and independently published approved portfolio",
  requiredAssertions: Object.freeze([
    ...M3_UPGRADE_REQUIRED_ASSERTIONS, ...M3_BUILD_REQUIRED_ASSERTIONS,
    ...M3_DATA_REQUIRED_ASSERTIONS, ...M3_RUNTIME_REQUIRED_ASSERTIONS,
    ...M3_RELEASE_REQUIRED_ASSERTIONS, ...M3_APPROVAL_PUBLISH_REQUIRED_ASSERTIONS,
  ]),
  run: runM3Journey,
});
