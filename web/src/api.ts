const REQUEST_TIMEOUT_MS = 40_000;
const SESSION_KEY = "hostlet.session";

export type Account = {
  id: string;
  email: string;
  display_name: string;
  revision: number;
};

export type CurrentUser = {
  account: Account;
  session: { id: string; expires_at: string };
};

export type GitHubConnection = {
  github_user: { id: number; login: string };
  expires_at: string | null;
  status: "active" | "expired" | "revoked";
  revision: number;
};

export type GitHubInstallation = {
  id: number;
  account_id: number;
  account_login: string;
  account_type: string;
  repository_selection: string;
  contents_permission: string | null;
  suspended: boolean;
};

export type GitHubRepository = {
  id: number;
  owner: string;
  name: string;
  private: boolean;
  default_branch: string;
  readable: boolean;
};

export type GitHubBranch = { name: string; ref: string; commit_sha: string };

export type ProjectGraph = {
  project: { id: string; name: string; revision: number };
  configuration: { id: string; revision: number; spec: unknown };
  repositories?: unknown[];
  services?: unknown[];
};

export type ProjectSummary = {
  id: string;
  name: string;
  mode: string;
  revision: number;
  current_configuration_revision_id: string | null;
};

export type ConfigurationQuestion = {
  id: string;
  kind: string;
  classification: "configuration_choice" | "public_build_value" | "secret_required" | "server_secret" | string;
  target_path: string;
  prompt: string;
  source_path: string | null;
  required: boolean;
  allowed_options?: string[];
};

export type CompatibilityReport = {
  id: string;
  project_id: string;
  configuration_revision_id: string;
  source_revision_id: string;
  analyzer_revision: string;
  status: "candidate" | "configuration_needed" | "database_needed" | "secrets_needed" | "showcase_only";
  headline: string;
  advisory: string;
  deployment_verified: false;
  facts: {
    repository: { layout: string; package_manager: string; lockfile_path: string | null };
    services: Array<Record<string, unknown>>;
    environment_requirements: Array<{ name: string; classification: string }>;
    reasons: Array<{ code: string; message: string; source_path: string | null }>;
    configuration_questions: ConfigurationQuestion[];
  };
  created_at: string;
};

export type ConfigurationAnswer =
  | { answer_version: "hostlet.configuration-answer/v1"; question_id: string; classification: "unresolved" }
  | { answer_version: "hostlet.configuration-answer/v1"; question_id: string; classification: "secret_required" }
  | { answer_version: "hostlet.configuration-answer/v1"; question_id: string; classification: "configuration_choice"; selected_option: string }
  | { answer_version: "hostlet.configuration-answer/v1"; question_id: string; classification: "public_build_value"; value: string };

export type PreviewContext = {
  project_reference_id: string;
  project_id: string;
  configuration_revision_id: string;
  source_revision_id: string;
  compatibility_report_id: string;
  placeholder: "gradient_1" | "grid_1" | "terminal_1";
  configuration_answers: ConfigurationAnswer[];
};

export type PortfolioDraft = {
  contract_version: "v1";
  profile: { display_name: string; headline: string | null; introduction: string; target_role: string };
  skills: string[];
  resume: { id: string; label: string; url: string } | null;
  contacts: Array<{ id: string; kind: string; label: string; url: string }>;
  projects: Array<Record<string, unknown> & {
    project_reference_id: string;
    kind: { type: string; project_id?: string; external_reference_id?: string };
    order: number;
    visibility: "shown" | "hidden";
    title: string;
    purpose: string;
    contribution: string;
    technical_decisions: Array<{ id: string; summary: string; rationale: string }>;
  }>;
  section_visibility: Record<string, "shown" | "hidden">;
};

export type PreviewAppearance = {
  layout: "layout_1";
  typography: "system_sans" | "editorial_serif";
  accent: "coral" | "indigo" | "forest";
};

export type PreviewRevision = {
  id: string;
  owner_account_id: string;
  revision: number;
  draft: PortfolioDraft;
  preview: PreviewAppearance & {
    project_contexts: PreviewContext[];
  };
  preview_context_revision: number | null;
  created_at: string;
};

