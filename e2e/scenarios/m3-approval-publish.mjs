import { createHash, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beginBrowser } from "../support/interactive-browser.mjs";
import { assertStatus, expectScenario, ScenarioExpectationError } from "../support/http-client.mjs";

export const M3_APPROVAL_PUBLISH_REQUIRED_ASSERTIONS = Object.freeze([
  "M3-APPROVAL-SETUP-01",
  "M3-APPROVAL-SETUP-02",
  "M3-APPROVAL-01",
  "M3-APPROVAL-02",
  "M3-APPROVAL-03",
  "M3-PUBLISH-01",
  "M3-PUBLISH-02",
  "M3-PUBLISH-03",
]);

function rawPathStatus(port, path, signal) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port,
      path,
      method: "GET",
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    }, (response) => {
      const status = response.statusCode;
      response.destroy();
      resolve({ status });
    });
    request.once("error", reject);
    request.end();
  });
}

function hostEnvironment(overrides = {}) {
  const environment = {};
  for (const name of ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TZ", "TMPDIR"]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return { ...environment, ...overrides };
}

function safeObserved(error) {
  if (error instanceof ScenarioExpectationError) return error.observed;
  return { failed_checks: 1 };
}

async function approvalPublishStep(context, id, scenario, expected, run) {
  try {
    const observed = await run();
    context.assertion(id, scenario, expected, observed, true);
    return observed;
  } catch (error) {
    context.assertion(
      id,
      scenario,
      expected,
      safeObserved(error),
      false,
      error instanceof ScenarioExpectationError ? error.check : "browser, HTTP, PostgreSQL, worker, or independent static boundary failed",
    );
    throw error;
  }
}

function requireCallback(orchestration, name) {
  const callback = orchestration?.[name];
  if (typeof callback !== "function") throw new Error(`M3 approval/publish compositor callback is required: ${name}`);
  return callback;
}

function sqlLiteral(value) {
  return String(value).replaceAll("'", "''");
}

async function readinessRows(m3, approvedRevisionId, projectReferenceId, label) {
  return m3.postgres.psqlJson(
    label,
    `SELECT COALESCE(json_agg(json_build_object(
       'id',readiness.id::text,'event_sequence',readiness.event_sequence,'fact_revision_id',readiness.fact_revision_id::text,
       'previous_event_id',readiness.previous_event_id::text,'state',readiness.state,'reason',readiness.reason,'attestation',readiness.attestation,
       'audit_event_id',audit.id::text,'audit_event_type',audit.event_type,
       'audit_target_type',audit.target_type,'audit_outcome',audit.outcome
     ) ORDER BY readiness.event_sequence),'[]'::json) FROM portfolio_readiness_events readiness
     JOIN audit_events audit ON audit.id=readiness.audit_event_id
     WHERE readiness.account_id='${sqlLiteral(m3.state.owner.record.id)}'
       AND readiness.approved_revision_id='${sqlLiteral(approvedRevisionId)}'
       AND readiness.project_reference_id='${sqlLiteral(projectReferenceId)}';`,
  );
}

async function factRevisionRows(m3, approvedRevisionId, label) {
  return m3.postgres.psqlJson(
    label,
    `SELECT COALESCE(json_agg(json_build_object(
       'id',facts.id::text,'project_reference_id',facts.project_reference_id,'revision_number',facts.revision_number,
       'previous_fact_revision_id',facts.previous_fact_revision_id::text,'revision_kind',facts.revision_kind,
       'source_release_id',facts.source_release_id::text,'source_deployment_id',facts.source_deployment_id::text,
       'facts_digest',encode(facts.facts_digest,'hex'),'audit_event_id',audit.id::text,
       'audit_event_type',audit.event_type,'audit_target_type',audit.target_type,
       'audit_outcome',audit.outcome
     ) ORDER BY facts.project_reference_id,facts.revision_number,facts.id),'[]'::json) FROM portfolio_deployment_fact_revisions facts
     JOIN audit_events audit ON audit.id=facts.audit_event_id
     WHERE facts.account_id='${sqlLiteral(m3.state.owner.record.id)}'
       AND facts.approved_revision_id='${sqlLiteral(approvedRevisionId)}';`,
  );
}

function stagingPath(root, lease) {
  if (!lease || typeof lease.staging_relative_path !== "string" || !lease.staging_relative_path.startsWith("staging/")) {
    throw new Error("publisher lease did not return an owned staging path");
  }
  return join(root, lease.staging_relative_path);
}

async function leasePublication(m3, workerId, label) {
  const response = await m3.roleInternal("publisher", "/internal/v1/portfolio-publications/lease", {
    method: "POST",
    body: { worker_id: workerId },
  });
  assertStatus(response, 200, label);
  expectScenario(
    response.payload?.publication_id && response.payload?.attempt_id && response.payload?.fence,
    `${label}: lease contains a fenced publication attempt`,
    { lease_present: false },
  );
  return response.payload;
}

async function completePublicationAttempt(m3, lease, workerId, outcome, label) {
  return m3.roleInternal("publisher", `/internal/v1/portfolio-publications/${lease.publication_id}/complete`, {
    method: "POST",
    body: {
      worker_id: workerId,
      attempt_id: lease.attempt_id,
      fence: lease.fence,
      outcome,
    },
  });
}

async function waitForLeaseExpiry(context, lease) {
  const expiry = Date.parse(lease.lease_expires_at);
  if (!Number.isFinite(expiry)) throw new Error("publisher lease expiry is invalid");
  while (Date.now() <= expiry + 100) {
    await context.delay(Math.min(500, Math.max(25, expiry + 150 - Date.now())));
  }
}

function projectPath(reference) {
  if (
    typeof reference === "string" &&
    reference.length > 0 &&
    reference.length <= 80 &&
    [...reference].every((character) => /[A-Za-z0-9_-]/.test(character))
  ) {
    return reference;
  }
  return `project-${createHash("sha256").update(String(reference)).digest("hex").slice(0, 16)}`;
}

async function waitForPath(path, context, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (context.abortSignal.aborted) throw context.abortSignal.reason;
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("publisher artifact root was not created");
}

async function signIn(browser, m3) {
  await browser.waitFor('[data-testid="auth-form"]');
  await browser.fill('[data-testid="auth-form"] input[name="email"]', m3.state.owner.record.email);
  await browser.fill('[data-testid="auth-form"] input[name="password"]', m3.credentials.ownerPassword);
  await browser.click('[data-testid="auth-form"] button[type="submit"]');
  await browser.waitFor('[data-testid="publication-panel"]', { waitTimeoutMs: 40_000 });
}

async function waitForPublicationState(browser, state, timeoutMs = 40_000) {
  await browser.waitFor(`[data-testid="publication-job"][data-publication-state="${state}"]`, { waitTimeoutMs: timeoutMs });
}

async function ensureCheckbox(browser, selector, checked) {
  await browser.waitFor(selector);
  const changed = await browser.evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!(input instanceof HTMLInputElement) || input.type !== "checkbox") return null;
    if (input.checked === ${checked ? "true" : "false"}) return false;
    input.click();
    return true;
  })()`);
  if (changed === null) throw new Error("browser checkbox was unavailable");
}

async function approveCurrentSavedRevision(browser) {
  await browser.waitFor(
    () => {
      const button = document.querySelector('[data-testid="publication-load-review"]');
      return Boolean(button && !button.disabled);
    },
    { waitTimeoutMs: 30_000 },
  );
  await browser.click('[data-testid="publication-load-review"]');
  await browser.waitFor('[data-testid="publication-review"]', { waitTimeoutMs: 30_000 });
  await browser.click('[data-testid="publication-entire-confirm"]');
  await browser.click('[data-testid="publication-approve"]');
  await browser.waitFor(
    () => document.querySelector('[data-testid="publication-notice"]')?.textContent?.includes("This saved revision is approved") === true,
    { waitTimeoutMs: 30_000 },
  );
}

function spawnPublisherWorker(context, m3, publisherBinary, label) {
  return context.spawnManaged(
    `M3 publisher worker ${label}`,
    publisherBinary,
    ["worker", "--control-url", m3.workerUrl, "--worker-id", `publisher-${label}`, "--once"],
    { cwd: context.repo, env: m3.componentEnvironment("publisher") },
    `m3-publisher-worker-${label}.log`,
  );
}

async function latestPublication(m3, label) {
  const response = await m3.ownerHTTP("/v1/portfolio/publications/latest");
  assertStatus(response, 200, label);
  return response.payload;
}

async function latestApproval(m3, label) {
  const response = await m3.ownerHTTP("/v1/portfolio/approved-revisions/latest");
  assertStatus(response, 200, label);
  return response.payload;
}

async function publicationRows(m3, label) {
  return m3.postgres.psqlJson(
    label,
    `SELECT COALESCE(json_agg(json_build_object(
       'id',publications.id::text,'approved_revision_id',publications.approved_revision_id::text,'slug',publications.slug,'state',publications.state,
       'document_digest',publications.document_digest,'artifact_digest',publications.artifact_digest,'pointer_generation',publications.pointer_generation,
       'failure_code',publications.failure_code,'cause',publications.cause,'audit_event_id',audit.id::text,
       'audit_event_type',audit.event_type,'audit_target_type',audit.target_type,'audit_outcome',audit.outcome
     ) ORDER BY publications.publication_sequence),'[]'::json) FROM portfolio_publications publications
     JOIN audit_events audit ON audit.id=publications.audit_event_id
     WHERE publications.account_id='${m3.state.owner.record.id.replaceAll("'", "''")}';`,
  );
}

async function publicSiteRows(m3, label) {
  return m3.postgres.psqlJson(
    label,
    `SELECT COALESCE(json_agg(json_build_object(
       'account_id',account_id::text,'slug',slug,'current_publication_id',current_publication_id::text,
       'current_artifact_digest',current_artifact_digest,'pointer_generation',pointer_generation
     ) ORDER BY slug),'[]'::json) FROM portfolio_public_sites
     WHERE account_id='${sqlLiteral(m3.state.owner.record.id)}';`,
  );
}

async function approvalCount(m3, label) {
  return m3.postgres.psqlJson(
    label,
    `SELECT COUNT(*)::int AS count FROM portfolio_approved_revisions WHERE account_id='${m3.state.owner.record.id.replaceAll("'", "''")}';`,
  );
}

