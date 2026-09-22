import { randomBytes, randomUUID } from "node:crypto";
import { relative } from "node:path";

import { expectScenario, ScenarioExpectationError } from "../support/http-client.mjs";
import { beginBrowser } from "../support/interactive-browser.mjs";

export const M2_BROWSER_REQUIRED_ASSERTIONS = Object.freeze([
  "M2-BROWSER-01",
]);

const BROWSER_GITHUB_USER = Object.freeze({ id: 22001, login: "synthetic-browser-owner" });
const INSTALLATION_ID = 41001;
const REPOSITORY_ID = 61001;
const REPOSITORY_NAME = "vite-portfolio";
const BRANCH_REF = "refs/heads/main";

function safeObserved(error) {
  if (error instanceof ScenarioExpectationError) return error.observed;
  return { failed_checks: 1 };
}

function stagedBrowserError(stage, error) {
  const message = String(error?.message ?? "").toLowerCase();
  const kind = message.includes("timed out")
    ? "bounded wait timed out"
    : message.includes("not found")
      ? "required element was unavailable"
      : message.includes("chromium") || message.includes("browser")
        ? "browser operation failed"
        : "journey assertion failed";
  const safeCheck = `M2 browser journey failed at ${stage}: ${kind}`;
  const staged = new Error(safeCheck);
  staged.safeCheck = safeCheck;
  return staged;
}

