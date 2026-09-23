import { runM3Context } from "../support/m3-context.mjs";
import { M3_UPGRADE_REQUIRED_ASSERTIONS } from "./m3-upgrade.mjs";

async function runM3Foundation(context) {
  context.registerFixture("M3 partial development foundation scenario", "e2e/scenarios/m3-foundation.mjs");
  await runM3Context(context);
}

export const scenario = Object.freeze({
  id: "m3-foundation",
  description: "Partial M3 development scenario: retained M2 populated upgrade foundation only; no HOST-233 claim",
  requiredAssertions: M3_UPGRADE_REQUIRED_ASSERTIONS,
  run: runM3Foundation,
});
