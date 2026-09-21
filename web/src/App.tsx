import { useEffect, useState } from "react";

type VersionPayload = {
  service: string;
  version: string;
  protocol_version: string;
};

type VersionState =
  | { status: "loading" }
  | { status: "online"; payload: VersionPayload }
  | { status: "offline"; message: string }
  | { status: "error"; message: string };

type ReadinessState =
  | { status: "loading" }
  | { status: "ready" }
  | { status: "not_ready"; message: string }
  | { status: "offline"; message: string }
  | { status: "error"; message: string };

type HealthState =
  | { status: "loading" }
  | { status: "healthy" }
  | { status: "offline"; message: string }
  | { status: "error"; message: string };

type ReadinessPayload = {
  status: string;
  reason?: string;
};

type HealthPayload = {
  status: "ok";
};

const REQUEST_TIMEOUT_MS = 5_000;

class InvalidResponseError extends Error {}

class RequestTimeoutError extends Error {}

async function fetchJsonWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  parentSignal: AbortSignal,
): Promise<{ response: Response; payload: unknown }> {
  const requestController = new AbortController();
  let didTimeout = false;
  const timeoutId = window.setTimeout(() => {
    didTimeout = true;
    requestController.abort();
  }, REQUEST_TIMEOUT_MS);
  const abortRequest = () => requestController.abort();
  parentSignal.addEventListener("abort", abortRequest, { once: true });

  try {
    const response = await fetch(input, { ...init, signal: requestController.signal });
    const payload = await readJson(response);
    return { response, payload };
  } catch (error) {
    if (parentSignal.aborted) throw error;
    if (didTimeout) throw new RequestTimeoutError("Request timed out");
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
    parentSignal.removeEventListener("abort", abortRequest);
  }
}

async function readJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    throw new InvalidResponseError("Unexpected response content type");
  }

  try {
    return await response.json();
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    throw new InvalidResponseError("Invalid JSON response");
  }
}

function isVersionPayload(value: unknown): value is VersionPayload {
  if (typeof value !== "object" || value === null) return false;

  const payload = value as Record<string, unknown>;
  return (
    typeof payload.service === "string" &&
    typeof payload.version === "string" &&
    typeof payload.protocol_version === "string"
  );
}

function isReadinessPayload(value: unknown): value is ReadinessPayload {
  if (typeof value !== "object" || value === null) return false;

  const payload = value as Record<string, unknown>;
  return (
    (payload.status === "ready" ||
      payload.status === "ok" ||
      payload.status === "not_ready") &&
    (payload.reason === undefined || typeof payload.reason === "string")
  );
}

function isHealthPayload(value: unknown): value is HealthPayload {
  if (typeof value !== "object" || value === null) return false;
  return (value as Record<string, unknown>).status === "ok";
}

async function requestVersion(signal: AbortSignal): Promise<VersionState> {
  try {
    const { response, payload } = await fetchJsonWithTimeout("/v1/version", {
      headers: { Accept: "application/json" },
      cache: "no-store",
    }, signal);

    if (!response.ok) {
      return {
        status: "error",
        message: `HTTP ${response.status}`,
      };
    }

    if (!isVersionPayload(payload)) {
      return { status: "error", message: "Unexpected response shape" };
    }

    return { status: "online", payload };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }

    if (error instanceof InvalidResponseError) {
      return { status: "error", message: error.message };
    }

    if (error instanceof RequestTimeoutError) {
      return { status: "offline", message: "Control API request timed out" };
    }

    return { status: "offline", message: "Control API is unreachable" };
  }
}

async function requestReadiness(signal: AbortSignal): Promise<ReadinessState> {
  try {
    const { response, payload } = await fetchJsonWithTimeout("/readyz", {
      headers: { Accept: "application/json" },
      cache: "no-store",
    }, signal);

    if (!isReadinessPayload(payload)) {
      return { status: "error", message: "Unexpected readiness response" };
    }

    if (response.status === 503 && payload.status === "not_ready" && payload.reason) {
      return {
        status: "not_ready",
        message: payload.reason,
      };
    }

    if (response.ok && (payload.status === "ready" || payload.status === "ok")) {
      return { status: "ready" };
    }

    if (response.status === 503) {
      return { status: "error", message: "Unexpected readiness response" };
    }

    if (!response.ok) {
      return { status: "error", message: `HTTP ${response.status}` };
    }

    return { status: "error", message: "Unexpected readiness response" };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }

    if (error instanceof InvalidResponseError) {
      return { status: "error", message: error.message };
    }

    if (error instanceof RequestTimeoutError) {
      return { status: "offline", message: "Readiness request timed out" };
    }

    return { status: "offline", message: "Readiness endpoint is unreachable" };
  }
}

async function requestHealth(signal: AbortSignal): Promise<HealthState> {
  try {
    const { response, payload } = await fetchJsonWithTimeout("/healthz", {
      headers: { Accept: "application/json" },
      cache: "no-store",
    }, signal);

    if (!response.ok) {
      return { status: "error", message: `HTTP ${response.status}` };
    }

    if (!isHealthPayload(payload)) {
      return { status: "error", message: "Unexpected health response" };
    }

    return { status: "healthy" };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }

    if (error instanceof InvalidResponseError) {
      return { status: "error", message: error.message };
    }

    if (error instanceof RequestTimeoutError) {
      return { status: "offline", message: "Health request timed out" };
    }

    return { status: "offline", message: "Health endpoint is unreachable" };
  }
}

function StatusPill({
  tone,
  children,
}: {
  tone: "loading" | "positive" | "warning" | "negative" | "muted";
  children: string;
}) {
  return (
    <span className={`status-pill status-pill--${tone}`}>
      <span className="status-pill__dot" aria-hidden="true" />
      {children}
    </span>
  );
}