async function browserStep(context, run) {
  const expected =
    "a real browser signs up, signs back in, follows the provider OAuth redirect, chooses a granted repository branch, and durably saves one immutable source without execution or hosting effects";
  try {
    const observed = await run();
    context.assertion("M2-BROWSER-01", "M2 browser GitHub onboarding", expected, observed, true);
    return observed;
  } catch (error) {
    context.assertion(
      "M2-BROWSER-01",
      "M2 browser GitHub onboarding",
      expected,
      safeObserved(error),
      false,
      error instanceof ScenarioExpectationError
        ? error.check
        : error?.safeCheck ?? "real browser onboarding or independent persistence observation failed",
    );
    throw error;
  }
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function viteEnvironment(apiUrl) {
  const environment = {};
  for (const name of ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TZ", "TMPDIR"]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  environment.VITE_CONTROL_PLANE = apiUrl;
  return environment;
}

async function browserCounts(postgres, label, databaseName = null) {
  const sql = `SELECT json_build_object(
      'accounts', (SELECT COUNT(*)::int FROM accounts),
      'projects', (SELECT COUNT(*)::int FROM projects),
      'bindings', (SELECT COUNT(*)::int FROM github_repository_bindings),
      'source_revisions', (SELECT COUNT(*)::int FROM github_source_revisions),
      'jobs', (SELECT COUNT(*)::int FROM jobs),
      'deployments', (SELECT COUNT(*)::int FROM deployments),
      'hosted_slots', (SELECT COALESCE(SUM(hosted_slots),0)::int FROM projects),
      'hosting_events', (SELECT COUNT(*)::int FROM hosting_state_events),
      'lifecycle_intents', (SELECT COUNT(*)::int FROM project_lifecycle_intents)
    );`;
  return databaseName
    ? postgres.psqlJsonDatabase(label, databaseName, sql)
    : postgres.psqlJson(label, sql);
}

async function durableBrowserSource(postgres, email, label, databaseName = null) {
  const sql = `SELECT json_build_object(
      'account_id', a.id::text,
      'project_id', p.id::text,
      'project_name', p.name,
      'project_mode', p.mode,
      'hosted_slots', p.hosted_slots::int,
      'binding_id', b.id::text,
      'binding_status', b.status,
      'github_repository_id', b.github_repository_id,
      'repository_owner', b.canonical_owner,
      'repository_name', b.canonical_name,
      'repository_private', b.repository_private,
      'authorized_ref', b.authorized_ref,
      'source_revision_id', s.id::text,
      'source', s.source,
      'commit', s.commit_sha,
      'tree', s.tree_sha
    )
    FROM accounts a
    JOIN projects p ON p.account_id=a.id
    JOIN github_repository_bindings b ON b.account_id=a.id AND b.project_id=p.id
    JOIN github_source_revisions s ON s.account_id=a.id AND s.project_id=p.id AND s.binding_id=b.id
    WHERE a.email=${sqlString(email)}
    ORDER BY s.observed_at DESC,s.id DESC
    LIMIT 1;`;
  return databaseName
    ? postgres.psqlJsonDatabase(label, databaseName, sql)
    : postgres.psqlJson(label, sql);
}

function validateDurableSource(source, expected = {}) {
  expectScenario(
    typeof source?.account_id === "string" &&
      typeof source.project_id === "string" &&
      typeof source.binding_id === "string" &&
      typeof source.source_revision_id === "string" &&
      source.project_name === "Browser source project" &&
      source.project_mode === "draft" &&
      source.hosted_slots === 0 &&
      source.binding_status === "active" &&
      source.github_repository_id === REPOSITORY_ID &&
      source.repository_name === REPOSITORY_NAME &&
      source.repository_private === true &&
      source.authorized_ref === BRANCH_REF &&
      source.source === "owner_resolve" &&
      /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(source.commit ?? "") &&
      /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(source.tree ?? "") &&
      (expected.projectId === undefined || source.project_id === expected.projectId) &&
      (expected.bindingId === undefined || source.binding_id === expected.bindingId) &&
      (expected.commit === undefined || source.commit === expected.commit),
    "browser source selection is independently durable and immutable",
    { durable_source_valid: false },
  );
}

export function registerM2BrowserFixtures(context) {
  context.registerFixture("M2 real-browser onboarding scenario", "e2e/scenarios/m2-browser.mjs");
  context.registerFixture("M2 interactive Chromium driver", "e2e/support/interactive-browser.mjs");
  context.registerFixture("M2 browser onboarding UI", "web/src/Onboarding.tsx");
  context.registerFixture("M2 browser API client", "web/src/api.ts");
  context.registerFixture("M2 Vite proxy configuration", "web/vite.config.ts");
  return Object.freeze({
    schema_version: 1,
    browser_boundary: "real Chromium through the Vite UI and real loopback provider redirects",
  });
}

export async function runM2BrowserScenarios(m2) {
  const { context, postgres, state, currentApiBinary, switchApi } = m2;
  const fixture = state.githubFixture;
  expectScenario(Boolean(fixture?.controls), "GitHub fixture is prepared before browser onboarding", {
    github_fixture_prepared: false,
  });

  return browserStep(context, async () => {
    const webPort = await context.allocatePort();
    const webUrl = `http://127.0.0.1:${webPort}/`;
    const browserCallbackUrl = webUrl;
    const apiCallbackUrl = `${m2.apiUrl}/github/callback`;
    const browserEmail = `browser-${randomUUID()}@m2.hostlet.test`;
    const browserPassword = `M2!browser-${randomBytes(32).toString("base64url")}`;
    context.registerSensitiveValues([browserPassword]);

    fixture.controls.setUserInstallationAccess(BROWSER_GITHUB_USER.id, true);
    fixture.controls.setGrant({
      installationId: INSTALLATION_ID,
      repositoryIds: [REPOSITORY_ID],
      contentsPermission: "read",
      suspended: false,
    });
    fixture.controls.setCallbackUrl(browserCallbackUrl);

    const baseline = await browserCounts(postgres, "m2-browser-baseline");
    const observationStart = fixture.safeObservations().length;
    let web = null;
    let browser = null;
    let primaryError = null;
    let durable = null;
    let screenshotPath = null;
    let domPath = null;
    let journeyStage = "configure API callback";
    let failureEvidenceSafe = false;

    try {
      journeyStage = "start API with browser callback";
      await switchApi(currentApiBinary, "M2 browser OAuth callback", {
        environmentOverrides: { HOSTLET_GITHUB_CALLBACK_URL: browserCallbackUrl },
      });

      web = context.spawnManaged(
        "M2 onboarding Vite web",
        "npm",
        ["run", "dev", "--prefix", "web", "--", "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"],
        { cwd: context.repo, env: viteEnvironment(m2.apiUrl) },
        "m2-browser-vite.log",
      );
      journeyStage = "wait for Vite";
      await context.waitForHttp(webUrl, 200, "M2 onboarding Vite web");

      journeyStage = "start Chromium";
      browser = await beginBrowser(context, {
        url: webUrl,
        width: 1440,
        height: 1100,
        label: "m2-github-onboarding",
        timeoutMs: 40_000,
      });
      journeyStage = "wait for enabled signup controls";
      await browser.waitFor('[data-testid="auth-form"] button[type="submit"]');

      await browser.click('.segmented button:nth-of-type(2)');
      journeyStage = "fill signup form";
      await browser.waitFor('[data-testid="auth-form"] input[name="displayName"]');
      await browser.fill('[data-testid="auth-form"] input[name="displayName"]', "M2 Browser Owner");
      await browser.fill('[data-testid="auth-form"] input[name="email"]', browserEmail);
      await browser.fill('[data-testid="auth-form"] input[name="password"]', browserPassword);
      journeyStage = "submit signup form";
      await browser.click('[data-testid="auth-form"] button[type="submit"]');
      journeyStage = "wait for signup session";
      await browser.waitFor('[data-testid="signed-in-user"]');
      failureEvidenceSafe = true;

      const signupSessionToken = await browser.evaluate('window.sessionStorage.getItem("hostlet.session")');
      expectScenario(typeof signupSessionToken === "string" && signupSessionToken.length >= 32, "browser signup creates an opaque session", {
        signup_session_present: false,
      });
      context.registerSensitiveValues([signupSessionToken]);

      journeyStage = "sign out signup session";
      await browser.click('[data-testid="signed-in-user"] button');
      failureEvidenceSafe = false;
      journeyStage = "wait for signin form";
      await browser.waitFor('[data-testid="auth-form"]');
      await browser.click('.segmented button:nth-of-type(1)');
      journeyStage = "fill signin form";
      await browser.fill('[data-testid="auth-form"] input[name="email"]', browserEmail);
      await browser.fill('[data-testid="auth-form"] input[name="password"]', browserPassword);
      journeyStage = "submit signin form";
      await browser.click('[data-testid="auth-form"] button[type="submit"]');
      journeyStage = "wait for GitHub connect action";
      await browser.waitFor('[data-testid="connect-github"]');
      failureEvidenceSafe = true;

      const signinSessionToken = await browser.evaluate('window.sessionStorage.getItem("hostlet.session")');
      expectScenario(
        typeof signinSessionToken === "string" &&
          signinSessionToken.length >= 32 &&
          signinSessionToken !== signupSessionToken,
        "browser sign-in replaces the signed-out session",
        { distinct_signin_session: false },
      );
      context.registerSensitiveValues([signinSessionToken]);

      fixture.controls.authorizeNext({
        userId: BROWSER_GITHUB_USER.id,
        login: BROWSER_GITHUB_USER.login,
      });
      journeyStage = "follow provider OAuth redirect";
      failureEvidenceSafe = false;
      await browser.click('[data-testid="connect-github"]');
      journeyStage = "complete provider OAuth callback";
      await browser.waitFor('[data-testid="github-connection"]', { waitTimeoutMs: 40_000 });
      const connectedIdentity = await browser.text('[data-testid="github-connection"]');
      expectScenario(
        connectedIdentity.includes(BROWSER_GITHUB_USER.login),
        "browser renders the distinct provider identity returned by OAuth",
        { connected_provider_identity_valid: false },
      );
      const callbackQueryRemoved = await browser.evaluate('window.location.search === ""');
      expectScenario(callbackQueryRemoved === true, "browser callback removes OAuth code and state from the address", {
        callback_query_removed: callbackQueryRemoved === true,
      });
      failureEvidenceSafe = true;

      journeyStage = "load installation choices";
      await browser.waitFor(
        () => document.querySelector('[data-testid="installation-select"]')?.options.length > 1,
        { waitTimeoutMs: 20_000 },
      );
      await browser.select('[data-testid="installation-select"]', String(INSTALLATION_ID));
      journeyStage = "load repository choices";
      await browser.waitFor(
        () => document.querySelector('[data-testid="repository-select"]')?.options.length > 1,
        { waitTimeoutMs: 20_000 },
      );
      await browser.select('[data-testid="repository-select"]', String(REPOSITORY_ID));
      journeyStage = "load branch choices";
      await browser.waitFor(
        () => document.querySelector('[data-testid="branch-select"]')?.options.length > 1,
        { waitTimeoutMs: 20_000 },
      );
      await browser.select('[data-testid="branch-select"]', BRANCH_REF);
      journeyStage = "submit project source selection";
      await browser.fill('form[data-testid="source-form"] > label:last-of-type input', "Browser source project");
      await browser.click('[data-testid="create-project"]');
      journeyStage = "wait for bound source";
      await browser.waitFor('[data-testid="bound-source"]', { waitTimeoutMs: 40_000 });

      const renderedSource = await browser.text('[data-testid="bound-source"]');
      expectScenario(
        renderedSource.includes("Browser source project") &&
          renderedSource.includes(REPOSITORY_NAME) &&
          renderedSource.includes("private") &&
          renderedSource.includes("main") &&
          renderedSource.includes("Saved commit"),
        "browser renders the owner-selected private repository, branch, and saved commit",
        { rendered_source_summary_valid: false },
      );

      journeyStage = "verify durable source binding";
      durable = await durableBrowserSource(postgres, browserEmail, "m2-browser-durable-source");
      validateDurableSource(durable);
      expectScenario(
        renderedSource.includes(durable.commit.slice(0, 12)),
        "browser renders the independently observed exact durable commit",
        { durable_commit_rendered: false },
      );

      const after = await browserCounts(postgres, "m2-browser-after");
      expectScenario(
        after.accounts === baseline.accounts + 1 &&
          after.projects === baseline.projects + 1 &&
          after.bindings === baseline.bindings + 1 &&
          after.source_revisions === baseline.source_revisions + 1 &&
          after.jobs === baseline.jobs &&
          after.deployments === baseline.deployments &&
          after.hosted_slots === baseline.hosted_slots &&
          after.hosting_events === baseline.hosting_events &&
          after.lifecycle_intents === baseline.lifecycle_intents,
        "browser onboarding creates only account, draft project, binding, and immutable source intent",
        after,
      );

      const browserObservations = fixture.safeObservations().slice(observationStart);
      expectScenario(
        browserObservations.some(({ method, path, outcome }) =>
          method === "GET" && path === "/login/oauth/authorize" && outcome === "oauth_code_issued"
        ) &&
          browserObservations.some(({ method, path, outcome }) =>
            method === "POST" && path === "/login/oauth/access_token" && outcome === "oauth_token_issued"
          ) &&
          browserObservations.some(({ path, outcome }) =>
            path === "/user/installations" && outcome === "installations_listed"
          ) &&
          browserObservations.some(({ outcome, requestedScopes }) =>
            outcome === "installation_token_issued" &&
              requestedScopes?.repositoryIds?.length === 1 &&
              requestedScopes.repositoryIds[0] === REPOSITORY_ID &&
              requestedScopes.permissions?.contents === "read" &&
              Object.keys(requestedScopes.permissions).length === 1
          ),
        "browser journey crosses the real synthetic provider authorization and least-privilege source boundary",
        { provider_request_count: browserObservations.length, provider_boundary_complete: false },
      );
      fixture.controls.assertNoUnexpectedRequests();

      journeyStage = "retain safe browser evidence";
      screenshotPath = await browser.screenshot("m2-browser-source-bound");
      domPath = await browser.captureDom("m2-browser-source-bound", { safe: true });
      context.state.productOutputs.m2Browser = {
        boundary: "real Chromium, Vite proxy, Hostlet API, PostgreSQL, and synthetic provider HTTP",
        screenshot: relative(context.artifactDir, screenshotPath),
        dom: relative(context.artifactDir, domPath),
        providerRequestCount: browserObservations.length,
        projectId: durable.project_id,
        bindingId: durable.binding_id,
        commit: durable.commit,
        jobsCreated: after.jobs - baseline.jobs,
        deploymentsCreated: after.deployments - baseline.deployments,
        hostedSlotsCreated: after.hosted_slots - baseline.hosted_slots,
        retainedCredentials: 0,
      };

      state.restoreReadChecks.push({
        name: "real-browser GitHub source binding",
        run: async (restored) => {
          const restoredSource = await durableBrowserSource(
            restored.postgres,
            browserEmail,
            "m2-restored-browser-source",
            restored.postgres.recoveryDatabaseName,
          );
          validateDurableSource(restoredSource, {
            projectId: durable.project_id,
            bindingId: durable.binding_id,
            commit: durable.commit,
          });
        },
      });

      return {
        account_created: true,
        distinct_signin_session: true,
        provider_oauth_redirect_observed: true,
        repository_id: durable.github_repository_id,
        branch: durable.authorized_ref,
        commit: durable.commit,
        project_id: durable.project_id,
        binding_id: durable.binding_id,
        jobs_created: after.jobs - baseline.jobs,
        deployments_created: after.deployments - baseline.deployments,
        hosted_slots_created: after.hosted_slots - baseline.hosted_slots,
        screenshot: relative(context.artifactDir, screenshotPath),
        dom: relative(context.artifactDir, domPath),
        retained_credentials: 0,
      };
    } catch (error) {
      const evidence = { stage: journeyStage, screenshot: null, dom: null };
      if (browser && failureEvidenceSafe) {
        try {
          const safePage = await browser.evaluate(
            'window.location.search === "" && !document.querySelector(\'input[type="password"]\')',
          );
          if (safePage) {
            const label = `m2-browser-failure-${journeyStage}`;
            evidence.screenshot = relative(context.artifactDir, await browser.screenshot(label));
            evidence.dom = relative(context.artifactDir, await browser.captureDom(label, { safe: true }));
          }
        } catch {
          // Failure evidence is best-effort and must not replace the journey error.
        }
      }
      context.state.productOutputs.m2BrowserFailure = evidence;
      primaryError = stagedBrowserError(journeyStage, error);
      throw primaryError;
    } finally {
      try {
        if (browser) await browser.close();
      } finally {
        try {
          if (web) await context.stopManaged(web, primaryError ? "M2 browser scenario failure" : "M2 browser scenario completion");
        } finally {
          fixture.controls.setCallbackUrl(apiCallbackUrl);
          await switchApi(currentApiBinary, "restore M2 API GitHub callback", {
            environmentOverrides: { HOSTLET_GITHUB_CALLBACK_URL: apiCallbackUrl },
          });
        }
      }
    }
  });
}
