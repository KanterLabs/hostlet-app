import type { PortfolioDraft, PreviewAppearance, PreviewContext } from "./api";
import "./preview-canvas.css";

export type PreviewCanvasProps = {
  draft: PortfolioDraft;
  preview: PreviewAppearance & { project_contexts?: PreviewContext[] };
};

type ProjectLink = {
  kind?: string;
  link?: { id?: string; label?: string; url?: string };
};

type ProjectEvidence = {
  id?: string;
  title?: string;
  url?: string;
  caption?: string | null;
};

function visible(draft: PortfolioDraft, section: string): boolean {
  return draft.section_visibility[section] !== "hidden";
}

function safeHref(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value.trim());
    if (url.username || url.password) return null;
    return url.protocol === "https:" || url.protocol === "mailto:" ? url.href : null;
  } catch {
    return null;
  }
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "\u2014";
  return `${parts[0]?.[0] ?? ""}${parts.length > 1 ? parts.at(-1)?.[0] ?? "" : ""}`.toUpperCase();
}

function Placeholder({ variant }: { variant: PreviewContext["placeholder"] }) {
  return (
    <div className={`portfolio-preview__visual portfolio-preview__visual--${variant}`} aria-label="Project visual placeholder">
      {variant === "terminal_1" ? (
        <div className="portfolio-preview__terminal" aria-hidden="true">
          <span>$ open project</span>
          <span className="portfolio-preview__terminal-line" />
          <span className="portfolio-preview__terminal-line portfolio-preview__terminal-line--short" />
        </div>
      ) : (
        <div className="portfolio-preview__visual-mark" aria-hidden="true"><span>H</span></div>
      )}
      <span className="portfolio-preview__placeholder-label">Visual placeholder</span>
    </div>
  );
}

function LinkList({ links }: { links: ProjectLink[] }) {
  const safeLinks = links.flatMap((item) => {
    const href = safeHref(item.link?.url);
    if (!href) return [];
    return [{ id: item.link?.id ?? href, label: item.link?.label?.trim() || "Project link", href }];
  });

  if (safeLinks.length === 0) return null;
  return (
    <div className="portfolio-preview__project-links" aria-label="Project links">
      {safeLinks.map((link) => (
        <a key={link.id} href={link.href} target="_blank" rel="noopener noreferrer">
          {link.label}<span aria-hidden="true"> ↗</span>
        </a>
      ))}
    </div>
  );
}

