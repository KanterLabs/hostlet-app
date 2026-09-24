import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  ApiError,
  api,
  clearSessionToken,
  idempotencyKey,
  loadSessionToken,
  saveSessionToken,
} from "./api";
import type {
  CurrentUser,
  GitHubBranch,
  GitHubConnection,
  GitHubInstallation,
  GitHubRepository,
  GitHubSource,
  ProjectGraph,
  ProjectSummary,
} from "./api";
import {
  safeProjectName,
  validStandardProjectSpec,
} from "./projectDefaults";
import type { ProjectDefaults, ProjectShape } from "./projectDefaults";
import { PreviewEditor } from "./PreviewEditor";
import "./onboarding.css";

type AuthView = "signin" | "signup";
const restrictedPreview = import.meta.env.VITE_HOSTLET_RESTRICTED_PREVIEW === "true";

const initialDefaults: ProjectDefaults = {
  shape: "vite",
  includeDatabase: false,
  lockfilePath: "package-lock.json",
  staticRoot: ".",
  applicationRoot: ".",
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "We couldn’t complete that request. Please try again.";
}

function shortCommit(commit: string): string {
  return commit.slice(0, 12);
}

export function Onboarding({ enabled }: { enabled: boolean }) {
  const [authView, setAuthView] = useState<AuthView>("signin");
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [token, setToken] = useState<string | null>(() => loadSessionToken());
  const [checkingSession, setCheckingSession] = useState(Boolean(token));
  const [connection, setConnection] = useState<GitHubConnection | null>(null);
  const [installations, setInstallations] = useState<GitHubInstallation[]>([]);
  const [repositories, setRepositories] = useState<GitHubRepository[]>([]);
  const [branches, setBranches] = useState<GitHubBranch[]>([]);
  const [installationId, setInstallationId] = useState("");
  const [repositoryId, setRepositoryId] = useState("");
  const [branchRef, setBranchRef] = useState("");
  const [projectName, setProjectName] = useState("");
  const [defaults, setDefaults] = useState<ProjectDefaults>(initialDefaults);
  const [project, setProject] = useState<ProjectGraph | null>(null);
  const [previewProjects, setPreviewProjects] = useState<ProjectSummary[]>([]);
  const [source, setSource] = useState<GitHubSource | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const callbackHandled = useRef(false);

  const resetGitHubSelection = useCallback(() => {
    setInstallations([]);
    setRepositories([]);
    setBranches([]);
    setInstallationId("");
    setRepositoryId("");
    setBranchRef("");
    setProject(null);
    setPreviewProjects([]);
    setSource(null);
  }, []);

  const expireSession = useCallback(() => {
    clearSessionToken();
    setToken(null);
    setUser(null);
    setConnection(null);
    callbackHandled.current = false;
    resetGitHubSelection();
  }, [resetGitHubSelection]);

  function chooseShape(shape: ProjectShape) {
    setDefaults((current) => ({
      ...current,
      shape,
      includeDatabase: shape === "vite" ? false : current.includeDatabase,
      staticRoot: shape === "fullstack" ? "apps/web" : ".",
      applicationRoot: shape === "fullstack" ? "apps/api" : ".",
    }));
  }

  const handleError = useCallback((error: unknown) => {
    if (error instanceof ApiError && error.status === 401) expireSession();
    setNotice(messageOf(error));
  }, [expireSession]);

  const loadGitHub = useCallback(async (sessionToken: string) => {
    try {
      const githubConnection = await api.githubConnection(sessionToken);
      setConnection(githubConnection);
      if (githubConnection.status !== "active") return;
      const response = await api.installations(sessionToken);
      const usable = response.installations.filter((installation) => !installation.suspended);
      setInstallations(usable);
      setInstallationId((current) => current || String(usable[0]?.id ?? ""));
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        setConnection(null);
        return;
      }
      handleError(error);
    }
  }, [handleError]);

  useEffect(() => {
    if (!token) {
      setCheckingSession(false);
      return;
    }
    let active = true;
    setCheckingSession(true);
    void api.me(token).then((currentUser) => {
      if (!active) return;
      setUser(currentUser);
      setCheckingSession(false);
    }).catch((error: unknown) => {
      if (!active) return;
      setCheckingSession(false);
      handleError(error);
    });
    return () => { active = false; };
  }, [handleError, token]);

  useEffect(() => {
    if (!user || !token || callbackHandled.current) return;
    callbackHandled.current = true;
    const url = new URL(window.location.href);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const denied = url.searchParams.get("error");
    if (code || state || denied) {
      for (const name of ["code", "state", "error", "error_description", "error_uri"] as const) {
        url.searchParams.delete(name);
      }
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    }
    if (denied) {
      setNotice("GitHub connection was cancelled. You can try again when you’re ready.");
      return;
    }
    if ((code && !state) || (!code && state)) {
      setNotice("The GitHub return link was incomplete. Please reconnect GitHub.");
      return;
    }
    if (code && state) {
      setBusy("github-callback");
      void api.completeGitHubOAuth(token, code, state).then((result) => {
        setConnection(result);
        setNotice("GitHub connected. Choose the account and repository you want Hostlet to read.");
        return loadGitHub(token);
      }).catch(handleError).finally(() => setBusy(null));
      return;
    }
    void loadGitHub(token);
  }, [handleError, loadGitHub, token, user]);

  useEffect(() => {
    if (!restrictedPreview || !user || !token) return;
    let active = true;
    void api.listProjects(token).then((response) => {
      if (active) setPreviewProjects(response.projects);
    }).catch((error: unknown) => { if (active) handleError(error); });
    return () => { active = false; };
  }, [handleError, token, user]);

  useEffect(() => {
    if (!token || !installationId || connection?.status !== "active") return;
    let active = true;
    setRepositories([]);
    setRepositoryId("");
    setBranches([]);
    setBranchRef("");
    void api.repositories(token, Number(installationId)).then((response) => {
      if (!active) return;
      const readable = response.repositories.filter((repository) => repository.readable);
      setRepositories(readable);
      setRepositoryId(String(readable[0]?.id ?? ""));
    }).catch((error: unknown) => active && handleError(error));
    return () => { active = false; };
  }, [connection?.status, handleError, installationId, token]);

  useEffect(() => {
    if (!token || !installationId || !repositoryId) return;
    let active = true;
    setBranches([]);
    setBranchRef("");
    void api.branches(token, Number(installationId), Number(repositoryId)).then((response) => {
      if (!active) return;
      setBranches(response.branches);
      const repository = repositories.find((item) => item.id === Number(repositoryId));
      const preferred = response.branches.find((branch) => branch.name === repository?.default_branch);
      setBranchRef((preferred ?? response.branches[0])?.ref ?? "");
      if (repository) setProjectName(safeProjectName(repository.name));
    }).catch((error: unknown) => active && handleError(error));
    return () => { active = false; };
  }, [handleError, installationId, repositories, repositoryId, token]);

  const selectedRepository = useMemo(
    () => repositories.find((repository) => repository.id === Number(repositoryId)),
    [repositories, repositoryId],
  );
  const selectedBranch = branches.find((branch) => branch.ref === branchRef);

  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!enabled) return;
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    setBusy("auth");
    setNotice(null);
    try {
      if (authView === "signup" && !restrictedPreview) {
        await api.createAccount({
          email,
          password,
          display_name: String(form.get("displayName") ?? "").trim(),
        });
      }
      const session = await api.createSession({ email, password });
      saveSessionToken(session.token);
      setToken(session.token);
      setNotice(authView === "signup" ? "Account created. Welcome to Hostlet." : "Welcome back.");
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(null);
    }
  }

  async function signOut() {
    if (!token) return;
    setBusy("signout");
    try {
      await api.signOut(token);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) setNotice(messageOf(error));
    } finally {
      expireSession();
      setBusy(null);
      setNotice("Signed out on this device.");
    }
  }

  async function connectGitHub() {
    if (!token) return;
    setBusy("github-connect");
    setNotice(null);
    try {
      const attempt = await api.beginGitHubOAuth(token);
      window.location.assign(attempt.authorization_url);
    } catch (error) {
      handleError(error);
      setBusy(null);
    }
  }

  async function createAndBind(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || !selectedRepository || !branchRef || !installationId) return;
    setBusy("project");
    setNotice(null);
    try {
      const created = await api.createProject(
        token,
        projectName.trim(),
        validStandardProjectSpec(defaults),
        idempotencyKey("web-project"),
      );
      const bound = await api.bindSource(token, created.project.id, created.project.revision, {
        installation_id: Number(installationId),
        repository_id: selectedRepository.id,
        ref: branchRef,
      }, idempotencyKey("web-source"));
      const refreshed = await api.getProject(token, created.project.id);
      setProject(refreshed);
      setSource(bound);
      setNotice("Project draft created and pinned to the selected source.");
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(null);
    }
  }

  async function openSavedProject(projectId: string) {
    if (!token) return;
    setBusy("saved-project");
    setNotice(null);
    try {
      const [graph, binding] = await Promise.all([
        api.getProject(token, projectId),
        api.getSource(token, projectId),
      ]);
      setProject(graph);
      setSource(binding);
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(null);
    }
  }

  const disabledReason = !enabled ? "The local control service must be ready before you can sign in." : null;

  return (
    <section className="panel onboarding" aria-labelledby="onboarding-title" data-testid="onboarding">
      <div className="onboarding__heading">
        <div>
          <p className="eyebrow">Start a project</p>
          <h2 id="onboarding-title">Connect a repository you choose.</h2>
          <p>Hostlet reads only repositories granted to the GitHub App. You choose the branch and review its exact saved source before any later compatibility check.</p>
        </div>
        {user && (
          <div className="identity" data-testid="signed-in-user">
            <span>Signed in as</span>
            <strong>{user.account.display_name}</strong>
            <small>{user.account.email}</small>
            <button className="text-button" type="button" onClick={() => void signOut()} disabled={busy === "signout"}>Sign out</button>
          </div>
        )}
      </div>

      {(notice || disabledReason) && (
        <p className="notice" role="status" data-testid="onboarding-notice">{notice ?? disabledReason}</p>
      )}

      {restrictedPreview && user && <div className="step-card" data-testid="restricted-preview-projects">
        <div>
          <h3>Owned preview projects</h3>
          {previewProjects.length === 0 ? <p>No owned project is available yet.</p> : <ul>
            {previewProjects.map((item) => <li key={item.id}>
              {item.name} · {item.mode} <button type="button" onClick={() => void openSavedProject(item.id)} disabled={busy === "saved-project"}>Open saved source</button>
            </li>)}
          </ul>}
        </div>
      </div>}

      {!user && (
        <div className="auth-card" aria-busy={checkingSession || busy === "auth"}>
          {!restrictedPreview && <div className="segmented" aria-label="Account action">
            <button type="button" aria-pressed={authView === "signin"} onClick={() => setAuthView("signin")}>Sign in</button>
            <button type="button" aria-pressed={authView === "signup"} onClick={() => setAuthView("signup")}>Create account</button>
          </div>}
          {restrictedPreview && <p>Owner account sign-in only. This preview uses synthetic project data.</p>}
          {checkingSession ? <p>Checking your session…</p> : (
            <form className="form-stack" onSubmit={(event) => void authenticate(event)} data-testid="auth-form">
              {authView === "signup" && <label>Display name<input name="displayName" autoComplete="name" required maxLength={100} /></label>}
              <label>Email address<input name="email" type="email" autoComplete="email" required /></label>
              <label>Password<input name="password" type="password" autoComplete={authView === "signup" ? "new-password" : "current-password"} required minLength={12} maxLength={256} /></label>
              <button className="primary-button" type="submit" disabled={!enabled || busy === "auth"}>{authView === "signup" ? "Create account and continue" : "Sign in"}</button>
            </form>
          )}
        </div>
      )}

      {user && !source && (
        <div className="onboarding-steps">
          <article className="step-card">
            <span className="step-number">1</span>
            <div>
              <h3>Connect GitHub</h3>
              {busy === "github-callback" ? <p>Finishing your GitHub connection…</p> : connection?.status === "active" ? (
                <p data-testid="github-connection">Connected as <strong>{connection.github_user.login}</strong>.</p>
              ) : (
                <>
                  <p>{connection ? "Your GitHub connection expired. Reconnect to choose a repository." : "Approve read access to the repositories you want to use with Hostlet."}</p>
                  <button className="primary-button" type="button" data-testid="connect-github" onClick={() => void connectGitHub()} disabled={busy === "github-connect"}>{connection ? "Reconnect GitHub" : "Connect GitHub"}</button>
                </>
              )}
            </div>
          </article>

          {connection?.status === "active" && (
            <article className="step-card">
              <span className="step-number">2</span>
              <form className="form-stack" onSubmit={(event) => void createAndBind(event)} data-testid="source-form">
                <h3>Choose a source</h3>
                <label>GitHub account or organization<select data-testid="installation-select" value={installationId} onChange={(event) => setInstallationId(event.target.value)} required><option value="">Choose an installation</option>{installations.map((item) => <option key={item.id} value={item.id}>{item.account_login}</option>)}</select></label>
                <label>Repository<select data-testid="repository-select" value={repositoryId} onChange={(event) => setRepositoryId(event.target.value)} required><option value="">Choose a repository</option>{repositories.map((item) => <option key={item.id} value={item.id}>{item.owner}/{item.name}{item.private ? " · private" : ""}</option>)}</select></label>
                <label>Branch<select data-testid="branch-select" value={branchRef} onChange={(event) => setBranchRef(event.target.value)} required><option value="">Choose a branch</option>{branches.map((item) => <option key={item.ref} value={item.ref}>{item.name}</option>)}</select></label>

                <fieldset>
                  <legend>Project structure</legend>
                  <div className="choice-grid">
                    {([[
                      "vite", "Vite static site"], ["node", "Node HTTP app"], ["next", "Next.js 16 standalone"], ["fullstack", "Static site + Node app"]] as [ProjectShape, string][]).map(([value, label]) => (
                      <label className="radio-card" key={value}><input type="radio" name="shape" value={value} checked={defaults.shape === value} onChange={() => chooseShape(value)} /><span>{label}</span></label>
                    ))}
                  </div>
                </fieldset>
                <div className="field-grid">
                  <label>Lockfile path<input value={defaults.lockfilePath} onChange={(event) => setDefaults((current) => ({ ...current, lockfilePath: event.target.value }))} required /></label>
                  {(defaults.shape === "vite" || defaults.shape === "fullstack") && <label>Static site root<input value={defaults.staticRoot} onChange={(event) => setDefaults((current) => ({ ...current, staticRoot: event.target.value }))} required /></label>}
                  {defaults.shape !== "vite" && <label>Application root<input value={defaults.applicationRoot} onChange={(event) => setDefaults((current) => ({ ...current, applicationRoot: event.target.value }))} required /></label>}
                </div>
                {defaults.shape !== "vite" && <label className="check-row"><input type="checkbox" checked={defaults.includeDatabase} onChange={(event) => setDefaults((current) => ({ ...current, includeDatabase: event.target.checked }))} />This project needs PostgreSQL</label>}
                <p className="form-hint">Defaults use npm and Node.js 24. These choices are unverified until Hostlet inspects the saved source.</p>
                <label>Project name<input value={projectName} onChange={(event) => setProjectName(event.target.value)} maxLength={120} required /></label>
                <button className="primary-button" type="submit" data-testid="create-project" disabled={!selectedBranch || busy === "project"}>{busy === "project" ? "Saving project…" : "Create project draft"}</button>
              </form>
            </article>
          )}
        </div>
      )}

      {source && project && (
        <article className="bound-source" data-testid="bound-source">
          <div><p className="eyebrow">Saved source</p><h3>{project.project.name}</h3><p>This private binding lets Hostlet inspect the selected source. It does not make repository content or a project story public.</p></div>
          <dl>
            <div><dt>Repository</dt><dd>{source.repository.owner}/{source.repository.name}{source.repository.private ? " · private" : ""}</dd></div>
            <div><dt>Branch</dt><dd>{source.ref.replace("refs/heads/", "")}</dd></div>
            <div><dt>Saved commit</dt><dd title={source.source_revision.resolved_commit}>{shortCommit(source.source_revision.resolved_commit)}</dd></div>
            <div><dt>Resolved</dt><dd>{new Date(source.source_revision.observed_at).toLocaleString()}</dd></div>
          </dl>
          {source.candidate_source_revision && source.candidate_source_revision.resolved_commit !== source.source_revision.resolved_commit && (
            <p className="source-update" data-testid="source-update">A newer branch source is available. Your saved commit stays unchanged until you explicitly update it.</p>
          )}
        </article>
      )}

      {user && token && (
        <PreviewEditor
          token={token}
          displayName={user.account.display_name}
          refreshKey={source?.source_revision.id ?? "signed-in"}
          onSessionExpired={expireSession}
        />
      )}
    </section>
  );
}