export type ApprovalTarget =
  | { type: "narrative"; field: "display_name" | "headline" | "introduction" | "target_role" | "skills" | "project_title" | "project_purpose"; project_reference_id: string | null }
  | { type: "contact"; contact_id: string }
  | { type: "link"; link_id: string; project_reference_id: string | null }
  | { type: "screenshot"; project_reference_id: string; evidence_id: string }
  | { type: "contribution"; project_reference_id: string }
  | { type: "technical_decision"; project_reference_id: string; decision_id: string }
  | { type: "status"; project_reference_id: string; field: "deployment_timestamp" | "availability" | "release_identifier" | "source_commit" | "demo_readiness" };

export type ApprovalRequirement = {
  target: ApprovalTarget;
  value: unknown;
  value_digest: string;
};

export type ReviewDeploymentFact = {
  project_reference_id: string;
  hosted_project_id: string;
  source_release_id: string;
  source_deployment_id: string;
  managed_demo_url: string;
  deployed_at: string;
  availability: "available" | "degraded" | "demo_offline";
  status_label: string;
  availability_observed_at: string;
  demo_access_revision: number;
  public_source_commit: string | null;
};

export type PublicationReview = {
  draft_revision_id: string;
  draft_revision: number;
  review_digest: string;
  snapshot: PortfolioDraft;
  preview_context: PreviewAppearance;
  requirements: ApprovalRequirement[];
  deployment_facts: ReviewDeploymentFact[];
};

export type RefreshField = "managed_demo_destination" | "deployment_timestamp" | "availability_label";

export type ReadinessEvent = {
  id: string;
  project_reference_id: string;
  fact_revision_id: string;
  state: "needs_recheck" | "ready_to_share" | string;
  reason: string | null;
  attestation: Record<string, unknown> | null;
  created_at: string;
};

export type AuthorizedFactRevision = {
  id: string;
  project_reference_id: string;
  revision: number;
  revision_kind: string;
  source_release_id: string;
  source_deployment_id: string;
  facts: Record<string, unknown>;
  refresh_scope: RefreshField[];
  created_at: string;
};

export type ApprovedRevision = {
  id: string;
  source_draft_revision_id: string;
  source_draft_revision: number;
  previous_approved_revision_id: string | null;
  review_digest: string;
  snapshot: PortfolioDraft;
  preview_context: PreviewAppearance;
  requirements: ApprovalRequirement[];
  approvals: Array<{ target: ApprovalTarget; value_digest: string }>;
  deployment_facts: AuthorizedFactRevision[];
  readiness: ReadinessEvent[];
  approved_at: string;
};

export type ApprovalEvidence =
  | { type: "entire_revision"; review_digest: string }
  | { type: "individual_fields"; fields: Array<{ target: ApprovalTarget; value_digest: string }> };

export type PortfolioPublication = {
  id: string;
  approved_revision_id: string;
  slug: string;
  cause: "owner_request" | "fact_refresh" | string;
  state: "queued" | "publishing" | "published" | "failed" | "superseded" | string;
  document_digest: string;
  artifact_digest: string | null;
  pointer_generation: number | null;
  failure_code: string | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
};

export type DetailedResponse<T> = { payload: T; etag: string | null };

export type GitHubSource = {
  binding_id: string;
  project_id: string;
  repository: { id: number; owner: string; name: string; private: boolean };
  ref: string;
  status: string;
  revision: number;
  source_revision: {
    id: string;
    configuration_revision_id: string;
    resolved_commit: string;
    tree_sha: string | null;
    source: string;
    observed_at: string;
  };
  candidate_source_revision?: {
    id: string;
    resolved_commit: string;
    observed_at: string;
  } | null;
  configuration_fresh: boolean;
};

