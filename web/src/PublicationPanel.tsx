import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, idempotencyKey } from "./api";
import type {
  ApprovedRevision,
  ApprovalRequirement,
  ApprovalTarget,
  PortfolioPublication,
  PublicationReview,
  RefreshField,
} from "./api";
import "./publication.css";

type ApprovalMode = "entire_revision" | "individual_fields";

function targetKey(target: ApprovalTarget): string {
  return JSON.stringify(target);
}

function words(value: string): string {
  return value.replaceAll("_", " ");
}

function projectTitle(review: Pick<PublicationReview, "snapshot">, referenceId: string): string {
  return review.snapshot.projects.find((project) => project.project_reference_id === referenceId)?.title ?? referenceId;
}

function targetLabel(review: PublicationReview, target: ApprovalTarget): string {
  switch (target.type) {
    case "narrative":
      return `${target.project_reference_id ? `${projectTitle(review, target.project_reference_id)} · ` : ""}${words(target.field)}`;
    case "contact": return `Contact · ${target.contact_id}`;
    case "link": return `${target.project_reference_id ? `${projectTitle(review, target.project_reference_id)} · ` : ""}link · ${target.link_id}`;
    case "screenshot": return `${projectTitle(review, target.project_reference_id)} · screenshot · ${target.evidence_id}`;
    case "contribution": return `${projectTitle(review, target.project_reference_id)} · contribution`;
    case "technical_decision": return `${projectTitle(review, target.project_reference_id)} · technical decision · ${target.decision_id}`;
    case "status": return `${projectTitle(review, target.project_reference_id)} · ${words(target.field)}`;
  }
}

function isSafePublicUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "mailto:";
  } catch {
    return false;
  }
}

function ReviewValue({ value }: { value: unknown }) {
  if (value === null) return <span className="publication-value publication-value--empty">Not set</span>;
  if (typeof value === "boolean") return <span className="publication-value">{value ? "Yes" : "No"}</span>;
  if (typeof value === "string") {
    return isSafePublicUrl(value)
      ? <a className="publication-value publication-value--link" href={value} target="_blank" rel="noreferrer">{value}</a>
      : <span className="publication-value">{value || "Empty text"}</span>;
  }
  if (typeof value === "number") return <span className="publication-value">{String(value)}</span>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="publication-value publication-value--empty">Empty list</span>;
    return <ul className="publication-value-list">{value.map((item, index) => <li key={index}><ReviewValue value={item} /></li>)}</ul>;
  }
  if (typeof value === "object") {
    return <dl className="publication-value-object">{Object.entries(value).map(([key, item]) => (
      <div key={key}><dt>{words(key)}</dt><dd><ReviewValue value={item} /></dd></div>
    ))}</dl>;
  }
  return <span className="publication-value">{String(value)}</span>;
}

function eligibleRefreshFields(review: PublicationReview, projectReferenceId: string): RefreshField[] {
  const project = review.snapshot.projects.find((item) => item.project_reference_id === projectReferenceId);
  const fact = review.deployment_facts.find((item) => item.project_reference_id === projectReferenceId);
  if (!project || !fact) return [];
  const fields: RefreshField[] = [];
  const links = Array.isArray(project.links) ? project.links : [];
  const managedDemoShown = links.some((candidate) => {
    if (typeof candidate !== "object" || candidate === null) return false;
    const link = candidate as { kind?: unknown; link?: { url?: unknown } };
    return link.kind === "demo" && link.link?.url === fact.managed_demo_url;
  });
  if (managedDemoShown) fields.push("managed_demo_destination");
  const displayed = project.displayed_status as Record<string, unknown> | undefined;
  if (displayed?.deployment_timestamp === true) fields.push("deployment_timestamp");
  if (displayed?.availability === true) fields.push("availability_label");
  return fields;
}

