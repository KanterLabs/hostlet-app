import { registerM3BuildFixtures } from "../support/m3-build.mjs";
import { runM3Context } from "../support/m3-context.mjs";
import { M3_BUILD_REQUIRED_ASSERTIONS, runM3BuildScenarios } from "./m3-build.mjs";
import { M3_UPGRADE_REQUIRED_ASSERTIONS } from "./m3-upgrade.mjs";

async function runM3BuildDevelopment(context) {
  registerM3BuildFixtures(context);
  await runM3Context(context, (m3) => runM3BuildScenarios(m3));
}

export const scenario = Object.freeze({
  id: "m3-build-development",
  description: "Partial M3 development scenario: retained upgrade plus actual disposable-VM build assertions; no HOST-233 claim",
  requiredAssertions: Object.freeze([...M3_UPGRADE_REQUIRED_ASSERTIONS, ...M3_BUILD_REQUIRED_ASSERTIONS]),
  run: runM3BuildDevelopment,
});
