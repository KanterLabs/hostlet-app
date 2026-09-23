import { runM3Context } from "../support/m3-context.mjs";
import { registerM3BuildFixtures } from "../support/m3-build.mjs";
import { createM3DataStage, registerM3DataFixtures } from "./m3-data.mjs";
import { M3_UPGRADE_REQUIRED_ASSERTIONS } from "./m3-upgrade.mjs";
import { ScenarioExpectationError } from "../support/http-client.mjs";

// Development subset of the predeclared DATA-01 boundary. The full M3 gate
// additionally requires real sandbox application access, which this omits.
async function runDataDevelopment(context) {
  context.registerFixture("M3 partial data development scenario", "e2e/scenarios/m3-data-development.mjs");
  registerM3BuildFixtures(context);
  registerM3DataFixtures(context);
  await runM3Context(context, async (m3) => {
    const seed = m3.state.m3UpgradeSeed;
    const data = createM3DataStage(m3, { mainProject: {
      graph: m3.state.graph, deployment: seed.deployment, reservation: seed.admission.reservation,
    } });
    let result;
    try {
      result = await data.provision();
    } catch (error) {
      context.assertion("M3-DATA-DEVELOPMENT-PROVISION", "M3 development data boundary",
        "two real tenant PostgreSQL fixtures reach ready through authenticated durable intent",
        error instanceof ScenarioExpectationError ? error.observed : { failed_checks: 1 }, false,
        error instanceof ScenarioExpectationError ? error.check : "tenant provisioning boundary failed");
      throw error;
    }
    context.assertion("M3-DATA-DEVELOPMENT-PROVISION", "M3 development data boundary",
      "two durable tenant database intents reach ready with actual populated PostgreSQL fixtures and verified worker receipts",
      { databases: result.databases.map(({ record, rows }) => ({ id: record.id, state: record.state, rows })) },
      result.databases.length === 2 && result.databases.every(({ record }) => record.state === "ready"));
  });
}

export const scenario = Object.freeze({
  id: "m3-data-development",
  description: "Partial M3 PostgreSQL provision development check; excludes sandbox access, recovery and HOST-233 acceptance",
  requiredAssertions: Object.freeze([...M3_UPGRADE_REQUIRED_ASSERTIONS, "M3-DATA-DEVELOPMENT-PROVISION"]),
  run: runDataDevelopment,
});