type ErrorEnvelope = { error?: { code?: string; message?: string } };

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, code?: string) {
    super(friendlyError(status, code));
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

function friendlyError(status: number, code?: string): string {
  if (status === 401) return "Your session has expired. Please sign in again.";
  if (code === "email_already_exists") return "An account already uses that email. Sign in instead.";
  if (status === 403 || status === 404) return "That item is no longer available to this account.";
  if (status === 409 || status === 412) return "This changed while you were working. Please try again.";
  if (status === 422) return "Review the form values and try again.";
  if (status === 429) return "Too many requests. Wait a moment and try again.";
  if (status >= 500 || code === "github_unavailable") return "Hostlet is temporarily unavailable. Please try again.";
  return "We couldn’t complete that request. Please try again.";
}

async function requestDetailed<T>(path: string, init: RequestInit = {}, token?: string): Promise<DetailedResponse<T>> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (token) {
    headers.set(import.meta.env.VITE_HOSTLET_RESTRICTED_PREVIEW === "true"
      ? "X-Hostlet-Authorization"
      : "Authorization", `Bearer ${token}`);
  }
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  try {
    const response = await fetch(path, { ...init, headers, signal: controller.signal, cache: "no-store" });
    if (response.status === 204) return { payload: undefined as T, etag: response.headers.get("etag") };
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    const payload = contentType.includes("application/json")
      ? ((await response.json()) as T & ErrorEnvelope)
      : undefined;
    if (!response.ok) throw new ApiError(response.status, payload?.error?.code);
    if (payload === undefined) throw new ApiError(502);
    return { payload, etag: response.headers.get("etag") };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("The request took too long. Please try again.");
    }
    throw new Error("Hostlet is unreachable. Check your connection and try again.");
  } finally {
    window.clearTimeout(timeout);
  }
}

async function request<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  return (await requestDetailed<T>(path, init, token)).payload;
}

export function loadSessionToken(): string | null {
  return window.sessionStorage.getItem(SESSION_KEY);
}

export function saveSessionToken(token: string): void {
  window.sessionStorage.setItem(SESSION_KEY, token);
}

export function clearSessionToken(): void {
  window.sessionStorage.removeItem(SESSION_KEY);
}