function readinessCopy(state: string, reason: string | null): string {
  if (state === "ready_to_share") return "Ready to share after owner checks";
  if (reason === "new_release") return "Needs recheck after a new release";
  if (reason === "demo_access_changed") return "Needs recheck after demo access changed";
  if (reason === "never_checked") return "Needs first owner check";
  if (reason === "owner_requested") return "Needs owner recheck";
  return `Needs recheck${reason ? ` · ${words(reason)}` : ""}`;
}

function publicationStateCopy(publication: PortfolioPublication): string {
  if (publication.state === "queued") return "Queued for the independent publisher";
  if (publication.state === "publishing") return "Building and validating the static site";
  if (publication.state === "published") return "Published";
  if (publication.state === "failed") return `Publication failed${publication.failure_code ? ` · ${words(publication.failure_code)}` : ""}`;
  if (publication.state === "superseded") return "Superseded by a newer publication";
  return words(publication.state);
}

function validSlug(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}

function publicSiteUrl(publication: PortfolioPublication): string | null {
  if (publication.state !== "published") return null;
  const base = import.meta.env.VITE_HOSTLET_PUBLIC_SITE_BASE_URL?.trim();
  if (!base) return null;
  try {
    const parsed = new URL(base);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]"))) return null;
    return new URL(`${encodeURIComponent(publication.slug)}/`, parsed.href.endsWith("/") ? parsed.href : `${parsed.href}/`).href;
  } catch {
    return null;
  }
}

