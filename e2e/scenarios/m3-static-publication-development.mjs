import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { beginBrowser } from "../support/interactive-browser.mjs";
import { assertStatus } from "../support/http-client.mjs";
import { runM3Context } from "../support/m3-context.mjs";
import { probeStaticHttpBoundary, staticHttpBoundaryPassed } from "../support/m3-static-http.mjs";
import { M3_UPGRADE_REQUIRED_ASSERTIONS } from "./m3-upgrade.mjs";

const ASSERTION = "M3-STATIC-PUBLICATION-DEVELOPMENT";
const DIGEST = /^sha256:[0-9a-f]{64}$/;

function requireCheck(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function hostEnvironment(overrides = {}) {
  const environment = {};
  for (const name of ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TZ", "TMPDIR"]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return { ...environment, ...overrides };
}

async function publicationState(m3, publicationId, label) {
  return m3.postgres.psqlJson(label, `SELECT json_build_object(
    'publication_id',p.id::text,'approved_revision_id',p.approved_revision_id::text,
    'state',p.state,'artifact_digest',p.artifact_digest,'pointer_generation',p.pointer_generation,
    'attempts',(SELECT COUNT(*)::int FROM portfolio_publication_attempts a WHERE a.publication_id=p.id),
    'succeeded_attempts',(SELECT COUNT(*)::int FROM portfolio_publication_attempts a WHERE a.publication_id=p.id AND a.state='succeeded'),
    'site_publication_id',(SELECT s.current_publication_id::text FROM portfolio_public_sites s WHERE s.account_id=p.account_id),
    'site_artifact_digest',(SELECT s.current_artifact_digest FROM portfolio_public_sites s WHERE s.account_id=p.account_id),
    'site_pointer_generation',(SELECT s.pointer_generation FROM portfolio_public_sites s WHERE s.account_id=p.account_id)
  ) FROM portfolio_publications p WHERE p.id='${publicationId}';`);
}

async function captureBrowser(context, browser, label) {
  const html = await browser.captureDom(`${label}-dom`, { safe: true });
  const png = await browser.screenshot(`${label}-screenshot`);
  return {
    html: relative(context.artifactDir, html), html_sha256: sha256(readFileSync(html)),
    screenshot: relative(context.artifactDir, png), screenshot_sha256: sha256(readFileSync(png)),
  };
}

async function saveApproveExternalRevision(m3, narrative, label) {
  const latest = await m3.ownerHTTP("/v1/portfolio/draft-revisions/latest");
  assertStatus(latest, 200, `${label} private preview base`);
  const draft = structuredClone(latest.payload.draft);
  requireCheck(draft.projects.length === 1 && draft.projects[0]?.kind?.type === "external_case_study", `${label} did not retain the external-only draft`);
  draft.profile.introduction = narrative;
  const saved = await m3.ownerHTTP("/v1/portfolio/preview-revisions", {
    method: "POST", headers: { "Idempotency-Key": `m3-static-${label}-preview-${randomUUID()}`, "If-Match": `"${latest.payload.revision}"` },
    body: { draft, preview: latest.payload.preview },
  });
  assertStatus(saved, 201, `${label} owner private preview save`);
  const review = await m3.ownerHTTP(`/v1/portfolio/publication-review?draft_revision_id=${encodeURIComponent(saved.payload.id)}`);
  assertStatus(review, 200, `${label} owner publication review`);
  requireCheck(review.payload?.deployment_facts?.length === 0 && DIGEST.test(review.payload?.review_digest ?? ""), `${label} review unexpectedly required deployment facts`);
  const approved = await m3.ownerHTTP("/v1/portfolio/approved-revisions", {
    method: "POST", headers: { "Idempotency-Key": `m3-static-${label}-approval-${randomUUID()}` },
    body: { draft_revision_id: saved.payload.id, review_digest: review.payload.review_digest, approval: { type: "entire_revision", review_digest: review.payload.review_digest }, refresh_authorizations: [] },
  });
  assertStatus(approved, 201, `${label} exact owner approval`);
  requireCheck(approved.payload?.source_draft_revision_id === saved.payload.id && approved.payload?.approvals?.length === review.payload.requirements.length, `${label} approval did not bind all reviewed values`);
  return { saved: saved.payload, review: review.payload, approved: approved.payload };
}

async function queuePublication(m3, approvedRevisionId, slug, label) {
  const response = await m3.ownerHTTP("/v1/portfolio/publications", {
    method: "POST", headers: { "Idempotency-Key": `m3-static-${label}-publish-${randomUUID()}` },
    body: { approved_revision_id: approvedRevisionId, slug },
  });
  assertStatus(response, 201, `${label} explicit owner publication`);
  requireCheck(response.payload?.state === "queued" && response.payload?.approved_revision_id === approvedRevisionId, `${label} did not queue the exact approved revision`);
  return response.payload;
}

async function leasePublication(m3, workerId, expectedPublicationId, label) {
  const response = await m3.roleInternal("publisher", "/internal/v1/portfolio-publications/lease", { method: "POST", body: { worker_id: workerId } });
  assertStatus(response, 200, `${label} publisher lease`);
  const lease = response.payload;
  requireCheck(lease?.publication_id === expectedPublicationId && typeof lease.attempt_id === "string" && Number.isSafeInteger(lease.fence) && lease.staging_relative_path === `staging/${lease.publication_id}/${lease.attempt_id}`, `${label} lease did not bind exact publication, attempt, fence and owned staging path`);
  return lease;
}

async function completePublication(m3, lease, workerId, outcome) {
  return m3.roleInternal("publisher", `/internal/v1/portfolio-publications/${lease.publication_id}/complete`, {
    method: "POST", body: { worker_id: workerId, attempt_id: lease.attempt_id, fence: lease.fence, outcome },
  });
}

async function staticBytes(url) {
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
  return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) };
}

