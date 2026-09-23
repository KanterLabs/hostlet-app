import { runM3Journey, scenario as fullJourney } from "./m3-journey.mjs";

export const scenario = Object.freeze({
  id: "m3-journey-development",
  description: "Partial M3 integration diagnostic: short real build setup followed by runtime, data, release and publication; excludes build retry and failure acceptance",
  requiredAssertions: Object.freeze(fullJourney.requiredAssertions.filter((id) =>
    id !== "M3-BUILD-03" && id !== "M3-BUILD-04")),
  run: (context) => runM3Journey(context, { developmentBuildsOnly: true }),
});