export function PublicationPanel({
  token,
  savedRevisionId,
  savedRevision,
  hasUnsavedChanges,
  editorBusy,
  onSessionExpired,
}: {
  token: string;
  savedRevisionId: string | null;
  savedRevision: number;
  hasUnsavedChanges: boolean;
  editorBusy: boolean;
  onSessionExpired: () => void;
}) {
  const [review, setReview] = useState<PublicationReview | null>(null);
  const [approved, setApproved] = useState<ApprovedRevision | null>(null);
  const [publication, setPublication] = useState<PortfolioPublication | null>(null);
  const [slug, setSlug] = useState("");
  const [mode, setMode] = useState<ApprovalMode>("entire_revision");
  const [entireConfirmed, setEntireConfirmed] = useState(false);
  const [selectedTargets, setSelectedTargets] = useState<Set<string>>(() => new Set());
  const [refreshFields, setRefreshFields] = useState<Record<string, RefreshField[]>>({});
  const [loadingReview, setLoadingReview] = useState(false);
  const [loadingLatest, setLoadingLatest] = useState(false);
  const [approving, setApproving] = useState(false);
  const [requestingPublication, setRequestingPublication] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [publicationMessage, setPublicationMessage] = useState<string | null>(null);
  const latestGeneration = useRef(0);
  const reviewGeneration = useRef(0);
  const publicationGeneration = useRef(0);
  const publicationIntent = useRef<{ approvedRevisionId: string; slug: string; key: string } | null>(null);

  const loadLatestApproval = useCallback(async () => {
    const generation = ++latestGeneration.current;
    setLoadingLatest(true);
    try {
      const response = await api.latestApprovedRevision(token);
      if (generation === latestGeneration.current) setApproved(response);
    } catch (error) {
      if (generation !== latestGeneration.current) return;
      if (error instanceof ApiError && error.status === 404) setApproved(null);
      else if (error instanceof ApiError && error.status === 401) onSessionExpired();
    } finally {
      if (generation === latestGeneration.current) setLoadingLatest(false);
    }
  }, [onSessionExpired, token]);

  useEffect(() => {
    void loadLatestApproval();
    return () => { latestGeneration.current += 1; };
  }, [loadLatestApproval]);

  const loadLatestPublication = useCallback(async () => {
    const generation = ++publicationGeneration.current;
    try {
      const response = await api.latestPublication(token);
      if (generation !== publicationGeneration.current) return;
      setPublication(response);
      setSlug((current) => current || response.slug);
    } catch (error) {
      if (generation !== publicationGeneration.current) return;
      if (error instanceof ApiError && error.status === 404) setPublication(null);
      else if (error instanceof ApiError && error.status === 401) onSessionExpired();
      else setPublicationMessage(error instanceof Error ? error.message : "Publication status could not be loaded.");
    }
  }, [onSessionExpired, token]);

  useEffect(() => {
    void loadLatestPublication();
    return () => { publicationGeneration.current += 1; };
  }, [loadLatestPublication]);

  useEffect(() => {
    if (!publication || (publication.state !== "queued" && publication.state !== "publishing")) return;
    const publicationId = publication.id;
    const generation = ++publicationGeneration.current;
    const timer = window.setTimeout(() => {
      void api.publication(token, publicationId).then((response) => {
        if (generation === publicationGeneration.current) setPublication(response);
      }).catch((error: unknown) => {
        if (generation !== publicationGeneration.current) return;
        if (error instanceof ApiError && error.status === 401) onSessionExpired();
        else setPublicationMessage(error instanceof Error ? error.message : "Publication status could not be refreshed.");
      });
    }, 1_000);
    return () => {
      window.clearTimeout(timer);
      publicationGeneration.current += 1;
    };
  }, [onSessionExpired, publication, token]);

  useEffect(() => {
    reviewGeneration.current += 1;
    setReview(null);
    setEntireConfirmed(false);
    setSelectedTargets(new Set());
    setRefreshFields({});
    setMessage(null);
  }, [savedRevisionId]);

  const allFieldsSelected = review !== null && review.requirements.length > 0
    && review.requirements.every((requirement) => selectedTargets.has(targetKey(requirement.target)));
  const canApprove = Boolean(review)
    && !hasUnsavedChanges
    && !editorBusy
    && !approving
    && (mode === "entire_revision" ? entireConfirmed : allFieldsSelected);

  const refreshOptions = useMemo(() => review?.deployment_facts.flatMap((fact) => {
    const eligible = eligibleRefreshFields(review, fact.project_reference_id);
    return eligible.length ? [{ fact, eligible }] : [];
  }) ?? [], [review]);

  async function loadReview() {
    if (!savedRevisionId || hasUnsavedChanges || editorBusy) return;
    const generation = ++reviewGeneration.current;
    setLoadingReview(true);
    setMessage(null);
    try {
      const response = await api.publicationReview(token, savedRevisionId);
      if (generation !== reviewGeneration.current) return;
      setReview(response);
      setEntireConfirmed(false);
      const availableTargets = new Set(response.requirements.map((requirement) => targetKey(requirement.target)));
      setSelectedTargets((current) => new Set([...current].filter((key) => availableTargets.has(key))));
      setRefreshFields((current) => Object.fromEntries(Object.entries(current).flatMap(([projectReferenceId, fields]) => {
        const eligible = eligibleRefreshFields(response, projectReferenceId);
        const retained = fields.filter((field) => eligible.includes(field));
        return retained.length ? [[projectReferenceId, retained]] : [];
      })));
    } catch (error) {
      if (generation !== reviewGeneration.current) return;
      if (error instanceof ApiError && error.status === 401) onSessionExpired();
      else setMessage(error instanceof Error ? error.message : "The saved revision could not be prepared for review.");
    } finally {
      if (generation === reviewGeneration.current) setLoadingReview(false);
    }
  }

  function toggleTarget(requirement: ApprovalRequirement, checked: boolean) {
    const key = targetKey(requirement.target);
    setSelectedTargets((current) => {
      const next = new Set(current);
      if (checked) next.add(key); else next.delete(key);
      return next;
    });
  }

  function toggleRefresh(projectReferenceId: string, field: RefreshField, checked: boolean) {
    setRefreshFields((current) => {
      const existing = current[projectReferenceId] ?? [];
      const fields = checked ? [...existing, field] : existing.filter((item) => item !== field);
      return { ...current, [projectReferenceId]: fields };
    });
  }

  async function approve() {
    if (!review || !canApprove) return;
    setApproving(true);
    setMessage(null);
    const approval = mode === "entire_revision"
      ? { type: "entire_revision" as const, review_digest: review.review_digest }
      : {
          type: "individual_fields" as const,
          fields: review.requirements.map((requirement) => ({
            target: requirement.target,
            value_digest: requirement.value_digest,
          })),
        };
    try {
      const result = await api.approveRevision(token, {
        draft_revision_id: review.draft_revision_id,
        review_digest: review.review_digest,
        approval,
        refresh_authorizations: Object.entries(refreshFields).flatMap(([project_reference_id, fields]) =>
          fields.length ? [{ project_reference_id, fields }] : []),
      }, idempotencyKey("web-portfolio-approval"));
      setApproved(result);
      setMessage("This saved revision is approved. Nothing has been published yet.");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        onSessionExpired();
      } else if (error instanceof ApiError && error.code === "stale_publication_review") {
        setMessage("The saved revision or its trusted deployment facts changed during review. Your choices are preserved; load the review again before approving.");
      } else {
        setMessage(error instanceof Error ? error.message : "The revision could not be approved.");
      }
    } finally {
      setApproving(false);
    }
  }

  async function publishApprovedRevision() {
    if (!approved || requestingPublication) return;
    const normalizedSlug = slug.trim().toLowerCase();
    if (!validSlug(normalizedSlug)) {
      setPublicationMessage("Use 1–63 lowercase letters, numbers, or single hyphens, with a letter or number at each end.");
      return;
    }
    setSlug(normalizedSlug);
    setRequestingPublication(true);
    setPublicationMessage(null);
    const prior = publicationIntent.current;
    const intent = prior
      && prior.approvedRevisionId === approved.id
      && prior.slug === normalizedSlug
      ? prior
      : { approvedRevisionId: approved.id, slug: normalizedSlug, key: idempotencyKey("web-portfolio-publication") };
    publicationIntent.current = intent;
    try {
      const response = await api.createPublication(token, intent.approvedRevisionId, intent.slug, intent.key);
      setPublication(response);
      publicationIntent.current = null;
      setPublicationMessage("Publication was queued. This page will report success only after the independent publisher validates and serves the artifact.");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onSessionExpired();
      else if (error instanceof ApiError && (error.code === "idempotency_payload_changed" || error.status === 409)) {
        setPublicationMessage("Publication state changed while this request was being recorded. Refresh status before trying again; the approved revision remains unchanged.");
      } else {
        setPublicationMessage(error instanceof Error ? `${error.message} Retrying keeps the same publication request.` : "The publication request could not be recorded. Retrying keeps the same request.");
      }
    } finally {
      setRequestingPublication(false);
    }
  }

  const saveFirst = !savedRevisionId || hasUnsavedChanges;

  return (
    <section className="publication-panel" data-testid="publication-panel" aria-labelledby="publication-title">
      <div className="publication-panel__heading">
        <div><p className="eyebrow">Owner publication approval</p><h2 id="publication-title">Review the exact saved revision.</h2></div>
        <button type="button" data-testid="publication-load-review" onClick={() => void loadReview()} disabled={saveFirst || editorBusy || loadingReview || approving}>
          {loadingReview ? "Loading review…" : `Review saved revision ${savedRevision || ""}`.trim()}
        </button>
      </div>

      {saveFirst && <p className="publication-save-first" data-testid="publication-save-first">Save your current editor changes before review. Approval always applies to one immutable saved revision, so unsaved values cannot be included or discarded silently.</p>}
      {message && <p className="notice" role="status" data-testid="publication-notice">{message}</p>}

      {approved && (
        <aside className="publication-approved" data-testid="publication-approved-state">
          <div><strong>Approved revision {approved.source_draft_revision}</strong><span>Approved {new Date(approved.approved_at).toLocaleString()}</span></div>
          <p>{publication?.state === "published" && publication.approved_revision_id === approved.id
            ? "This approved revision has a published, independently served static artifact."
            : publication && (publication.state === "queued" || publication.state === "publishing") && publication.approved_revision_id === approved.id
              ? "This approved revision is in the publication queue. The currently served site is unchanged until validation succeeds."
              : "This approval is recorded, but this revision has not been published."}</p>
          {approved.readiness.length > 0 ? <ul>{approved.readiness.map((item) => (
            <li key={item.id} data-testid="publication-readiness" data-readiness-state={item.state}>
              <strong>{projectTitle({ snapshot: approved.snapshot }, item.project_reference_id)}</strong>
              <span>{readinessCopy(item.state, item.reason)}</span>
            </li>
          ))}</ul> : <p data-testid="publication-readiness-empty">No displayed demo readiness checks are required for this revision.</p>}
          <button type="button" data-testid="publication-refresh-status" onClick={() => void loadLatestApproval()} disabled={loadingLatest || approving}>{loadingLatest ? "Checking status…" : "Refresh approval status"}</button>
        </aside>
      )}

      {approved && (
        <section className="publication-release" data-testid="publication-release" aria-labelledby="publication-release-title">
          <div>
            <h3 id="publication-release-title">Publish an approved revision</h3>
            <p>This publishes approved revision {approved.source_draft_revision}. Approval by itself does not publish or change the currently served site.</p>
          </div>
          <label>Site address
            <span className="publication-slug-input"><input data-testid="publication-slug" value={slug} onChange={(event) => setSlug(event.target.value.toLowerCase())} placeholder="avery-portfolio" maxLength={63} disabled={requestingPublication} /><span>public site</span></span>
          </label>
          <button type="button" className="primary-button" data-testid="publication-publish" onClick={() => void publishApprovedRevision()} disabled={requestingPublication || !validSlug(slug.trim().toLowerCase()) || (publication?.approved_revision_id === approved.id && publication.slug === slug.trim().toLowerCase())}>
            {requestingPublication ? "Requesting publication…" : publication?.state === "failed" && publication.approved_revision_id === approved.id && publication.slug === slug.trim().toLowerCase() ? "Approve a new revision to retry" : "Publish approved revision"}
          </button>
          {publicationMessage && <p className="notice" role="status" data-testid="publication-publish-notice">{publicationMessage}</p>}
          {publication && (
            <article className={`publication-job publication-job--${publication.state}`} data-testid="publication-job" data-publication-state={publication.state}>
              <div><strong>{publicationStateCopy(publication)}</strong><span>Site: {publication.slug}</span></div>
              {publicSiteUrl(publication) && <p><a data-testid="publication-url" href={publicSiteUrl(publication)!} target="_blank" rel="noreferrer">{publicSiteUrl(publication)}</a></p>}
              {publication.state === "published" && !publicSiteUrl(publication) && <p data-testid="publication-url-unavailable">The artifact is live, but this environment did not provide a browser URL.</p>}
              {publication.state === "failed" && <p>The prior served site, if any, remains unchanged. Save and approve a new revision before requesting a replacement.</p>}
              {publication.state === "superseded" && <p>This request did not replace the served site. Refresh to see the newer publication.</p>}
              <dl>
                <div><dt>Publication</dt><dd>{publication.id}</dd></div>
                <div><dt>Document digest</dt><dd>{publication.document_digest}</dd></div>
                {publication.artifact_digest && <div><dt>Artifact digest</dt><dd>{publication.artifact_digest}</dd></div>}
                {publication.pointer_generation !== null && <div><dt>Site generation</dt><dd>{publication.pointer_generation}</dd></div>}
                {publication.published_at && <div><dt>Published</dt><dd>{new Date(publication.published_at).toLocaleString()}</dd></div>}
              </dl>
              <button type="button" data-testid="publication-refresh-job" onClick={() => void loadLatestPublication()} disabled={requestingPublication}>Refresh publication status</button>
            </article>
          )}
        </section>
      )}

      {review && (
        <div className="publication-review" data-testid="publication-review" data-review-digest={review.review_digest}>
          <div className="publication-review__summary">
            <strong>Saved revision {review.draft_revision}</strong>
            <span>{review.requirements.length} public {review.requirements.length === 1 ? "value" : "values"} to approve</span>
          </div>
          <dl className="publication-appearance" data-testid="publication-review-appearance">
            <div><dt>Layout</dt><dd>{words(review.preview_context.layout)}</dd></div>
            <div><dt>Typography</dt><dd>{words(review.preview_context.typography)}</dd></div>
            <div><dt>Accent</dt><dd>{words(review.preview_context.accent)}</dd></div>
          </dl>

          <ol className="publication-requirements">
            {review.requirements.map((requirement) => {
              const key = targetKey(requirement.target);
              return <li key={`${key}-${requirement.value_digest}`} data-testid="publication-review-field">
                {mode === "individual_fields" && <input aria-label={`Approve ${targetLabel(review, requirement.target)}`} type="checkbox" checked={selectedTargets.has(key)} onChange={(event) => toggleTarget(requirement, event.target.checked)} disabled={approving} />}
                <div><strong>{targetLabel(review, requirement.target)}</strong><ReviewValue value={requirement.value} /></div>
              </li>;
            })}
          </ol>

          {review.requirements.some((item) => item.target.type === "status" && item.target.field === "source_commit") && (
            <p className="publication-commit-warning" data-testid="publication-source-commit">This revision explicitly includes a source commit. Confirm that exact value above is safe to make public. Source commits stay private by default.</p>
          )}

          {refreshOptions.length > 0 && (
            <fieldset className="publication-refresh" data-testid="publication-refresh-options" disabled={approving}>
              <legend>Optional updates from future trusted releases</legend>
              <p>Leave these off to keep every approved value fixed. These permissions never update narrative, contributions, evidence, screenshots, or source commits.</p>
              {refreshOptions.map(({ fact, eligible }) => <div key={fact.project_reference_id}>
                <strong>{projectTitle(review, fact.project_reference_id)}</strong>
                {eligible.map((field) => <label key={field}><input type="checkbox" data-testid={`publication-refresh-${field}`} checked={(refreshFields[fact.project_reference_id] ?? []).includes(field)} onChange={(event) => toggleRefresh(fact.project_reference_id, field, event.target.checked)} />Allow {words(field)} to follow a trusted promoted release</label>)}
              </div>)}
            </fieldset>
          )}

          <fieldset className="publication-approval-mode" disabled={approving}>
            <legend>How do you want to approve this revision?</legend>
            <label><input type="radio" name="publication-approval-mode" value="entire_revision" checked={mode === "entire_revision"} onChange={() => setMode("entire_revision")} />Approve the whole reviewed revision</label>
            <label><input type="radio" name="publication-approval-mode" value="individual_fields" checked={mode === "individual_fields"} onChange={() => setMode("individual_fields")} />Approve each public value above</label>
            {mode === "entire_revision" && <label className="publication-entire-confirm"><input data-testid="publication-entire-confirm" type="checkbox" checked={entireConfirmed} onChange={(event) => setEntireConfirmed(event.target.checked)} />I reviewed every exact value above and approve this saved revision.</label>}
          </fieldset>

          <button className="primary-button publication-approve" type="button" data-testid="publication-approve" onClick={() => void approve()} disabled={!canApprove}>
            {approving ? "Recording approval…" : "Approve saved revision"}
          </button>
          {hasUnsavedChanges && <p className="publication-save-first">The editor changed after this review. Save and load a new review before approving.</p>}
        </div>
      )}
    </section>
  );
}
