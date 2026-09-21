// Intentional runner-integrity fault. Run alongside the real API/browser
// scenarios to prove an omitted required assertion makes the bundle fail.
// This module must never be included in an acceptance run.
export const scenario = Object.freeze({
  id: "m1-required-assertion-fault",
  requiredAssertions: ["deliberately-omitted-required-assertion"],
  async run() {},
});
