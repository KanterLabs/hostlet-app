import { runM3Context } from "../support/m3-context.mjs";
import { registerM3BuildFixtures } from "../support/m3-build.mjs";
import { createM3DataStage, registerM3DataFixtures } from "./m3-data.mjs";
import { M3_UPGRADE_REQUIRED_ASSERTIONS } from "./m3-upgrade.mjs";
import { ScenarioExpectationError } from "../support/http-client.mjs";

const ASSERTION = "M3-DATA-STORAGE-DEVELOPMENT";

async function runStorageDevelopment(context) {
  context.registerFixture("M3 focused storage freeze diagnostic", "e2e/scenarios/m3-data-storage-development.mjs");
  registerM3BuildFixtures(context);
  registerM3DataFixtures(context);
  await runM3Context(context, async (m3) => {
    const seed = m3.state.m3UpgradeSeed;
    const data = createM3DataStage(m3, { mainProject: {
      graph: m3.state.graph, deployment: seed.deployment, reservation: seed.admission.reservation,
    } });
    try {
      await data.provision();
      const observed = await data.verifyStorageFreezeDevelopment();
      context.assertion(ASSERTION, "M3 focused storage freeze diagnostic",
        "real second tenant database exceeds 1 GiB; filtered worker observations persist sticky read-only mode with fresh credential read and write-denial proof",
        observed, true);
    } catch (error) {
      context.assertion(ASSERTION, "M3 focused storage freeze diagnostic",
        "real second tenant database exceeds 1 GiB; filtered worker observations persist sticky read-only mode with fresh credential read and write-denial proof",
        error instanceof ScenarioExpectationError ? error.observed : { failed_checks: 1 }, false,
        error instanceof ScenarioExpectationError ? error.check : "focused tenant storage boundary failed");
      throw error;
    }
  });
}

export const scenario = Object.freeze({
  id: "m3-data-storage-development",
  description: "Non-gating real tenant storage freeze diagnostic; excludes runtime application probe, portable export, and full M3-DATA-01-STORAGE acceptance",
  requiredAssertions: Object.freeze([...M3_UPGRADE_REQUIRED_ASSERTIONS, ASSERTION]),
  run: runStorageDevelopment,
});