function VersionStatus({ state }: { state: VersionState }) {
  if (state.status === "loading") {
    return <StatusPill tone="loading">Checking</StatusPill>;
  }

  if (state.status === "offline") {
    return <StatusPill tone="negative">Offline</StatusPill>;
  }

  if (state.status === "error") {
    return <StatusPill tone="warning">Unexpected response</StatusPill>;
  }

  return <StatusPill tone="positive">Online</StatusPill>;
}

function ReadinessStatus({ state }: { state: ReadinessState }) {
  if (state.status === "loading") {
    return <StatusPill tone="loading">Checking</StatusPill>;
  }

  if (state.status === "ready") {
    return <StatusPill tone="positive">Ready</StatusPill>;
  }

  if (state.status === "not_ready") {
    return <StatusPill tone="warning">Not ready</StatusPill>;
  }

  if (state.status === "offline") {
    return <StatusPill tone="negative">Offline</StatusPill>;
  }

  return <StatusPill tone="warning">Unexpected response</StatusPill>;
}

function HealthStatus({ state }: { state: HealthState }) {
  if (state.status === "loading") {
    return <StatusPill tone="loading">Checking</StatusPill>;
  }

  if (state.status === "healthy") {
    return <StatusPill tone="positive">Healthy</StatusPill>;
  }

  if (state.status === "offline") {
    return <StatusPill tone="negative">Offline</StatusPill>;
  }

  return <StatusPill tone="warning">Unexpected response</StatusPill>;
}

export function App() {
  const [version, setVersion] = useState<VersionState>({ status: "loading" });
  const [readiness, setReadiness] = useState<ReadinessState>({ status: "loading" });
  const [health, setHealth] = useState<HealthState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();

    void requestVersion(controller.signal).then(setVersion).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setVersion({ status: "offline", message: "Control API is unreachable" });
      }
    });

    void requestReadiness(controller.signal).then(setReadiness).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setReadiness({ status: "offline", message: "Readiness endpoint is unreachable" });
      }
    });

    void requestHealth(controller.signal).then(setHealth).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setHealth({ status: "offline", message: "Health endpoint is unreachable" });
      }
    });

    return () => controller.abort();
  }, []);

  const versionDetail =
    version.status === "online"
      ? `${version.payload.service} · ${version.payload.version}`
      : version.status === "loading"
        ? "Requesting /v1/version"
        : version.message;

  const readinessDetail =
    readiness.status === "ready"
      ? "Control service reports ready"
      : readiness.status === "not_ready"
        ? readiness.message
        : readiness.status === "loading"
          ? "Requesting /readyz"
          : readiness.message;

  const healthDetail =
    health.status === "healthy"
      ? "Liveness check returned HTTP 200"
      : health.status === "loading"
        ? "Requesting /healthz"
        : health.message;

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="wordmark" href="/" aria-label="Hostlet home">
          <span className="wordmark__mark" aria-hidden="true">
            H
          </span>
          <span>Hostlet</span>
        </a>
        <span className="environment-label">Development scaffold</span>
      </header>

      <main className="page-content">
        <section className="hero" aria-labelledby="page-title">
          <p className="eyebrow">Stateless HTTP application hosting</p>
          <h1 id="page-title">A clear home for your services.</h1>
          <p className="hero__copy">
            Hostlet will make it simple to run focused, stateless HTTP applications.
            Control-plane signals are visible here while the product surface is still taking shape.
          </p>
        </section>

        <section
          className="panel status-panel"
          aria-labelledby="status-title"
          aria-live="polite"
          aria-busy={
            version.status === "loading" ||
            readiness.status === "loading" ||
            health.status === "loading"
          }
        >
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Live checks</p>
              <h2 id="status-title">Control plane status</h2>
            </div>
            <span className="panel-heading__protocol">hostlet.agent/v1</span>
          </div>

          <div className="status-grid">
            <article className="status-card">
              <div className="status-card__heading">
                <h3>Control API</h3>
                <VersionStatus state={version} />
              </div>
              <p>{versionDetail}</p>
              {version.status === "online" && (
                <dl className="metadata-list">
                  <div>
                    <dt>Protocol</dt>
                    <dd>{version.payload.protocol_version}</dd>
                  </div>
                  <div>
                    <dt>Endpoint</dt>
                    <dd>/v1/version</dd>
                  </div>
                </dl>
              )}
            </article>

            <article className="status-card">
              <div className="status-card__heading">
                <h3>Readiness</h3>
                <ReadinessStatus state={readiness} />
              </div>
              <p>{readinessDetail}</p>
              <dl className="metadata-list">
                <div>
                  <dt>Endpoint</dt>
                  <dd>/readyz</dd>
                </div>
              </dl>
            </article>

            <article className="status-card">
              <div className="status-card__heading">
                <h3>Liveness</h3>
                <HealthStatus state={health} />
              </div>
              <p>{healthDetail}</p>
              <dl className="metadata-list">
                <div>
                  <dt>Endpoint</dt>
                  <dd>/healthz</dd>
                </div>
              </dl>
            </article>
          </div>
        </section>

        <section className="panel empty-panel" aria-labelledby="empty-title">
          <div className="empty-panel__icon" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div>
            <p className="eyebrow">Product surface</p>
            <h2 id="empty-title">Nothing to manage yet.</h2>
            <p>
              Service and deployment views will appear when the Hostlet control plane has its
              application model. This development scaffold keeps the state honest while that
              work is underway.
            </p>
          </div>
        </section>
      </main>

      <footer className="footer">
        <span>Hostlet · Building the calm path to production.</span>
        <span>Local control plane · 127.0.0.1:8080</span>
      </footer>
    </div>
  );
}
