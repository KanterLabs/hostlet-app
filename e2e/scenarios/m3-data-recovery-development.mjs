import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { registerM3BuildFixtures } from "../support/m3-build.mjs";
import { runM3Context } from "../support/m3-context.mjs";
import { runM3BuildScenarios } from "./m3-build.mjs";
import { createM3DataStage, registerM3DataFixtures } from "./m3-data.mjs";
import { runM3RuntimeScenarios } from "./m3-runtime.mjs";

const REQUIRED_ASSERTIONS = Object.freeze([
  "M3-UPGRADE-01", "M3-UPGRADE-02",
  "M3-BUILD-01", "M3-BUILD-02",
  "M3-DATA-01", "M3-DATA-03", "M3-DATA-02", "M3-DATA-01-STORAGE",
]);

async function runDataRecoveryDevelopment(context) {
  context.registerFixture("M3 data recovery development diagnostic", "e2e/scenarios/m3-data-recovery-development.mjs");
  registerM3BuildFixtures(context);
  registerM3DataFixtures(context);

  const phases = [];
  const savePhases = () => writeFileSync(join(context.artifactDir, "m3-data-recovery-phases.json"),
    `${JSON.stringify({ schema: "hostlet.m3-data-recovery-phases/v1", diagnostic_only: true, m3_gate_satisfied: false, phases }, null, 2)}\n`,
    { mode: 0o600 });
  async function phase(name, run) {
    const entry = { name, started_at: new Date().toISOString(), status: "running" };
    phases.push(entry);
    savePhases();
    try { const value = await run(); entry.status = "passed"; return value; }
    catch (error) { entry.status = "failed"; throw error; }
    finally { entry.finished_at = new Date().toISOString(); savePhases(); }
  }

  const setup = { name: "retained M2 upgrade and selected-source setup", started_at: new Date().toISOString(), status: "running" };
  phases.push(setup);
  savePhases();
  try {
    await runM3Context(context, async (m3) => {
      setup.status = "passed";
      setup.finished_at = new Date().toISOString();
      savePhases();

      await phase("disposable VM builds", () => runM3BuildScenarios(m3, { developmentBuildsOnly: true }));
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
      await phase("actual runtime capability evaluation", () => runM3RuntimeScenarios(context, m3, { releaseDiagnostic: true }));
      await phase("application database access", () => data.verifyProvisioning());
      await phase("portable export and isolated recovery", () => data.runExportRestore());
      await phase("daily backups and monthly restore coverage", () => data.runBackupPolicy());
      await phase("observed database allowance enforcement", () => data.verifyStorageOverage());
    });
  } catch (error) {
    if (setup.status === "running") {
      setup.status = "failed";
      setup.finished_at = new Date().toISOString();
      savePhases();
    }
    throw error;
  }
}

export const scenario = Object.freeze({
  id: "m3-data-recovery-development",
  description: "Non-gating real M3 build, runtime and tenant data recovery diagnostic; excludes release migration, publication and stopped rollback",
  requiredAssertions: REQUIRED_ASSERTIONS,
  run: runDataRecoveryDevelopment,
});
