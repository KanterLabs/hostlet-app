import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  api,
  idempotencyKey,
} from "./api";
import type {
  CompatibilityReport,
  ConfigurationAnswer,
  ConfigurationQuestion,
  GitHubSource,
  PortfolioDraft,
  PreviewContext,
  PreviewRevision,
  ProjectGraph,
  ProjectSummary,
} from "./api";
import "./preview.css";
import { PreviewCanvas } from "./PreviewCanvas";
import { PublicationPanel } from "./PublicationPanel";

type ProjectBundle = {
  summary: ProjectSummary;
  graph: ProjectGraph | null;
  source: GitHubSource | null;
  report: CompatibilityReport | null;
};

type ConflictState = { latest: PreviewRevision; etag: string | null };
type JsonRecord = Record<string, unknown>;
type SavedEditorState = { id: string; revision: number; draft: PortfolioDraft; preview: PreviewRevision["preview"] };
type DisplayedStatusField = "deployment_timestamp" | "availability" | "release_identifier" | "source_commit" | "demo_readiness";

const answerVersion = "hostlet.configuration-answer/v1" as const;

function emptyDraft(displayName: string): PortfolioDraft {
  return {
    contract_version: "v1",
    profile: { display_name: displayName, headline: null, introduction: "", target_role: "" },
    skills: [],
    resume: null,
    contacts: [],
    projects: [],
    section_visibility: {
      headline: "shown",
      introduction: "shown",
      target_role: "shown",
      skills: "shown",
      resume: "shown",
      contacts: "shown",
      projects: "shown",
    },
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function projectIdOf(project: PortfolioDraft["projects"][number]): string | null {
  return project.kind.type === "hosted_project" && project.kind.project_id
    ? project.kind.project_id
    : null;
}

function defaultPortfolioProject(project: ProjectSummary, order: number): PortfolioDraft["projects"][number] {
  return {
    project_reference_id: `project-${project.id}`,
    kind: { type: "hosted_project", project_id: project.id },
    order,
    visibility: "shown",
    title: project.name,
    purpose: "",
    contribution: "",
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

function defaultContext(project: PortfolioDraft["projects"][number], bundle: ProjectBundle): PreviewContext | null {
  if (!bundle.report) return null;
  return {
    project_reference_id: project.project_reference_id,
    project_id: bundle.summary.id,
    configuration_revision_id: bundle.report.configuration_revision_id,
    source_revision_id: bundle.report.source_revision_id,
    compatibility_report_id: bundle.report.id,
    placeholder: "gradient_1",
    configuration_answers: [],
  };
}

function answerFor(context: PreviewContext | undefined, question: ConfigurationQuestion): ConfigurationAnswer | undefined {
  return context?.configuration_answers.find((answer) => answer.question_id === question.id);
}

function answerValue(answer: ConfigurationAnswer | undefined): string {
  if (!answer) return "unresolved";
  return answer.classification === "configuration_choice" ? answer.selected_option : answer.classification;
}

function statusCopy(report: CompatibilityReport | null): string {
  if (!report) return "Compatibility has not been checked for this exact source.";
  return report.headline;
}

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonRecord : null;
}

function servicesOf(spec: unknown): JsonRecord[] {
  const services = asRecord(spec)?.services;
  return Array.isArray(services) ? services.flatMap((service): JsonRecord[] => {
    const record = asRecord(service);
    return record ? [record] : [];
  }) : [];
}

async function listAllProjects(token: string): Promise<ProjectSummary[]> {
  const projects: ProjectSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.listProjects(token, cursor);
    projects.push(...page.projects);
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return projects;
}

export function PreviewEditor({
  token,
  displayName,
  refreshKey,
  onSessionExpired,
}: {
  token: string;
  displayName: string;
  refreshKey: string;
  onSessionExpired: () => void;
}) {
  const [draft, setDraft] = useState<PortfolioDraft>(() => emptyDraft(displayName));
  const [preview, setPreview] = useState<PreviewRevision["preview"]>({
    layout: "layout_1",
    typography: "system_sans",
    accent: "coral",
    project_contexts: [],
  });
  const [baseRevision, setBaseRevision] = useState(0);
  const [baseEtag, setBaseEtag] = useState<string | null>(null);
  const [savedEditorState, setSavedEditorState] = useState<SavedEditorState | null>(null);
  const [projects, setProjects] = useState<ProjectBundle[]>([]);
  const [pickerProjectId, setPickerProjectId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [skillsText, setSkillsText] = useState("");
  const [configurationDrafts, setConfigurationDrafts] = useState<Record<string, JsonRecord>>({});
  const [configuringProject, setConfiguringProject] = useState<string | null>(null);
  const initialLoadComplete = useRef(false);
  const loadGeneration = useRef(0);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    setMessage(null);
    try {
      let latest: PreviewRevision | null = null;
      let etag: string | null = null;
      try {
        const response = await api.latestPreview(token);
        latest = response.payload;
        etag = response.etag;
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 404)) throw error;
      }

      const summaries = await listAllProjects(token);
      const contextByProject = new Map(
        (latest?.preview.project_contexts ?? []).map((context) => [context.project_id, context]),
      );
      const bundles = await Promise.all(summaries.map(async (summary): Promise<ProjectBundle> => {
        let graph: ProjectGraph | null = null;
        let source: GitHubSource | null = null;
        let report: CompatibilityReport | null = null;
        try { graph = await api.getProject(token, summary.id); } catch { /* unavailable projects remain listed safely */ }
        try { source = await api.getSource(token, summary.id); } catch { /* an unbound draft has no source */ }
        const context = contextByProject.get(summary.id);
        if (context) {
          try { report = await api.getCompatibility(token, summary.id, context.compatibility_report_id); } catch { /* stale context stays non-verified */ }
        } else if (source && graph) {
          try {
            report = await api.latestCompatibility(token, summary.id, source.source_revision.id, graph.configuration.id);
          } catch { /* a report can be created explicitly below */ }
        }
        return { summary, graph, source, report };
      }));

      if (generation !== loadGeneration.current) return;

      setProjects(bundles);
      setConfigurationDrafts(Object.fromEntries(bundles.flatMap((bundle): Array<[string, JsonRecord]> => {
        const spec = asRecord(bundle.graph?.configuration.spec);
        return spec ? [[bundle.summary.id, clone(spec)]] : [];
      })));
      setPickerProjectId(bundles.find((bundle) => bundle.report)?.summary.id ?? bundles[0]?.summary.id ?? "");
      if (latest) {
        setDraft(clone(latest.draft));
        setSkillsText(latest.draft.skills.join(", "));
        setPreview(clone(latest.preview));
        setBaseRevision(latest.revision);
        setBaseEtag(etag);
        setSavedEditorState({ id: latest.id, revision: latest.revision, draft: clone(latest.draft), preview: clone(latest.preview) });
      } else {
        setDraft(emptyDraft(displayName));
        setSkillsText("");
        setPreview({ layout: "layout_1", typography: "system_sans", accent: "coral", project_contexts: [] });
        setBaseRevision(0);
        setBaseEtag('"0"');
        setSavedEditorState(null);
      }
      setConflict(null);
      initialLoadComplete.current = true;
    } catch (error) {
      if (generation !== loadGeneration.current) return;
      if (error instanceof ApiError && error.status === 401) onSessionExpired();
      else setMessage(error instanceof Error ? error.message : "The private preview could not be loaded.");
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [displayName, onSessionExpired, token]);

  useEffect(() => {
    void load();
    return () => { loadGeneration.current += 1; };
  }, [load]);

  useEffect(() => {
    if (!initialLoadComplete.current || refreshKey === "signed-in") return;
    let active = true;
    void (async () => {
      try {
        const summaries = await listAllProjects(token);
        const bundles = await Promise.all(summaries.map(async (summary): Promise<ProjectBundle> => {
          let graph: ProjectGraph | null = null;
          let source: GitHubSource | null = null;
          let report: CompatibilityReport | null = null;
          try { graph = await api.getProject(token, summary.id); } catch { /* keep the safe summary */ }
          try { source = await api.getSource(token, summary.id); } catch { /* an unbound draft has no source */ }
          if (source && graph) {
            try { report = await api.latestCompatibility(token, summary.id, source.source_revision.id, graph.configuration.id); } catch { /* analysis remains explicit */ }
          }
          return { summary, graph, source, report };
        }));
        if (!active) return;
        setProjects(bundles);
        setConfigurationDrafts((current) => ({
          ...current,
          ...Object.fromEntries(bundles.flatMap((bundle): Array<[string, JsonRecord]> => {
            const spec = asRecord(bundle.graph?.configuration.spec);
            return spec && !current[bundle.summary.id] ? [[bundle.summary.id, clone(spec)]] : [];
          })),
        }));
        setPickerProjectId((current) => current || (bundles.find((bundle) => bundle.report)?.summary.id ?? bundles[0]?.summary.id ?? ""));
      } catch (error) {
        if (active) setMessage(error instanceof Error ? error.message : "Saved projects could not be refreshed.");
      }
    })();
    return () => { active = false; };
  }, [refreshKey, token]);

  const hostedProjects = useMemo(
    () => draft.projects.filter((project) => projectIdOf(project)).sort((a, b) => a.order - b.order),
    [draft.projects],
  );
  const selectedIds = new Set(hostedProjects.map((project) => projectIdOf(project)));
  const availableProjects = projects.filter((bundle) => !selectedIds.has(bundle.summary.id));
  const draftWithCurrentSkills = useMemo(() => ({
    ...draft,
    skills: skillsText.split(",").map((skill) => skill.trim()).filter(Boolean),
  }), [draft, skillsText]);
  const hasUnsavedChanges = savedEditorState === null
    ? JSON.stringify(draftWithCurrentSkills) !== JSON.stringify(emptyDraft(displayName))
      || JSON.stringify(preview) !== JSON.stringify({ layout: "layout_1", typography: "system_sans", accent: "coral", project_contexts: [] })
    : JSON.stringify(draftWithCurrentSkills) !== JSON.stringify(savedEditorState.draft)
      || JSON.stringify(preview) !== JSON.stringify(savedEditorState.preview);

  function updateProfile(field: keyof PortfolioDraft["profile"], value: string) {
    setDraft((current) => ({ ...current, profile: { ...current.profile, [field]: value } }));
  }

  function updatePrimaryContact(field: "kind" | "label" | "url", value: string) {
    setDraft((current) => {
      const contacts = [...current.contacts];
      const first = contacts[0] ?? { id: "contact-primary", kind: "website", label: "", url: "" };
      contacts[0] = { ...first, [field]: value };
      return { ...current, contacts };
    });
  }

  function addProject() {
    const bundle = projects.find((item) => item.summary.id === pickerProjectId);
    if (!bundle) return;
    if (!bundle.report) {
      setMessage("Run compatibility for this exact source before adding it to the private preview.");
      return;
    }
    const project = defaultPortfolioProject(bundle.summary, draft.projects.length);
    const context = defaultContext(project, bundle);
    setDraft((current) => ({ ...current, projects: [...current.projects, project] }));
    if (context) setPreview((current) => ({ ...current, project_contexts: [...current.project_contexts, context] }));
    const next = availableProjects.find((item) => item.summary.id !== pickerProjectId);
    setPickerProjectId(next?.summary.id ?? "");
  }

  function updateProject(referenceId: string, field: "title" | "purpose" | "contribution" | "visibility", value: string) {
    setDraft((current) => ({
      ...current,
      projects: current.projects.map((project) => project.project_reference_id === referenceId
        ? { ...project, [field]: value }
        : project),
    }));
  }

  function updateDisplayedStatus(referenceId: string, field: DisplayedStatusField, shown: boolean) {
    setDraft((current) => ({
      ...current,
      projects: current.projects.map((project) => project.project_reference_id !== referenceId ? project : {
        ...project,
        displayed_status: { ...(asRecord(project.displayed_status) ?? {}), [field]: shown },
      }),
    }));
  }

  function updateDecision(referenceId: string, decisionId: string, field: "summary" | "rationale", value: string) {
    setDraft((current) => ({ ...current, projects: current.projects.map((project) =>
      project.project_reference_id !== referenceId ? project : {
        ...project,
        technical_decisions: project.technical_decisions.map((decision) =>
          decision.id === decisionId ? { ...decision, [field]: value } : decision),
      }),
    }));
  }

  function addDecision(referenceId: string) {
    setDraft((current) => ({ ...current, projects: current.projects.map((project) =>
      project.project_reference_id !== referenceId ? project : {
        ...project,
        technical_decisions: [...project.technical_decisions, {
          id: `decision-${crypto.randomUUID()}`,
          summary: "",
          rationale: "",
        }],
      }),
    }));
  }

  function removeDecision(referenceId: string, decisionId: string) {
    setDraft((current) => ({ ...current, projects: current.projects.map((project) =>
      project.project_reference_id !== referenceId ? project : {
        ...project,
        technical_decisions: project.technical_decisions.filter((decision) => decision.id !== decisionId),
      }),
    }));
  }

  function removeEvidence(referenceId: string, evidenceId: string) {
    setDraft((current) => ({ ...current, projects: current.projects.map((project) =>
      project.project_reference_id !== referenceId ? project : {
        ...project,
        evidence: Array.isArray(project.evidence)
          ? project.evidence.filter((item) => asRecord(item)?.id !== evidenceId)
          : [],
      },
    ) }));
  }

  function moveProject(referenceId: string, direction: -1 | 1) {
    setDraft((current) => {
      const ordered = [...current.projects].sort((a, b) => a.order - b.order);
      const index = ordered.findIndex((project) => project.project_reference_id === referenceId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= ordered.length) return current;
      [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
      return { ...current, projects: ordered.map((project, order) => ({ ...project, order })) };
    });
  }

  function updatePlaceholder(referenceId: string, placeholder: PreviewContext["placeholder"]) {
    setPreview((current) => ({
      ...current,
      project_contexts: current.project_contexts.map((context) =>
        context.project_reference_id === referenceId ? { ...context, placeholder } : context),
    }));
  }

  function updateQuestion(referenceId: string, question: ConfigurationQuestion, value: string) {
    setPreview((current) => ({
      ...current,
      project_contexts: current.project_contexts.map((context) => {
        if (context.project_reference_id !== referenceId) return context;
        let answer: ConfigurationAnswer;
        if (value === "unresolved") {
          answer = { answer_version: answerVersion, question_id: question.id, classification: "unresolved" };
        } else if (value === "secret_required") {
          answer = { answer_version: answerVersion, question_id: question.id, classification: "secret_required" };
        } else if (value === "public_build_value") {
          answer = { answer_version: answerVersion, question_id: question.id, classification: "public_build_value", value: "" };
        } else {
          answer = { answer_version: answerVersion, question_id: question.id, classification: "configuration_choice", selected_option: value };
        }
        return {
          ...context,
          configuration_answers: [
            ...context.configuration_answers.filter((item) => item.question_id !== question.id),
            answer,
          ],
        };
      }),
    }));
  }

  function updatePublicValue(referenceId: string, questionId: string, value: string) {
    setPreview((current) => ({
      ...current,
      project_contexts: current.project_contexts.map((context) => context.project_reference_id !== referenceId
        ? context
        : {
            ...context,
            configuration_answers: context.configuration_answers.map((answer) =>
              answer.question_id === questionId && answer.classification === "public_build_value"
                ? { ...answer, value }
                : answer),
          }),
    }));
  }

  function updateConfigurationService(projectId: string, index: number, field: string, value: unknown) {
    setConfigurationDrafts((current) => {
      const spec = clone(current[projectId] ?? {});
      const services = servicesOf(spec).map((service) => ({ ...service }));
      if (!services[index]) return current;
      if (field === "node_major") {
        services[index].node = { major: value };
      } else if (field === "health_path") {
        services[index].health_check = { protocol: "http", path: value };
      } else {
        services[index][field] = value;
      }
      spec.services = services;
      return { ...current, [projectId]: spec };
    });
  }

  function updateLockfile(projectId: string, value: string) {
    setConfigurationDrafts((current) => {
      const spec = clone(current[projectId] ?? {});
      const repositories = Array.isArray(spec.repositories)
        ? spec.repositories.flatMap((repository): JsonRecord[] => {
            const record = asRecord(repository);
            return record ? [record] : [];
          }).map((repository) => ({ ...repository }))
        : [];
      if (repositories[0]) repositories[0].lockfile_path = value;
      spec.repositories = repositories;
      return { ...current, [projectId]: spec };
    });
  }

  function toggleDatabase(projectId: string, enabled: boolean) {
    setConfigurationDrafts((current) => {
      const spec = clone(current[projectId] ?? {});
      let services = servicesOf(spec).map((service) => ({ ...service }));
      services = services.filter((service) => service.kind !== "postgres");
      services = services.map((service) => service.kind === "application" ? { ...service, uses_durable_data: enabled } : service);
      if (enabled) services.push({
        name: "database", kind: "postgres", root: null, framework: "postgresql18", node: null,
        build_command: null, output_directory: null, start_command: null, health_check: null,
        uses_durable_data: false,
      });
      spec.services = services;
      return { ...current, [projectId]: spec };
    });
  }

  async function saveConfiguration(bundle: ProjectBundle) {
    if (!bundle.graph || !bundle.source || !configurationDrafts[bundle.summary.id]) return;
    setConfiguringProject(bundle.summary.id);
    setMessage(null);
    try {
      const graph = await api.createConfiguration(
        token,
        bundle.summary.id,
        bundle.graph.project.revision,
        configurationDrafts[bundle.summary.id],
        idempotencyKey("web-configuration"),
      );
      const source = await api.resolveSource(
        token,
        bundle.summary.id,
        bundle.source.revision,
        idempotencyKey("web-source-resolve"),
      );
      const report = await api.createCompatibility(
        token,
        bundle.summary.id,
        graph.project.revision,
        source.source_revision.id,
        graph.configuration.id,
        idempotencyKey("web-compatibility"),
      );
      setProjects((current) => current.map((item) => item.summary.id === bundle.summary.id
        ? { ...item, summary: { ...item.summary, revision: graph.project.revision, current_configuration_revision_id: graph.configuration.id }, graph, source, report }
        : item));
      setPreview((current) => ({
        ...current,
        project_contexts: current.project_contexts.map((context) => context.project_id === bundle.summary.id
          ? {
              ...context,
              configuration_revision_id: report.configuration_revision_id,
              source_revision_id: report.source_revision_id,
              compatibility_report_id: report.id,
              configuration_answers: [],
            }
          : context),
      }));
      setMessage(`${report.headline}. The updated configuration was saved, the source was resolved again, and compatibility was rerun.`);
    } catch (error) {
      let refreshSucceeded = false;
      try {
        const [graph, source] = await Promise.all([
          api.getProject(token, bundle.summary.id),
          api.getSource(token, bundle.summary.id),
        ]);
        setProjects((current) => current.map((item) => item.summary.id === bundle.summary.id
          ? {
              ...item,
              summary: { ...item.summary, revision: graph.project.revision, current_configuration_revision_id: graph.configuration.id },
              graph,
              source,
            }
          : item));
        refreshSucceeded = true;
      } catch { /* the original safe error remains the useful result */ }
      const failure = error instanceof Error ? error.message : "The project configuration could not be updated.";
      setMessage(refreshSucceeded
        ? `${failure} Current project state was refreshed so you can retry.`
        : `${failure} Reload the page before retrying so Hostlet can use the latest project state.`);
    } finally {
      setConfiguringProject(null);
    }
  }

  async function runCompatibility(bundle: ProjectBundle) {
    if (!bundle.graph || !bundle.source) return;
    setMessage(null);
    try {
      const report = await api.createCompatibility(
        token,
        bundle.summary.id,
        bundle.graph.project.revision,
        bundle.source.source_revision.id,
        bundle.graph.configuration.id,
        idempotencyKey("web-compatibility"),
      );
      setProjects((current) => current.map((item) => item.summary.id === bundle.summary.id ? { ...item, report } : item));
      setMessage(report.headline);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Compatibility could not be checked.");
    }
  }

  async function save() {
    setSaving(true);
    setMessage(null);
    setConflict(null);
    try {
      const draftToSave = { ...draft, skills: skillsText.split(",").map((skill) => skill.trim()).filter(Boolean) };
      const response = await api.savePreview(token, baseEtag ?? `"${baseRevision}"`, { draft: draftToSave, preview }, idempotencyKey("web-preview"));
      setDraft(clone(response.payload.draft));
      setSkillsText(response.payload.draft.skills.join(", "));
      setPreview(clone(response.payload.preview));
      setBaseRevision(response.payload.revision);
      setBaseEtag(response.etag);
      setSavedEditorState({
        id: response.payload.id,
        revision: response.payload.revision,
        draft: clone(response.payload.draft),
        preview: clone(response.payload.preview),
      });
      setMessage("Private preview saved.");
    } catch (error) {
      if (error instanceof ApiError && error.status === 412) {
        try {
          const latest = await api.latestPreview(token);
          setConflict({ latest: latest.payload, etag: latest.etag });
        } catch {
          setMessage("The saved preview changed. Reload this page before trying again.");
        }
      } else if (error instanceof ApiError && error.status === 401) {
        onSessionExpired();
      } else {
        setMessage(error instanceof Error ? error.message : "The private preview could not be saved.");
      }
    } finally {
      setSaving(false);
    }
  }

  function acceptLatest() {
    if (!conflict) return;
    setDraft(clone(conflict.latest.draft));
    setSkillsText(conflict.latest.draft.skills.join(", "));
    setPreview(clone(conflict.latest.preview));
    setBaseRevision(conflict.latest.revision);
    setBaseEtag(conflict.etag);
    setSavedEditorState({ id: conflict.latest.id, revision: conflict.latest.revision, draft: clone(conflict.latest.draft), preview: clone(conflict.latest.preview) });
    setConflict(null);
  }

  function reapplyUnsaved() {
    if (!conflict) return;
    setBaseRevision(conflict.latest.revision);
    setBaseEtag(conflict.etag);
    setSavedEditorState({ id: conflict.latest.id, revision: conflict.latest.revision, draft: clone(conflict.latest.draft), preview: clone(conflict.latest.preview) });
    setConflict(null);
    setMessage("Your unsaved values are still in the editor. Review them, then save to apply them over the latest revision.");
  }

  if (loading) return <section className="preview-editor preview-editor--loading" aria-busy="true"><p>Loading your private preview…</p></section>;

  return (
    <section className={`preview-editor preview-editor--${preview.accent} preview-editor--${preview.typography}`} data-testid="preview-editor" aria-labelledby="preview-title">
      <div className="preview-editor__heading">
        <div><p className="eyebrow">Private portfolio preview</p><h2 id="preview-title">Write the story behind your work.</h2><p>Only content you type here becomes part of this private draft. Repository access does not approve source text, links, screenshots, or claims for publication.</p></div>
        <button type="button" className="primary-button" data-testid="preview-save" onClick={() => void save()} disabled={saving || configuringProject !== null}>{saving ? "Saving…" : "Save private preview"}</button>
      </div>
      {message && <p className="notice" role="status" data-testid="preview-editor-notice">{message}</p>}
      {conflict && (
        <aside className="preview-conflict" data-testid="preview-conflict">
          <h3>A newer saved version exists</h3>
          <p>The latest saved introduction is: “{conflict.latest.draft.profile.introduction}”</p>
          <p>Your unsaved values remain in the editor. Choose which version to continue from.</p>
          <div><button type="button" onClick={acceptLatest}>Reload saved version</button><button type="button" onClick={reapplyUnsaved}>Keep and reapply my edits</button></div>
        </aside>
      )}
      <p className="deployment-notice" data-testid="preview-deployment-notice">Compatibility is advisory; deployment not yet verified. This preview creates no live demo or hosted slot.</p>

      <fieldset className="preview-editor__fields" disabled={saving || configuringProject !== null}>
      <div className="appearance-controls">
        <label>Layout<select data-testid="preview-layout" value={preview.layout} onChange={() => undefined}><option value="layout_1">Project spotlight</option></select></label>
        <label>Typography<select data-testid="preview-typography" value={preview.typography} onChange={(event) => setPreview((current) => ({ ...current, typography: event.target.value as PreviewRevision["preview"]["typography"] }))}><option value="system_sans">System sans</option><option value="editorial_serif">Editorial serif</option></select></label>
        <label>Accent<select data-testid="preview-accent" value={preview.accent} onChange={(event) => setPreview((current) => ({ ...current, accent: event.target.value as PreviewRevision["preview"]["accent"] }))}><option value="coral">Coral</option><option value="indigo">Indigo</option><option value="forest">Forest</option></select></label>
        <label>Skills section<select data-testid="preview-section-skills" value={draft.section_visibility.skills ?? "shown"} onChange={(event) => setDraft((current) => ({ ...current, section_visibility: { ...current.section_visibility, skills: event.target.value as "shown" | "hidden" } }))}><option value="shown">Shown</option><option value="hidden">Hidden</option></select></label>
      </div>

      <div className="profile-fields">
        <label>Display name<input name="profile.display_name" value={draft.profile.display_name} onChange={(event) => updateProfile("display_name", event.target.value)} maxLength={120} /></label>
        <label>Headline<input name="profile.headline" value={draft.profile.headline ?? ""} onChange={(event) => setDraft((current) => ({ ...current, profile: { ...current.profile, headline: event.target.value || null } }))} maxLength={160} /></label>
        <label className="profile-fields__wide">Introduction<textarea name="profile.introduction" value={draft.profile.introduction} onChange={(event) => updateProfile("introduction", event.target.value)} maxLength={4000} rows={4} required /></label>
        <label>Target role<input name="profile.target_role" value={draft.profile.target_role} onChange={(event) => updateProfile("target_role", event.target.value)} maxLength={240} required /></label>
        <label>Skills, separated by commas<input value={skillsText} onChange={(event) => setSkillsText(event.target.value)} onBlur={() => setDraft((current) => ({ ...current, skills: skillsText.split(",").map((skill) => skill.trim()).filter(Boolean) }))} /></label>
        <label>Résumé label<input value={draft.resume?.label ?? ""} onChange={(event) => setDraft((current) => ({ ...current, resume: event.target.value || current.resume?.url ? { id: current.resume?.id ?? "resume-main", label: event.target.value, url: current.resume?.url ?? "" } : null }))} /></label>
        <label>Résumé URL<input type="url" value={draft.resume?.url ?? ""} onChange={(event) => setDraft((current) => ({ ...current, resume: event.target.value || current.resume?.label ? { id: current.resume?.id ?? "resume-main", label: current.resume?.label ?? "Resume", url: event.target.value } : null }))} /></label>
        <label>Primary contact type<select value={draft.contacts[0]?.kind ?? "website"} onChange={(event) => updatePrimaryContact("kind", event.target.value)}><option value="email">Email</option><option value="website">Website</option><option value="social">Professional profile</option><option value="other">Other</option></select></label>
        <label>Primary contact label<input value={draft.contacts[0]?.label ?? ""} onChange={(event) => updatePrimaryContact("label", event.target.value)} maxLength={80} /></label>
        <label>Primary contact URL<input value={draft.contacts[0]?.url ?? ""} onChange={(event) => updatePrimaryContact("url", event.target.value)} placeholder={draft.contacts[0]?.kind === "email" ? "mailto:name@example.com" : "https://…"} /></label>
      </div>

      <details className="section-controls">
        <summary>Section visibility</summary>
        <div>{(["headline", "introduction", "target_role", "resume", "contacts", "projects"] as const).map((section) => <label key={section}>{section.replace("_", " ")}<select data-testid={`preview-section-${section}`} value={draft.section_visibility[section] ?? "shown"} onChange={(event) => setDraft((current) => ({ ...current, section_visibility: { ...current.section_visibility, [section]: event.target.value as "shown" | "hidden" } }))}><option value="shown">Shown</option><option value="hidden">Hidden</option></select></label>)}</div>
      </details>

      <div className="project-picker">
        <label>Add a saved project<select data-testid="preview-project-picker" value={pickerProjectId} onChange={(event) => setPickerProjectId(event.target.value)}><option value="">Choose a project</option>{availableProjects.map((bundle) => <option key={bundle.summary.id} value={bundle.summary.id}>{bundle.summary.name}{bundle.report ? ` · ${bundle.report.headline}` : " · check needed"}</option>)}</select></label>
        {(() => {
          const selected = projects.find((bundle) => bundle.summary.id === pickerProjectId);
          return selected && !selected.report && selected.source && selected.graph
            ? <button type="button" onClick={() => void runCompatibility(selected)}>Check compatibility</button>
            : null;
        })()}
        <button type="button" data-testid="preview-add-project" onClick={addProject} disabled={!pickerProjectId}>Add project</button>
      </div>

      <div className="preview-projects">
        {hostedProjects.map((project, index) => {
          const projectId = projectIdOf(project)!;
          const bundle = projects.find((item) => item.summary.id === projectId);
          const context = preview.project_contexts.find((item) => item.project_reference_id === project.project_reference_id);
          const report = context
            ? bundle?.report && bundle.report.id === context.compatibility_report_id ? bundle.report : null
            : bundle?.report ?? null;
          const configuration = configurationDrafts[projectId];
          const configurationServices = servicesOf(configuration);
          const repositoryConfiguration = Array.isArray(configuration?.repositories)
            ? asRecord(configuration!.repositories[0])
            : null;
          const displayedStatus = asRecord(project.displayed_status) ?? {};
          return (
            <article className="preview-project" data-testid="preview-project-editor" data-project-id={projectId} key={project.project_reference_id}>
              <div className={`placeholder-art placeholder-art--${context?.placeholder ?? "gradient_1"}`} aria-label="Decorative placeholder artwork"><span>Placeholder artwork</span></div>
              <div className="preview-project__body">
                <div className="preview-project__topline"><strong>{bundle?.summary.name ?? project.title}</strong><div><button type="button" data-testid="preview-move-up" onClick={() => moveProject(project.project_reference_id, -1)} disabled={index === 0}>Move up</button><button type="button" onClick={() => moveProject(project.project_reference_id, 1)} disabled={index === hostedProjects.length - 1}>Move down</button></div></div>
                <p className={`compatibility compatibility--${report?.status ?? "unknown"}`} data-testid="preview-compatibility">{statusCopy(report)}{report?.status === "showcase_only" ? " This project can remain a private showcase without live-demo claims." : ""}</p>
                {bundle?.source && (!context || bundle.source.source_revision.id === context.source_revision_id)
                  ? <p className="source-fact">Saved source: {bundle.source.ref.replace("refs/heads/", "")} · <code>{bundle.source.source_revision.resolved_commit.slice(0, 12)}</code></p>
                  : context ? <p className="source-fact">This preview retains its earlier exact source. Resolve and check again before replacing it.</p> : null}
                {!report && bundle?.source && bundle.graph && <button type="button" onClick={() => void runCompatibility(bundle)}>Run compatibility check</button>}
                <div className="project-fields">
                  <label>Project title<input data-field="title" value={project.title} onChange={(event) => updateProject(project.project_reference_id, "title", event.target.value)} maxLength={240} /></label>
                  <label>Visibility<select value={project.visibility} onChange={(event) => updateProject(project.project_reference_id, "visibility", event.target.value)}><option value="shown">Shown</option><option value="hidden">Hidden</option></select></label>
                  <label className="project-fields__wide">Purpose<textarea data-field="purpose" value={project.purpose} onChange={(event) => updateProject(project.project_reference_id, "purpose", event.target.value)} rows={3} maxLength={2000} /></label>
                  <label className="project-fields__wide">Your contribution<textarea data-field="contribution" value={project.contribution} onChange={(event) => updateProject(project.project_reference_id, "contribution", event.target.value)} rows={3} maxLength={2000} /></label>
                  <div className="project-fields__wide decision-fields">
                    <span>Technical decisions</span>
                    {project.technical_decisions.map((decision) => <div key={decision.id}><label>Decision<input value={decision.summary} onChange={(event) => updateDecision(project.project_reference_id, decision.id, "summary", event.target.value)} maxLength={240} /></label><label>Why you chose it<input value={decision.rationale} onChange={(event) => updateDecision(project.project_reference_id, decision.id, "rationale", event.target.value)} maxLength={1000} /></label><button type="button" onClick={() => removeDecision(project.project_reference_id, decision.id)}>Remove</button></div>)}
                    <button type="button" onClick={() => addDecision(project.project_reference_id)}>Add technical decision</button>
                  </div>
                  {context && <label>Artwork placeholder<select data-testid="preview-placeholder" value={context.placeholder} onChange={(event) => updatePlaceholder(project.project_reference_id, event.target.value as PreviewContext["placeholder"])}><option value="gradient_1">Soft gradient</option><option value="grid_1">Structured grid</option><option value="terminal_1">Terminal motif</option></select></label>}
                  <fieldset className="project-fields__wide public-status-fields" data-testid="preview-public-status">
                    <legend>Public deployment status</legend>
                    <p>Each selected value is resolved from the current trusted release and still requires owner review. Source commit is private unless you explicitly select it.</p>
                    {([[
                      "deployment_timestamp", "Deployment time"],
                      ["availability", "Availability"],
                      ["release_identifier", "Release identifier"],
                      ["source_commit", "Source commit"],
                      ["demo_readiness", "Demo readiness"],
                    ] as Array<[DisplayedStatusField, string]>).map(([field, label]) => (
                      <label key={field}><input type="checkbox" data-testid={`preview-status-${field}`} checked={displayedStatus[field] === true} onChange={(event) => updateDisplayedStatus(project.project_reference_id, field, event.target.checked)} />{label}</label>
                    ))}
                  </fieldset>
                  {Array.isArray(project.evidence) && project.evidence.length > 0 && <fieldset className="project-fields__wide public-evidence-fields" data-testid="preview-public-evidence">
                    <legend>Public evidence</legend>
                    <p>Only evidence retained here can be reviewed for publication.</p>
                    {project.evidence.map((item) => {
                      const evidence = asRecord(item);
                      const id = typeof evidence?.id === "string" ? evidence.id : "";
                      return id ? <div key={id}><span>{typeof evidence?.title === "string" ? evidence.title : id}</span><button type="button" data-testid="preview-remove-evidence" data-evidence-id={id} onClick={() => removeEvidence(project.project_reference_id, id)}>Remove</button></div> : null;
                    })}
                  </fieldset>}
                </div>
                {report?.facts.reasons.length ? <ul className="compatibility-reasons">{report.facts.reasons.map((reason) => <li key={reason.code}>{reason.message}</li>)}</ul> : null}
                {context && report?.facts.configuration_questions.map((question) => {
                  const answer = answerFor(context, question);
                  const value = answerValue(answer);
                  const options = question.classification === "configuration_choice"
                    ? question.allowed_options ?? []
                    : question.classification === "public_build_value"
                      ? ["public_build_value"]
                      : ["secret_required"];
                  return (
                    <div className="configuration-question" key={question.id}>
                      <label>{question.prompt}<select data-testid="preview-question-answer" data-question-id={question.id} value={value} onChange={(event) => updateQuestion(project.project_reference_id, question, event.target.value)}><option value="unresolved">Decide later</option>{options.map((option) => <option value={option} key={option}>{option === "secret_required" ? "Secret required later (value not entered here)" : option === "public_build_value" ? "Set a public build value" : option}</option>)}</select></label>
                      {answer?.classification === "public_build_value" && <label>Public build value<input value={answer.value} onChange={(event) => updatePublicValue(project.project_reference_id, question.id, event.target.value)} /><small>This value may be included in a public browser build. Never enter a secret.</small></label>}
                      {answer?.classification === "secret_required" && <p>No secret value is collected in the portfolio editor.</p>}
                    </div>
                  );
                })}
                {bundle?.graph && bundle.source && configuration && (
                  <details className="configuration-editor" data-testid="preview-configuration">
                    <summary>Adjust detected project configuration</summary>
                    <p>Changing these settings creates a new saved configuration, resolves the selected branch again, and reruns compatibility. Answers above record planning choices only.</p>
                    <label>Lockfile path<input data-testid="preview-config-lockfile" value={String(repositoryConfiguration?.lockfile_path ?? "package-lock.json")} onChange={(event) => updateLockfile(projectId, event.target.value)} /></label>
                    {configurationServices.map((service, serviceIndex) => service.kind === "postgres" ? null : (
                      <fieldset key={`${String(service.kind)}-${serviceIndex}`}>
                        <legend>{service.kind === "static_frontend" ? "Static site" : "Application"}</legend>
                        <div>
                          <label>Framework<select data-testid="preview-config-framework" data-service-kind={String(service.kind)} value={String(service.framework ?? "")} onChange={(event) => updateConfigurationService(projectId, serviceIndex, "framework", event.target.value)}>{service.kind === "static_frontend" ? <><option value="vite_static">Vite static</option><option value="static_export">Static export</option></> : <><option value="node_http">Node HTTP</option><option value="nextjs16_standalone">Next.js 16 standalone</option></>}</select></label>
                          <label>Service root<input data-testid="preview-config-root" data-service-kind={String(service.kind)} value={String(service.root ?? ".")} onChange={(event) => updateConfigurationService(projectId, serviceIndex, "root", event.target.value)} /></label>
                          <label>Node.js<select data-testid="preview-config-node" data-service-kind={String(service.kind)} value={String(asRecord(service.node)?.major ?? 24)} onChange={(event) => updateConfigurationService(projectId, serviceIndex, "node_major", Number(event.target.value))}><option value="24">24</option><option value="22">22</option></select></label>
                          <label>Build command<input data-testid="preview-config-build" data-service-kind={String(service.kind)} value={String(service.build_command ?? "")} onChange={(event) => updateConfigurationService(projectId, serviceIndex, "build_command", event.target.value || null)} /></label>
                          {service.kind === "application" && <><label>Start command<input data-testid="preview-config-start" value={String(service.start_command ?? "")} onChange={(event) => updateConfigurationService(projectId, serviceIndex, "start_command", event.target.value || null)} /></label><label>Health path<input data-testid="preview-config-health" value={String(asRecord(service.health_check)?.path ?? "/healthz")} onChange={(event) => updateConfigurationService(projectId, serviceIndex, "health_path", event.target.value)} /></label></>}
                          {service.kind === "static_frontend" && <label>Output directory<input value={String(service.output_directory ?? "dist")} onChange={(event) => updateConfigurationService(projectId, serviceIndex, "output_directory", event.target.value || null)} /></label>}
                        </div>
                      </fieldset>
                    ))}
                    {configurationServices.some((service) => service.kind === "application") && <label className="check-row"><input type="checkbox" data-testid="preview-config-postgres" checked={configurationServices.some((service) => service.kind === "postgres")} onChange={(event) => toggleDatabase(projectId, event.target.checked)} />This project needs PostgreSQL</label>}
                    <button type="button" data-testid="preview-config-save" onClick={() => void saveConfiguration(bundle)} disabled={configuringProject === projectId}>{configuringProject === projectId ? "Updating configuration…" : "Save configuration and check again"}</button>
                  </details>
                )}
              </div>
            </article>
          );
        })}
      </div>

      </fieldset>

      <PreviewCanvas draft={draft} preview={preview} />

      <PublicationPanel
        token={token}
        savedRevisionId={savedEditorState?.id ?? null}
        savedRevision={savedEditorState?.revision ?? 0}
        hasUnsavedChanges={hasUnsavedChanges}
        editorBusy={saving || configuringProject !== null}
        onSessionExpired={onSessionExpired}
      />

      {draft.projects.some((project) => project.kind.type !== "hosted_project") && <p className="retained-content">Existing external case studies remain in this draft and will be preserved when you save.</p>}
      <small className="revision-note">Editing revision {baseRevision} {baseEtag ? `(${baseEtag})` : ""}</small>
    </section>
  );
}