async function hostedCapacityUsage(m3, label) {
  return m3.postgres.psqlJson(
    label,
    `SELECT json_build_object(
       'project_count',(SELECT COUNT(*)::int FROM projects WHERE account_id='${m3.state.owner.record.id.replaceAll("'", "''")}'),
       'hosted_slots',(SELECT COALESCE(SUM(hosted_slots),0)::int FROM projects WHERE account_id='${m3.state.owner.record.id.replaceAll("'", "''")}'),
       'active_reservations',(SELECT COUNT(*)::int FROM slot_reservations WHERE account_id='${m3.state.owner.record.id.replaceAll("'", "''")}' AND state<>'released')
     );`,
  );
}

export function registerM3ApprovalPublishFixtures(context) {
  context.registerFixture("M3 approval and independent publication browser scenario", "e2e/scenarios/m3-approval-publish.mjs");
  context.registerFixture("M3 approval contract", "docs/M3-APPROVAL-CONTRACT.md");
  context.registerFixture("M3 publisher contract", "docs/M3-PUBLISHER-CONTRACT.md");
  context.registerFixture("M3 interactive Chromium driver", "e2e/support/interactive-browser.mjs");
  context.registerFixture("M3 owner approval UI", "web/src/PublicationPanel.tsx");
}

// The compositor owns release/runtime sequencing and passes only real boundary
// callbacks. This scenario owns the browser, Vite, publisher worker and static
// server. No callback may insert approval, fact, publication, attempt or artifact
// rows directly.
export async function runM3ApprovalPublishScenarios(context, m3, orchestration) {
  registerM3ApprovalPublishFixtures(context);
  const prepareCurrentRelease = requireCallback(orchestration, "prepareCurrentRelease");
  const promoteReplacementRelease = requireCallback(orchestration, "promoteReplacementRelease");
  const withUpstreamsStopped = requireCallback(orchestration, "withUpstreamsStopped");

  let initialRelease = null;
  await approvalPublishStep(
    context,
    "M3-APPROVAL-SETUP-01",
    "M3 approval/publish setup",
    "the compositor exposes the actual current healthy routed release before browser approval begins",
    async () => {
      initialRelease = await prepareCurrentRelease({ context, m3 });
      expectScenario(
        initialRelease?.projectId === m3.state.graph.project.id &&
          typeof initialRelease.sourceReleaseId === "string" &&
          typeof initialRelease.managedDemoUrl === "string" &&
          typeof initialRelease.sourceCommit === "string" &&
          typeof initialRelease.projectReferenceId === "string",
        "approval fixture exposes the actual current healthy routed release",
        { current_release_ready: false },
      );
      return {
        project_id: initialRelease.projectId,
        source_release_id: initialRelease.sourceReleaseId,
        project_reference_id: initialRelease.projectReferenceId,
      };
    },
  );
  let publicationBeforeApproval = null;
  await approvalPublishStep(
    context,
    "M3-APPROVAL-SETUP-02",
    "M3 approval/publish setup",
    "the pre-approval publication head is observed through the owner HTTP boundary",
    async () => {
      publicationBeforeApproval = await m3.ownerHTTP("/v1/portfolio/publications/latest");
      expectScenario(
        publicationBeforeApproval.status === 200 || publicationBeforeApproval.status === 404,
        "approval scenario records the pre-approval publication head",
        { preapproval_publication_status: publicationBeforeApproval.status },
      );
      return { preapproval_publication_status: publicationBeforeApproval.status };
    },
  );

  const webPort = await context.allocatePort();
  const staticPort = await context.allocatePort();
  const webUrl = `http://127.0.0.1:${webPort}/`;
  const staticBase = `http://127.0.0.1:${staticPort}/`;
  const publisherBinary = join(context.repo, "target", "debug", "hostlet-publisher");
  const publisherRoot = join(m3.policyClock.stateDir, "publisher");
  const slug = `m3-owner-${randomUUID().slice(0, 8)}`;
  const firstNarrative = `Approved <script> browser narrative & "quoted" ${randomUUID().slice(0, 8)}`;
  const hiddenHeadline = `Hidden owner-only headline ${randomUUID().slice(0, 8)}`;
  const replacementNarrative = `Replacement browser narrative ${randomUUID().slice(0, 8)}`;
  const recoveryNarrative = `Recovered browser narrative ${randomUUID().slice(0, 8)}`;
  const stalePublicationSlug = `m3-stale-${randomUUID().slice(0, 8)}`;
  const projectSelector = `[data-testid="preview-project-editor"][data-project-id="${m3.state.graph.project.id}"]`;
  const web = context.spawnManaged(
    "M3 approval Vite web",
    "npm",
    ["run", "dev", "--prefix", "web", "--", "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"],
    { cwd: context.repo, env: hostEnvironment({ VITE_CONTROL_PLANE: m3.apiUrl, VITE_HOSTLET_PUBLIC_SITE_BASE_URL: staticBase }) },
    "m3-approval-vite.log",
  );
  let browser = null;
  let staticServer = null;
  let firstApproval = null;
  let firstPublished = null;
  let replacementApproval = null;
  let firstReadinessAttestation = null;
  let staleReviewResponse = null;
  let promotionConcurrentDraftWrite = null;
  let promotionConcurrentDraftRequest = null;
  let promotionConcurrentEditNarrative = null;
  let promotionConcurrentEditSourceUrl = null;
  let primaryError = null;
  let webStopped = false;
  let initialCapacityUsage = null;

  try {
    await context.waitForHttp(webUrl, 200, "M3 approval Vite web");
    browser = await beginBrowser(context, { url: webUrl, width: 1440, height: 1300, label: "m3-approval-publish", timeoutMs: 40_000 });
    await signIn(browser, m3);
    initialCapacityUsage = await hostedCapacityUsage(m3, "m3-hosted-capacity-before-publication");

    await approvalPublishStep(
      context,
      "M3-APPROVAL-01",
      "M3 owner approval",
      "the owner reviews and approves every exact public value from one immutable saved revision; unsaved, private source and stale values cannot become approved",
      async () => {
        await browser.select('[data-testid="preview-accent"]', "indigo");
        await browser.fill('[data-testid="preview-editor"] [name="profile.introduction"]', firstNarrative);
        await browser.fill('[data-testid="preview-editor"] [name="profile.headline"]', hiddenHeadline);
        await browser.select('[data-testid="preview-section-headline"]', "hidden");
        const reviewDisabledWithUnsaved = await browser.evaluate('document.querySelector(\'[data-testid="publication-load-review"]\')?.disabled === true');
        expectScenario(reviewDisabledWithUnsaved, "unsaved browser values cannot enter publication review", { review_disabled_with_unsaved_values: false });
        await ensureCheckbox(browser, `${projectSelector} [data-testid="preview-status-deployment_timestamp"]`, true);
        await ensureCheckbox(browser, `${projectSelector} [data-testid="preview-status-availability"]`, true);
        await ensureCheckbox(browser, `${projectSelector} [data-testid="preview-status-release_identifier"]`, true);
        await ensureCheckbox(browser, `${projectSelector} [data-testid="preview-status-demo_readiness"]`, true);
        await ensureCheckbox(browser, `${projectSelector} [data-testid="preview-status-source_commit"]`, false);
        await browser.click(`${projectSelector} [data-testid="preview-remove-evidence"]`);
        const screenshotStillPresent = await browser.evaluate(`Boolean(document.querySelector(${JSON.stringify(`${projectSelector} [data-testid="preview-remove-evidence"]`)}))`);
        expectScenario(!screenshotStillPresent, "owner removes externally loaded screenshot evidence before publication review", { external_screenshot_retained: screenshotStillPresent });
        const sourceCommitSelected = await browser.evaluate(`document.querySelector(${JSON.stringify(`${projectSelector} [data-testid="preview-status-source_commit"]`)})?.checked === true`);
        expectScenario(!sourceCommitSelected, "source commit remains private without explicit owner opt-in", { source_commit_selected: sourceCommitSelected });
        await browser.click('[data-testid="preview-save"]');
        try {
          await browser.waitFor(() => {
            const button = document.querySelector('[data-testid="publication-load-review"]');
            return Boolean(button && !button.disabled);
          }, { waitTimeoutMs: 30_000 });
        } catch (error) {
          const [state, screenshot, dom] = await Promise.allSettled([
            browser.evaluate(`(() => {
              const notice = document.querySelector('[data-testid="preview-editor-notice"]')?.textContent ?? '';
              const review = document.querySelector('[data-testid="publication-load-review"]');
              const save = document.querySelector('[data-testid="preview-save"]');
              return {
                review_present: Boolean(review),
                review_disabled: review instanceof HTMLButtonElement ? review.disabled : null,
                save_disabled: save instanceof HTMLButtonElement ? save.disabled : null,
                save_first_present: Boolean(document.querySelector('[data-testid="publication-save-first"]')),
                notice_kind: notice === 'Private preview saved.' ? 'saved'
                  : notice.includes('Review the form values') ? 'validation'
                  : notice.includes('changed while you were working') ? 'stale'
                  : notice.includes('session has expired') ? 'session_expired'
                  : notice ? 'other' : 'none',
              };
            })()`),
            browser.screenshot('m3-approval-save-transition-failure'),
            browser.captureDom('m3-approval-save-transition-failure', { safe: true }),
          ]);
          try {
            writeFileSync(join(context.artifactDir, 'm3-approval-save-transition-failure.json'), JSON.stringify({
              schema: 'hostlet.e2e.approval-save-transition-failure/v1',
              ui: state.status === 'fulfilled' ? state.value : null,
              screenshot_retained: screenshot.status === 'fulfilled',
              safe_dom_retained: dom.status === 'fulfilled',
            }), { flag: 'wx', mode: 0o600 });
          } catch { /* Preserve the original browser transition failure. */ }
          throw error;
        }
        await browser.click('[data-testid="publication-load-review"]');
        await browser.waitFor('[data-testid="publication-review"]', { waitTimeoutMs: 30_000 });
        await ensureCheckbox(browser, '[data-testid="publication-refresh-deployment_timestamp"]', true);
        await ensureCheckbox(browser, '[data-testid="publication-refresh-availability_label"]', true);
        await browser.click('[data-testid="publication-entire-confirm"]');
        await browser.click('[data-testid="publication-approve"]');
        await browser.waitFor('[data-testid="publication-approved-state"]', { waitTimeoutMs: 30_000 });
        firstApproval = await latestApproval(m3, "first browser-approved revision");
        const firstFact = firstApproval.deployment_facts.find(({ project_reference_id: id }) => id === initialRelease.projectReferenceId);
        expectScenario(Boolean(firstFact), "first approval exposes the current fact revision for readiness attestation", { fact_revision_present: false });
        firstReadinessAttestation = await m3.ownerHTTP("/v1/portfolio/readiness-attestations", {
          method: "POST",
          headers: { "Idempotency-Key": `m3-initial-readiness-${randomUUID()}` },
          body: {
            approved_revision_id: firstApproval.id,
            project_reference_id: initialRelease.projectReferenceId,
            fact_revision_id: firstFact.id,
            demo_page_verified: true,
            synthetic_example_data_verified: true,
            restricted_access_verified: true,
            visitor_instructions_verified: true,
            visitor_instructions: "Open the managed demo and use the seeded example account.",
          },
        });
        assertStatus(firstReadinessAttestation, 201, "initial readiness attestation");
        expectScenario(
          firstReadinessAttestation.payload?.state === "ready_to_share" &&
            firstReadinessAttestation.payload?.attestation?.release_id === initialRelease.sourceReleaseId,
          "owner attestation establishes readiness before the replacement release",
          { readiness_state: firstReadinessAttestation.payload?.state ?? null },
        );
        firstApproval = await latestApproval(m3, "first approval after readiness attestation");
        const duplicateApprovalKey = `m3-duplicate-approval-${randomUUID()}`;
        const duplicateApprovalBody = {
          draft_revision_id: firstApproval.source_draft_revision_id,
          review_digest: firstApproval.review_digest,
          approval: { type: "entire_revision", review_digest: firstApproval.review_digest },
          refresh_authorizations: [
            {
              project_reference_id: initialRelease.projectReferenceId,
              fields: ["deployment_timestamp", "availability_label"],
            },
          ],
        };
        const approvalCountBeforeReplay = await approvalCount(m3, "m3-approval-count-before-idempotent-replay");
        const duplicateApproval = await m3.ownerHTTP("/v1/portfolio/approved-revisions", {
          method: "POST",
          headers: { "Idempotency-Key": duplicateApprovalKey },
          body: duplicateApprovalBody,
        });
        assertStatus(duplicateApproval, 201, "duplicate approval first replay");
        const duplicateApprovalReplay = await m3.ownerHTTP("/v1/portfolio/approved-revisions", {
          method: "POST",
          headers: { "Idempotency-Key": duplicateApprovalKey },
          body: duplicateApprovalBody,
        });
        assertStatus(duplicateApprovalReplay, 201, "duplicate approval exact idempotent replay");
        const approvalCountAfterReplay = await approvalCount(m3, "m3-approval-count-after-idempotent-replay");
        expectScenario(
          duplicateApproval.payload.id === firstApproval.id &&
            JSON.stringify(duplicateApprovalReplay.payload) === JSON.stringify(duplicateApproval.payload) &&
            approvalCountAfterReplay.count === approvalCountBeforeReplay.count,
          "duplicate exact approval is byte-stable and appends no revision",
          { approved_revision_id: duplicateApproval.payload.id, approval_count_delta: approvalCountAfterReplay.count - approvalCountBeforeReplay.count },
        );
        const afterApprovalPublication = await m3.ownerHTTP("/v1/portfolio/publications/latest");
        expectScenario(
          afterApprovalPublication.status === publicationBeforeApproval.status &&
            (afterApprovalPublication.status === 404 || afterApprovalPublication.payload.id === publicationBeforeApproval.payload.id),
          "approval alone does not append or replace a publication",
          { before_status: publicationBeforeApproval.status, after_status: afterApprovalPublication.status },
        );
        const requirements = firstApproval.requirements;
        expectScenario(
          firstApproval.snapshot.profile.introduction === firstNarrative &&
            firstApproval.snapshot.section_visibility.headline === "hidden" &&
            firstApproval.snapshot.projects.every(({ evidence }) => evidence.every(({ url }) => url !== "https://assets.example.test/atlas/dashboard.webp")) &&
            firstApproval.approvals.length === requirements.length &&
            requirements.every(({ value_digest: digest }) => firstApproval.approvals.some(({ value_digest }) => value_digest === digest)) &&
            !JSON.stringify(requirements).includes(initialRelease.sourceCommit) &&
            !JSON.stringify(requirements).includes(hiddenHeadline) &&
            !JSON.stringify(requirements).includes("https://assets.example.test/atlas/dashboard.webp"),
          "durable approval records every exact public target while omitting the private source commit",
          { exact_approval_complete: false },
        );
        return { approved_revision_id: firstApproval.id, target_count: requirements.length, source_commit_public: false, external_screenshot_approved: false, hidden_headline_approved: false, duplicate_approval_rows: approvalCountAfterReplay.count - approvalCountBeforeReplay.count, publication_created_by_approval: false };
      },
    );

    await approvalPublishStep(
      context,
      "M3-PUBLISH-01",
      "M3 independent static publishing",
      "an explicit browser publication renders and independently serves the complete approved document with no private or hidden source values",
      async () => {
        const rowsBeforeUnsafeSlug = await publicationRows(m3, "m3-publications-before-unsafe-slug");
        const unsafeSlug = await m3.ownerHTTP("/v1/portfolio/publications", {
          method: "POST",
          headers: { "Idempotency-Key": `m3-unsafe-slug-${randomUUID()}` },
          body: { approved_revision_id: firstApproval.id, slug: "../private" },
        });
        assertStatus(unsafeSlug, 400, "unsafe publication slug rejection");
        expectScenario(unsafeSlug.payload?.error?.code === "invalid_publication_slug", "unsafe path-like slug fails before publication", { error_code: unsafeSlug.payload?.error?.code ?? null });
        const rowsAfterUnsafeSlug = await publicationRows(m3, "m3-publications-after-unsafe-slug");
        expectScenario(rowsAfterUnsafeSlug.length === rowsBeforeUnsafeSlug.length, "unsafe slug appends no publication", { before: rowsBeforeUnsafeSlug.length, after: rowsAfterUnsafeSlug.length });
        await browser.fill('[data-testid="publication-slug"]', slug);
        await browser.click('[data-testid="publication-publish"]');
        await waitForPublicationState(browser, "queued");
        spawnPublisherWorker(context, m3, publisherBinary, "initial");
        await waitForPublicationState(browser, "published");
        firstPublished = await latestPublication(m3, "initial published portfolio");
        await waitForPath(publisherRoot, context);
        staticServer = context.spawnManaged(
          "M3 independent static portfolio server",
          publisherBinary,
          ["serve", "--root", publisherRoot, "--bind", `127.0.0.1:${staticPort}`, "--expected-host", `127.0.0.1:${staticPort}`],
          { cwd: context.repo, env: { PATH: process.env.PATH ?? "" } },
          "m3-publisher-static.log",
        );
        const publicUrl = `${staticBase}${slug}/`;
        await context.waitForHttp(publicUrl, 200, "M3 independent published portfolio");
        await browser.navigate(publicUrl);
        const publicText = await browser.text("body");
        const publicScriptCount = await browser.evaluate('document.querySelectorAll("script").length');
        const publishedProjectCards = await browser.evaluate('[...document.querySelectorAll("a.card")].map((card) => ({ href: card.href, title: card.querySelector("h3")?.textContent ?? "", text: card.textContent ?? "" }))');
        const expectedProjects = firstApproval.snapshot.projects
          .filter(({ visibility }) => visibility === "shown")
          .sort((a, b) => a.order - b.order)
          .map((project) => ({ ...project, expected_path: projectPath(project.project_reference_id) }));
        const expectedProjectTitles = expectedProjects.map(({ title }) => title);
        const indexLinks = await browser.evaluate('[...document.querySelectorAll("a[href]")].map((link) => link.href)');
        const hiddenProjectTitles = firstApproval.snapshot.projects.filter(({ visibility }) => visibility !== "shown").map(({ title }) => title);
        const indexShapeMatches = publishedProjectCards.length === expectedProjects.length &&
          publishedProjectCards.every((card, index) =>
            card.title === expectedProjects[index].title &&
            card.text.includes(expectedProjects[index].purpose) &&
            card.href === `${staticBase}${slug}/projects/${expectedProjects[index].expected_path}/`);
        expectScenario(
          indexShapeMatches && hiddenProjectTitles.every((title) => !publicText.includes(title)),
          "published index contains every shown project in approved order and omits hidden projects",
          {
            published_project_count: publishedProjectCards.length,
            expected_project_count: expectedProjects.length,
            published_project_titles: publishedProjectCards.map(({ title }) => title),
            expected_project_titles: expectedProjectTitles,
            hidden_project_titles_absent: hiddenProjectTitles.every((title) => !publicText.includes(title)),
          },
        );
        let projectChecks = [];
        for (const [index, expectedProject] of expectedProjects.entries()) {
          const card = publishedProjectCards[index];
          await browser.navigate(card.href);
          const projectText = await browser.text("body");
          const projectLinks = await browser.evaluate('[...document.querySelectorAll("a[href]")].map((link) => link.href)');
          const projectImages = await browser.evaluate('[...document.querySelectorAll("img[src]")].map((image) => image.src)');
          const decisionValues = (expectedProject.technical_decisions ?? []).flatMap(({ summary, rationale }) => [summary, rationale]);
          const expectedLinkDestinations = (expectedProject.links ?? []).map(({ link }) => link.url);
          const expectedEvidence = expectedProject.evidence ?? [];
          const fact = firstApproval.deployment_facts.find(({ project_reference_id: id }) => id === expectedProject.project_reference_id);
          const readiness = firstApproval.readiness.find(({ project_reference_id: id }) => id === expectedProject.project_reference_id);
          const status = expectedProject.displayed_status ?? {};
          const expectedStatusValues = [
            status.deployment_timestamp === true ? fact?.facts?.deployed_at : null,
            status.availability === true ? fact?.facts?.status_label : null,
            status.release_identifier === true ? fact?.facts?.displayed_release_identifier : null,
          ].filter((value) => typeof value === "string");
          const readinessDisplayed = status.demo_readiness === true && readiness?.state === "ready_to_share";
          const detailMatches =
            projectText.includes(expectedProject.title) &&
            projectText.includes(expectedProject.purpose) &&
            projectText.includes(expectedProject.contribution) &&
            decisionValues.every((value) => projectText.includes(value)) &&
            expectedLinkDestinations.every((url) => projectLinks.includes(url)) &&
            expectedEvidence.every((evidence) =>
              projectText.includes(evidence.title) &&
              (evidence.kind === "screenshot" ? projectImages.includes(evidence.url) : projectLinks.includes(evidence.url))) &&
            expectedStatusValues.every((value) => projectText.includes(value)) &&
            (!readinessDisplayed || projectText.includes("ready to share"));
          const privateValuesAbsent =
            !projectText.includes(hiddenHeadline) &&
            !projectText.includes(initialRelease.sourceCommit) &&
            !projectText.includes("synthetic private fixture metadata");
          projectChecks.push({
            project_reference_id: expectedProject.project_reference_id,
            title: expectedProject.title,
            detail_matches: detailMatches,
            links_present: expectedLinkDestinations.every((url) => projectLinks.includes(url)),
            evidence_present: expectedEvidence.every((evidence) => projectText.includes(evidence.title)),
            status_values_present: expectedStatusValues.every((value) => projectText.includes(value)),
            readiness_present: !readinessDisplayed || projectText.includes("ready to share"),
            private_values_absent: privateValuesAbsent,
          });
          expectScenario(
            detailMatches && privateValuesAbsent,
            `published detail ${index + 1} contains all approved project values without the private source commit`,
            projectChecks.at(-1),
          );
        }
        await browser.navigate(publicUrl);
        const cssResponse = await fetch(`${staticBase}${slug}/assets/site.css`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
        const cssText = await cssResponse.text();
        const accentPublished = firstApproval.preview_context?.accent === "indigo" && cssText.includes("#4f46a5");
        expectScenario(
          cssResponse.status === 200 && accentPublished,
          "published CSS preserves the owner-approved indigo appearance token",
          { css_status: cssResponse.status, approved_accent: firstApproval.preview_context?.accent ?? null, indigo_token_present: cssText.includes("#4f46a5") },
        );
        const approvedProject = expectedProjects.find(({ project_reference_id: id }) => id === initialRelease.projectReferenceId);
        expectScenario(Boolean(approvedProject), "published detail has a matching approved project", { approved_project_present: false });
        const approvedLinkDestinations = (approvedProject?.links ?? []).map(({ link }) => link.url);
        expectScenario(
          publicText.includes(firstNarrative) &&
            !publicText.includes(hiddenHeadline) &&
            !publicText.includes("https://assets.example.test/atlas/dashboard.webp") &&
            !publicText.includes("synthetic private fixture metadata") &&
            publicScriptCount === 0 &&
            firstApproval.snapshot.skills.every((skill) => publicText.includes(skill)) &&
            firstApproval.snapshot.contacts.every(({ url }) => indexLinks.includes(url)) &&
            (!firstApproval.snapshot.resume || indexLinks.includes(firstApproval.snapshot.resume.url)) &&
            indexShapeMatches &&
            projectChecks.every(({ detail_matches, private_values_absent }) => detail_matches && private_values_absent) &&
            !publicText.includes(initialRelease.sourceCommit) &&
            firstPublished.state === "published" &&
            typeof firstPublished.artifact_digest === "string" &&
            Number.isSafeInteger(firstPublished.pointer_generation),
          "independent static server exposes only the approved artifact after verified pointer promotion",
          {
            public_narrative_present: publicText.includes(firstNarrative),
            approved_contribution_present: projectChecks.find(({ project_reference_id }) => project_reference_id === initialRelease.projectReferenceId)?.detail_matches ?? false,
            approved_link_destinations_present: approvedLinkDestinations.every((url) => indexLinks.includes(url)),
            skills_present: firstApproval.snapshot.skills.every((skill) => publicText.includes(skill)),
            contact_destinations_present: firstApproval.snapshot.contacts.every(({ url }) => indexLinks.includes(url)),
            project_order_and_visibility_match: indexShapeMatches,
            all_project_details_match: projectChecks.every(({ detail_matches }) => detail_matches),
            hidden_headline_present: publicText.includes(hiddenHeadline),
            removed_screenshot_present: publicText.includes("https://assets.example.test/atlas/dashboard.webp"),
            private_fixture_metadata_present: publicText.includes("synthetic private fixture metadata"),
            private_commit_present: publicText.includes(initialRelease.sourceCommit),
            script_element_count: publicScriptCount,
          },
        );
        await browser.navigate(webUrl);
        await browser.waitFor('[data-testid="publication-panel"]');
        await browser.waitFor('[data-testid="publication-job"][data-publication-state="published"] [data-testid="publication-url"]', { waitTimeoutMs: 40_000 });
        const shownUrl = await browser.text('[data-testid="publication-url"]');
        expectScenario(shownUrl === publicUrl, "dashboard links to the exact independently served approved publication", { browser_url_matches_served_url: shownUrl === publicUrl });
        return { publication_id: firstPublished.id, artifact_digest: firstPublished.artifact_digest, pointer_generation: firstPublished.pointer_generation, public_url: shownUrl };
      },
    );

    const factsBeforePromotion = await factRevisionRows(m3, firstApproval.id, "m3-fact-revisions-before-automatic-promotion");
    const readinessBeforePromotion = await readinessRows(m3, firstApproval.id, initialRelease.projectReferenceId, "m3-readiness-before-automatic-promotion");
    const publicationsBeforePromotion = await publicationRows(m3, "m3-publications-before-automatic-promotion");
    const latestDraftBeforePromotion = await m3.ownerHTTP("/v1/portfolio/draft-revisions/latest");
    assertStatus(latestDraftBeforePromotion, 200, "latest draft before concurrent replacement promotion");
    promotionConcurrentEditNarrative = `${firstNarrative} Concurrent owner edit survives automatic promotion ${randomUUID().slice(0, 8)}`;
    promotionConcurrentEditSourceUrl = `https://owner-edited.example.test/${randomUUID().slice(0, 8)}`;
    const editedDraftBeforePromotion = JSON.parse(JSON.stringify(latestDraftBeforePromotion.payload.draft));
    editedDraftBeforePromotion.profile.introduction = promotionConcurrentEditNarrative;
    const editedProjectBeforePromotion = editedDraftBeforePromotion.projects.find(({ project_reference_id: id }) => id === initialRelease.projectReferenceId);
    const editedSourceLinkBeforePromotion = editedProjectBeforePromotion?.links?.find(({ kind }) => kind === "source");
    if (!editedSourceLinkBeforePromotion?.link) throw new Error("concurrent owner edit fixture omitted its source link");
    editedSourceLinkBeforePromotion.link.url = promotionConcurrentEditSourceUrl;
    promotionConcurrentDraftRequest = {
      method: "POST",
      headers: {
        "If-Match": `"${latestDraftBeforePromotion.payload.revision}"`,
        "Idempotency-Key": `m3-concurrent-promotion-draft-${randomUUID()}`,
      },
      body: { draft: editedDraftBeforePromotion, preview: latestDraftBeforePromotion.payload.preview },
    };
    const draftWritePromise = m3.ownerHTTP("/v1/portfolio/preview-revisions", promotionConcurrentDraftRequest);
    const [concurrentDraftWrite, replacementRelease] = await Promise.all([
      draftWritePromise,
      promoteReplacementRelease({
        context,
        m3,
        initialRelease,
        beforeStage: async () => {
          const draftBeforeReplacement = await draftWritePromise;
          assertStatus(draftBeforeReplacement, 201, "concurrent owner draft edit before replacement staging");
          staleReviewResponse = await m3.ownerHTTP(
            `/v1/portfolio/publication-review?draft_revision_id=${encodeURIComponent(draftBeforeReplacement.payload.id)}`,
          );
          assertStatus(staleReviewResponse, 200, "publication review captured for the concurrent draft before replacement staging");
          const initialReleaseFact = staleReviewResponse.payload?.deployment_facts?.find(({ project_reference_id: id }) =>
            id === initialRelease.projectReferenceId);
          expectScenario(
            staleReviewResponse.payload?.draft_revision_id === draftBeforeReplacement.payload?.id &&
              initialReleaseFact?.source_release_id === initialRelease.sourceReleaseId,
            "the concurrent draft review is bound to the initial trusted release before replacement staging",
            {
              draft_revision_id_matches: staleReviewResponse.payload?.draft_revision_id === draftBeforeReplacement.payload?.id,
              review_source_release_id: initialReleaseFact?.source_release_id ?? null,
              initial_source_release_id: initialRelease.sourceReleaseId,
            },
          );
        },
      }),
    ]);
    promotionConcurrentDraftWrite = concurrentDraftWrite;
    assertStatus(promotionConcurrentDraftWrite, 201, "concurrent owner draft edit during replacement promotion");
    expectScenario(
      replacementRelease?.sourceReleaseId && replacementRelease.sourceReleaseId !== initialRelease.sourceReleaseId,
      "replacement callback activates a distinct actual routed release",
      { distinct_replacement_release: false },
    );
    const factsAfterPromotion = await factRevisionRows(m3, firstApproval.id, "m3-fact-revisions-after-automatic-promotion");
    const readinessAfterPromotion = await readinessRows(m3, firstApproval.id, initialRelease.projectReferenceId, "m3-readiness-after-automatic-promotion");
    const publicationsAfterPromotion = await publicationRows(m3, "m3-publications-after-automatic-promotion");
    const factsBeforePromotionIds = new Set(factsBeforePromotion.map(({ id }) => id));
    const automaticFactRows = factsAfterPromotion.filter(({ id }) => !factsBeforePromotionIds.has(id));
    const priorProjectFacts = factsBeforePromotion.filter(({ project_reference_id: id }) => id === initialRelease.projectReferenceId);
    const priorProjectFact = priorProjectFacts.at(-1);
    const automaticFact = automaticFactRows.find(({ project_reference_id: id }) => id === initialRelease.projectReferenceId);
    expectScenario(
      factsAfterPromotion.length === factsBeforePromotion.length + 1 &&
        automaticFactRows.length === 1 &&
        automaticFact?.revision_kind === "fact_refresh" &&
        automaticFact.source_release_id === replacementRelease.sourceReleaseId &&
        typeof automaticFact.source_deployment_id === "string" &&
        automaticFact.revision_number === (priorProjectFact?.revision_number ?? 0) + 1 &&
        automaticFact.previous_fact_revision_id === (priorProjectFact?.id ?? null) &&
        typeof automaticFact.audit_event_id === "string" &&
        automaticFact.audit_event_type === "portfolio.deployment_facts_refreshed" &&
        automaticFact.audit_target_type === "portfolio_deployment_fact_revision" &&
        automaticFact.audit_outcome === "succeeded",
      "real release activation automatically appends one authorized fact revision with exact source and audit evidence",
      {
        fact_rows_before: factsBeforePromotion.length,
        fact_rows_after: factsAfterPromotion.length,
        automatic_fact_revision: automaticFact?.revision_number ?? null,
        automatic_fact_source_release: automaticFact?.source_release_id ?? null,
        automatic_fact_source_deployment: automaticFact?.source_deployment_id ?? null,
        automatic_fact_audit_type: automaticFact?.audit_event_type ?? null,
      },
    );
    const readinessBeforePromotionIds = new Set(readinessBeforePromotion.map(({ id }) => id));
    const automaticReadinessRows = readinessAfterPromotion.filter(({ id }) => !readinessBeforePromotionIds.has(id));
    const priorReadiness = readinessBeforePromotion.at(-1);
    const automaticReadiness = automaticReadinessRows.at(-1);
    expectScenario(
      readinessAfterPromotion.length === readinessBeforePromotion.length + 1 &&
        automaticReadinessRows.length === 1 &&
        automaticReadiness?.state === "needs_recheck" &&
        automaticReadiness.reason === "new_release" &&
        automaticReadiness.fact_revision_id === automaticFact?.id &&
        automaticReadiness.previous_event_id === (priorReadiness?.id ?? null) &&
        typeof automaticReadiness.audit_event_id === "string" &&
        automaticReadiness.audit_event_type === "portfolio.readiness_recheck_required" &&
        automaticReadiness.audit_target_type === "portfolio_readiness_event" &&
        automaticReadiness.audit_outcome === "succeeded",
      "real release activation automatically appends one linked readiness recheck while retaining its audit chain",
      {
        readiness_rows_before: readinessBeforePromotion.length,
        readiness_rows_after: readinessAfterPromotion.length,
        automatic_readiness_state: automaticReadiness?.state ?? null,
        automatic_readiness_reason: automaticReadiness?.reason ?? null,
        automatic_readiness_fact_revision: automaticReadiness?.fact_revision_id ?? null,
        automatic_readiness_previous_event: automaticReadiness?.previous_event_id ?? null,
        automatic_readiness_audit_type: automaticReadiness?.audit_event_type ?? null,
      },
    );
    const publicationsBeforePromotionIds = new Set(publicationsBeforePromotion.map(({ id }) => id));
    const automaticPublicationRows = publicationsAfterPromotion.filter(({ id }) => !publicationsBeforePromotionIds.has(id));
    const automaticPublication = automaticPublicationRows.at(-1);
    expectScenario(
      publicationsAfterPromotion.length === publicationsBeforePromotion.length + 1 &&
        automaticPublicationRows.length === 1 &&
        automaticPublication?.approved_revision_id === firstApproval.id &&
        automaticPublication.cause === "deployment_fact_refresh" &&
        automaticPublication.state === "queued" &&
        automaticPublication.document_digest !== firstPublished.document_digest &&
        typeof automaticPublication.audit_event_id === "string" &&
        automaticPublication.audit_event_type === "portfolio.publication.fact_refresh_queued" &&
        automaticPublication.audit_target_type === "portfolio_publication" &&
        automaticPublication.audit_outcome === "succeeded",
      "real release activation queues one digest-changing fact-refresh publication for the same approval",
      {
        publications_before: publicationsBeforePromotion.length,
        publications_after: publicationsAfterPromotion.length,
        automatic_publication_id: automaticPublication?.id ?? null,
        automatic_publication_cause: automaticPublication?.cause ?? null,
        automatic_publication_state: automaticPublication?.state ?? null,
        document_digest_changed: automaticPublication?.document_digest !== firstPublished.document_digest,
        automatic_publication_audit_type: automaticPublication?.audit_event_type ?? null,
      },
    );
    const approvalAfterAutomaticPromotion = await latestApproval(m3, "approval after automatic release fact refresh");
    const initialFact = firstApproval.deployment_facts.find(({ project_reference_id: id }) => id === initialRelease.projectReferenceId);
    const currentAutomaticFact = approvalAfterAutomaticPromotion.deployment_facts.find(({ project_reference_id: id }) => id === initialRelease.projectReferenceId);
    const unchangedFactFields = ["displayed_release_identifier", "public_source_commit", "managed_demo_link_id", "managed_demo_link_digest"].every((field) =>
      currentAutomaticFact?.facts?.[field] === initialFact?.facts?.[field]);
    const authorizedRefreshScope = JSON.stringify([...(currentAutomaticFact?.refresh_scope ?? [])].sort()) ===
      JSON.stringify(["availability_label", "deployment_timestamp"]);
    expectScenario(
      approvalAfterAutomaticPromotion.id === firstApproval.id &&
        currentAutomaticFact?.id === automaticFact?.id &&
        currentAutomaticFact?.source_release_id === replacementRelease.sourceReleaseId &&
        currentAutomaticFact?.revision === automaticFact?.revision_number &&
        unchangedFactFields &&
        authorizedRefreshScope,
      "automatic activation refresh is visible through the approved-revision owner API before any replay request",
      {
        same_approval: approvalAfterAutomaticPromotion.id === firstApproval.id,
        current_fact_revision: currentAutomaticFact?.revision ?? null,
        current_fact_release: currentAutomaticFact?.source_release_id ?? null,
        authorized_refresh_scope: currentAutomaticFact?.refresh_scope ?? null,
        unchanged_authorized_fact_fields: unchangedFactFields,
      },
    );
    const latestDraftAfterPromotion = await m3.ownerHTTP("/v1/portfolio/draft-revisions/latest");
    assertStatus(latestDraftAfterPromotion, 200, "latest draft after concurrent replacement promotion");
    const concurrentDraftPersistedAfterPromotion = latestDraftAfterPromotion.payload?.draft?.profile?.introduction === promotionConcurrentEditNarrative &&
      latestDraftAfterPromotion.payload?.draft?.projects?.some(({ project_reference_id: id, links }) =>
        id === initialRelease.projectReferenceId && links.some(({ kind, link }) => kind === "source" && link.url === promotionConcurrentEditSourceUrl));
    expectScenario(
      latestDraftAfterPromotion.payload?.id === promotionConcurrentDraftWrite.payload?.id &&
        latestDraftAfterPromotion.payload?.revision === promotionConcurrentDraftWrite.payload?.revision &&
        promotionConcurrentDraftWrite.payload?.draft?.profile?.introduction === promotionConcurrentEditNarrative &&
        promotionConcurrentDraftWrite.payload?.draft?.projects?.some(({ project_reference_id: id, links }) =>
          id === initialRelease.projectReferenceId && links.some(({ kind, link }) => kind === "source" && link.url === promotionConcurrentEditSourceUrl)) &&
        concurrentDraftPersistedAfterPromotion,
      "the first real replacement promotion races an owner draft edit without overwriting its narrative or source link",
      {
        draft_write_status: promotionConcurrentDraftWrite.status,
        draft_revision_persisted: latestDraftAfterPromotion.payload?.id === promotionConcurrentDraftWrite.payload?.id,
        draft_revision_number_persisted: latestDraftAfterPromotion.payload?.revision === promotionConcurrentDraftWrite.payload?.revision,
        draft_write_narrative_preserved: promotionConcurrentDraftWrite.payload?.draft?.profile?.introduction === promotionConcurrentEditNarrative,
        draft_write_link_preserved: promotionConcurrentDraftWrite.payload?.draft?.projects?.some(({ project_reference_id: id, links }) =>
          id === initialRelease.projectReferenceId && links.some(({ kind, link }) => kind === "source" && link.url === promotionConcurrentEditSourceUrl)) ?? false,
        latest_draft_persisted: concurrentDraftPersistedAfterPromotion,
      },
    );
    const approvalsBeforeRejections = await approvalCount(m3, "m3-approvals-before-rejections");
    const currentReview = await m3.ownerHTTP(`/v1/portfolio/publication-review?draft_revision_id=${encodeURIComponent(staleReviewResponse.payload.draft_revision_id)}`);
    assertStatus(currentReview, 200, "current review after replacement release");
    const refreshedReviewFact = currentReview.payload?.deployment_facts?.find(({ project_reference_id: id }) =>
      id === initialRelease.projectReferenceId);
    expectScenario(
      currentReview.payload?.draft_revision_id === staleReviewResponse.payload.draft_revision_id &&
        currentReview.payload?.review_digest !== staleReviewResponse.payload.review_digest &&
        currentReview.payload?.snapshot?.profile?.introduction === promotionConcurrentEditNarrative &&
        refreshedReviewFact?.source_release_id === replacementRelease.sourceReleaseId,
      "the same concurrent draft gets a new review digest only after trusted release facts change",
      {
        same_draft_revision: currentReview.payload?.draft_revision_id === staleReviewResponse.payload.draft_revision_id,
        review_digest_changed: currentReview.payload?.review_digest !== staleReviewResponse.payload.review_digest,
        edited_narrative_preserved: currentReview.payload?.snapshot?.profile?.introduction === promotionConcurrentEditNarrative,
        refreshed_review_source_release: refreshedReviewFact?.source_release_id ?? null,
        replacement_source_release: replacementRelease.sourceReleaseId,
      },
    );
    // The automatic publication is legitimate activation output; rejection oracles start after it.
    const publicationsBeforeRejections = publicationsAfterPromotion;
    const staleApproval = await m3.ownerHTTP("/v1/portfolio/approved-revisions", {
      method: "POST",
      headers: { "Idempotency-Key": `m3-stale-approval-${randomUUID()}` },
      body: {
        // Reuse the exact concurrent draft reviewed before replacement staging;
        // only trusted release facts changed before this approval attempt.
        draft_revision_id: currentReview.payload.draft_revision_id,
        review_digest: staleReviewResponse.payload.review_digest,
        approval: { type: "entire_revision", review_digest: staleReviewResponse.payload.review_digest },
        refresh_authorizations: [],
      },
    });
    assertStatus(staleApproval, 409, "stale trusted-fact approval rejection");
    expectScenario(staleApproval.payload?.error?.code === "stale_publication_review", "stale review returns the publication-specific conflict", { error_code: staleApproval.payload?.error?.code ?? null });
    const incompleteApproval = await m3.ownerHTTP("/v1/portfolio/approved-revisions", {
      method: "POST",
      headers: { "Idempotency-Key": `m3-incomplete-approval-${randomUUID()}` },
      body: {
        draft_revision_id: currentReview.payload.draft_revision_id,
        review_digest: currentReview.payload.review_digest,
        approval: { type: "individual_fields", fields: [] },
        refresh_authorizations: [],
      },
    });
    assertStatus(incompleteApproval, 422, "incomplete field approval rejection");
    expectScenario(incompleteApproval.payload?.error?.code === "incomplete_publication_approval", "incomplete approval returns the field-completeness error", { error_code: incompleteApproval.payload?.error?.code ?? null });
    const foreignReview = await m3.call(`/v1/portfolio/publication-review?draft_revision_id=${encodeURIComponent(currentReview.payload.draft_revision_id)}`, { token: m3.state.other.token });
    assertStatus(foreignReview, 404, "foreign owner publication review rejection");
    const foreignApproval = await m3.call("/v1/portfolio/approved-revisions", {
      method: "POST",
      token: m3.state.other.token,
      headers: { "Idempotency-Key": `m3-foreign-approval-${randomUUID()}` },
      body: {
        draft_revision_id: currentReview.payload.draft_revision_id,
        review_digest: currentReview.payload.review_digest,
        approval: { type: "entire_revision", review_digest: currentReview.payload.review_digest },
        refresh_authorizations: [],
      },
    });
    assertStatus(foreignApproval, 409, "foreign owner approval rejection");
    expectScenario(
      foreignApproval.payload?.error?.code === "stale_portfolio_draft",
      "foreign owner approval returns the owner-scoped stale-draft conflict",
      { error_code: foreignApproval.payload?.error?.code ?? null },
    );
    const forgedRefresh = await m3.roleInternal("runtime", "/internal/v1/portfolio/deployment-fact-refreshes", {
      method: "POST",
      body: { source_release_id: replacementRelease.sourceReleaseId, availability: "available" },
    });
    assertStatus(forgedRefresh, 400, "caller-authored deployment fact rejection");
    const approvalsAfterRejections = await approvalCount(m3, "m3-approvals-after-rejections");
    const publicationsAfterRejections = await publicationRows(m3, "m3-publications-after-rejections");
    expectScenario(
      approvalsAfterRejections.count === approvalsBeforeRejections.count &&
        JSON.stringify(publicationsAfterRejections) === JSON.stringify(publicationsBeforeRejections),
      "stale, incomplete, foreign and forged-fact requests append no approval or publication",
      {
        approvals_before: approvalsBeforeRejections.count,
        approvals_after: approvalsAfterRejections.count,
        publications_before: publicationsBeforeRejections.length,
        publications_after: publicationsAfterRejections.length,
      },
    );
    await approvalPublishStep(
      context,
      "M3-APPROVAL-02",
      "M3 owner approval",
      "a real promoted release refreshes only previously authorized deployment facts and preserves owner narrative and approval",
      async () => {
        const replayedRefresh = await m3.roleInternal("runtime", "/internal/v1/portfolio/deployment-fact-refreshes", {
          method: "POST",
          body: { source_release_id: replacementRelease.sourceReleaseId },
        });
        assertStatus(replayedRefresh, 200, "runtime-authenticated approved deployment fact refresh replay");
        const factsAfterRefresh = await factRevisionRows(m3, firstApproval.id, "m3-fact-revisions-after-automatic-refresh-replay");
        const publicationsAfterRefresh = await publicationRows(m3, "m3-publications-after-automatic-refresh-replay");
        expectScenario(
          concurrentDraftPersistedAfterPromotion &&
            replayedRefresh.payload?.revisions?.length === 0 &&
            JSON.stringify(factsAfterRefresh) === JSON.stringify(factsAfterPromotion) &&
            JSON.stringify(publicationsAfterRefresh) === JSON.stringify(publicationsAfterPromotion),
          "the automatic refresh preserves the raced owner draft while a replay appends no duplicate fact or publication",
          {
            draft_edit_persisted: concurrentDraftPersistedAfterPromotion,
            replay_fact_revision_count: replayedRefresh.payload?.revisions?.length ?? null,
            fact_history_unchanged: JSON.stringify(factsAfterRefresh) === JSON.stringify(factsAfterPromotion),
            publication_history_unchanged: JSON.stringify(publicationsAfterRefresh) === JSON.stringify(publicationsAfterPromotion),
          },
        );

        const draftReplay = await m3.ownerHTTP("/v1/portfolio/preview-revisions", promotionConcurrentDraftRequest);
        assertStatus(draftReplay, 201, "concurrent owner draft edit exact replay");
        const latestDraftAfterReplay = await m3.ownerHTTP("/v1/portfolio/draft-revisions/latest");
        assertStatus(latestDraftAfterReplay, 200, "latest draft after concurrent edit replay");
        expectScenario(
          draftReplay.payload?.id === promotionConcurrentDraftWrite.payload?.id &&
            draftReplay.payload?.revision === promotionConcurrentDraftWrite.payload?.revision &&
            latestDraftAfterReplay.payload?.revision === promotionConcurrentDraftWrite.payload?.revision &&
            latestDraftAfterReplay.payload?.draft?.profile?.introduction === promotionConcurrentEditNarrative &&
            latestDraftAfterReplay.payload?.draft?.projects?.some(({ project_reference_id: id, links }) =>
              id === initialRelease.projectReferenceId && links.some(({ kind, link }) => kind === "source" && link.url === promotionConcurrentEditSourceUrl)),
          "exact concurrent draft replay is byte-stable and appends no narrative or owner-link revision",
          {
            replay_same_revision: draftReplay.payload?.revision === promotionConcurrentDraftWrite.payload?.revision,
            latest_revision: latestDraftAfterReplay.payload?.revision ?? null,
            narrative_preserved: latestDraftAfterReplay.payload?.draft?.profile?.introduction === promotionConcurrentEditNarrative,
            owner_edited_link_preserved: latestDraftAfterReplay.payload?.draft?.projects?.some(({ project_reference_id: id, links }) =>
              id === initialRelease.projectReferenceId && links.some(({ kind, link }) => kind === "source" && link.url === promotionConcurrentEditSourceUrl)) ?? false,
          },
        );

        const repeatedRefresh = await m3.roleInternal("runtime", "/internal/v1/portfolio/deployment-fact-refreshes", {
          method: "POST",
          body: { source_release_id: replacementRelease.sourceReleaseId },
        });
        assertStatus(repeatedRefresh, 200, "repeated runtime deployment fact refresh");
        const publicationsAfterRepeatedRefresh = await publicationRows(m3, "m3-publications-after-repeated-fact-refresh");
        const factsAfterRepeatedRefresh = await factRevisionRows(m3, firstApproval.id, "m3-fact-revisions-after-repeated-fact-refresh");
        expectScenario(
          repeatedRefresh.payload.revisions.length === 0 &&
            JSON.stringify(factsAfterRepeatedRefresh) === JSON.stringify(factsAfterRefresh) &&
            publicationsAfterRepeatedRefresh.length === publicationsAfterRefresh.length,
          "repeated deployment event appends neither a fact revision nor a publication",
          {
            fact_revision_count: repeatedRefresh.payload.revisions.length,
            fact_history_unchanged: JSON.stringify(factsAfterRepeatedRefresh) === JSON.stringify(factsAfterRefresh),
            publication_delta: publicationsAfterRepeatedRefresh.length - publicationsAfterRefresh.length,
          },
        );

        await m3.stopApi("M3 approval-02 draft and fact restart durability");
        await m3.startApi({ binary: m3.currentApiBinary, label: "M3 approval-02 draft and fact restart durability" });
        const latestDraftAfterRestart = await m3.ownerHTTP("/v1/portfolio/draft-revisions/latest");
        assertStatus(latestDraftAfterRestart, 200, "latest draft after approval/fact API restart");
        const approvalAfterRestart = await latestApproval(m3, "approval after trusted release refresh restart");
        const factsAfterRestart = await factRevisionRows(m3, firstApproval.id, "m3-fact-revisions-after-approval-fact-restart");
        const publicationsAfterRestart = await publicationRows(m3, "m3-publications-after-approval-fact-restart");
        const replayAfterRestart = await m3.roleInternal("runtime", "/internal/v1/portfolio/deployment-fact-refreshes", {
          method: "POST",
          body: { source_release_id: replacementRelease.sourceReleaseId },
        });
        assertStatus(replayAfterRestart, 200, "replayed deployment fact refresh after API restart");
        const factsAfterRestartReplay = await factRevisionRows(m3, firstApproval.id, "m3-fact-revisions-after-restart-replay");
        const publicationsAfterRestartReplay = await publicationRows(m3, "m3-publications-after-restart-replay");
        const restartHistoryUnchanged = JSON.stringify(factsAfterRestartReplay) === JSON.stringify(factsAfterRestart);
        expectScenario(
          latestDraftAfterRestart.payload?.revision === promotionConcurrentDraftWrite.payload?.revision &&
            latestDraftAfterRestart.payload?.draft?.profile?.introduction === promotionConcurrentEditNarrative &&
            latestDraftAfterRestart.payload?.draft?.projects?.some(({ project_reference_id: id, links }) =>
              id === initialRelease.projectReferenceId && links.some(({ kind, link }) => kind === "source" && link.url === promotionConcurrentEditSourceUrl)) &&
            approvalAfterRestart.id === firstApproval.id &&
            approvalAfterRestart.snapshot.profile.introduction === firstNarrative &&
            approvalAfterRestart.snapshot.projects?.some(({ project_reference_id: id, links }) =>
              id === initialRelease.projectReferenceId && links.some(({ kind, link }) => kind === "source" && link.url !== promotionConcurrentEditSourceUrl)) &&
            replayAfterRestart.payload.revisions.length === 0 &&
            restartHistoryUnchanged &&
            publicationsAfterRestartReplay.length === publicationsAfterRestart.length,
          "API restart preserves the concurrent draft and approved narrative while replaying no duplicate fact or publication",
          {
            draft_revision_preserved: latestDraftAfterRestart.payload?.revision === promotionConcurrentDraftWrite.payload?.revision,
            draft_narrative_preserved: latestDraftAfterRestart.payload?.draft?.profile?.introduction === promotionConcurrentEditNarrative,
            owner_edited_link_preserved: latestDraftAfterRestart.payload?.draft?.projects?.some(({ project_reference_id: id, links }) =>
              id === initialRelease.projectReferenceId && links.some(({ kind, link }) => kind === "source" && link.url === promotionConcurrentEditSourceUrl)) ?? false,
            approved_narrative_preserved: approvalAfterRestart.snapshot.profile.introduction === firstNarrative,
            approved_owner_link_unchanged: approvalAfterRestart.snapshot.projects?.some(({ project_reference_id: id, links }) =>
              id === initialRelease.projectReferenceId && links.some(({ kind, link }) => kind === "source" && link.url !== promotionConcurrentEditSourceUrl)) ?? false,
            replay_fact_revision_count: replayAfterRestart.payload.revisions.length,
            fact_history_unchanged: restartHistoryUnchanged,
            publication_delta: publicationsAfterRestartReplay.length - publicationsAfterRestart.length,
          },
        );

        const trackedFactHistory = factsAfterRefresh.filter(({ project_reference_id: id }) => id === initialRelease.projectReferenceId);
        const coherentFactHistory = trackedFactHistory.length >= 2 && trackedFactHistory.every((row, index) =>
          row.revision_number === index + 1 &&
          typeof row.source_deployment_id === "string" && typeof row.audit_event_id === "string" &&
          row.audit_event_type === (index === 0 ? "portfolio.deployment_facts_authorized" : "portfolio.deployment_facts_refreshed") &&
          (index === 0 ? row.previous_fact_revision_id === null : row.previous_fact_revision_id === trackedFactHistory[index - 1].id));
        const automaticFactRevisionIdsPersisted = automaticFactRows.every(({ id }) => factsAfterRefresh.some((row) => row.id === id));
        const current = approvalAfterRestart;
        expectScenario(
          current.id === firstApproval.id &&
            current.snapshot.profile.introduction === firstNarrative &&
            current.deployment_facts.some(({ source_release_id: id, revision }) => id === replacementRelease.sourceReleaseId && revision >= 2),
          "fact refresh advances immutable deployment facts without rewriting owner content",
          {
            same_approval: current.id === firstApproval.id,
            narrative_preserved: current.snapshot.profile.introduction === firstNarrative,
            coherent_fact_history: coherentFactHistory,
            automatic_fact_revision_ids_persisted: automaticFactRevisionIdsPersisted,
          },
        );
        expectScenario(
          coherentFactHistory && automaticFactRevisionIdsPersisted,
          "automatic deployment fact revisions form one persisted previous-id and audit chain without duplicate release facts",
          {
            tracked_fact_revisions: trackedFactHistory.map(({ revision_number: revision }) => revision),
            coherent_previous_ids: coherentFactHistory,
            automatic_fact_revision_ids_persisted: automaticFactRevisionIdsPersisted,
          },
        );
        await browser.navigate(webUrl);
        await browser.waitFor('[data-testid="publication-panel"]', { waitTimeoutMs: 40_000 });
        await browser.waitFor('[data-testid="preview-editor"] [name="profile.introduction"]', { waitTimeoutMs: 40_000 });
        const browserDraftNarrative = await browser.evaluate(
          'document.querySelector(\'[data-testid="preview-editor"] [name="profile.introduction"]\')?.value ?? null',
        );
        expectScenario(
          browserDraftNarrative === promotionConcurrentEditNarrative,
          "the restarted owner editor reloads the concurrent narrative without overwriting it",
          { browser_draft_narrative_preserved: browserDraftNarrative === promotionConcurrentEditNarrative },
        );
        await browser.click('[data-testid="publication-refresh-job"]');
        await waitForPublicationState(browser, "queued");
        spawnPublisherWorker(context, m3, publisherBinary, "fact-refresh");
        await waitForPublicationState(browser, "published");
        const refreshedPublication = await latestPublication(m3, "fact-refresh publication");
        const approvedSourceUrl = firstApproval.snapshot.projects
          .find(({ project_reference_id: id }) => id === initialRelease.projectReferenceId)
          ?.links?.find(({ kind }) => kind === "source")?.link?.url;
        await browser.navigate(`${staticBase}${slug}/`);
        const automaticPublicIndexText = await browser.text("body");
        await browser.navigate(`${staticBase}${slug}/projects/${projectPath(initialRelease.projectReferenceId)}/`);
        const automaticPublicDetailText = await browser.text("body");
        const automaticPublicLinks = await browser.evaluate('[...document.querySelectorAll("a[href]")].map((link) => link.href)');
        expectScenario(
          refreshedPublication.cause === "deployment_fact_refresh" && refreshedPublication.approved_revision_id === firstApproval.id,
          "automatic fact refresh republishes the same approval with a new public document",
          { cause: refreshedPublication.cause, approved_revision_id: refreshedPublication.approved_revision_id },
        );
        expectScenario(
          automaticPublicIndexText.includes(firstNarrative) &&
            automaticPublicDetailText.includes(firstApproval.snapshot.projects.find(({ project_reference_id: id }) => id === initialRelease.projectReferenceId)?.title ?? "") &&
            typeof approvedSourceUrl === "string" &&
            automaticPublicLinks.includes(approvedSourceUrl) &&
            !automaticPublicLinks.includes(promotionConcurrentEditSourceUrl),
          "automatic fact publication preserves the approved narrative and link while the owner edit remains in the private draft",
          {
            approved_narrative_present: automaticPublicIndexText.includes(firstNarrative),
            approved_project_detail_present: automaticPublicDetailText.includes(firstApproval.snapshot.projects.find(({ project_reference_id: id }) => id === initialRelease.projectReferenceId)?.title ?? ""),
            approved_source_link_present: typeof approvedSourceUrl === "string" && automaticPublicLinks.includes(approvedSourceUrl),
            concurrent_owner_link_public: automaticPublicLinks.includes(promotionConcurrentEditSourceUrl),
          },
        );
        await browser.navigate(webUrl);
        await browser.waitFor('[data-testid="publication-panel"]', { waitTimeoutMs: 40_000 });
        return {
          approved_revision_id: current.id,
          owner_narrative_preserved: true,
          refreshed_release_id: replacementRelease.sourceReleaseId,
          stale_rejected: staleApproval.status === 409,
          incomplete_rejected: incompleteApproval.status === 422,
          foreign_rejected: foreignReview.status === 404 && foreignApproval.status === 409,
          forged_fact_rejected: forgedRefresh.status === 400,
          rejected_approval_writes: approvalsAfterRejections.count - approvalsBeforeRejections.count,
          automatic_fact_revision: automaticFact?.revision_number ?? null,
          automatic_readiness_event_id: automaticReadiness?.id ?? null,
          automatic_publication_id: automaticPublication?.id ?? null,
          repeated_refresh_revisions: repeatedRefresh.payload.revisions.length,
          concurrent_draft_revision: promotionConcurrentDraftWrite.payload.revision,
          concurrent_draft_replay_revision: draftReplay.payload.revision,
          owner_edited_source_url: promotionConcurrentEditSourceUrl,
          fact_history_revisions: trackedFactHistory.map(({ revision_number: revision }) => revision),
          restart_replay_revisions: replayAfterRestart.payload.revisions.length,
          browser_draft_narrative_preserved: browserDraftNarrative === promotionConcurrentEditNarrative,
          browser_draft_owner_link_preserved: latestDraftAfterRestart.payload?.draft?.projects?.some(({ project_reference_id: id, links }) =>
            id === initialRelease.projectReferenceId && links.some(({ kind, link }) => kind === "source" && link.url === promotionConcurrentEditSourceUrl)) ?? false,
          approved_source_link_public: typeof approvedSourceUrl === "string" && automaticPublicLinks.includes(approvedSourceUrl),
        };
      },
    );

    await approvalPublishStep(
      context,
      "M3-APPROVAL-03",
      "M3 owner approval",
      "the new release marks readiness as needing recheck while retaining the approved case study and prior readiness history",
      async () => {
        await browser.click('[data-testid="publication-refresh-status"]');
        await browser.waitFor(() => document.querySelector('[data-testid="publication-readiness"]')?.getAttribute("data-readiness-state") === "needs_recheck");
        const current = await latestApproval(m3, "readiness after replacement release");
        const readiness = current.readiness.find(({ project_reference_id: id }) => id === initialRelease.projectReferenceId);
        const history = await readinessRows(m3, firstApproval.id, initialRelease.projectReferenceId, "m3-readiness-history-after-release");
        const prior = history.find(({ id }) => id === firstReadinessAttestation.payload.id);
        const latest = history.at(-1);
        const priorAttestationRetained = latest?.attestation?.release_id === initialRelease.sourceReleaseId &&
          latest?.attestation?.fact_revision_id === firstReadinessAttestation.payload.fact_revision_id &&
          latest?.previous_event_id === prior?.id;
        expectScenario(
          readiness?.state === "needs_recheck" &&
            readiness.reason === "new_release" &&
            history.length >= 2 &&
            prior?.state === "ready_to_share" &&
            prior?.attestation?.release_id === initialRelease.sourceReleaseId &&
            latest?.id === readiness.id &&
            priorAttestationRetained,
          "release change invalidates readiness independently of health while retaining prior attestation history",
          {
            readiness_state: readiness?.state ?? null,
            readiness_reason: readiness?.reason ?? null,
            history_length: history.length,
            prior_state: prior?.state ?? null,
            prior_attestation_retained: priorAttestationRetained,
          },
        );
        return {
          readiness_state: readiness.state,
          readiness_reason: readiness.reason,
          approved_revision_retained: current.id === firstApproval.id,
          prior_attestation_id: prior.id,
          new_readiness_event_id: latest.id,
          readiness_history_length: history.length,
        };
      },
    );

    await approvalPublishStep(
      context,
      "M3-PUBLISH-02",
      "M3 independent static publishing",
      "corrupt and interrupted publisher attempts preserve the immutable last-good pointer, stale completion is fenced and cleaned up, and a reclaimed retry publishes a new digest",
      async () => {
        await browser.fill('[data-testid="preview-editor"] [name="profile.introduction"]', replacementNarrative);
        await browser.click('[data-testid="preview-save"]');
        await approveCurrentSavedRevision(browser);
        replacementApproval = await latestApproval(m3, "replacement browser approval");

        const rowsBeforeStalePublication = await publicationRows(m3, "m3-publications-before-stale-approved-publish");
        const sitesBeforeStalePublication = await publicSiteRows(m3, "m3-sites-before-stale-approved-publish");
        const staleApprovedPublication = await m3.ownerHTTP("/v1/portfolio/publications", {
          method: "POST",
          headers: { "Idempotency-Key": `m3-stale-approved-publication-${randomUUID()}` },
          body: { approved_revision_id: firstApproval.id, slug: stalePublicationSlug },
        });
        assertStatus(staleApprovedPublication, 409, "stale approved revision publication rejection");
        expectScenario(
          staleApprovedPublication.payload?.error?.code === "stale_approved_revision",
          "publishing an older approved revision fails before site creation",
          { error_code: staleApprovedPublication.payload?.error?.code ?? null },
        );
        const rowsAfterStalePublication = await publicationRows(m3, "m3-publications-after-stale-approved-publish");
        const sitesAfterStalePublication = await publicSiteRows(m3, "m3-sites-after-stale-approved-publish");
        expectScenario(
          rowsAfterStalePublication.length === rowsBeforeStalePublication.length &&
            JSON.stringify(sitesAfterStalePublication) === JSON.stringify(sitesBeforeStalePublication),
          "stale approved publication appends no row or site pointer",
          {
            publication_rows_before: rowsBeforeStalePublication.length,
            publication_rows_after: rowsAfterStalePublication.length,
            site_rows_unchanged: JSON.stringify(sitesAfterStalePublication) === JSON.stringify(sitesBeforeStalePublication),
          },
        );

        await browser.fill('[data-testid="publication-slug"]', slug);
        await browser.click('[data-testid="publication-publish"]');
        await waitForPublicationState(browser, "queued");
        const corruptLease = await leasePublication(m3, "publisher-corrupt-artifact", "corrupt artifact publisher lease");
        const corruptStaging = stagingPath(publisherRoot, corruptLease);
        mkdirSync(corruptStaging, { recursive: true, mode: 0o700 });
        writeFileSync(join(corruptStaging, "manifest.json"), "{\"format\":\"hostlet.static-site-manifest/v1\"", { mode: 0o600, flag: "wx" });
        const corruptCompletion = await completePublicationAttempt(
          m3,
          corruptLease,
          "publisher-corrupt-artifact",
          { state: "succeeded", artifact_digest: `sha256:${"0".repeat(64)}` },
          "corrupt artifact completion",
        );
        assertStatus(corruptCompletion, 422, "corrupt artifact rejection");
        expectScenario(
          corruptCompletion.payload?.error?.code === "invalid_static_artifact",
          "corrupt manifest fails closed before pointer promotion",
          { error_code: corruptCompletion.payload?.error?.code ?? null },
        );
        const corruptFailure = await completePublicationAttempt(
          m3,
          corruptLease,
          "publisher-corrupt-artifact",
          { state: "failed", code: "invalid_static_artifact" },
          "corrupt artifact failure completion",
        );
        assertStatus(corruptFailure, 200, "corrupt artifact failure is recorded");
        const failedPublication = await latestPublication(m3, "corrupt publisher failure");
        expectScenario(
          failedPublication.approved_revision_id === replacementApproval.id &&
            failedPublication.state === "failed" &&
            failedPublication.failure_code === "invalid_static_artifact" &&
            !existsSync(corruptStaging),
          "corrupt publication records a bounded failure and removes its staging tree",
          { state: failedPublication.state, failure_code: failedPublication.failure_code, staging_exists: existsSync(corruptStaging) },
        );
        const oldResponse = await fetch(`${staticBase}${slug}/`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
        const oldText = await oldResponse.text();
        expectScenario(
          oldResponse.status === 200 && oldText.includes(firstNarrative) && !oldText.includes(replacementNarrative),
          "corrupt replacement leaves last-good static pointer unchanged",
          { old_status: oldResponse.status, old_content_preserved: oldText.includes(firstNarrative) && !oldText.includes(replacementNarrative) },
        );

        await browser.fill('[data-testid="preview-editor"] [name="profile.introduction"]', recoveryNarrative);
        await browser.click('[data-testid="preview-save"]');
        await approveCurrentSavedRevision(browser);
        const recoveryApproval = await latestApproval(m3, "recovery browser approval");
        await browser.fill('[data-testid="publication-slug"]', slug);
        await browser.click('[data-testid="publication-publish"]');
        await waitForPublicationState(browser, "queued");
        const interruptedLease = await leasePublication(m3, "publisher-interrupted-old", "interrupted publisher lease");
        const interruptedStaging = stagingPath(publisherRoot, interruptedLease);
        mkdirSync(interruptedStaging, { recursive: true, mode: 0o700 });
        writeFileSync(join(interruptedStaging, "partial.html"), "partial publisher output\n", { mode: 0o600, flag: "wx" });
        await waitForLeaseExpiry(context, interruptedLease);
        spawnPublisherWorker(context, m3, publisherBinary, "interruption-recovery");
        const staleCompletion = await completePublicationAttempt(
          m3,
          interruptedLease,
          "publisher-interrupted-old",
          { state: "succeeded", artifact_digest: `sha256:${"0".repeat(64)}` },
          "stale interrupted completion",
        );
        assertStatus(staleCompletion, 409, "stale interrupted completion rejection");
        expectScenario(
          staleCompletion.payload?.error?.code === "publisher_attempt_fenced",
          "an expired interrupted attempt cannot promote an artifact",
          { error_code: staleCompletion.payload?.error?.code ?? null },
        );
        await waitForPublicationState(browser, "published");
        const replacementPublished = await latestPublication(m3, "reclaimed interrupted publication");
        expectScenario(
          replacementPublished.approved_revision_id === recoveryApproval.id &&
            replacementPublished.artifact_digest !== firstPublished.artifact_digest &&
            replacementPublished.pointer_generation > firstPublished.pointer_generation &&
            !existsSync(interruptedStaging),
          "reclaimed retry atomically advances to a distinct immutable artifact and cleans interrupted staging",
          {
            distinct_artifact: replacementPublished.artifact_digest !== firstPublished.artifact_digest,
            generation_advanced: replacementPublished.pointer_generation > firstPublished.pointer_generation,
            interrupted_staging_exists: existsSync(interruptedStaging),
          },
        );
        await context.stopManaged(staticServer, "M3 static server restart proof");
        staticServer = context.spawnManaged(
          "M3 restarted independent static portfolio server",
          publisherBinary,
          ["serve", "--root", publisherRoot, "--bind", `127.0.0.1:${staticPort}`, "--expected-host", `127.0.0.1:${staticPort}`],
          { cwd: context.repo, env: { PATH: process.env.PATH ?? "" } },
          "m3-publisher-static-restarted.log",
        );
        await context.waitForHttp(`${staticBase}${slug}/`, 200, "restarted M3 static portfolio");
        const restartedResponse = await fetch(`${staticBase}${slug}/`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
        const restartedText = await restartedResponse.text();
        expectScenario(
          restartedResponse.status === 200 && restartedText.includes(recoveryNarrative) && !restartedText.includes(firstNarrative),
          "static restart serves the recovered immutable artifact",
          { status: restartedResponse.status, recovered_content: restartedText.includes(recoveryNarrative), old_content_absent: !restartedText.includes(firstNarrative) },
        );
        const rows = await publicationRows(m3, "m3-publication-history");
        return {
          stale_approved_publication_status: staleApprovedPublication.status,
          corrupt_completion_status: corruptCompletion.status,
          corrupt_failure_status: corruptFailure.status,
          corrupt_last_good_preserved: oldText.includes(firstNarrative) && !oldText.includes(replacementNarrative),
          stale_completion_status: staleCompletion.status,
          interrupted_staging_clean: !existsSync(interruptedStaging),
          publication_count: rows.length,
          final_artifact_digest: replacementPublished.artifact_digest,
        };
      },
    );

    await approvalPublishStep(
      context,
      "M3-PUBLISH-03",
      "M3 independent static publishing",
      "with dashboard/control, provider and tenant endpoints stopped, a fresh browser loads index and detail pages solely from the independent artifact server",
      async () => {
        const finalCapacityUsage = await hostedCapacityUsage(m3, "m3-hosted-capacity-after-publication");
        expectScenario(
          finalCapacityUsage.active_reservations === initialCapacityUsage.active_reservations &&
            finalCapacityUsage.hosted_slots === initialCapacityUsage.hosted_slots &&
            finalCapacityUsage.project_count === initialCapacityUsage.project_count,
          "portfolio and external case-study publication consume no hosted-project slot",
          { before: initialCapacityUsage, after: finalCapacityUsage },
        );
        await context.stopManaged(web, "M3 independent publisher dashboard outage");
        webStopped = true;
        return withUpstreamsStopped({ context, m3 }, async () => {
          const publicUrl = `${staticBase}${slug}/`;
          const unknownSlugResponse = await fetch(`${staticBase}m3-unknown-${randomUUID().slice(0, 8)}/`, {
            cache: "no-store",
            signal: AbortSignal.timeout(10_000),
          });
          const encodedSeparatorResponse = await fetch(`${staticBase}${slug}/assets%2Fsite.css`, {
            cache: "no-store",
            signal: AbortSignal.timeout(10_000),
          });
          const encodedTraversalResponse = await rawPathStatus(staticPort, `/${slug}/%2e%2e/${slug}/index.html`, context.abortSignal);
          const unknownHostResponse = await fetch(publicUrl, {
            cache: "no-store",
            headers: { Host: "evil.example.test" },
            signal: AbortSignal.timeout(10_000),
          });
          expectScenario(
            unknownSlugResponse.status === 404 &&
              encodedSeparatorResponse.status === 404 &&
              encodedTraversalResponse.status === 404 &&
              [400, 404].includes(unknownHostResponse.status),
            "independent static server rejects unknown hosts, unknown slugs and encoded traversal paths",
            {
              unknown_slug_status: unknownSlugResponse.status,
              encoded_separator_status: encodedSeparatorResponse.status,
              encoded_traversal_status: encodedTraversalResponse.status,
              unknown_host_status: unknownHostResponse.status,
            },
          );

          await browser.close();
          browser = await beginBrowser(context, { url: publicUrl, width: 1200, height: 900, label: "m3-static-outage", timeoutMs: 30_000 });
          const indexText = await browser.text("body");
          const detailHref = await browser.evaluate('document.querySelector("a.card")?.href ?? null');
          expectScenario(typeof detailHref === "string" && detailHref.startsWith(`${staticBase}${slug}/projects/`), "published index contains an independent local project detail link", { detail_link: detailHref });
          await browser.navigate(detailHref);
          const detailText = await browser.text("body");
          const resourceOrigins = await browser.evaluate('[...performance.getEntriesByType("resource")].map((entry) => new URL(entry.name).origin)');
          const staticOrigin = new URL(staticBase).origin;
          expectScenario(
            indexText.includes(recoveryNarrative) &&
              detailText.includes("My contribution") &&
              resourceOrigins.length > 0 &&
              resourceOrigins.every((origin) => origin === staticOrigin),
            "fresh outage browser reads approved index and case-study content without a dependent page-load request",
            { index_content_present: indexText.includes(recoveryNarrative), detail_content_present: detailText.includes("My contribution"), resource_origins: resourceOrigins },
          );
          return {
            index_loaded: true,
            detail_loaded: true,
            dependent_upstreams_running: 0,
            active_reservation_delta: finalCapacityUsage.active_reservations - initialCapacityUsage.active_reservations,
            hosted_slot_delta: finalCapacityUsage.hosted_slots - initialCapacityUsage.hosted_slots,
            project_count_delta: finalCapacityUsage.project_count - initialCapacityUsage.project_count,
            unknown_host_rejected: [400, 404].includes(unknownHostResponse.status),
            encoded_paths_rejected: encodedSeparatorResponse.status === 404 && encodedTraversalResponse.status === 404,
            resource_origins: resourceOrigins,
          };
        });
      },
    );
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (browser) await browser.close();
    if (staticServer) await context.stopManaged(staticServer, primaryError ? "M3 approval/publish scenario failure" : "M3 approval/publish scenario completion");
    if (!webStopped) await context.stopManaged(web, primaryError ? "M3 approval/publish web failure" : "M3 approval/publish web completion");
  }
}
