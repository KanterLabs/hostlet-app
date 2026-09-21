export class ScenarioExpectationError extends Error {
  constructor(check, observed) {
    super(check);
    this.name = "ScenarioExpectationError";
    this.check = check;
    this.observed = observed;
  }
}

export function expectScenario(condition, check, observed) {
  if (!condition) throw new ScenarioExpectationError(check, observed);
}

export async function requestJson(
  baseUrl,
  path,
  {
    method = "GET",
    body,
    rawBody,
    token,
    headers = {},
    timeoutMs = 15_000,
    abortSignal,
  } = {},
) {
  const requestHeaders = { Accept: "application/json", ...headers };
  let requestBody;
  if (rawBody !== undefined) {
    requestHeaders["Content-Type"] ??= "application/json";
    requestBody = rawBody;
  } else if (body !== undefined) {
    requestHeaders["Content-Type"] ??= "application/json";
    requestBody = JSON.stringify(body);
  }
  if (token !== undefined) requestHeaders.Authorization = `Bearer ${token}`;

  const signals = [AbortSignal.timeout(timeoutMs)];
  if (abortSignal) signals.push(abortSignal);
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: requestHeaders,
    body: requestBody,
    cache: "no-store",
    signal: AbortSignal.any(signals),
  });
  const text = await response.text();
  let payload = null;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { non_json_response: true };
    }
  }
  return { status: response.status, payload };
}

export function assertStatus(response, expected, check) {
  expectScenario(response.status === expected, check, { status: response.status });
}

export function assertErrorShape(response, expectedStatus, check) {
  assertStatus(response, expectedStatus, check);
  const error = response.payload?.error;
  expectScenario(
    typeof error?.code === "string" &&
      error.code.length > 0 &&
      typeof error?.message === "string" &&
      error.message.length > 0 &&
      typeof error?.request_id === "string" &&
      error.request_id.length > 0,
    `${check}: stable JSON error shape`,
    { status: response.status, error_shape_valid: false },
  );
}

export function assertAccountRecord(record, check) {
  const keys =
    record && typeof record === "object" && !Array.isArray(record)
      ? Object.keys(record).sort()
      : [];
  expectScenario(
    keys.join(",") === "display_name,email,id,revision" &&
      typeof record.id === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        record.id,
      ) &&
      typeof record.email === "string" &&
      typeof record.display_name === "string" &&
      Number.isInteger(record.revision) &&
      record.revision >= 0,
    check,
    { account_shape_valid: false, field_count: keys.length },
  );
}

export function assertSessionResponse(payload, accountId, check) {
  const keys =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? Object.keys(payload).sort()
      : [];
  expectScenario(
    keys.join(",") === "account_id,expires_at,token" &&
      payload.account_id === accountId &&
      typeof payload.token === "string" &&
      payload.token.length >= 32 &&
      typeof payload.expires_at === "string" &&
      Number.isFinite(Date.parse(payload.expires_at)),
    check,
    { session_shape_valid: false, field_count: keys.length },
  );
}

export function assertNoCredentialValue(value, credentials, check) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  const hasCredential = credentials.some(
    (credential) => typeof credential === "string" && credential.length > 0 && serialized.includes(credential),
  );
  expectScenario(!hasCredential, check, { credential_matches: hasCredential ? 1 : 0 });
}
