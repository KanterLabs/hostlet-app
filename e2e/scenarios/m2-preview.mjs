import { randomUUID } from "node:crypto";
import { relative } from "node:path";

import {
  assertErrorShape,
  assertNoCredentialValue,
  assertStatus,
  expectScenario,
  ScenarioExpectationError,
} from "../support/http-client.mjs";
import { beginBrowser } from "../support/interactive-browser.mjs";

export const M2_PREVIEW_REQUIRED_ASSERTIONS = Object.freeze([
  "M2-PREVIEW-01",
  "M2-PREVIEW-02",
  "M2-PREVIEW-03",
  "M2-PREVIEW-04",
]);

const PRIVATE_SOURCE_MARKERS = Object.freeze([
  "synthetic private fixture metadata",
  "synthetic Compose fixture",
  "document.querySelector('#root')",
  "services:\n  api:",
]);

function safeObserved(error) {
  if (error instanceof ScenarioExpectationError) return error.observed;
  return { failed_checks: 1 };
}

async function previewStep(context, id, expected, run) {
  try {
    const observed = await run();
    context.assertion(id, "M2 private editable portfolio preview", expected, observed, true);
    return observed;
  } catch (error) {
    context.assertion(
      id,
      "M2 private editable portfolio preview",
      expected,
      safeObserved(error),
      false,
      error instanceof ScenarioExpectationError
        ? error.check
        : "preview browser, HTTP, or persistence boundary failed",
    );
    throw error;
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function cssAttribute(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function viteEnvironment(apiUrl) {
  const environment = {};
  for (const name of ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TZ", "TMPDIR"]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  environment.VITE_CONTROL_PLANE = apiUrl;
  return environment;
}

async function rawRequest(m2, path, {
  method = "GET",
  token,
  headers = {},
  body,
  timeoutMs = 15_000,
} = {}) {
  const requestHeaders = { Accept: "application/json", ...headers };
  if (token) requestHeaders.Authorization = `Bearer ${token}`;
  let requestBody;
  if (body !== undefined) {
    requestHeaders["Content-Type"] ??= "application/json";
    requestBody = JSON.stringify(body);
  }
  const response = await fetch(`${m2.apiUrl}${path}`, {
    method,
    headers: requestHeaders,
    body: requestBody,
    cache: "no-store",
    signal: AbortSignal.any([m2.context.abortSignal, AbortSignal.timeout(timeoutMs)]),
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
  return { status: response.status, payload, headers: response.headers };
}

async function latestPreview(m2, token = m2.state.owner.token) {
  return rawRequest(m2, "/v1/portfolio/draft-revisions/latest", { token });
}

async function savePreview(m2, token, baseRevision, key, body) {
  return rawRequest(m2, "/v1/portfolio/preview-revisions", {
    method: "POST",
    token,
    headers: {
      "Idempotency-Key": key,
      "If-Match": `"${baseRevision}"`,
    },
    body,
  });
}

function previewBody(response) {
  return { draft: clone(response.payload.draft), preview: clone(response.payload.preview) };
}

async function waitForRevision(m2, minimumExclusive, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const latest = await latestPreview(m2);
    if (latest.status === 200 && latest.payload.revision > minimumExclusive) return latest;
    await m2.context.delay(75);
  }
  throw new Error("preview revision did not commit before the deadline");
}

async function previewRows(postgres, accountId, label, databaseName = null) {
  const sql = `SELECT COALESCE(json_agg(json_build_object(
      'id',d.id::text,
      'revision',d.revision_number::int,
      'draft',d.draft,
      'layout',c.layout,
      'typography',c.typography,
      'accent',c.accent,
      'contexts',COALESCE((
        SELECT json_agg(json_build_object(
          'project_reference_id',pc.project_reference_id,
          'project_id',pc.project_id::text,
          'configuration_revision_id',pc.configuration_revision_id::text,
          'source_revision_id',pc.source_revision_id::text,
          'compatibility_report_id',pc.compatibility_report_id::text,
          'placeholder',pc.placeholder,
          'configuration_answers',pc.configuration_answers
        ) ORDER BY pc.project_reference_id)
        FROM portfolio_preview_project_contexts pc
        WHERE pc.account_id=d.account_id AND pc.portfolio_revision_id=d.id
      ),'[]'::json)
    ) ORDER BY d.revision_number),'[]'::json)
    FROM portfolio_draft_revisions d
    LEFT JOIN portfolio_preview_contexts c
      ON c.account_id=d.account_id AND c.portfolio_revision_id=d.id
    WHERE d.account_id=${sqlString(accountId)}::uuid;`;
  return databaseName
    ? postgres.psqlJsonDatabase(label, databaseName, sql)
    : postgres.psqlJson(label, sql);
}

async function previewEffects(postgres, label) {
  return postgres.psqlJson(
    label,
    `SELECT json_build_object(
      'preview_revisions',(SELECT COUNT(*)::int FROM portfolio_preview_contexts),
      'preview_project_contexts',(SELECT COUNT(*)::int FROM portfolio_preview_project_contexts),
      'jobs',(SELECT COUNT(*)::int FROM jobs),
      'deployments',(SELECT COUNT(*)::int FROM deployments),
      'entitlements',(SELECT COUNT(*)::int FROM admission_entitlements),
      'capacity_holds',(SELECT COUNT(*)::int FROM capacity_holds),
      'slot_reservations',(SELECT COUNT(*)::int FROM slot_reservations),
      'source_proofs',(SELECT COUNT(*)::int FROM admission_source_proofs),
      'build_usage_events',(SELECT COUNT(*)::int FROM build_usage_events),
      'hosting_events',(SELECT COUNT(*)::int FROM hosting_state_events),
      'lifecycle_intents',(SELECT COUNT(*)::int FROM project_lifecycle_intents),
      'hosted_slots',(SELECT COALESCE(SUM(hosted_slots),0)::int FROM projects)
    );`,
  );
}

async function fullCompatibilityReport(m2, status, repositoryId) {
  const project = m2.state.compatibility?.projects?.[repositoryId];
  const summary = m2.state.compatibility?.reports?.find(
    (report) => report.projectId === project?.graph?.project?.id && report.status === status,
  );
  expectScenario(Boolean(project && summary), `preview prerequisite report ${repositoryId}/${status}`, {
    compatibility_prerequisite_present: false,
  });
  const response = await m2.call(
    `/v1/projects/${project.graph.project.id}/compatibility-reports/${summary.id}`,
    { token: m2.state.owner.token },
  );
  assertStatus(response, 200, `preview reads ${status} compatibility report`);
  return { project, report: response.payload };
}

function contextFor(projectReferenceId, fixture, answers = [], placeholder = "gradient_1") {
  return {
    project_reference_id: projectReferenceId,
    project_id: fixture.project.graph.project.id,
    configuration_revision_id: fixture.report.configuration_revision_id,
    source_revision_id: fixture.report.source_revision_id,
    compatibility_report_id: fixture.report.id,
    placeholder,
    configuration_answers: answers,
  };
}

function portfolioProject(projectReferenceId, projectId, title, order) {
  return {
    project_reference_id: projectReferenceId,
    kind: { type: "hosted_project", project_id: projectId },
    order,
    visibility: "shown",
    title,
    purpose: "Synthetic owner-written purpose for private preview validation.",
    contribution: "Designed and implemented the synthetic example represented in this private draft.",
    technical_decisions: [],
    links: [],
    evidence: [],
    authorized_deployment_facts_id: null,
    displayed_status: {
      deployment_timestamp: false,
      availability: false,
      release_identifier: false,
      source_commit: false,
      demo_readiness: false,
    },
    demo_readiness: {
      state: "needs_recheck",
      previous_attestation: null,
      reason: "never_checked",
    },
  };
}

function addProjectToBody(body, fixture, referenceId, title, answers = []) {
  const existing = body.draft.projects.find(({ kind }) =>
    kind.type === "hosted_project" && kind.project_id === fixture.project.graph.project.id
  );
  if (!existing) {
    body.draft.projects.push(
      portfolioProject(referenceId, fixture.project.graph.project.id, title, body.draft.projects.length),
    );
  }
  const effectiveReferenceId = existing?.project_reference_id ?? referenceId;
  body.preview.project_contexts = body.preview.project_contexts.filter(
    ({ project_reference_id: id }) => id !== effectiveReferenceId,
  );
  body.preview.project_contexts.push(contextFor(effectiveReferenceId, fixture, answers));
  return effectiveReferenceId;
}

function assertPrivateNoStore(response, check) {
  const cacheControl = response.headers.get("cache-control")?.toLowerCase() ?? "";
  expectScenario(
    cacheControl.includes("private") && cacheControl.includes("no-store"),
    check,
    { private_no_store: false },
  );
}

function assertExactError(response, status, code, check) {
  assertErrorShape(response, status, check);
  expectScenario(response.payload?.error?.code === code, `${check}: exact error code`, {
    expected_code: code,
    observed_code: response.payload?.error?.code ?? null,
  });
}

async function signInPreview(browser, m2) {
  await browser.waitFor('[data-testid="auth-form"]');
  await browser.fill('[data-testid="auth-form"] input[name="email"]', m2.state.owner.record.email);
  await browser.fill('[data-testid="auth-form"] input[name="password"]', m2.credentials.ownerPassword);
  await browser.click('[data-testid="auth-form"] button[type="submit"]');
  await browser.waitFor('[data-testid="preview-editor"]', { waitTimeoutMs: 30_000 });
  const token = await browser.evaluate('window.sessionStorage.getItem("hostlet.session")');
  expectScenario(typeof token === "string" && token.length >= 32, "preview browser session is opaque", {
    browser_session_present: false,
  });
  m2.context.registerSensitiveValues([token]);
  return token;
}

async function addBrowserProject(browser, projectId, { title, purpose, contribution, placeholder = "gradient_1" }) {
  await browser.select('[data-testid="preview-project-picker"]', projectId);
  await browser.click('[data-testid="preview-add-project"]');
  const card = `[data-testid="preview-project-editor"][data-project-id="${cssAttribute(projectId)}"]`;
  await browser.waitFor(card);
  await browser.fill(`${card} [data-field="title"]`, title);
  await browser.fill(`${card} [data-field="purpose"]`, purpose);
  await browser.fill(`${card} [data-field="contribution"]`, contribution);
  await browser.select(`${card} [data-testid="preview-placeholder"]`, placeholder);
  return card;
}

async function assertUnsavedIntroduction(browser, context, expected, lastSaved, stage) {
  const observation = await browser.evaluate(`(() => {
    const value = document.querySelector('[data-testid="preview-editor"] [name="profile.introduction"]')?.value;
    return {
      present: typeof value === "string",
      length: typeof value === "string" ? value.length : null,
      matchesExpected: value === ${JSON.stringify(expected)},
      matchesLastSaved: value === ${JSON.stringify(lastSaved)},
    };
  })()`);
  let dom = null;
  if (!observation?.matchesExpected) {
    const safePage = await browser.evaluate(
      'window.location.search === "" && !document.querySelector(\'input[type="password"]\')',
    );
    if (safePage) {
      try {
        dom = relative(
          context.artifactDir,
          await browser.captureDom(`m2-preview-unsaved-reset-${stage}`, { safe: true }),
        );
      } catch {
        // Diagnostic evidence is best-effort and must not replace the strict value oracle.
      }
    }
    context.state.productOutputs.m2PreviewUnsavedFailure = {
      stage,
      dom,
      valuePresent: observation?.present === true,
      observedLength: observation?.length ?? null,
      matchedLastSaved: observation?.matchesLastSaved === true,
    };
  }
  expectScenario(
    observation?.matchesExpected === true,
    `new source binding preserves the unsaved introduction at ${stage}`,
    {
      stage,
      value_present: observation?.present === true,
      observed_length: observation?.length ?? null,
      matched_expected_unsaved: observation?.matchesExpected === true,
      matched_last_saved: observation?.matchesLastSaved === true,
      safe_dom: dom,
    },
  );
}

function assertPreviewShape(response, status, check) {
  assertStatus(response, status, check);
  expectScenario(
    typeof response.payload?.id === "string" &&
      typeof response.payload.owner_account_id === "string" &&
      Number.isInteger(response.payload.revision) &&
      response.payload.revision > 0 &&
      response.payload.draft?.contract_version === "v1" &&
      response.payload.preview?.layout === "layout_1" &&
      new Set(["system_sans", "editorial_serif"]).has(response.payload.preview?.typography) &&
      new Set(["coral", "indigo", "forest"]).has(response.payload.preview?.accent) &&
      Array.isArray(response.payload.preview?.project_contexts) &&
      (response.payload.preview_context_revision === null ||
        Number.isInteger(response.payload.preview_context_revision)),
    `${check}: versioned preview response shape`,
    { preview_shape_valid: false },
  );
  const etag = response.headers.get("etag");
  expectScenario(etag === `"${response.payload.revision}"`, `${check}: revision ETag`, {
    etag_matches_revision: false,
  });
  assertPrivateNoStore(response, `${check}: private no-store response`);
  return response.payload;
}

function assertLatestShape(response, check) {
  return assertPreviewShape(response, 200, check);
}

async function createFreshOwner(m2, label) {
  const password = `M2-${label}-${randomUUID()}-password!`;
  const email = `${label}-${randomUUID()}@m2-preview.hostlet.test`;
  m2.context.registerSensitiveValues([password]);
  const account = await m2.call("/v1/accounts", {
    method: "POST",
    body: { email, display_name: `M2 preview ${label}`, password },
  });
  assertStatus(account, 201, `${label} account creation`);
  const session = await m2.call("/v1/sessions", {
    method: "POST",
    body: { email, password },
  });
  assertStatus(session, 201, `${label} session creation`);
  m2.context.registerSensitiveValues([session.payload.token]);
  return Object.freeze({ record: account.payload, token: session.payload.token });
}

export function registerM2PreviewFixtures(context) {
  context.registerFixture("M2 private preview E2E scenario", "e2e/scenarios/m2-preview.mjs");
  context.registerFixture("M2 portfolio draft contract", "contracts/v1/portfolio/draft-valid.json");
  context.registerFixture("M2 preview acceptance inventory", "docs/M2-SCENARIOS.md");
  context.registerFixture("M2 interactive Chromium driver for preview", "e2e/support/interactive-browser.mjs");
  return Object.freeze({
    schema_version: 1,
    layout: "layout_1",
    typography: Object.freeze(["system_sans", "editorial_serif"]),
    accents: Object.freeze(["coral", "indigo", "forest"]),
  });
}

export async function runM2PreviewScenarios(m2) {
  const { context, postgres, state, currentApiBinary, retainedM1Binary, switchApi } = m2;
  expectScenario(Boolean(state.compatibility), "compatibility scenarios publish preview prerequisites", {
    compatibility_state_present: false,
  });
  const compatible = await fullCompatibilityReport(m2, "candidate", 61001);
  const configurable = await fullCompatibilityReport(m2, "database_needed", 61004);
  const unsupported = await fullCompatibilityReport(m2, "showcase_only", 61007);
  const secretsNeeded = await fullCompatibilityReport(m2, "secrets_needed", 61005);
  const configurationQuestion = configurable.report.facts?.configuration_questions?.find(
    ({ id }) => typeof id === "string" && id.length > 0,
  );
  const secretQuestion = secretsNeeded.report.facts?.configuration_questions?.find(
    ({ classification }) => classification === "secret_required" || classification === "server_secret",
  );
  expectScenario(Boolean(configurationQuestion), "configuration-needed report exposes a safe question", {
    configuration_question_present: false,
  });
  expectScenario(
    configurationQuestion.classification === "configuration_choice" &&
      configurationQuestion.allowed_options?.includes("postgresql18"),
    "configuration question exposes the bounded PostgreSQL option",
    { bounded_configuration_option_present: false },
  );
  expectScenario(Boolean(secretQuestion), "secrets-needed report exposes a non-value secret question", {
    secret_question_present: false,
  });

  const webPort = await context.allocatePort();
  const webUrl = `http://127.0.0.1:${webPort}/`;
  const web = context.spawnManaged(
    "M2 preview Vite web",
    "npm",
    ["run", "dev", "--prefix", "web", "--", "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"],
    { cwd: context.repo, env: viteEnvironment(m2.apiUrl) },
    "m2-preview-vite.log",
  );
  let ownerBrowser = null;
  let concurrentBrowser = null;
  let anonymousBrowser = null;
  let activeBinary = currentApiBinary;
  let firstSaved = null;
  let finalSaved = null;
  let freshOwner = null;
  const effectsBefore = await previewEffects(postgres, "m2-preview-effects-before");

  try {
    await context.waitForHttp(webUrl, 200, "M2 preview Vite web");
    ownerBrowser = await beginBrowser(context, {
      url: webUrl,
      width: 1440,
      height: 1200,
      label: "m2-private-preview-owner",
      timeoutMs: 40_000,
    });
    await signInPreview(ownerBrowser, m2);

    await previewStep(
      context,
      "M2-PREVIEW-01",
      "an authenticated real browser selects exact compatibility results, authors a private ordered draft with approved placeholders and configuration answers, saves one version, then reloads and signs in to the same private state without a subscription",
      async () => {
        const initialResponse = await latestPreview(m2);
        const initial = assertLatestShape(initialResponse, "initial inherited M1 draft");
        expectScenario(
          initial.preview_context_revision === null &&
            initial.preview.layout === "layout_1" &&
            initial.preview.typography === "system_sans" &&
            initial.preview.accent === "coral",
          "M1 draft receives bounded server preview defaults",
          { default_preview_context_valid: false },
        );

        freshOwner = await createFreshOwner(m2, "fresh-zero-base");
        const absentFreshPreview = await latestPreview(m2, freshOwner.token);
        assertExactError(absentFreshPreview, 404, "not_found", "fresh owner has no preview revision");
        const freshDraft = clone(initial.draft);
        freshDraft.profile.display_name = "Fresh zero-base owner";
        freshDraft.profile.headline = "First private preview revision";
        freshDraft.projects = [];
        const freshCreatedResponse = await savePreview(
          m2,
          freshOwner.token,
          0,
          `m2-preview-fresh-zero-${randomUUID()}`,
          {
            draft: freshDraft,
            preview: {
              layout: "layout_1",
              typography: "system_sans",
              accent: "coral",
              project_contexts: [],
            },
          },
        );
        const freshCreated = assertPreviewShape(
          freshCreatedResponse,
          201,
          "fresh owner creates first preview with If-Match zero",
        );
        const freshReloaded = assertLatestShape(
          await latestPreview(m2, freshOwner.token),
          "fresh owner reloads first preview",
        );
        expectScenario(
          freshCreated.revision === 1 &&
            freshCreated.preview_context_revision === 1 &&
            freshReloaded.id === freshCreated.id,
          "fresh owner If-Match zero creates exactly revision one",
          { fresh_revision: freshCreated.revision, fresh_reload_same_revision: false },
        );

        await ownerBrowser.select('[data-testid="preview-layout"]', "layout_1");
        await ownerBrowser.select('[data-testid="preview-typography"]', "system_sans");
        await ownerBrowser.select('[data-testid="preview-accent"]', "coral");
        await ownerBrowser.fill('[data-testid="preview-editor"] [name="profile.display_name"]', "Avery Preview");
        await ownerBrowser.fill('[data-testid="preview-editor"] [name="profile.headline"]', "Owner-written private preview");
        await ownerBrowser.fill(
          '[data-testid="preview-editor"] [name="profile.introduction"]',
          "I wrote this synthetic preview narrative explicitly; no repository text was copied.",
        );
        await ownerBrowser.fill('[data-testid="preview-editor"] [name="profile.target_role"]', "Software engineer");

        await addBrowserProject(ownerBrowser, compatible.project.graph.project.id, {
          title: "Synthetic Vite portfolio",
          purpose: "Shows an owner-selected static project without claiming deployment.",
          contribution: "Authored the interface and selected the exact immutable source.",
        });
        const configurableCard = await addBrowserProject(ownerBrowser, configurable.project.graph.project.id, {
          title: "Configuration walkthrough",
          purpose: "Shows an unresolved configuration question in a private draft.",
          contribution: "Documented the safe configuration decision without storing a secret.",
          placeholder: "grid_1",
        });
        const questionSelector = `${configurableCard} [data-testid="preview-question-answer"][data-question-id="${cssAttribute(configurationQuestion.id)}"]`;
        await ownerBrowser.select(questionSelector, "unresolved");

        const beforeSave = initial.revision;
        await ownerBrowser.click('[data-testid="preview-save"]');
        const savedResponse = await waitForRevision(m2, beforeSave);
        firstSaved = assertLatestShape(savedResponse, "first browser preview save");
        expectScenario(
          firstSaved.owner_account_id === state.owner.record.id &&
            firstSaved.revision === beforeSave + 1 &&
            firstSaved.preview_context_revision === firstSaved.revision &&
            firstSaved.preview.project_contexts.length >= 2 &&
            firstSaved.preview.project_contexts.some(({ project_id: id, source_revision_id: sourceId, compatibility_report_id: reportId }) =>
              id === compatible.project.graph.project.id &&
                sourceId === compatible.report.source_revision_id &&
                reportId === compatible.report.id
            ) &&
            firstSaved.preview.project_contexts.some(({ project_id: id, placeholder }) =>
              id === compatible.project.graph.project.id && placeholder === "gradient_1"
            ) &&
            firstSaved.preview.project_contexts.some(({ project_id: id, placeholder, configuration_answers: answers }) =>
              id === configurable.project.graph.project.id &&
                placeholder === "grid_1" &&
                answers.some(({ question_id: questionId, classification }) =>
                  questionId === configurationQuestion.id && classification === "unresolved"
                )
            ),
          "browser save preserves exact source/report context and unresolved answer",
          { exact_context_and_answer_valid: false },
        );

        const firstRows = await previewRows(postgres, state.owner.record.id, "m2-preview-first-save");
        const persisted = firstRows.find(({ id }) => id === firstSaved.id);
        expectScenario(
          persisted?.layout === "layout_1" &&
            persisted.typography === "system_sans" &&
            persisted.accent === "coral" &&
            persisted.contexts.length === firstSaved.preview.project_contexts.length &&
            persisted.contexts.some(({ project_id: id, placeholder }) =>
              id === compatible.project.graph.project.id && placeholder === "gradient_1"
            ) &&
            persisted.contexts.some(({ project_id: id, placeholder }) =>
              id === configurable.project.graph.project.id && placeholder === "grid_1"
            ),
          "first browser save is independently durable in PostgreSQL",
          { first_revision_durable: false },
        );

        await ownerBrowser.click('[data-testid="signed-in-user"] button');
        await ownerBrowser.waitFor('[data-testid="auth-form"]');
        await signInPreview(ownerBrowser, m2);
        await ownerBrowser.waitFor('[data-testid="preview-project-editor"]');
        const reloadedName = await ownerBrowser.evaluate(
          'document.querySelector(\'[data-testid="preview-editor"] [name="profile.display_name"]\')?.value',
        );
        const deploymentNotice = await ownerBrowser.text('[data-testid="preview-deployment-notice"]');
        const reloadedProjectIds = await ownerBrowser.evaluate(
          '[...document.querySelectorAll(\'[data-testid="preview-project-editor"]\')].map((node) => node.dataset.projectId).filter(Boolean)',
        );
        const expectedHostedOrder = firstSaved.draft.projects
          .filter(({ kind }) => kind.type === "hosted_project")
          .sort((left, right) => left.order - right.order)
          .map(({ kind }) => kind.project_id);
        const compatibleCardText = await ownerBrowser.text(
          `[data-testid="preview-project-editor"][data-project-id="${cssAttribute(compatible.project.graph.project.id)}"]`,
        );
        const reloadedQuestionAnswer = await ownerBrowser.evaluate(
          `document.querySelector(${JSON.stringify(questionSelector)})?.value`,
        );
        const reloadedPlaceholders = await ownerBrowser.evaluate(
          `[...document.querySelectorAll('[data-testid="preview-project-editor"]')].map((card) => ({projectId: card.dataset.projectId, placeholder: card.querySelector('[data-testid="preview-placeholder"]')?.value}))`,
        );
        expectScenario(
          reloadedName === "Avery Preview" &&
            deploymentNotice.includes("deployment not yet verified") &&
            JSON.stringify(reloadedProjectIds) === JSON.stringify(expectedHostedOrder) &&
            compatibleCardText.includes(compatible.project.source.source_revision.resolved_commit.slice(0, 12)) &&
            reloadedQuestionAnswer === "unresolved" &&
            reloadedPlaceholders.some(({ projectId, placeholder }) =>
              projectId === compatible.project.graph.project.id && placeholder === "gradient_1"
            ) &&
            reloadedPlaceholders.some(({ projectId, placeholder }) =>
              projectId === configurable.project.graph.project.id && placeholder === "grid_1"
            ),
          "sign-in reload restores owner content, order, exact source and unresolved question",
          {
            restored_profile: reloadedName === "Avery Preview",
            restored_order: JSON.stringify(reloadedProjectIds) === JSON.stringify(expectedHostedOrder),
            restored_exact_source: false,
            restored_question: reloadedQuestionAnswer === "unresolved",
            restored_placeholders: false,
            deployment_not_verified: false,
          },
        );
        return {
          revision: firstSaved.revision,
          selected_project_contexts: firstSaved.preview.project_contexts.length,
          layout: firstSaved.preview.layout,
          typography: firstSaved.preview.typography,
          accent: firstSaved.preview.accent,
          restored_after_signin: true,
          deployment_verified: false,
          hosted_slots_created: 0,
        };
      },
    );

    await previewStep(
      context,
      "M2-PREVIEW-02",
      "browser edits append immutable revisions; concurrent stale editors keep both values recoverable; invalid, unsafe and cross-project snapshots roll back; exact idempotency replays; and a retained M1 append inherits context while forcing a stale M2 save",
      async () => {
        const unsavedDuringBinding = "Unsaved narrative survives a newly bound source refresh.";
        const projectsBeforeBinding = await rawRequest(m2, "/v1/projects", { token: state.owner.token });
        assertStatus(projectsBeforeBinding, 200, "project list before browser source binding");
        const projectIdsBeforeBinding = new Set(projectsBeforeBinding.payload.projects.map(({ id }) => id));
        await ownerBrowser.fill(
          '[data-testid="preview-editor"] [name="profile.introduction"]',
          unsavedDuringBinding,
        );
        const lastSavedBeforeBinding = firstSaved.draft.profile.introduction;
        await assertUnsavedIntroduction(
          ownerBrowser,
          context,
          unsavedDuringBinding,
          lastSavedBeforeBinding,
          "after-fill",
        );
        await ownerBrowser.waitFor(
          () => document.querySelector('[data-testid="installation-select"]')?.options.length > 1,
          { waitTimeoutMs: 20_000 },
        );
        await ownerBrowser.select('[data-testid="installation-select"]', "41001");
        await assertUnsavedIntroduction(
          ownerBrowser,
          context,
          unsavedDuringBinding,
          lastSavedBeforeBinding,
          "after-installation-select",
        );
        await ownerBrowser.waitFor(
          () => document.querySelector('[data-testid="repository-select"]')?.options.length > 1,
          { waitTimeoutMs: 20_000 },
        );
        await assertUnsavedIntroduction(
          ownerBrowser,
          context,
          unsavedDuringBinding,
          lastSavedBeforeBinding,
          "after-repository-load",
        );
        await ownerBrowser.select('[data-testid="repository-select"]', "61001");
        await assertUnsavedIntroduction(
          ownerBrowser,
          context,
          unsavedDuringBinding,
          lastSavedBeforeBinding,
          "after-repository-select",
        );
        await ownerBrowser.waitFor(
          () => document.querySelector('[data-testid="branch-select"]')?.options.length > 1,
          { waitTimeoutMs: 20_000 },
        );
        await assertUnsavedIntroduction(
          ownerBrowser,
          context,
          unsavedDuringBinding,
          lastSavedBeforeBinding,
          "after-branch-load",
        );
        await ownerBrowser.select('[data-testid="branch-select"]', "refs/heads/main");
        await assertUnsavedIntroduction(
          ownerBrowser,
          context,
          unsavedDuringBinding,
          lastSavedBeforeBinding,
          "after-branch-select",
        );
        const browserBoundProjectName = `Preview refresh ${randomUUID().slice(0, 8)}`;
        await ownerBrowser.fill('form[data-testid="source-form"] > label:last-of-type input', browserBoundProjectName);
        await ownerBrowser.click('[data-testid="create-project"]');
        await assertUnsavedIntroduction(
          ownerBrowser,
          context,
          unsavedDuringBinding,
          lastSavedBeforeBinding,
          "after-create-click",
        );
        await ownerBrowser.waitFor('[data-testid="bound-source"]', { waitTimeoutMs: 40_000 });
        await assertUnsavedIntroduction(
          ownerBrowser,
          context,
          unsavedDuringBinding,
          lastSavedBeforeBinding,
          "after-bound-source",
        );
        const projectsAfterBinding = await rawRequest(m2, "/v1/projects", { token: state.owner.token });
        assertStatus(projectsAfterBinding, 200, "project list after browser source binding");
        const newlyBound = projectsAfterBinding.payload.projects.find(
          ({ id, name }) => !projectIdsBeforeBinding.has(id) && name === browserBoundProjectName,
        );
        expectScenario(Boolean(newlyBound), "browser binding creates one discoverable owner project", {
          newly_bound_project_found: false,
        });
        await ownerBrowser.waitFor(
          `[data-testid="preview-project-picker"] option[value="${cssAttribute(newlyBound.id)}"]`,
          { waitTimeoutMs: 20_000 },
        );
        await assertUnsavedIntroduction(
          ownerBrowser,
          context,
          unsavedDuringBinding,
          lastSavedBeforeBinding,
          "after-picker-refresh",
        );

        const firstSnapshot = clone((await previewRows(
          postgres,
          state.owner.record.id,
          "m2-preview-before-edit",
        )).find(({ id }) => id === firstSaved.id));
        const beforeEdit = assertLatestShape(await latestPreview(m2), "preview before browser edit");
        await ownerBrowser.select('[data-testid="preview-typography"]', "editorial_serif");
        await ownerBrowser.select('[data-testid="preview-accent"]', "indigo");
        await ownerBrowser.select('[data-testid="preview-section-skills"]', "hidden");
        await ownerBrowser.fill(
          '[data-testid="preview-editor"] [name="profile.introduction"]',
          "Edited owner narrative retained as a new immutable preview revision.",
        );
        const configurableCard = `[data-testid="preview-project-editor"][data-project-id="${cssAttribute(configurable.project.graph.project.id)}"]`;
        await ownerBrowser.select(
          `${configurableCard} [data-testid="preview-question-answer"][data-question-id="${cssAttribute(configurationQuestion.id)}"]`,
          "postgresql18",
        );
        const compatibleCard = `[data-testid="preview-project-editor"][data-project-id="${cssAttribute(compatible.project.graph.project.id)}"]`;
        await ownerBrowser.click(`${compatibleCard} [data-testid="preview-move-up"]`);
        await ownerBrowser.click('[data-testid="preview-save"]');
        const editedResponse = await waitForRevision(m2, beforeEdit.revision);
        const edited = assertLatestShape(editedResponse, "edited browser preview save");
        expectScenario(
          edited.preview.typography === "editorial_serif" &&
            edited.preview.accent === "indigo" &&
            edited.draft.section_visibility.skills === "hidden" &&
            edited.draft.profile.introduction ===
              "Edited owner narrative retained as a new immutable preview revision." &&
            edited.draft.projects.find(({ kind }) =>
              kind.type === "hosted_project" && kind.project_id === compatible.project.graph.project.id
            )?.order < firstSaved.draft.projects.find(({ kind }) =>
              kind.type === "hosted_project" && kind.project_id === compatible.project.graph.project.id
            )?.order &&
            edited.preview.project_contexts.find(({ project_id: id }) =>
              id === configurable.project.graph.project.id
            )?.configuration_answers.some(({ question_id: id, classification, selected_option: option }) =>
              id === configurationQuestion.id &&
                classification === "configuration_choice" &&
                option === "postgresql18"
            ),
          "appearance, visibility, ordering and narrative edit persist together",
          { edited_snapshot_valid: false },
        );
        const rowsAfterEdit = await previewRows(postgres, state.owner.record.id, "m2-preview-after-edit");
        const firstAfterEdit = rowsAfterEdit.find(({ id }) => id === firstSaved.id);
        expectScenario(
          JSON.stringify(firstAfterEdit) === JSON.stringify(firstSnapshot),
          "editing appends without mutating the prior preview revision",
          { prior_revision_immutable: false },
        );

        concurrentBrowser = await beginBrowser(context, {
          url: webUrl,
          width: 1280,
          height: 1000,
          label: "m2-private-preview-concurrent",
          timeoutMs: 40_000,
        });
        await signInPreview(concurrentBrowser, m2);
        const loserValue = "Unsaved editor value retained after the conflict.";
        const winnerValue = "Concurrent winner value committed to PostgreSQL.";
        await ownerBrowser.fill('[data-testid="preview-editor"] [name="profile.introduction"]', loserValue);
        await concurrentBrowser.fill('[data-testid="preview-editor"] [name="profile.introduction"]', winnerValue);
        await concurrentBrowser.click('[data-testid="preview-save"]');
        const winnerResponse = await waitForRevision(m2, edited.revision);
        const winner = assertLatestShape(winnerResponse, "concurrent preview winner");
        await ownerBrowser.click('[data-testid="preview-save"]');
        await ownerBrowser.waitFor('[data-testid="preview-conflict"]');
        const retainedLoser = await ownerBrowser.evaluate(
          'document.querySelector(\'[data-testid="preview-editor"] [name="profile.introduction"]\')?.value',
        );
        const conflictText = await ownerBrowser.text('[data-testid="preview-conflict"]');
        expectScenario(
          winner.draft.profile.introduction === winnerValue &&
            retainedLoser === loserValue &&
            conflictText.includes(winnerValue),
          "stale browser keeps its unsaved value and exposes the committed winner for resolution",
          { winner_recoverable: false, loser_recoverable: retainedLoser === loserValue },
        );
        await concurrentBrowser.close();
        concurrentBrowser = null;

        await switchApi(currentApiBinary, "M2 preview concurrent winner restart proof");
        activeBinary = currentApiBinary;
        const winnerAfterRestart = assertLatestShape(
          await latestPreview(m2),
          "concurrent winner after API restart",
        );
        await ownerBrowser.navigate(webUrl);
        await ownerBrowser.waitFor('[data-testid="preview-editor"]', { waitTimeoutMs: 30_000 });
        const winnerAfterRefresh = await ownerBrowser.evaluate(
          'document.querySelector(\'[data-testid="preview-editor"] [name="profile.introduction"]\')?.value',
        );
        expectScenario(
          winnerAfterRestart.id === winner.id &&
            winnerAfterRestart.draft.profile.introduction === winnerValue &&
            winnerAfterRefresh === winnerValue,
          "refresh and API restart preserve the concurrent winning revision",
          {
            restart_preserved_winner: winnerAfterRestart.id === winner.id,
            refresh_preserved_winner: winnerAfterRefresh === winnerValue,
          },
        );

        const failureBase = assertLatestShape(await latestPreview(m2), "validation failure base");
        const failureBody = previewBody({ payload: failureBase });
        const invalidCases = [];
        const cases = [
          ["invalid-layout", 422, "invalid_preview_context", (body) => { body.preview.layout = "layout_2"; }],
          ["invalid-placeholder", 422, "invalid_preview_context", (body) => {
            body.preview.project_contexts[0].placeholder = "repository_screenshot";
          }],
          ["oversized-field", 422, "invalid_portfolio_draft", (body) => {
            body.draft.profile.introduction = "x".repeat(4_001);
          }],
          ["unsafe-link", 422, "invalid_portfolio_draft", (body) => {
            body.draft.contacts[0] = { id: "unsafe-contact", kind: "website", label: "Unsafe", url: "javascript:alert(1)" };
          }],
          ["cross-project-context", 422, "invalid_preview_context", (body) => {
            body.preview.project_contexts[0].project_id = unsupported.project.graph.project.id;
          }],
        ];
        const rowsBeforeFailures = (await previewRows(
          postgres,
          state.owner.record.id,
          "m2-preview-validation-before",
        )).length;
        for (const [name, status, code, mutate] of cases) {
          const body = clone(failureBody);
          mutate(body);
          const response = await savePreview(m2, state.owner.token, failureBase.revision, `m2-preview-${name}`, body);
          assertExactError(response, status, code, `${name} preview rejection`);
          invalidCases.push({ case: name, status: response.status });
        }
        const missingPrecondition = await rawRequest(m2, "/v1/portfolio/preview-revisions", {
          method: "POST",
          token: state.owner.token,
          headers: { "Idempotency-Key": "m2-preview-missing-if-match" },
          body: failureBody,
        });
        assertExactError(missingPrecondition, 428, "if_match_required", "preview requires If-Match");
        const malformedPrecondition = await rawRequest(m2, "/v1/portfolio/preview-revisions", {
          method: "POST",
          token: state.owner.token,
          headers: { "Idempotency-Key": "m2-preview-malformed-if-match", "If-Match": "not-a-revision" },
          body: failureBody,
        });
        assertExactError(malformedPrecondition, 400, "malformed_if_match", "preview rejects malformed If-Match");
        const rowsAfterFailures = (await previewRows(
          postgres,
          state.owner.record.id,
          "m2-preview-validation-after",
        )).length;
        expectScenario(rowsAfterFailures === rowsBeforeFailures, "invalid preview snapshots create no partial revision", {
          revision_rows_before: rowsBeforeFailures,
          revision_rows_after: rowsAfterFailures,
        });

        const replayBody = clone(failureBody);
        replayBody.draft.profile.headline = "Idempotent preview headline";
        const replayKey = `m2-preview-idempotent-${randomUUID()}`;
        const created = await savePreview(m2, state.owner.token, failureBase.revision, replayKey, replayBody);
        assertStatus(created, 201, "preview idempotent creation");
        assertPrivateNoStore(created, "preview bearer write cache policy");
        const replay = await savePreview(m2, state.owner.token, failureBase.revision, replayKey, replayBody);
        assertStatus(replay, 201, "preview exact idempotency replay");
        assertPrivateNoStore(replay, "preview bearer replay cache policy");
        expectScenario(
          replay.payload.id === created.payload.id && replay.payload.revision === created.payload.revision,
          "exact preview replay returns the committed revision",
          { exact_replay_same_revision: false },
        );
        const changedReplayBody = clone(replayBody);
        changedReplayBody.draft.profile.headline = "Changed idempotency payload";
        const changedReplay = await savePreview(
          m2,
          state.owner.token,
          failureBase.revision,
          replayKey,
          changedReplayBody,
        );
        assertExactError(changedReplay, 409, "idempotency_payload_changed", "changed preview idempotency replay");

        const beforeRetained = assertLatestShape(await latestPreview(m2), "preview before retained M1 append");
        await ownerBrowser.navigate(webUrl);
        await ownerBrowser.waitFor('[data-testid="preview-editor"]', { waitTimeoutMs: 30_000 });
        const retainedLoserValue = "This M2 editor became stale during a retained M1 append.";
        await ownerBrowser.fill(
          '[data-testid="preview-editor"] [name="profile.introduction"]',
          retainedLoserValue,
        );
        const retainedDraft = clone(beforeRetained.draft);
        retainedDraft.profile.headline = "Content appended by retained M1";
        const removedContext = beforeRetained.preview.project_contexts.find(
          ({ project_id: id }) => id === configurable.project.graph.project.id,
        );
        const replacedContext = beforeRetained.preview.project_contexts.find(
          ({ project_id: id }) => id === compatible.project.graph.project.id,
        );
        expectScenario(
          Boolean(removedContext && replacedContext),
          "retained M1 filtering probe has removable and replaceable hosted references",
          { filtering_probe_contexts_present: false },
        );
        retainedDraft.projects = retainedDraft.projects
          .filter(({ project_reference_id: id }) => id !== removedContext.project_reference_id)
          .map((project) => project.project_reference_id === replacedContext.project_reference_id
            ? {
                ...project,
                kind: { type: "hosted_project", project_id: secretsNeeded.project.graph.project.id },
              }
            : project);
        try {
          await switchApi(retainedM1Binary, "retained M1 preview content append");
          activeBinary = retainedM1Binary;
          const retainedAppend = await m2.call("/v1/portfolio/draft-revisions", {
            method: "POST",
            token: state.owner.token,
            headers: { "Idempotency-Key": `m2-preview-retained-${randomUUID()}` },
            body: { draft: retainedDraft },
          });
          assertStatus(retainedAppend, 201, "retained M1 appends portfolio content on schema 5");
        } finally {
          await switchApi(currentApiBinary, "current API resumes after retained M1 preview append");
          activeBinary = currentApiBinary;
        }
        const inheritedResponse = await latestPreview(m2);
        const inherited = assertLatestShape(inheritedResponse, "preview after retained M1 append");
        expectScenario(
          inherited.revision === beforeRetained.revision + 1 &&
            inherited.preview_context_revision === beforeRetained.revision &&
            inherited.preview.layout === beforeRetained.preview.layout &&
            inherited.preview.typography === beforeRetained.preview.typography &&
            inherited.preview.accent === beforeRetained.preview.accent &&
            !inherited.preview.project_contexts.some(({ project_reference_id: id }) =>
              id === removedContext.project_reference_id || id === replacedContext.project_reference_id
            ) &&
            inherited.preview.project_contexts.length === beforeRetained.preview.project_contexts.length - 2 &&
            inherited.draft.profile.headline === "Content appended by retained M1",
          "retained M1 content append inherits appearance while filtering removed and replaced hosted contexts",
          { retained_context_filtered: false },
        );
        const retainedRowsBeforeStale = (await previewRows(
          postgres,
          state.owner.record.id,
          "m2-preview-retained-stale-before",
        )).length;
        const retainedStaleHttp = await savePreview(
          m2,
          state.owner.token,
          beforeRetained.revision,
          `m2-preview-retained-stale-${randomUUID()}`,
          previewBody({ payload: beforeRetained }),
        );
        assertExactError(retainedStaleHttp, 412, "stale_revision", "retained M1 forces stale HTTP save");
        const retainedRowsAfterStale = (await previewRows(
          postgres,
          state.owner.record.id,
          "m2-preview-retained-stale-after",
        )).length;
        expectScenario(
          retainedRowsAfterStale === retainedRowsBeforeStale,
          "stale preview save creates no partial revision",
          { rows_before: retainedRowsBeforeStale, rows_after: retainedRowsAfterStale },
        );
        await ownerBrowser.click('[data-testid="preview-save"]');
        await ownerBrowser.waitFor('[data-testid="preview-conflict"]');
        const retainedStaleValue = await ownerBrowser.evaluate(
          'document.querySelector(\'[data-testid="preview-editor"] [name="profile.introduction"]\')?.value',
        );
        expectScenario(
          retainedStaleValue === retainedLoserValue,
          "retained M1 append forces a stale M2 save while preserving the browser edit",
          { retained_stale_value_preserved: retainedStaleValue === retainedLoserValue },
        );
        return {
          immutable_prior_revision: true,
          concurrent_winner_revision: winner.revision,
          stale_values_recoverable: 2,
          rejected_invalid_snapshots: invalidCases.length,
          partial_revisions_from_rejections: 0,
          exact_idempotency_replay: true,
          changed_idempotency_rejected: true,
          retained_append_revision: inherited.revision,
          inherited_context_revision: inherited.preview_context_revision,
        };
      },
    );

    await previewStep(
      context,
      "M2-PREVIEW-03",
      "preview and project-list reads are private no-store and owner-scoped across unauthenticated, other-account, revoked-session, malformed-query, direct-ID and restart probes without exposing credentials or private source",
      async () => {
        expectScenario(Boolean(freshOwner), "fresh owner is available for project-list pagination", {
          fresh_owner_present: false,
        });
        const pagedProjectIds = [];
        for (let index = 0; index < 51; index += 1) {
          const created = await rawRequest(m2, "/v1/projects", {
            method: "POST",
            token: freshOwner.token,
            headers: { "Idempotency-Key": `m2-preview-page-project-${index}-${randomUUID()}` },
            body: {
              name: `Pagination project ${String(index + 1).padStart(2, "0")}`,
              configuration: clone(compatible.project.graph.configuration.spec),
            },
          });
          assertStatus(created, 201, `pagination project ${index + 1} creation`);
          pagedProjectIds.push(created.payload.project.id);
        }
        const listedPages = [];
        const listedPagedIds = [];
        let nextCursor = null;
        do {
          const page = await rawRequest(
            m2,
            nextCursor ? `/v1/projects?after=${encodeURIComponent(nextCursor)}` : "/v1/projects",
            { token: freshOwner.token },
          );
          assertStatus(page, 200, `fresh owner project page ${listedPages.length + 1}`);
          assertPrivateNoStore(page, `fresh owner project page ${listedPages.length + 1} cache policy`);
          expectScenario(
            page.payload.projects.length <= 50,
            "project-list page respects the fifty-project cap",
            { page_size: page.payload.projects.length },
          );
          listedPages.push(page.payload.projects.length);
          listedPagedIds.push(...page.payload.projects.map(({ id }) => id));
          if (page.payload.next_cursor !== null) {
            expectScenario(
              page.payload.next_cursor === page.payload.projects.at(-1)?.id,
              "project-list cursor equals the last returned stable key",
              { cursor_matches_last_id: false },
            );
          }
          nextCursor = page.payload.next_cursor;
        } while (nextCursor !== null && listedPages.length < 3);
        expectScenario(
          JSON.stringify(listedPages) === JSON.stringify([50, 1]) &&
            new Set(listedPagedIds).size === 51 &&
            [...listedPagedIds].sort().every((id, index) => id === [...pagedProjectIds].sort()[index]),
          "keyset pagination returns all fifty-one owner projects once across a true page boundary",
          {
            page_sizes: listedPages,
            unique_project_ids: new Set(listedPagedIds).size,
            complete_owner_set: false,
          },
        );

        const ownerListBefore = await rawRequest(m2, "/v1/projects", { token: state.owner.token });
        assertStatus(ownerListBefore, 200, "owner project picker list");
        assertPrivateNoStore(ownerListBefore, "owner project picker list cache policy");
        const ownerProjectIds = ownerListBefore.payload.projects.map(({ id }) => id).sort();
        const requiredProjectIds = [
          compatible.project.graph.project.id,
          configurable.project.graph.project.id,
          unsupported.project.graph.project.id,
        ];
        expectScenario(
          requiredProjectIds.every((id) => ownerProjectIds.includes(id)),
          "project picker lists the same projects created through the public compatibility workflow",
          { expected_projects_listed: false, listed_project_count: ownerProjectIds.length },
        );

        const anonymousLatest = await rawRequest(m2, "/v1/portfolio/draft-revisions/latest");
        assertExactError(anonymousLatest, 401, "authentication_required", "unauthenticated latest preview");
        const anonymousProjects = await rawRequest(m2, "/v1/projects");
        assertExactError(anonymousProjects, 401, "authentication_required", "unauthenticated project picker list");
        const otherLatest = await latestPreview(m2, state.other.token);
        assertExactError(otherLatest, 404, "not_found", "other account latest preview");
        const otherProjects = await rawRequest(m2, "/v1/projects", { token: state.other.token });
        assertStatus(otherProjects, 200, "other account project picker list");
        expectScenario(
          otherProjects.payload.projects.every(({ id }) =>
            !ownerProjectIds.includes(id) && !listedPagedIds.includes(id)
          ),
          "other account project list contains no project ID from either owner",
          { foreign_project_ids_visible: false },
        );
        const unknownQuery = await rawRequest(m2, "/v1/projects?owner_id=not-accepted", {
          token: state.owner.token,
        });
        assertExactError(unknownQuery, 400, "invalid_project_cursor", "project list unknown query parameter");
        const malformedCursor = await rawRequest(m2, "/v1/projects?after=not-a-uuid", {
          token: state.owner.token,
        });
        assertExactError(malformedCursor, 400, "invalid_project_cursor", "project list malformed cursor");

        const ownerLatest = assertLatestShape(await latestPreview(m2), "owner preview privacy probe");
        const otherDirect = await m2.call(`/v1/portfolio/draft-revisions/${ownerLatest.id}`, {
          token: state.other.token,
        });
        assertExactError(otherDirect, 404, "not_found", "other account direct preview revision read");
        const otherCrossWrite = await savePreview(
          m2,
          state.other.token,
          0,
          `m2-preview-other-cross-write-${randomUUID()}`,
          previewBody({ payload: ownerLatest }),
        );
        assertExactError(otherCrossWrite, 404, "not_found", "other account direct owner-project preview write");

        const session = await m2.call("/v1/sessions", {
          method: "POST",
          body: { email: state.owner.record.email, password: m2.credentials.ownerPassword },
        });
        assertStatus(session, 201, "privacy probe session creation");
        context.registerSensitiveValues([session.payload.token]);
        const revoked = await m2.call("/v1/sessions/current", {
          method: "DELETE",
          token: session.payload.token,
        });
        assertStatus(revoked, 204, "privacy probe session revocation");
        const revokedRead = await latestPreview(m2, session.payload.token);
        assertExactError(revokedRead, 401, "authentication_required", "revoked session latest preview");

        anonymousBrowser = await beginBrowser(context, {
          url: webUrl,
          width: 1100,
          height: 850,
          label: "m2-private-preview-anonymous",
          timeoutMs: 30_000,
        });
        await anonymousBrowser.waitFor('[data-testid="auth-form"]');
        const anonymousEditorVisible = await anonymousBrowser.evaluate(
          'Boolean(document.querySelector(\'[data-testid="preview-editor"]\'))',
        );
        expectScenario(!anonymousEditorVisible, "anonymous browser cannot render the private editor", {
          anonymous_editor_visible: anonymousEditorVisible,
        });
        await anonymousBrowser.close();
        anonymousBrowser = null;

        await switchApi(currentApiBinary, "M2 preview owner-list restart proof");
        activeBinary = currentApiBinary;
        const ownerListAfter = await rawRequest(m2, "/v1/projects", { token: state.owner.token });
        assertStatus(ownerListAfter, 200, "owner project picker list after restart");
        expectScenario(
          JSON.stringify(ownerListAfter.payload.projects.map(({ id }) => id).sort()) ===
            JSON.stringify(ownerProjectIds),
          "API restart preserves the owner project picker IDs",
          { stable_project_ids_after_restart: false },
        );
        const latestAfterRestart = assertLatestShape(await latestPreview(m2), "owner preview after restart");
        const serialized = JSON.stringify(latestAfterRestart);
        expectScenario(
          PRIVATE_SOURCE_MARKERS.every((marker) => !serialized.includes(marker)),
          "private preview response contains no private source body or commit message",
          { private_source_marker_present: true },
        );
        assertNoCredentialValue(serialized, Object.values(m2.credentials), "preview response omits Hostlet credentials");
        assertNoCredentialValue(
          serialized,
          [state.githubFixture.controls.webhookSecret()],
          "preview response omits provider credentials",
        );
        return {
          anonymous_preview_status: anonymousLatest.status,
          other_preview_status: otherLatest.status,
          revoked_preview_status: revokedRead.status,
          direct_other_read_status: otherDirect.status,
          direct_other_write_status: otherCrossWrite.status,
          owner_project_count: ownerProjectIds.length,
          foreign_project_ids_visible: 0,
          malformed_query_status: unknownQuery.status,
          malformed_cursor_status: malformedCursor.status,
          restart_preserved_project_ids: true,
          private_no_store: true,
          retained_credentials: 0,
          retained_private_source_bodies: 0,
        };
      },
    );

    await previewStep(
      context,
      "M2-PREVIEW-04",
      "unsupported private source remains an owner-authored showcase-only preview without copied repository text, live-demo claims, secret answer values, publication, execution, entitlement, capacity, slot, deployment or build effects",
      async () => {
        await ownerBrowser.navigate(webUrl);
        await ownerBrowser.waitFor('[data-testid="preview-editor"]', { waitTimeoutMs: 30_000 });
        const beforeUnsupported = assertLatestShape(await latestPreview(m2), "preview before unsupported selection");
        const configurableEditorCard = await addBrowserProject(
          ownerBrowser,
          configurable.project.graph.project.id,
          {
            title: "Reconfigured application walkthrough",
            purpose: "Shows an owner-controlled configuration recheck.",
            contribution: "Changed the bounded configuration and reviewed the new analysis.",
            placeholder: "grid_1",
          },
        );
        const unsupportedCard = await addBrowserProject(ownerBrowser, unsupported.project.graph.project.id, {
          title: "Owner-authored unsupported showcase",
          purpose: "Explains a synthetic unsupported architecture without a live deployment claim.",
          contribution: "Wrote this narrative explicitly for the private preview.",
          placeholder: "terminal_1",
        });
        const unsupportedAdvisory = await ownerBrowser.text(`${unsupportedCard} [data-testid="preview-compatibility"]`);
        expectScenario(
          unsupportedAdvisory.includes("Showcase-only unsupported") &&
            !unsupportedAdvisory.toLowerCase().includes("live demo") &&
            !unsupportedAdvisory.toLowerCase().includes("deployment verified"),
          "unsupported selection is visibly showcase-only without live-demo claims",
          { showcase_only_visible: false, live_demo_claim_visible: true },
        );
        await ownerBrowser.click('[data-testid="preview-save"]');
        const unsupportedSavedResponse = await waitForRevision(m2, beforeUnsupported.revision);
        finalSaved = assertLatestShape(unsupportedSavedResponse, "unsupported showcase preview save");
        const unsupportedContext = finalSaved.preview.project_contexts.find(
          ({ project_id: id }) => id === unsupported.project.graph.project.id,
        );
        expectScenario(
          unsupportedContext?.compatibility_report_id === unsupported.report.id &&
            unsupportedContext.placeholder === "terminal_1" &&
            finalSaved.draft.projects.some(({ kind, displayed_status: status, demo_readiness: readiness }) =>
              kind.type === "hosted_project" &&
                kind.project_id === unsupported.project.graph.project.id &&
                Object.values(status).every((value) => value === false) &&
                readiness.state === "needs_recheck"
            ),
          "unsupported exact report persists with no verified deployment fact",
          { unsupported_context_valid: false },
        );

        await ownerBrowser.navigate(webUrl);
        await ownerBrowser.waitFor('[data-testid="preview-editor"]', { waitTimeoutMs: 30_000 });
        const reloadedUnsupportedPlaceholder = await ownerBrowser.evaluate(
          `document.querySelector(${JSON.stringify(`${unsupportedCard} [data-testid="preview-placeholder"]`)})?.value`,
        );
        expectScenario(
          reloadedUnsupportedPlaceholder === "terminal_1",
          "terminal placeholder survives an authenticated browser reload",
          { reloaded_unsupported_placeholder: reloadedUnsupportedPlaceholder ?? null },
        );

        const configurableContextBefore = finalSaved.preview.project_contexts.find(
          ({ project_id: id }) => id === configurable.project.graph.project.id,
        );
        const configurationCard = configurableEditorCard;
        await ownerBrowser.click(`${configurationCard} [data-testid="preview-configuration"] summary`);
        const nodeSelector = `${configurationCard} [data-testid="preview-config-node"][data-service-kind="application"]`;
        const currentNodeMajor = await ownerBrowser.evaluate(
          `document.querySelector(${JSON.stringify(nodeSelector)})?.value`,
        );
        const nextNodeMajor = currentNodeMajor === "24" ? "22" : "24";
        await ownerBrowser.select(nodeSelector, nextNodeMajor);
        await ownerBrowser.click(`${configurationCard} [data-testid="preview-config-save"]`);
        await ownerBrowser.waitFor(
          () => document.querySelector('[data-testid="preview-editor-notice"]')?.textContent?.includes(
            "The updated configuration was saved, the source was resolved again, and compatibility was rerun.",
          ),
          { waitTimeoutMs: 40_000 },
        );
        const [updatedGraph, updatedSource] = await Promise.all([
          m2.call(`/v1/projects/${configurable.project.graph.project.id}`, { token: state.owner.token }),
          m2.call(`/v1/projects/${configurable.project.graph.project.id}/github-source`, { token: state.owner.token }),
        ]);
        assertStatus(updatedGraph, 200, "browser-updated configuration graph");
        assertStatus(updatedSource, 200, "browser-reresolved exact source");
        const updatedReport = await m2.call(
          `/v1/projects/${configurable.project.graph.project.id}/compatibility-reports/latest?source_revision_id=${encodeURIComponent(updatedSource.payload.source_revision.id)}&configuration_revision_id=${encodeURIComponent(updatedGraph.payload.configuration.id)}`,
          { token: state.owner.token },
        );
        assertStatus(updatedReport, 200, "browser-reran compatibility report");
        expectScenario(
          updatedGraph.payload.configuration.id !== configurableContextBefore.configuration_revision_id &&
            updatedSource.payload.source_revision.id !== configurableContextBefore.source_revision_id &&
            updatedReport.payload.id !== configurableContextBefore.compatibility_report_id &&
            updatedReport.payload.configuration_revision_id === updatedGraph.payload.configuration.id &&
            updatedReport.payload.source_revision_id === updatedSource.payload.source_revision.id,
          "browser configuration edit creates a new exact immutable configuration, source, and report tuple",
          { immutable_configuration_source_report_tuple_advanced: false },
        );
        const updatedCardText = await ownerBrowser.text(configurationCard);
        expectScenario(
          updatedCardText.includes(updatedReport.payload.headline) &&
            updatedCardText.includes(updatedSource.payload.source_revision.resolved_commit.slice(0, 12)),
          "browser card renders the rerun report and newly resolved saved source",
          { updated_report_and_source_rendered: false },
        );
        await ownerBrowser.click('[data-testid="preview-save"]');
        const updatedPreviewResponse = await waitForRevision(m2, finalSaved.revision);
        finalSaved = assertLatestShape(updatedPreviewResponse, "preview save after browser configuration rerun");
        const updatedSavedContext = finalSaved.preview.project_contexts.find(
          ({ project_id: id }) => id === configurable.project.graph.project.id,
        );
        expectScenario(
          updatedSavedContext?.configuration_revision_id === updatedGraph.payload.configuration.id &&
            updatedSavedContext.source_revision_id === updatedSource.payload.source_revision.id &&
            updatedSavedContext.compatibility_report_id === updatedReport.payload.id,
          "preview save persists the exact browser-rerun tuple",
          { updated_preview_context_persisted: false },
        );

        const secretValue = `must-not-persist-${randomUUID()}`;
        context.registerSensitiveValues([secretValue]);
        const secretBody = previewBody({ payload: finalSaved });
        addProjectToBody(
          secretBody,
          secretsNeeded,
          "preview-secret-boundary",
          "Secret configuration boundary",
          [{
            answer_version: "hostlet.configuration-answer/v1",
            question_id: secretQuestion.id,
            classification: "secret_required",
            value: secretValue,
          }],
        );
        const rowsBeforeSecretRejection = await previewRows(
          postgres,
          state.owner.record.id,
          "m2-preview-secret-rejection-before",
        );
        const secretRejected = await savePreview(
          m2,
          state.owner.token,
          finalSaved.revision,
          `m2-preview-secret-value-${randomUUID()}`,
          secretBody,
        );
        assertExactError(
          secretRejected,
          422,
          "invalid_configuration_answer",
          "secret-valued answer rejection",
        );
        const latestAfterSecret = assertLatestShape(await latestPreview(m2), "preview after rejected secret value");
        const rowsAfterSecretRejection = await previewRows(
          postgres,
          state.owner.record.id,
          "m2-preview-secret-rejection-after",
        );
        const latestAfterSecretSerialized = JSON.stringify(latestAfterSecret);
        const finalSavedSerialized = JSON.stringify(finalSaved);
        const rowsBeforeSecretSerialized = JSON.stringify(rowsBeforeSecretRejection);
        const rowsAfterSecretSerialized = JSON.stringify(rowsAfterSecretRejection);
        const latestSnapshotUnchanged = latestAfterSecretSerialized === finalSavedSerialized;
        const sqlRowsUnchanged = rowsAfterSecretSerialized === rowsBeforeSecretSerialized;
        const secretValuePersisted = latestAfterSecretSerialized.includes(secretValue) ||
          rowsAfterSecretSerialized.includes(secretValue);
        expectScenario(
          latestSnapshotUnchanged && sqlRowsUnchanged && !secretValuePersisted,
          "secret answer rejection creates no partial preview revision",
          {
            latest_snapshot_unchanged: latestSnapshotUnchanged,
            sql_revision_and_context_rows_unchanged: sqlRowsUnchanged,
            secret_value_persisted: secretValuePersisted,
            partial_revision_created: !sqlRowsUnchanged,
          },
        );

        const retained = JSON.stringify(latestAfterSecret);
        expectScenario(
          PRIVATE_SOURCE_MARKERS.every((marker) => !retained.includes(marker)) &&
            !retained.includes("README") &&
            !retained.includes(unsupported.project.source.source_revision.resolved_commit),
          "preview copies no README, private source body, commit message, or provider commit metadata",
          { private_source_metadata_copied: true },
        );
        const effectsAfter = await previewEffects(postgres, "m2-preview-effects-after");
        expectScenario(
          effectsAfter.jobs === effectsBefore.jobs &&
            effectsAfter.deployments === effectsBefore.deployments &&
            effectsAfter.entitlements === effectsBefore.entitlements &&
            effectsAfter.capacity_holds === effectsBefore.capacity_holds &&
            effectsAfter.slot_reservations === effectsBefore.slot_reservations &&
            effectsAfter.source_proofs === effectsBefore.source_proofs &&
            effectsAfter.build_usage_events === effectsBefore.build_usage_events &&
            effectsAfter.hosting_events === effectsBefore.hosting_events &&
            effectsAfter.lifecycle_intents === effectsBefore.lifecycle_intents &&
            effectsAfter.hosted_slots === effectsBefore.hosted_slots,
          "preview work creates no execution, purchase, capacity, deployment, build, or slot effect",
          effectsAfter,
        );

        const screenshot = await ownerBrowser.screenshot("m2-private-preview-showcase");
        const canvas = await ownerBrowser.evaluate(`(() => {
          const node = document.querySelector('[data-testid="preview-canvas"]');
          return node ? {
            text: node.textContent,
            titles: [...node.querySelectorAll('.portfolio-preview__project h3')].map((heading) => heading.textContent),
            skillsVisible: Boolean(node.querySelector('.portfolio-preview__skills')),
          } : null;
        })()`);
        const expectedCanvasTitles = finalSaved.draft.projects
          .filter(({ visibility }) => visibility === "shown")
          .sort((left, right) => left.order - right.order)
          .map(({ title }) => title);
        expectScenario(
          canvas?.text.includes(finalSaved.draft.profile.display_name) &&
            canvas.text.includes(finalSaved.draft.profile.introduction) &&
            canvas.text.includes("Private preview") &&
            canvas.text.includes("Deployment not verified") &&
            JSON.stringify(canvas.titles) === JSON.stringify(expectedCanvasTitles) &&
            canvas.skillsVisible === false,
          "private canvas renders saved owner content and ordered visible projects while hiding the skills section",
          { canvas_present: Boolean(canvas), ordered_visible_projects: canvas?.titles.length ?? 0 },
        );
        await ownerBrowser.evaluate(`document.querySelector('[data-testid="preview-canvas"]').scrollIntoView({block:"start"})`);
        const canvasScreenshot = await ownerBrowser.screenshot("m2-private-preview-canvas");
        const dom = await ownerBrowser.captureDom("m2-private-preview-showcase", { safe: true });
        const finalRows = await previewRows(postgres, state.owner.record.id, "m2-preview-final-rows");
        const expectedFinalRow = clone(finalRows.find(({ id }) => id === finalSaved.id));
        expectScenario(
          expectedFinalRow?.contexts.some(({ project_id: id, placeholder }) =>
            id === configurable.project.graph.project.id && placeholder === "grid_1"
          ) && expectedFinalRow.contexts.some(({ project_id: id, placeholder }) =>
            id === unsupported.project.graph.project.id && placeholder === "terminal_1"
          ),
          "bounded grid and terminal placeholders persist in PostgreSQL",
          { persisted_placeholders_valid: false },
        );
        state.preview = Object.freeze({
          revisionId: finalSaved.id,
          revision: finalSaved.revision,
          projectIds: Object.freeze(finalSaved.preview.project_contexts.map(({ project_id: id }) => id)),
        });
        state.restoreReadChecks.push({
          name: "private preview revisions, inherited context, and unsupported showcase",
          run: async (restored) => {
            const restoredRows = await previewRows(
              restored.postgres,
              state.owner.record.id,
              "m2-restored-preview-rows",
              restored.postgres.recoveryDatabaseName,
            );
            const restoredFinal = restoredRows.find(({ id }) => id === finalSaved.id);
            expectScenario(
              JSON.stringify(restoredFinal) === JSON.stringify(expectedFinalRow) &&
                restoredFinal?.contexts.some(({ project_id: id, placeholder }) =>
                  id === configurable.project.graph.project.id && placeholder === "grid_1"
                ) && restoredFinal.contexts.some(({ project_id: id, placeholder }) =>
                  id === unsupported.project.graph.project.id && placeholder === "terminal_1"
                ),
              "restored preview retains the exact final immutable draft and context",
              { final_preview_restored: false },
            );
          },
        });
        context.state.productOutputs.m2Preview = {
          finalRevisionId: finalSaved.id,
          finalRevision: finalSaved.revision,
          contextCount: finalSaved.preview.project_contexts.length,
          immutableRevisionCount: finalRows.length,
          screenshot: relative(context.artifactDir, screenshot),
          canvasScreenshot: relative(context.artifactDir, canvasScreenshot),
          dom: relative(context.artifactDir, dom),
          retainedCredentials: 0,
          retainedPrivateSourceBodies: 0,
          publicPublications: 0,
        };
        return {
          final_revision: finalSaved.revision,
          immutable_revision_rows: finalRows.length,
          unsupported_status: unsupported.report.status,
          unsupported_live_demo_claims: 0,
          secret_value_rejected: true,
          copied_private_source_markers: 0,
          hosted_slots_created: effectsAfter.hosted_slots - effectsBefore.hosted_slots,
          jobs_created: effectsAfter.jobs - effectsBefore.jobs,
          deployments_created: effectsAfter.deployments - effectsBefore.deployments,
          entitlements_created: effectsAfter.entitlements - effectsBefore.entitlements,
          capacity_holds_created: effectsAfter.capacity_holds - effectsBefore.capacity_holds,
          build_events_created: effectsAfter.build_usage_events - effectsBefore.build_usage_events,
          public_publications: 0,
          screenshot: relative(context.artifactDir, screenshot),
          canvasScreenshot: relative(context.artifactDir, canvasScreenshot),
          dom: relative(context.artifactDir, dom),
          retained_credentials: 0,
        };
      },
    );
  } finally {
    if (activeBinary !== currentApiBinary) {
      await switchApi(currentApiBinary, "restore current API after preview scenario");
    }
    if (anonymousBrowser) await anonymousBrowser.close();
    if (concurrentBrowser) await concurrentBrowser.close();
    if (ownerBrowser) await ownerBrowser.close();
    await context.stopManaged(web, "M2 private preview scenario finalization");
  }
}