async function runStaticPublicationDevelopment(context) {
  for (const [label, path] of [
    ["M3 external-only static publication diagnostic", "e2e/scenarios/m3-static-publication-development.mjs"],
    ["M3 real publisher worker", "crates/publisher/src/worker.rs"],
    ["M3 independent static server", "crates/publisher/src/server.rs"],
    ["M3 publisher renderer", "crates/publisher/src/render.rs"],
    ["M3 publication approval boundary", "crates/control/src/portfolio_approval.rs"],
    ["M3 Chromium driver", "e2e/support/interactive-browser.mjs"],
    ["M3 static HTTP probe", "e2e/support/m3-static-http.mjs"],
  ]) context.registerFixture(label, path);

  await runM3Context(context, async (m3) => {
    const baseline = await m3.ownerHTTP("/v1/portfolio/draft-revisions/latest");
    assertStatus(baseline, 200, "external-only publication baseline preview");
    const draft = structuredClone(baseline.payload.draft);
    const external = draft.projects.find((project) => project.kind?.type === "external_case_study");
    requireCheck(Boolean(external), "retained owned portfolio fixture lacks an external case study");
    const privateHeadline = `Private headline ${randomUUID().slice(0, 8)}`;
    const publicNarrative = `Approved <script> case study & "quoted" ${randomUUID().slice(0, 8)}`;
    const publicLink = `https://code.example.test/avery/accessibility-audit-${randomUUID().slice(0, 8)}`;
    const slug = `m3-static-${randomUUID().slice(0, 8)}`;
    draft.profile.introduction = publicNarrative;
    draft.profile.headline = privateHeadline;
    draft.section_visibility.headline = "hidden";
    draft.projects = [{
      ...external, order: 0, visibility: "shown", evidence: [], authorized_deployment_facts_id: null,
      links: [{ kind: "source", link: { id: "link-accessibility-source", label: "Case study source", url: publicLink } }],
    }];
    const preview = { ...baseline.payload.preview, accent: "indigo", project_contexts: [] };
    const saved = await m3.ownerHTTP("/v1/portfolio/preview-revisions", {
      method: "POST", headers: { "Idempotency-Key": `m3-external-preview-${randomUUID()}`, "If-Match": `"${baseline.payload.revision}"` },
      body: { draft, preview },
    });
    assertStatus(saved, 201, "owner saves external-only private preview");
    requireCheck(saved.payload?.draft?.projects?.length === 1 && saved.payload.draft.projects[0]?.kind?.type === "external_case_study" && saved.payload.preview?.project_contexts?.length === 0, "saved preview unexpectedly retained hosted or release context");

    const review = await m3.ownerHTTP(`/v1/portfolio/publication-review?draft_revision_id=${encodeURIComponent(saved.payload.id)}`);
    assertStatus(review, 200, "owner reviews external-only saved revision");
    requireCheck(review.payload?.draft_revision_id === saved.payload.id && Array.isArray(review.payload?.requirements) && review.payload.requirements.length > 0 && Array.isArray(review.payload?.deployment_facts) && review.payload.deployment_facts.length === 0 && DIGEST.test(review.payload.review_digest), "external-only review did not preserve exact owner targets without trusted deployment facts");
    const approved = await m3.ownerHTTP("/v1/portfolio/approved-revisions", {
      method: "POST", headers: { "Idempotency-Key": `m3-external-approval-${randomUUID()}` },
      body: { draft_revision_id: saved.payload.id, review_digest: review.payload.review_digest, approval: { type: "entire_revision", review_digest: review.payload.review_digest }, refresh_authorizations: [] },
    });
    assertStatus(approved, 201, "owner approves exact external-only revision");
    requireCheck(approved.payload?.source_draft_revision_id === saved.payload.id && approved.payload.approvals?.length === review.payload.requirements.length && approved.payload.deployment_facts?.length === 0, "external-only approval did not bind all exact public values without deployment facts");
    const queued = await m3.ownerHTTP("/v1/portfolio/publications", {
      method: "POST", headers: { "Idempotency-Key": `m3-external-publish-${randomUUID()}` },
      body: { approved_revision_id: approved.payload.id, slug },
    });
    assertStatus(queued, 201, "owner explicitly queues external-only publication");
    requireCheck(queued.payload?.state === "queued" && queued.payload.approved_revision_id === approved.payload.id, "publication did not queue the exact owner-approved revision");

    const publisherBinary = join(context.repo, "target", "debug", "hostlet-publisher");
    const staticPort = await context.allocatePort();
    const webPort = await context.allocatePort();
    const staticBase = `http://127.0.0.1:${staticPort}/`;
    const webUrl = `http://127.0.0.1:${webPort}/`;
    const publicUrl = `${staticBase}${slug}/`;
    let worker = null;
    let staticServer = null;
    let web = null;
    let browser = null;
    let primaryError = null;
    let observations = null;
    let failureCapture = null;
    const staticHttp = {};
    try {
      worker = await context.runCommand("M3 external-only publisher worker", publisherBinary, [
        "worker", "--control-url", m3.workerUrl, "--worker-id", `publisher-static-${randomUUID()}`, "--once",
      ], { cwd: context.repo, env: m3.componentEnvironment("publisher"), timeoutMs: 60_000, logName: "m3-static-publication-worker.log" });
      requireCheck(worker.code === 0 && worker.signal === null, "real publisher worker failed its one fenced publication attempt");
      const published = await m3.ownerHTTP("/v1/portfolio/publications/latest");
      assertStatus(published, 200, "owner reads published external-only artifact");
      const rows = await publicationState(m3, published.payload.id, "m3-static-publication-rows");
      requireCheck(published.payload.id === queued.payload.id && published.payload.state === "published" && DIGEST.test(published.payload.artifact_digest) && Number.isSafeInteger(published.payload.pointer_generation) && rows.publication_id === published.payload.id && rows.approved_revision_id === approved.payload.id && rows.state === "published" && rows.attempts === 1 && rows.succeeded_attempts === 1 && rows.site_publication_id === published.payload.id && rows.site_artifact_digest === published.payload.artifact_digest && rows.site_pointer_generation === published.payload.pointer_generation, "durable publication, worker attempt, and current site pointer did not agree");

      staticServer = context.spawnManaged("M3 external-only independent static server", publisherBinary, [
        "serve", "--root", join(m3.policyClock.stateDir, "publisher"), "--bind", `127.0.0.1:${staticPort}`, "--expected-host", `127.0.0.1:${staticPort}`,
      ], { cwd: context.repo, env: { PATH: process.env.PATH ?? "" } }, "m3-static-publication-server.log");
      await context.waitForHttp(publicUrl, 200, "M3 external-only published home");
      web = context.spawnManaged("M3 external-only Vite dashboard", "npm", ["run", "dev", "--prefix", "web", "--", "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"], {
        cwd: context.repo, env: hostEnvironment({ VITE_CONTROL_PLANE: m3.apiUrl, VITE_HOSTLET_PUBLIC_SITE_BASE_URL: staticBase }),
      }, "m3-static-publication-vite.log");
      await context.waitForHttp(webUrl, 200, "M3 external-only Vite dashboard");
      browser = await beginBrowser(context, { url: webUrl, width: 1440, height: 1300, label: "m3-static-publication", timeoutMs: 40_000 });
      await browser.waitFor('[data-testid="auth-form"]');
      await browser.fill('[data-testid="auth-form"] input[name="email"]', m3.state.owner.record.email);
      await browser.fill('[data-testid="auth-form"] input[name="password"]', m3.credentials.ownerPassword);
      await browser.click('[data-testid="auth-form"] button[type="submit"]');
      await browser.waitFor('[data-testid="publication-panel"]', { waitTimeoutMs: 40_000 });

      await browser.navigate(publicUrl);
      await browser.waitFor('a.card[href]', { waitTimeoutMs: 20_000 });
      const homeText = await browser.text("body");
      const homeLinks = await browser.evaluate('[...document.querySelectorAll("a[href]")].map((a) => a.href)');
      const homeScriptCount = await browser.evaluate('document.querySelectorAll("script").length');
      const card = await browser.evaluate('(() => { const a = document.querySelector("a.card[href]"); return a ? { href: a.href, title: a.querySelector("h3")?.textContent ?? "", purpose: a.querySelector("p")?.textContent ?? "" } : null; })()');
      const firstHome = await staticBytes(publicUrl);
      const homeHtml = firstHome.bytes.toString("utf8");
      requireCheck(firstHome.status === 200 && homeText.includes(publicNarrative) && homeHtml.includes("&lt;script&gt;") && !homeHtml.includes("<script>") && homeScriptCount === 0 && card?.title === external.title && card?.purpose === external.purpose && homeLinks.includes(publicLink) === false && !homeText.includes(privateHeadline) && !homeText.includes(m3.state.selectedSource.commitSha), "published home did not expose the approved escaped external-only document safely");
      const homeCapture = await captureBrowser(context, browser, "m3-static-publication-home");

      await browser.click('a.card[href]');
      await browser.waitFor('a.back[href="../../"]', { waitTimeoutMs: 20_000 });
      const detailUrl = await browser.evaluate("location.href");
      const detailText = await browser.text("body");
      const detailLinks = await browser.evaluate('[...document.querySelectorAll("a[href]")].map((a) => a.href)');
      const back = await browser.evaluate(`(() => { const a = document.querySelector(${JSON.stringify('a.back[href="../../"]')}); return a ? { href: a.href, text: a.textContent?.trim() ?? "" } : null; })()`);
      requireCheck(detailUrl === `${publicUrl}projects/${external.project_reference_id}/` && detailText.includes(external.title) && detailText.includes(external.purpose) && detailText.includes(external.contribution) && detailLinks.includes(publicLink) && back?.href === publicUrl && back.text.includes("Portfolio") && !detailText.includes(privateHeadline) && !detailText.includes(m3.state.selectedSource.commitSha), "published case-study detail or semantic back link did not match approved public values");
      const detailCapture = await captureBrowser(context, browser, "m3-static-publication-detail");
      await browser.click('a.back[href="../../"]');
      await browser.waitFor('a.card[href]', { waitTimeoutMs: 20_000 });
      requireCheck((await browser.evaluate("location.href")) === publicUrl && (await browser.text("body")).includes(publicNarrative), "detail back navigation did not return to the published home");

      await browser.navigate(webUrl);
      await browser.waitFor('[data-testid="publication-panel"]', { waitTimeoutMs: 30_000 });
      await browser.waitFor(() => {
        const link = document.querySelector('[data-testid="publication-url"]');
        const state = document.querySelector('[data-testid="publication-job"]');
        return link instanceof HTMLAnchorElement && state?.getAttribute("data-publication-state") === "published";
      }, { waitTimeoutMs: 30_000 });
      const shownUrl = await browser.text('[data-testid="publication-url"]');
      const dashboardCapture = await captureBrowser(context, browser, "m3-static-publication-dashboard-return");
      requireCheck(shownUrl === publicUrl && (await browser.evaluate(`document.querySelector(${JSON.stringify('[data-testid="publication-url"]')})?.href`)) === publicUrl, "dashboard did not render the exact published static URL after returning from the site");

      const publisherRoot = join(m3.policyClock.stateDir, "publisher");
      const replacementNarrative = `Replacement <script> case study & "quoted" ${randomUUID().slice(0, 8)}`;
      const replacement = await saveApproveExternalRevision(m3, replacementNarrative, "corrupt-replacement");
      const corruptQueued = await queuePublication(m3, replacement.approved.id, slug, "corrupt-replacement");
      const corruptWorkerId = `publisher-corrupt-${randomUUID()}`;
      const corruptLease = await leasePublication(m3, corruptWorkerId, corruptQueued.id, "corrupt replacement");
      const corruptStaging = join(publisherRoot, corruptLease.staging_relative_path);
      mkdirSync(corruptStaging, { recursive: true, mode: 0o700 });
      writeFileSync(join(corruptStaging, "manifest.json"), '{"format":"hostlet.static-site-manifest/v1"', { mode: 0o600, flag: "wx" });
      const corruptCompletion = await completePublication(m3, corruptLease, corruptWorkerId, { state: "succeeded", artifact_digest: `sha256:${"0".repeat(64)}` });
      requireCheck(corruptCompletion.status === 422 && corruptCompletion.payload?.error?.code === "invalid_static_artifact", "corrupt staged manifest was accepted as a successful publication");
      const corruptFailure = await completePublication(m3, corruptLease, corruptWorkerId, { state: "failed", code: "invalid_static_artifact" });
      assertStatus(corruptFailure, 200, "record corrupt publisher failure");
      const failedPublication = await m3.ownerHTTP("/v1/portfolio/publications/latest");
      assertStatus(failedPublication, 200, "owner observes corrupt publisher failure");
      const failedRows = await publicationState(m3, failedPublication.payload.id, "m3-static-corrupt-publication-rows");
      const afterCorrupt = await staticBytes(publicUrl);
      requireCheck(failedPublication.payload.id === corruptQueued.id && failedPublication.payload.state === "failed" && failedPublication.payload.failure_code === "invalid_static_artifact" && failedRows.site_publication_id === published.payload.id && failedRows.site_artifact_digest === published.payload.artifact_digest && failedRows.site_pointer_generation === published.payload.pointer_generation && !existsSync(corruptStaging) && afterCorrupt.status === 200 && afterCorrupt.bytes.equals(firstHome.bytes), "corrupt replacement changed the last-good pointer or HTTP bytes or retained staging");

      const recoveryNarrative = `Recovered <script> case study & "quoted" ${randomUUID().slice(0, 8)}`;
      const recovery = await saveApproveExternalRevision(m3, recoveryNarrative, "interrupted-recovery");
      const recoveryQueued = await queuePublication(m3, recovery.approved.id, slug, "interrupted-recovery");
      const interruptedWorkerId = `publisher-interrupted-${randomUUID()}`;
      const interruptedLease = await leasePublication(m3, interruptedWorkerId, recoveryQueued.id, "interrupted recovery");
      const interruptedStaging = join(publisherRoot, interruptedLease.staging_relative_path);
      mkdirSync(interruptedStaging, { recursive: true, mode: 0o700 });
      writeFileSync(join(interruptedStaging, "partial.html"), "partial publisher output\n", { mode: 0o600, flag: "wx" });
      const expiry = Date.parse(interruptedLease.lease_expires_at);
      requireCheck(Number.isFinite(expiry) && expiry > Date.now(), "interrupted publisher lease expiry was invalid");
      while (Date.now() <= expiry + 100) await context.delay(Math.min(500, Math.max(25, expiry + 150 - Date.now())));
      const recoveryWorker = await context.runCommand("M3 interrupted external-only publisher recovery", publisherBinary, [
        "worker", "--control-url", m3.workerUrl, "--worker-id", `publisher-recovery-${randomUUID()}`, "--once",
      ], { cwd: context.repo, env: m3.componentEnvironment("publisher"), timeoutMs: 60_000, logName: "m3-static-publication-recovery-worker.log" });
      requireCheck(recoveryWorker.code === 0 && recoveryWorker.signal === null, "real publisher failed to reclaim the expired attempt");
      const staleCompletion = await completePublication(m3, interruptedLease, interruptedWorkerId, { state: "succeeded", artifact_digest: `sha256:${"0".repeat(64)}` });
      requireCheck(staleCompletion.status === 409 && staleCompletion.payload?.error?.code === "publisher_attempt_fenced", "expired publisher completion was not fenced");
      const recovered = await m3.ownerHTTP("/v1/portfolio/publications/latest");
      assertStatus(recovered, 200, "owner reads recovered publication");
      const recoveredRows = await publicationState(m3, recovered.payload.id, "m3-static-recovered-publication-rows");
      requireCheck(recovered.payload.id === recoveryQueued.id && recovered.payload.state === "published" && recovered.payload.artifact_digest !== published.payload.artifact_digest && recovered.payload.pointer_generation > published.payload.pointer_generation && recoveredRows.site_publication_id === recovered.payload.id && recoveredRows.site_artifact_digest === recovered.payload.artifact_digest && recoveredRows.site_pointer_generation === recovered.payload.pointer_generation && recoveredRows.attempts === 2 && recoveredRows.succeeded_attempts === 1 && !existsSync(interruptedStaging), "reclaimed publisher did not advance a distinct immutable pointer and clean old staging");

      await context.stopManaged(staticServer, "M3 external-only static server restart");
      staticServer = context.spawnManaged("M3 restarted external-only static server", publisherBinary, [
        "serve", "--root", publisherRoot, "--bind", `127.0.0.1:${staticPort}`, "--expected-host", `127.0.0.1:${staticPort}`,
      ], { cwd: context.repo, env: { PATH: process.env.PATH ?? "" } }, "m3-static-publication-server-restarted.log");
      await context.waitForHttp(publicUrl, 200, "restarted external-only static server");
      const afterRecovery = await staticBytes(publicUrl);
      await browser.navigate(publicUrl);
      const recoveredText = await browser.text("body");
      const recoveryCapture = await captureBrowser(context, browser, "m3-static-publication-recovered");
      requireCheck(afterRecovery.status === 200 && !afterRecovery.bytes.equals(firstHome.bytes) && recoveredText.includes(recoveryNarrative) && !recoveredText.includes(publicNarrative) && !recoveredText.includes(replacementNarrative), "restarted static server did not serve only the recovered escaped narrative");
      await probeStaticHttpBoundary(staticPort, slug, context.abortSignal, staticHttp);
      requireCheck(staticHttpBoundaryPassed(staticHttp), `restarted static server Host and literal path probe failed: ${JSON.stringify(staticHttp)}`);

      await browser.close();
      browser = null;
      await context.stopManaged(web, "M3 external-only dashboard outage");
      web = null;
      let outageBrowser = null;
      let providerPaused = false;
      let apiStopped = false;
      let outageHomeCapture = null;
      let outageDetailCapture = null;
      try {
        await m3.state.githubFixture.pause();
        providerPaused = true;
        await m3.stopApi("M3 external-only static independence outage");
        apiStopped = true;
        outageBrowser = await beginBrowser(context, { url: publicUrl, width: 1440, height: 1300, label: "m3-static-publication-offline", timeoutMs: 40_000 });
        await outageBrowser.waitFor('a.card[href]', { waitTimeoutMs: 20_000 });
        const outageHomeText = await outageBrowser.text("body");
        outageHomeCapture = await captureBrowser(context, outageBrowser, "m3-static-publication-offline-home");
        requireCheck(outageHomeText.includes(recoveryNarrative) && !outageHomeText.includes(publicNarrative), "fresh browser did not load recovered home while dashboard, control, and provider were stopped");
        await outageBrowser.click('a.card[href]');
        await outageBrowser.waitFor('a.back[href="../../"]', { waitTimeoutMs: 20_000 });
        const outageDetailText = await outageBrowser.text("body");
        outageDetailCapture = await captureBrowser(context, outageBrowser, "m3-static-publication-offline-detail");
        requireCheck(outageDetailText.includes(external.title) && outageDetailText.includes(external.contribution), "fresh browser did not load external case-study detail during upstream outage");
      } finally {
        let browserCloseError = null;
        if (outageBrowser) { try { await outageBrowser.close(); } catch (error) { browserCloseError = error; } }
        try { if (providerPaused) await m3.state.githubFixture.resume(); }
        finally { if (apiStopped) await m3.startApi({ binary: m3.currentApiBinary, label: "M3 external-only upstreams resumed" }); }
        if (browserCloseError) throw browserCloseError;
      }

      observations = {
        diagnostic_only: true, production_capability_registered: false, m3_gate_satisfied: false,
        source_draft_revision_id: saved.payload.id, approved_revision_id: approved.payload.id,
        publication_id: published.payload.id, document_digest: published.payload.document_digest,
        artifact_digest: published.payload.artifact_digest, pointer_generation: published.payload.pointer_generation,
        deployment_facts_count: review.payload.deployment_facts.length,
        requirements_count: review.payload.requirements.length, approvals_count: approved.payload.approvals.length,
        project_reference_id: external.project_reference_id, public_url: publicUrl, detail_url: detailUrl,
        escaped_script_text: true, script_element_count: homeScriptCount, approved_link_present: detailLinks.includes(publicLink),
        private_headline_absent: true, private_source_commit_absent: true, dashboard_return_url_matches: shownUrl === publicUrl,
        publication_rows: rows,
        worker: { exit_code: worker.code, signal: worker.signal, log: relative(context.artifactDir, worker.logPath), log_sha256: sha256(readFileSync(worker.logPath)) },
        browser: { home: homeCapture, detail: detailCapture, dashboard_return: dashboardCapture, recovery: recoveryCapture, offline_home: outageHomeCapture, offline_detail: outageDetailCapture },
        static_http: staticHttp,
        replacement: {
          approved_revision_id: replacement.approved.id, publication_id: corruptQueued.id,
          corrupt_success_status: corruptCompletion.status, failed_completion_status: corruptFailure.status,
          failure_code: failedPublication.payload.failure_code, staging_absent: !existsSync(corruptStaging),
          last_good_http_sha256: sha256(firstHome.bytes), after_corrupt_http_sha256: sha256(afterCorrupt.bytes),
          last_good_pointer_preserved: failedRows.site_publication_id === published.payload.id,
        },
        recovery: {
          approved_revision_id: recovery.approved.id, publication_id: recovered.payload.id,
          artifact_digest: recovered.payload.artifact_digest, pointer_generation: recovered.payload.pointer_generation,
          stale_completion_status: staleCompletion.status, stale_completion_code: staleCompletion.payload.error.code,
          interrupted_staging_absent: !existsSync(interruptedStaging), attempts: recoveredRows.attempts,
          recovered_http_sha256: sha256(afterRecovery.bytes),
          worker_log: relative(context.artifactDir, recoveryWorker.logPath), worker_log_sha256: sha256(readFileSync(recoveryWorker.logPath)),
          upstream_outage: { dashboard_stopped: true, control_stopped: true, synthetic_provider_paused: true, fresh_home_and_detail_loaded: true, tenant_endpoints: "N/A: external-only fixture" },
        },
      };
    } catch (error) {
      primaryError = error;
      if (browser) {
        try { failureCapture = await captureBrowser(context, browser, "m3-static-publication-failed"); } catch { /* original failure remains authoritative */ }
      }
    } finally {
      if (browser) { try { await browser.close(); } catch (error) { primaryError ??= error; } }
      if (web) { try { await context.stopManaged(web, "M3 static publication Vite cleanup"); } catch (error) { primaryError ??= error; } }
      if (staticServer) { try { await context.stopManaged(staticServer, "M3 static publication server cleanup"); } catch (error) { primaryError ??= error; } }
    }

    const record = { schema: "hostlet.m3-static-publication-development/v1", diagnostic_only: true, production_capability_registered: false, m3_gate_satisfied: false, status: primaryError ? "failed" : "passed", observations, static_http: staticHttp, failure_capture: failureCapture, ...(primaryError ? { error: context.redact(primaryError.message) } : {}) };
    writeFileSync(join(context.artifactDir, "m3-static-publication-development.json"), `${context.redact(JSON.stringify(record, null, 2))}\n`, { encoding: "utf8", mode: 0o600 });
    const expected = "real external-only approval publishes escaped static pages; corrupt and expired publisher attempts preserve or safely replace the last-good pointer, and a fresh browser reads the recovered site with dashboard, control and provider stopped";
    context.assertion(ASSERTION, "M3 external-only static publication diagnostic", expected, { ...observations, static_http: staticHttp, failure_capture: failureCapture, diagnostic_only: true, production_capability_registered: false }, !primaryError, primaryError?.message ?? null);
    if (primaryError) throw primaryError;
  });
}

export const scenario = Object.freeze({
  id: "m3-static-publication-development",
  description: "Diagnostic-only external case-study publication, corrupt and interrupted publisher recovery, and independent static browsing; excludes tenant outage and M3 gate acceptance",
  requiredAssertions: Object.freeze([...M3_UPGRADE_REQUIRED_ASSERTIONS, ASSERTION]),
  run: runStaticPublicationDevelopment,
});
