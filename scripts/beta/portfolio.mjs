import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const templatePath = resolve(import.meta.dirname, "../../contracts/v1/portfolio/draft-valid.json");

export function previewDraft(projectId, demoUrl) {
  const draft = JSON.parse(readFileSync(templatePath, "utf8"));
  draft.profile.display_name = "Hostlet Preview Owner";
  draft.profile.headline = "Owned Node and PostgreSQL demo";
  draft.profile.introduction = "A synthetic application preview for reviewing Hostlet's portfolio and demo journey.";
  draft.profile.target_role = "Software developer";
  draft.resume = null;
  draft.contacts = [];
  draft.section_visibility.resume = "hidden";
  draft.section_visibility.contacts = "hidden";
  draft.projects = draft.projects.filter((project) => project.kind.type === "hosted_project");
  const project = draft.projects[0];
  project.kind.project_id = projectId;
  project.title = "Owned journal demo";
  project.purpose = "Demonstrates a Node service with a durable PostgreSQL write.";
  project.contribution = "Synthetic owner-controlled demonstration project.";
  project.technical_decisions = [];
  project.links = [{ kind: "demo", link: { id: "link-owned-demo", label: "Live demo", url: demoUrl } }];
  project.evidence = [];
  project.authorized_deployment_facts_id = null;
  project.displayed_status = { deployment_timestamp: false, availability: false, release_identifier: false, source_commit: false, demo_readiness: false };
  project.demo_readiness = { state: "needs_recheck", previous_attestation: null, reason: "never_checked" };
  return draft;
}

export async function ensurePreviewDraft(context, { projectId, configurationRevisionId, sourceRevisionId, compatibilityReportId }) {
  const current = await context.ownerHTTP("/v1/portfolio/draft-revisions/latest");
  if (current.status === 200 && current.payload?.revision > 0) {
    return { id: current.payload.id, revision: current.payload.revision, existing: true };
  }
  if (current.status !== 200 && current.status !== 404) throw new Error(`portfolio draft read failed (${current.status})`);
  const draft = previewDraft(projectId, context.config.origins.demo);
  const project = draft.projects[0];
  const response = await context.ownerHTTP("/v1/portfolio/preview-revisions", {
    method: "POST",
    headers: { "Idempotency-Key": "m35-owner-first-preview-draft", "If-Match": `"${current.payload?.revision ?? 0}"` },
    body: {
      draft,
      preview: { layout: "layout_1", typography: "system_sans", accent: "forest", project_contexts: [{
        project_reference_id: project.project_reference_id, project_id: projectId,
        configuration_revision_id: configurationRevisionId, source_revision_id: sourceRevisionId,
        compatibility_report_id: compatibilityReportId, placeholder: "gradient_1", configuration_answers: [],
      }] },
    },
  });
  if (response.status !== 201) throw new Error(`portfolio preview creation failed (${response.status}: ${response.payload?.error?.code ?? "unknown"})`);
  context.updateManifest({ portfolio: { initialDraftRevisionId: response.payload.id } });
  return { id: response.payload.id, revision: response.payload.revision, existing: false };
}

// Publication is a separate owner action. This accepts only an approval already
// written through the real review boundary and never creates an approval itself.
export async function ensureApprovedPublication(context, { slug = "owned-preview" } = {}) {
  const approved = await context.ownerHTTP("/v1/portfolio/approved-revisions/latest");
  if (approved.status !== 200 || !approved.payload?.id) throw new Error("owner-approved revision is required before publication");
  const current = await context.ownerHTTP("/v1/portfolio/publications/latest");
  if (current.status === 200) {
    if (current.payload.state !== "published") throw new Error(`existing publication is ${current.payload.state}; wait for the real publisher`);
    return { id: current.payload.id, approvedRevisionId: current.payload.approved_revision_id, existing: true };
  }
  if (current.status !== 404) throw new Error(`publication read failed (${current.status})`);
  const queued = await context.ownerHTTP("/v1/portfolio/publications", { method: "POST",
    headers: { "Idempotency-Key": `m35-owner-approved-publication-${approved.payload.id}` },
    body: { approved_revision_id: approved.payload.id, slug } });
  if (queued.status !== 201 && queued.status !== 202) throw new Error(`approved publication queue failed (${queued.status}: ${queued.payload?.error?.code ?? "unknown"})`);
  context.updateManifest({ portfolio: { approvedRevisionId: approved.payload.id, publicationId: queued.payload.id } });
  return { id: queued.payload.id, approvedRevisionId: approved.payload.id, existing: false, state: queued.payload.state };
}
