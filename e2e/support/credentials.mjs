import { randomBytes } from "node:crypto";

function opaque(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function createFoundationCredentials() {
  return Object.freeze({
    postgresPassword: opaque(36),
    secretKey: randomBytes(32).toString("hex"),
    recoveryKey: randomBytes(32).toString("hex"),
    workerToken: opaque(32),
    ownerPassword: `M1!owner-${opaque(24)}`,
    otherPassword: `M1!other-${opaque(24)}`,
    unknownSessionToken: opaque(32),
  });
}

export function credentialValues(credentials, sessionTokens = []) {
  return [...Object.values(credentials), ...sessionTokens].filter(
    (value) => typeof value === "string" && value.length > 0,
  );
}

export function productEnvironment(baseEnvironment, configuration, credentials) {
  const environment = {};
  for (const name of ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TZ", "RUST_BACKTRACE"]) {
    if (baseEnvironment[name] !== undefined) environment[name] = baseEnvironment[name];
  }

  Object.assign(environment, {
    DATABASE_URL: configuration.databaseUrl,
    HOSTLET_API_BIND: configuration.apiBind,
    HOSTLET_WORKER_BIND: configuration.workerBind,
    HOSTLET_SECRET_KEY: credentials.secretKey,
    HOSTLET_RECOVERY_KEY: credentials.recoveryKey,
    HOSTLET_WORKER_TOKEN: credentials.workerToken,
    HOSTLET_WORKER_LEASE_SECONDS: String(configuration.workerLeaseSeconds ?? 30),
  });

  return environment;
}
