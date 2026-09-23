import { runM3Context } from "../support/m3-context.mjs";
import { registerM3BuildFixtures } from "../support/m3-build.mjs";
import { runM3BuildScenarios } from "./m3-build.mjs";
import { M3_UPGRADE_REQUIRED_ASSERTIONS } from "./m3-upgrade.mjs";

const assertionId = "M3-BUILD-WORKSPACE-DIAGNOSTIC";

async function runWorkspaceDevelopment(context) {
  registerM3BuildFixtures(context);
  await runM3Context(context, async (m3) => {
    await runM3BuildScenarios(m3, { developmentBuildsOnly: true });
    try {
      const result = await m3.state.m3Build.buildFixture("workspace_exhaustion", {
        expectedState: "failed", expectedCode: "workspace_limit",
      });
      context.assertion(assertionId, "M3 workspace exhaustion diagnostic", "workspace_limit with confirmed VM cleanup",
        { state: result.detail.build.state, code: result.detail.build.terminal_code, cleanup: result.detail.build.cleanup_status },
        result.detail.build.state === "failed" && result.detail.build.terminal_code === "workspace_limit" && result.detail.build.cleanup_status === "confirmed");
    } catch (error) {
      context.assertion(assertionId, "M3 workspace exhaustion diagnostic", "workspace_limit with confirmed VM cleanup",
        { failed_checks: 1, code: error.observed?.code ?? null }, false, error.message);
      throw error;
    }
  });
}

export const scenario = Object.freeze({
  id: "m3-build-workspace-development",
  description: "Partial owned M3 workspace exhaustion diagnostic; does not satisfy HOST-233 or the full build suite",
  requiredAssertions: Object.freeze([...M3_UPGRADE_REQUIRED_ASSERTIONS, "M3-BUILD-01", "M3-BUILD-02", assertionId]),
  run: runWorkspaceDevelopment,
});
