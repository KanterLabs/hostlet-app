export const scaffoldScenario = Object.freeze({
  id: "m1-scaffold",
  description: "Real control API and Vite/Chromium scaffold boundary",
  requiredAssertions: Object.freeze([
    "source-policy",
    "api-process-started",
    "api-health-status",
    "api-health-body",
    "api-version-status",
    "api-version-body",
    "api-ready-status",
    "api-ready-body",
    "web-process-started",
    "browser-connected-exit",
    "browser-connected-screenshot",
    "browser-connected-online",
    "browser-connected-healthy",
    "browser-connected-not-ready",
    "browser-connected-version",
    "browser-connected-protocol",
    "browser-connected-reason",
    "api-stopped-unreachable",
    "browser-offline-exit",
    "browser-offline-screenshot",
    "browser-offline-status-count",
    "browser-offline-version-message",
    "browser-offline-readiness-message",
    "browser-offline-health-message",
  ]),
  fixtures: Object.freeze([
    "contracts/v1/version.json",
    "web/package-lock.json",
  ]),
});

// Future running-service scenarios should be separate modules exporting the
// same metadata shape plus their runner hook. Keeping metadata outside the
// orchestrator lets PostgreSQL/worker cards add owned modules without changing
// this scaffold inventory or creating an isolated-test path.