export const api = {
  createAccount: (body: { email: string; password: string; display_name: string }) =>
    request<Account>("/v1/accounts", { method: "POST", body: JSON.stringify(body) }),
  createSession: (body: { email: string; password: string }) =>
    request<{ token: string; expires_at: string; account_id: string }>("/v1/sessions", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  me: (token: string) => request<CurrentUser>("/v1/me", {}, token),
  signOut: (token: string) => request<void>("/v1/sessions/current", { method: "DELETE" }, token),
  beginGitHubOAuth: (token: string) =>
    request<{ authorization_url: string; expires_at: string }>("/v1/github/oauth-attempts", { method: "POST" }, token),
  completeGitHubOAuth: (token: string, code: string, state: string) =>
    request<GitHubConnection>("/v1/github/oauth-completions", {
      method: "POST",
      body: JSON.stringify({ code, state }),
    }, token),
  githubConnection: (token: string) => request<GitHubConnection>("/v1/github/connection", {}, token),
  installations: (token: string) =>
    request<{ installations: GitHubInstallation[] }>("/v1/github/installations", {}, token),
  repositories: (token: string, installationId: number) =>
    request<{ repositories: GitHubRepository[] }>(`/v1/github/installations/${installationId}/repositories`, {}, token),
  branches: (token: string, installationId: number, repositoryId: number) =>
    request<{ branches: GitHubBranch[] }>(`/v1/github/installations/${installationId}/repositories/${repositoryId}/branches`, {}, token),
  createProject: (token: string, name: string, configuration: unknown, idempotencyKey: string) =>
    request<ProjectGraph>("/v1/projects", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ name, configuration }),
    }, token),
  getProject: (token: string, projectId: string) => request<ProjectGraph>(`/v1/projects/${projectId}`, {}, token),
  listProjects: (token: string, after?: string) => request<{ projects: ProjectSummary[]; next_cursor: string | null }>(
    `/v1/projects${after ? `?after=${encodeURIComponent(after)}` : ""}`,
    {},
    token,
  ),
  bindSource: (
    token: string,
    projectId: string,
    revision: number,
    body: { installation_id: number; repository_id: number; ref: string },
    idempotencyKey: string,
  ) => request<GitHubSource>(`/v1/projects/${projectId}/github-source`, {
    method: "PUT",
    headers: { "If-Match": `"${revision}"`, "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(body),
  }, token),
  getSource: (token: string, projectId: string) =>
    request<GitHubSource>(`/v1/projects/${projectId}/github-source`, {}, token),
  resolveSource: (token: string, projectId: string, bindingRevision: number, key: string) =>
    request<GitHubSource>(`/v1/projects/${projectId}/github-source/resolve`, {
      method: "POST",
      headers: { "If-Match": `"${bindingRevision}"`, "Idempotency-Key": key },
    }, token),
  createConfiguration: (token: string, projectId: string, projectRevision: number, configuration: unknown, key: string) =>
    request<ProjectGraph>(`/v1/projects/${projectId}/configuration-revisions`, {
      method: "POST",
      headers: { "If-Match": `"${projectRevision}"`, "Idempotency-Key": key },
      body: JSON.stringify({ configuration }),
    }, token),
  latestCompatibility: (token: string, projectId: string, sourceRevisionId: string, configurationRevisionId: string) =>
    request<CompatibilityReport>(`/v1/projects/${projectId}/compatibility-reports/latest?source_revision_id=${encodeURIComponent(sourceRevisionId)}&configuration_revision_id=${encodeURIComponent(configurationRevisionId)}`, {}, token),
  getCompatibility: (token: string, projectId: string, reportId: string) =>
    request<CompatibilityReport>(`/v1/projects/${projectId}/compatibility-reports/${reportId}`, {}, token),
  createCompatibility: (token: string, projectId: string, projectRevision: number, sourceRevisionId: string, configurationRevisionId: string, key: string) =>
    request<CompatibilityReport>(`/v1/projects/${projectId}/compatibility-reports`, {
      method: "POST",
      headers: { "If-Match": `"${projectRevision}"`, "Idempotency-Key": key },
      body: JSON.stringify({ source_revision_id: sourceRevisionId, configuration_revision_id: configurationRevisionId }),
    }, token),
  latestPreview: (token: string) =>
    requestDetailed<PreviewRevision>("/v1/portfolio/draft-revisions/latest", {}, token),
  savePreview: (token: string, ifMatch: string, body: Pick<PreviewRevision, "draft" | "preview">, key: string) =>
    requestDetailed<PreviewRevision>("/v1/portfolio/preview-revisions", {
      method: "POST",
      headers: { "If-Match": ifMatch, "Idempotency-Key": key },
      body: JSON.stringify(body),
    }, token),
  publicationReview: (token: string, draftRevisionId: string) =>
    request<PublicationReview>(`/v1/portfolio/publication-review?draft_revision_id=${encodeURIComponent(draftRevisionId)}`, {}, token),
  approveRevision: (
    token: string,
    body: {
      draft_revision_id: string;
      review_digest: string;
      approval: ApprovalEvidence;
      refresh_authorizations: Array<{ project_reference_id: string; fields: RefreshField[] }>;
    },
    key: string,
  ) => request<ApprovedRevision>("/v1/portfolio/approved-revisions", {
    method: "POST",
    headers: { "Idempotency-Key": key },
    body: JSON.stringify(body),
  }, token),
  latestApprovedRevision: (token: string) =>
    request<ApprovedRevision>("/v1/portfolio/approved-revisions/latest", {}, token),
  createPublication: (token: string, approvedRevisionId: string, slug: string, key: string) =>
    request<PortfolioPublication>("/v1/portfolio/publications", {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: JSON.stringify({ approved_revision_id: approvedRevisionId, slug }),
    }, token),
  latestPublication: (token: string) =>
    request<PortfolioPublication>("/v1/portfolio/publications/latest", {}, token),
  publication: (token: string, publicationId: string) =>
    request<PortfolioPublication>(`/v1/portfolio/publications/${encodeURIComponent(publicationId)}`, {}, token),
};

export function idempotencyKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}
