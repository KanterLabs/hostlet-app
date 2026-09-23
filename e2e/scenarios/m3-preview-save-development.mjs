import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { beginBrowser } from "../support/interactive-browser.mjs";
import { assertStatus } from "../support/http-client.mjs";
import { runM3Context } from "../support/m3-context.mjs";
import { M3_UPGRADE_REQUIRED_ASSERTIONS } from "./m3-upgrade.mjs";

const ASSERTION = "M3-PREVIEW-SAVE-DEVELOPMENT";

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function requireCheck(condition, message) {
  if (!condition) throw new Error(message);
}

function hostEnvironment(overrides = {}) {
  const environment = {};
  for (const name of ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TZ", "TMPDIR"]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return { ...environment, ...overrides };
}

async function ensureCheckbox(browser, selector, checked) {
  await browser.waitFor(selector);
  const available = await browser.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLInputElement) || element.type !== "checkbox") return false;
    if (element.checked !== ${checked ? "true" : "false"}) element.click();
    return element.checked === ${checked ? "true" : "false"};
  })()`);
  requireCheck(available, `browser checkbox ${selector} did not reach the requested state`);
}

async function observePreviewSaveResponses(browser) {
  const installed = await browser.evaluate(`(() => {
    if (window.__hostletPreviewSaveResponses) return true;
    const originalFetch = window.fetch.bind(window);
    const observed = [];
    window.__hostletPreviewSaveResponses = observed;
    window.fetch = (...args) => originalFetch(...args).then((response) => {
      try {
        const input = args[0];
        const url = new URL(input instanceof Request ? input.url : String(input), location.href);
        const method = String(args[1]?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
        if (method === "POST" && url.pathname === "/v1/portfolio/preview-revisions" && observed.length < 3) {
          const record = { status: response.status, error_code: null, issues: [] };
          observed.push(record);
          void response.clone().json().then((body) => {
            const error = body?.error;
            if (typeof error?.code === "string" && /^[a-z0-9_]{1,80}$/.test(error.code)) record.error_code = error.code;
            const issues = error?.details?.issues;
            if (Array.isArray(issues)) record.issues = issues.slice(0, 12).filter((issue) =>
              typeof issue?.code === "string" && /^[a-z0-9_]{1,80}$/.test(issue.code) &&
              typeof issue?.path === "string" && /^projects\\[\\d+\\]\\.[a-z_]+$/.test(issue.path)
            ).map((issue) => ({ code: issue.code, path: issue.path }));
          }).catch(() => {});
        }
      } catch { /* observation cannot change the browser request result */ }
      return response;
    });
    return true;
  })()`);
  requireCheck(installed === true, "browser preview save response observer was unavailable");
}

async function safeUiState(browser) {
  if (!browser) return { browser_available: false, capture_reason: "Chromium page was unavailable" };
  return browser.evaluate(`(() => {
    const preview = document.querySelector('[data-testid="preview-editor"]');
    const save = document.querySelector('[data-testid="preview-save"]');
    const review = document.querySelector('[data-testid="publication-load-review"]');
    const notice = document.querySelector('[data-testid="preview-editor-notice"]');
    const publicationNotice = document.querySelector('[data-testid="publication-notice"]');
    const controls = [...document.querySelectorAll('[data-testid="preview-editor"] input, [data-testid="preview-editor"] textarea, [data-testid="preview-editor"] select')];
    const invalid = controls.filter((element) => element instanceof HTMLElement && !element.checkValidity()).slice(0, 12);
    return {
      browser_available: true,
      preview_editor_present: Boolean(preview),
      project_editor_count: document.querySelectorAll('[data-testid="preview-project-editor"]').length,
      save_present: Boolean(save), save_disabled: save?.disabled ?? null, save_label: save?.textContent?.trim().slice(0, 80) ?? null,
      review_present: Boolean(review), review_disabled: review?.disabled ?? null, review_label: review?.textContent?.trim().slice(0, 80) ?? null,
      save_first_present: Boolean(document.querySelector('[data-testid="publication-save-first"]')),
      editor_notice: notice?.textContent?.trim().slice(0, 240) ?? null,
      publication_notice: publicationNotice?.textContent?.trim().slice(0, 240) ?? null,
      conflict_present: Boolean(document.querySelector('[data-testid="preview-conflict"]')),
      invalid_controls: invalid.map((element) => ({ name: element.getAttribute('name') ?? element.getAttribute('data-field') ?? element.tagName.toLowerCase(), message: element.validationMessage.slice(0, 160) })),
      save_responses: Array.isArray(window.__hostletPreviewSaveResponses) ? window.__hostletPreviewSaveResponses.slice(0, 3) : [],
    };
  })()`);
}

async function captureEvidence(context, browser, label) {
  let ui;
  try { ui = await safeUiState(browser); }
  catch (error) { ui = { browser_available: Boolean(browser), capture_reason: `UI state: ${error.message}` }; }
  const evidence = { ui };
  if (browser) {
    try {
      const html = await browser.captureDom(`${label}-dom`, { safe: true });
      evidence.html = relative(context.artifactDir, html);
      evidence.html_sha256 = sha256(readFileSync(html));
    } catch (error) { evidence.html_capture_error = error.message; }
    try {
      const png = await browser.screenshot(`${label}-screenshot`);
      evidence.screenshot = relative(context.artifactDir, png);
      evidence.screenshot_sha256 = sha256(readFileSync(png));
    } catch (error) { evidence.screenshot_capture_error = error.message; }
  }
  return evidence;
}

async function runPreviewSaveDevelopment(context) {
  context.registerFixture("M3 focused private preview browser save diagnostic", "e2e/scenarios/m3-preview-save-development.mjs");
  context.registerFixture("M3 interactive Chromium driver", "e2e/support/interactive-browser.mjs");
  context.registerFixture("M3 private preview editor", "web/src/PreviewEditor.tsx");
  context.registerFixture("M3 saved revision review control", "web/src/PublicationPanel.tsx");

  await runM3Context(context, async (m3) => {
    const baseline = await m3.ownerHTTP("/v1/portfolio/draft-revisions/latest");
    assertStatus(baseline, 200, "selected-source private preview baseline");
    const projectId = m3.state.graph.project.id;
    const project = baseline.payload.draft.projects.find((item) => item.kind?.type === "hosted_project" && item.kind.project_id === projectId);
    const selectedContext = baseline.payload.preview.project_contexts.find((item) => item.project_id === projectId && item.project_reference_id === project?.project_reference_id);
    requireCheck(Boolean(project && selectedContext && m3.state.selectedSource), "retained selected-source private preview lacks the exact owned hosted project context");
    const selectedSource = m3.state.selectedSource;
    requireCheck(selectedContext.configuration_revision_id === selectedSource.configurationRevisionId && selectedContext.source_revision_id === selectedSource.sourceRevisionId && selectedContext.compatibility_report_id === selectedSource.compatibilityReportId, "private preview context is not bound to the retained selected-source identities");

    const webPort = await context.allocatePort();
    const webUrl = `http://127.0.0.1:${webPort}/`;
    const web = context.spawnManaged("M3 preview save Vite web", "npm", ["run", "dev", "--prefix", "web", "--", "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"], { cwd: context.repo, env: hostEnvironment({ VITE_CONTROL_PLANE: m3.apiUrl }) }, "m3-preview-save-vite.log");
    let browser = null;
    let primaryError = null;
    let observations = null;
    let latestStatus = null;
    let evidence = null;
    const narrative = `Approved <script> browser narrative & "quoted" ${randomUUID().slice(0, 8)}`;
    const headline = `Focused owner headline ${randomUUID().slice(0, 8)}`;
    const projectSelector = `[data-testid="preview-project-editor"][data-project-id="${projectId}"]`;
    try {
      await context.waitForHttp(webUrl, 200, "M3 preview save Vite web");
      browser = await beginBrowser(context, { url: webUrl, width: 1440, height: 1300, label: "m3-preview-save", timeoutMs: 40_000 });
      await browser.waitFor('[data-testid="auth-form"]');
      await browser.fill('[data-testid="auth-form"] input[name="email"]', m3.state.owner.record.email);
      await browser.fill('[data-testid="auth-form"] input[name="password"]', m3.credentials.ownerPassword);
      await browser.click('[data-testid="auth-form"] button[type="submit"]');
      await browser.waitFor(projectSelector, { waitTimeoutMs: 40_000 });
      await browser.waitFor('[data-testid="publication-load-review"]', { waitTimeoutMs: 40_000 });
      await observePreviewSaveResponses(browser);
      const initialUi = await safeUiState(browser);

      await browser.select('[data-testid="preview-accent"]', "indigo");
      await browser.fill('[data-testid="preview-editor"] [name="profile.introduction"]', narrative);
      await browser.fill('[data-testid="preview-editor"] [name="profile.headline"]', headline);
      await browser.select('[data-testid="preview-section-headline"]', "hidden");
      await ensureCheckbox(browser, `${projectSelector} [data-testid="preview-status-deployment_timestamp"]`, true);
      await ensureCheckbox(browser, `${projectSelector} [data-testid="preview-status-availability"]`, true);
      await ensureCheckbox(browser, `${projectSelector} [data-testid="preview-status-release_identifier"]`, true);
      await ensureCheckbox(browser, `${projectSelector} [data-testid="preview-status-demo_readiness"]`, true);
      await ensureCheckbox(browser, `${projectSelector} [data-testid="preview-status-source_commit"]`, false);
      await browser.click(`${projectSelector} [data-testid="preview-remove-evidence"]`);
      const unsavedUi = await safeUiState(browser);
      requireCheck(unsavedUi.review_disabled === true && unsavedUi.save_disabled === false, "unsaved private preview did not disable review while allowing save");
      await browser.click('[data-testid="preview-save"]');
      await browser.waitFor(() => {
        const button = document.querySelector('[data-testid="publication-load-review"]');
        const notice = document.querySelector('[data-testid="preview-editor-notice"]');
        return Boolean(button && !button.disabled && notice?.textContent?.includes("Private preview saved."));
      }, { waitTimeoutMs: 30_000 });
      const savedUi = await safeUiState(browser);
      requireCheck(savedUi.review_disabled === false && savedUi.save_first_present === false && savedUi.editor_notice === "Private preview saved." && savedUi.invalid_controls.length === 0, "saved preview did not produce a valid review-ready browser state");

      const latest = await m3.ownerHTTP("/v1/portfolio/draft-revisions/latest");
      latestStatus = latest.status;
      assertStatus(latest, 200, "owner reads browser-saved private preview");
      const savedProject = latest.payload.draft.projects.find((item) => item.project_reference_id === project.project_reference_id);
      const savedContext = latest.payload.preview.project_contexts.find((item) => item.project_reference_id === project.project_reference_id);
      requireCheck(latest.payload.id !== baseline.payload.id && latest.payload.revision > baseline.payload.revision && latest.payload.draft.profile.introduction === narrative && latest.payload.draft.profile.headline === headline && latest.payload.draft.section_visibility.headline === "hidden" && latest.payload.preview.accent === "indigo" && savedProject?.kind?.project_id === projectId && savedProject?.evidence?.length === 0 && savedProject?.displayed_status?.source_commit === false && savedContext?.source_revision_id === selectedSource.sourceRevisionId, "durable owner preview did not retain the browser's exact saved values and selected-source relation");

      const invalidDraft = structuredClone(latest.payload.draft);
      const hostedIndex = invalidDraft.projects.findIndex((item) => item.project_reference_id === project.project_reference_id);
      requireCheck(hostedIndex >= 0, "saved hosted project disappeared before caller-facts rejection check");
      invalidDraft.projects[hostedIndex].authorized_deployment_facts_id = randomUUID();
      const suppliedFacts = await m3.ownerHTTP("/v1/portfolio/preview-revisions", {
        method: "POST",
        headers: { "If-Match": `"${latest.payload.revision}"`, "Idempotency-Key": `m3-preview-caller-facts-${randomUUID()}` },
        body: { draft: invalidDraft, preview: latest.payload.preview },
      });
      const suppliedIssues = suppliedFacts.payload?.error?.details?.issues;
      const forbiddenFactPath = `projects[${hostedIndex}].authorized_deployment_facts_id`;
      requireCheck(suppliedFacts.status === 422 && suppliedFacts.payload?.error?.code === "invalid_portfolio_draft" && Array.isArray(suppliedIssues) && suppliedIssues.some((issue) => issue.code === "unauthorized_deployment_facts" && issue.path === forbiddenFactPath), "owner-supplied deployment facts ID was not rejected at the exact private preview boundary");
      const afterRejectedFacts = await m3.ownerHTTP("/v1/portfolio/draft-revisions/latest");
      requireCheck(afterRejectedFacts.status === 200 && afterRejectedFacts.payload?.id === latest.payload.id && afterRejectedFacts.payload?.revision === latest.payload.revision, "rejected caller deployment facts changed the saved preview revision");

      const review = await m3.ownerHTTP(`/v1/portfolio/publication-review?draft_revision_id=${encodeURIComponent(latest.payload.id)}`);
      requireCheck(review.status === 409 && review.payload?.error?.code === "deployment_facts_unavailable", "publication review accepted private display preferences without a healthy routed release");
      const approval = await m3.ownerHTTP("/v1/portfolio/approved-revisions/latest");
      requireCheck(approval.status === 404, "a private preview without a healthy release unexpectedly produced an approved revision");
      observations = {
        diagnostic_only: true, production_capability_registered: false, m3_gate_satisfied: false,
        project_id: projectId, selected_source_commit: selectedSource.commitSha,
        baseline_revision_id: baseline.payload.id, baseline_revision: baseline.payload.revision,
        saved_revision_id: latest.payload.id, saved_revision: latest.payload.revision,
        initial_ui: initialUi, unsaved_ui: unsavedUi, saved_ui: savedUi,
        owner_latest_status: latest.status, saved_introduction_sha256: sha256(Buffer.from(narrative)),
        selected_source_context_retained: true, evidence_removed: true, source_commit_opt_in: false,
        caller_facts_rejection: { status: suppliedFacts.status, error_code: suppliedFacts.payload.error.code, issue: { code: "unauthorized_deployment_facts", path: forbiddenFactPath }, latest_revision_unchanged: true },
        review_without_release: { status: review.status, error_code: review.payload.error.code, approved_revision_status: approval.status },
      };
    } catch (error) {
      primaryError = error;
    } finally {
      evidence = await captureEvidence(context, browser, primaryError ? "m3-preview-save-failed" : "m3-preview-save-passed");
      if (browser) {
        try { await browser.close(); } catch (error) { primaryError ??= error; }
      }
      try { await context.stopManaged(web, "M3 preview save Vite cleanup"); } catch (error) { primaryError ??= error; }
    }

    if (browser && (!evidence.html || !evidence.screenshot || evidence.ui?.review_present !== true)) {
      primaryError ??= new Error("browser save diagnostic did not retain complete DOM, screenshot, and review control evidence");
    }

    const record = {
      schema: "hostlet.m3-preview-save-development/v1",
      diagnostic_only: true, production_capability_registered: false, m3_gate_satisfied: false,
      status: primaryError ? "failed" : "passed", project_id: projectId,
      owner_latest_status: latestStatus, evidence, observations,
      ...(primaryError ? { error: context.redact(primaryError.message) } : {}),
    };
    writeFileSync(join(context.artifactDir, "m3-preview-save-development.json"), `${context.redact(JSON.stringify(record, null, 2))}\n`, { encoding: "utf8", mode: 0o600 });
    const expected = "the real browser disables review for unsaved private preview edits, then one save persists exact values in PostgreSQL and enables Review saved revision without approving or publishing";
    context.assertion(ASSERTION, "M3 focused private preview save", expected, { ...observations, evidence, owner_latest_status: latestStatus, diagnostic_only: true, production_capability_registered: false }, !primaryError, primaryError?.message ?? null);
    if (primaryError) throw primaryError;
  });
}

export const scenario = Object.freeze({
  id: "m3-preview-save-development",
  description: "Diagnostic-only Chromium preview save and review-readiness transition over real M3 control and PostgreSQL; excludes approval, publication, runtime, and M3 gate acceptance",
  requiredAssertions: Object.freeze([...M3_UPGRADE_REQUIRED_ASSERTIONS, ASSERTION]),
  run: runPreviewSaveDevelopment,
});