function EvidenceList({ evidence }: { evidence: ProjectEvidence[] }) {
  const items = evidence.flatMap((item) => {
    const href = safeHref(item.url);
    if (!href) return [];
    return [{ id: item.id ?? href, title: item.title?.trim() || "Supporting evidence", caption: item.caption?.trim(), href }];
  });

  if (items.length === 0) return null;
  return (
    <div className="portfolio-preview__evidence">
      <h4>Supporting evidence</h4>
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <a href={item.href} target="_blank" rel="noopener noreferrer">{item.title}<span aria-hidden="true"> ↗</span></a>
            {item.caption && <span>{item.caption}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PreviewCanvas({ draft, preview }: PreviewCanvasProps) {
  const displayName = draft.profile.display_name.trim();
  const headline = draft.profile.headline?.trim() ?? "";
  const contexts = new Map((preview.project_contexts ?? []).map((context) => [context.project_reference_id, context]));
  const projects = visible(draft, "projects")
    ? [...draft.projects].filter((project) => project.visibility === "shown").sort((left, right) => left.order - right.order)
    : [];
  const resumeHref = visible(draft, "resume") ? safeHref(draft.resume?.url) : null;
  const contacts = visible(draft, "contacts")
    ? draft.contacts.flatMap((contact) => {
      const href = safeHref(contact.url);
      return href ? [{ ...contact, href }] : [];
    })
    : [];

  return (
    <section
      className={`portfolio-preview portfolio-preview--${preview.typography} portfolio-preview--${preview.accent}`}
      data-testid="preview-canvas"
      aria-label="Private portfolio preview"
    >
      <div className="portfolio-preview__toolbar">
        <span className="portfolio-preview__privacy"><span aria-hidden="true">●</span> Private preview</span>
        <span>Deployment not verified</span>
      </div>

      <article className="portfolio-preview__page">
        <header className="portfolio-preview__hero">
          <div className="portfolio-preview__monogram" aria-hidden="true">{initials(displayName)}</div>
          <div className="portfolio-preview__identity">
            {visible(draft, "target_role") && (
              <p className="portfolio-preview__role">{draft.profile.target_role.trim() || "Your target role"}</p>
            )}
            <h1>{displayName || "Your name"}</h1>
            {visible(draft, "headline") && (
              <p className={`portfolio-preview__headline${headline ? "" : " portfolio-preview__empty"}`}>
                {headline || "Your headline will appear here."}
              </p>
            )}
          </div>
        </header>

        <div className="portfolio-preview__intro-row">
          {visible(draft, "introduction") && (
            <p className={`portfolio-preview__introduction${draft.profile.introduction.trim() ? "" : " portfolio-preview__empty"}`}>
              {draft.profile.introduction.trim() || "Add a short introduction to your portfolio."}
            </p>
          )}
          {(resumeHref || contacts.length > 0) && (
            <nav className="portfolio-preview__primary-links" aria-label="Portfolio links">
              {resumeHref && draft.resume && (
                <a href={resumeHref} target="_blank" rel="noopener noreferrer">
                  {draft.resume.label.trim() || "Résumé"}<span aria-hidden="true"> ↗</span>
                </a>
              )}
              {contacts.map((contact) => (
                <a key={contact.id} href={contact.href} target="_blank" rel="noopener noreferrer">
                  {contact.label.trim() || "Contact"}<span aria-hidden="true"> ↗</span>
                </a>
              ))}
            </nav>
          )}
        </div>

        {visible(draft, "skills") && draft.skills.length > 0 && (
          <section className="portfolio-preview__skills" aria-labelledby="preview-skills-title">
            <h2 id="preview-skills-title">Tools &amp; skills</h2>
            <ul>{draft.skills.map((skill, index) => <li key={`${skill}-${index}`}>{skill}</li>)}</ul>
          </section>
        )}

        {visible(draft, "projects") && (
          <section className="portfolio-preview__work" aria-labelledby="preview-work-title">
            <div className="portfolio-preview__section-heading">
              <p>Selected work</p>
              <h2 id="preview-work-title">Projects with a point of view.</h2>
            </div>

            {projects.length === 0 ? (
              <p className="portfolio-preview__empty portfolio-preview__empty-projects">Shown projects will appear here.</p>
            ) : (
              <div className="portfolio-preview__project-list">
                {projects.map((project, index) => {
                  const context = contexts.get(project.project_reference_id);
                  const links = Array.isArray(project.links) ? project.links as ProjectLink[] : [];
                  const evidence = Array.isArray(project.evidence) ? project.evidence as ProjectEvidence[] : [];
                  return (
                    <article className="portfolio-preview__project" key={project.project_reference_id}>
                      <Placeholder variant={context?.placeholder ?? "gradient_1"} />
                      <div className="portfolio-preview__project-copy">
                        <span className="portfolio-preview__project-number" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                        <h3>{project.title.trim() || "Untitled project"}</h3>
                        <p className="portfolio-preview__purpose">{project.purpose.trim() || "Add this project’s purpose."}</p>
                        {project.contribution.trim() && (
                          <div className="portfolio-preview__contribution">
                            <h4>My contribution</h4>
                            <p>{project.contribution}</p>
                          </div>
                        )}
                        {project.technical_decisions.length > 0 && (
                          <div className="portfolio-preview__decisions">
                            <h4>Technical decisions</h4>
                            <ul>
                              {project.technical_decisions.map((decision) => (
                                <li key={decision.id}>
                                  <strong>{decision.summary}</strong>
                                  {decision.rationale.trim() && <span>{decision.rationale}</span>}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        <LinkList links={links} />
                        <EvidenceList evidence={evidence} />
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        )}

        <footer className="portfolio-preview__footer">
          <span>{displayName || "Portfolio preview"}</span>
          <span>Private draft · deployment not verified</span>
        </footer>
      </article>
    </section>
  );
}
