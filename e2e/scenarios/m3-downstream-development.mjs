import { runM3Journey, scenario as fullJourney } from "./m3-journey.mjs";

const OMITTED_ASSERTIONS = new Set([
  "M3-BUILD-03",
  "M3-BUILD-04",
  "M3-RUNTIME-01",
  "M3-RUNTIME-02",
  "M3-RUNTIME-03",
  "M3-RUNTIME-04",
  "M3-RUNTIME-05",
]);

export const scenario = Object.freeze({
  id: "m3-downstream-development",
  description: "Non-gating downstream M3 diagnostic with real build/evaluation/database state and complete data, release, approval, publication and recovery phases",
  requiredAssertions: Object.freeze(fullJourney.requiredAssertions.filter((id) => !OMITTED_ASSERTIONS.has(id))),
  run: (context) => runM3Journey(context, { downstreamDevelopment: true }),
});
