import { join } from "node:path";
import { runM3Context } from "../support/m3-context.mjs";
import { registerM3BuildFixtures } from "../support/m3-build.mjs";
import { runM3BuildScenarios } from "./m3-build.mjs";
import { createM3DataStage, registerM3DataFixtures } from "./m3-data.mjs";
import { runM3RuntimeScenarios, M3_RUNTIME_REQUIRED_ASSERTIONS } from "./m3-runtime.mjs";
import { M3_UPGRADE_REQUIRED_ASSERTIONS } from "./m3-upgrade.mjs";

async function runRuntimeDevelopment(context) {
  context.registerFixture("M3 partial runtime development scenario", "e2e/scenarios/m3-runtime-development.mjs");
  registerM3BuildFixtures(context);
  registerM3DataFixtures(context);
  await runM3Context(context, async (m3) => {
    await runM3BuildScenarios(m3, { developmentBuildsOnly: true });
    const prepared = m3.state.m3Build.fullstackV1.prepared;
    const data = createM3DataStage(m3, { mainProject: {
      graph: prepared.graph, deployment: prepared.deployment, reservation: prepared.admission.reservation,
    } });
    m3.state.dataStage = data;
    await data.provision();
    m3.state.runtimeEvaluationInputs = {
      nodeBaseRoots: {
        22: join(context.repo, ".local/m3-assets/node22/runtime-base/rootfs"),
        24: join(context.repo, ".local/m3-assets/node24/runtime-base/rootfs"),
      },
      tenantPeers: m3.state.tenantPeers,
    };
    await runM3RuntimeScenarios(context, m3);
    await data.verifyProvisioning();
  });
}

export const scenario = Object.freeze({
  id: "m3-runtime-development",
  description: "Partial M3 real VM, database and sandbox runtime development journey; excludes complete build failure, release, recovery and publishing gates",
  requiredAssertions: Object.freeze([
    ...M3_UPGRADE_REQUIRED_ASSERTIONS, "M3-BUILD-01", "M3-BUILD-02",
    ...M3_RUNTIME_REQUIRED_ASSERTIONS, "M3-DATA-01",
  ]),
  run: runRuntimeDevelopment,
});
