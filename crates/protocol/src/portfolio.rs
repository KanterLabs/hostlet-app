//! Versioned portfolio content and publication-boundary contracts.
//!
//! `PortfolioDraft` is owner-authored input. Server-assigned ownership, revision,
//! approval, deployment-fact, and audit data use separate record types so an API
//! never has to trust client-supplied scope.

use std::collections::HashSet;
use std::fmt;

use serde::{Deserialize, Serialize};
use url::Url;

const MAX_ID_LEN: usize = 128;
const MAX_URL_LEN: usize = 2_048;
const MAX_DIGEST_LEN: usize = 71;
const MAX_TIMESTAMP_LEN: usize = 64;
const MAX_AUDIT_REASON_LEN: usize = 500;
const MAX_SKILLS: usize = 64;
const MAX_CONTACTS: usize = 16;
const MAX_PROJECTS: usize = 32;
const MAX_DECISIONS: usize = 16;
const MAX_LINKS: usize = 16;
const MAX_EVIDENCE: usize = 24;

/// The portfolio contract version represented by this module.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PortfolioContractVersion {
    V1,
}

/// Owner-authored content accepted by draft create and replace operations.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PortfolioDraft {
    pub contract_version: PortfolioContractVersion,
    pub profile: PortfolioProfile,
    pub skills: Vec<String>,
    pub resume: Option<PublicLink>,
    pub contacts: Vec<ContactLink>,
    pub projects: Vec<ProjectReference>,
    pub section_visibility: SectionVisibility,
}

impl PortfolioDraft {
    /// Validate bounded owner input before assigning ownership or persistence IDs.
    pub fn validate(&self) -> Result<(), ValidationErrors> {
        let mut errors = Vec::new();

        validate_text(
            &mut errors,
            "profile.display_name",
            &self.profile.display_name,
            1,
            120,
        );
        validate_optional_text(
            &mut errors,
            "profile.headline",
            self.profile.headline.as_deref(),
            160,
        );
        validate_text(
            &mut errors,
            "profile.introduction",
            &self.profile.introduction,
            1,
            4_000,
        );
        validate_text(
            &mut errors,
            "profile.target_role",
            &self.profile.target_role,
            1,
            240,
        );

        validate_count(&mut errors, "skills", self.skills.len(), MAX_SKILLS);
        for (index, skill) in self.skills.iter().enumerate() {
            validate_text(&mut errors, &format!("skills[{index}]"), skill, 1, 80);
        }

        if let Some(resume) = &self.resume {
            validate_link(&mut errors, "resume", resume, LinkScheme::Https);
        }

        validate_count(&mut errors, "contacts", self.contacts.len(), MAX_CONTACTS);
        let mut contact_ids = HashSet::new();
        for (index, contact) in self.contacts.iter().enumerate() {
            let path = format!("contacts[{index}]");
            validate_id(&mut errors, &format!("{path}.id"), &contact.id);
            validate_unique(
                &mut errors,
                &format!("{path}.id"),
                &contact.id,
                &mut contact_ids,
            );
            validate_text(&mut errors, &format!("{path}.label"), &contact.label, 1, 80);
            let scheme = match contact.kind {
                ContactKind::Email => LinkScheme::Mailto,
                ContactKind::Website | ContactKind::Social | ContactKind::Other => {
                    LinkScheme::Https
                }
            };
            validate_url(&mut errors, &format!("{path}.url"), &contact.url, scheme);
        }

        validate_count(&mut errors, "projects", self.projects.len(), MAX_PROJECTS);
        let mut project_reference_ids = HashSet::new();
        let mut project_orders = HashSet::new();
        for (index, project) in self.projects.iter().enumerate() {
            let path = format!("projects[{index}]");
            validate_project(
                &mut errors,
                &path,
                project,
                &mut project_reference_ids,
                &mut project_orders,
            );
        }
        for expected_order in 0..self.projects.len() {
            if !project_orders.contains(&(expected_order as u16)) {
                push_error(
                    &mut errors,
                    "projects",
                    "project_order_gap",
                    "project order values must be unique and contiguous from zero",
                );
                break;
            }
        }

        finish(errors)
    }

    /// Approval targets required to make every currently shown field public.
    ///
    /// Persistence code must derive this list from the stored snapshot. It must
    /// not accept a client-authored approval manifest as authoritative.
    pub fn required_approval_targets(&self) -> Vec<ApprovalTarget> {
        let mut targets = vec![ApprovalTarget::Narrative {
            field: NarrativeField::DisplayName,
            project_reference_id: None,
        }];

        if self.section_visibility.headline == Visibility::Shown && self.profile.headline.is_some()
        {
            targets.push(ApprovalTarget::Narrative {
                field: NarrativeField::Headline,
                project_reference_id: None,
            });
        }
        if self.section_visibility.introduction == Visibility::Shown {
            targets.push(ApprovalTarget::Narrative {
                field: NarrativeField::Introduction,
                project_reference_id: None,
            });
        }
        if self.section_visibility.target_role == Visibility::Shown {
            targets.push(ApprovalTarget::Narrative {
                field: NarrativeField::TargetRole,
                project_reference_id: None,
            });
        }
        if self.section_visibility.skills == Visibility::Shown && !self.skills.is_empty() {
            targets.push(ApprovalTarget::Narrative {
                field: NarrativeField::Skills,
                project_reference_id: None,
            });
        }
        if self.section_visibility.resume == Visibility::Shown {
            if let Some(resume) = &self.resume {
                targets.push(ApprovalTarget::Link {
                    link_id: resume.id.clone(),
                    project_reference_id: None,
                });
            }
        }
        if self.section_visibility.contacts == Visibility::Shown {
            targets.extend(self.contacts.iter().map(|contact| ApprovalTarget::Contact {
                contact_id: contact.id.clone(),
            }));
        }

        if self.section_visibility.projects == Visibility::Shown {
            for project in self
                .projects
                .iter()
                .filter(|project| project.visibility == Visibility::Shown)
            {
                let project_id = Some(project.project_reference_id.clone());
                targets.push(ApprovalTarget::Narrative {
                    field: NarrativeField::ProjectTitle,
                    project_reference_id: project_id.clone(),
                });
                targets.push(ApprovalTarget::Narrative {
                    field: NarrativeField::ProjectPurpose,
                    project_reference_id: project_id,
                });
                targets.push(ApprovalTarget::Contribution {
                    project_reference_id: project.project_reference_id.clone(),
                });
                targets.extend(project.technical_decisions.iter().map(|decision| {
                    ApprovalTarget::TechnicalDecision {
                        project_reference_id: project.project_reference_id.clone(),
                        decision_id: decision.id.clone(),
                    }
                }));
                targets.extend(project.links.iter().map(|link| ApprovalTarget::Link {
                    link_id: link.link.id.clone(),
                    project_reference_id: Some(project.project_reference_id.clone()),
                }));
                targets.extend(project.evidence.iter().map(|evidence| match evidence.kind {
                    EvidenceKind::Screenshot => ApprovalTarget::Screenshot {
                        project_reference_id: project.project_reference_id.clone(),
                        evidence_id: evidence.id.clone(),
                    },
                    EvidenceKind::Document | EvidenceKind::DemoRecording => ApprovalTarget::Link {
                        link_id: evidence.id.clone(),
                        project_reference_id: Some(project.project_reference_id.clone()),
                    },
                }));
                if project.displayed_status.deployment_timestamp {
                    targets.push(ApprovalTarget::Status {
                        project_reference_id: project.project_reference_id.clone(),
                        field: StatusField::DeploymentTimestamp,
                    });
                }
                if project.displayed_status.availability {
                    targets.push(ApprovalTarget::Status {
                        project_reference_id: project.project_reference_id.clone(),
                        field: StatusField::Availability,
                    });
                }
                if project.displayed_status.release_identifier {
                    targets.push(ApprovalTarget::Status {
                        project_reference_id: project.project_reference_id.clone(),
                        field: StatusField::ReleaseIdentifier,
                    });
                }
                if project.displayed_status.source_commit {
                    targets.push(ApprovalTarget::Status {
                        project_reference_id: project.project_reference_id.clone(),
                        field: StatusField::SourceCommit,
                    });
                }
                if project.displayed_status.demo_readiness {
                    targets.push(ApprovalTarget::Status {
                        project_reference_id: project.project_reference_id.clone(),
                        field: StatusField::DemoReadiness,
                    });
                }
            }
        }

        targets
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PortfolioProfile {
    pub display_name: String,
    pub headline: Option<String>,
    pub introduction: String,
    pub target_role: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SectionVisibility {
    pub headline: Visibility,
    pub introduction: Visibility,
    pub target_role: Visibility,
    pub skills: Visibility,
    pub resume: Visibility,
    pub contacts: Visibility,
    pub projects: Visibility,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Visibility {
    Shown,
    Hidden,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublicLink {
    pub id: String,
    pub label: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContactLink {
    pub id: String,
    pub kind: ContactKind,
    pub label: String,
    pub url: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContactKind {
    Email,
    Website,
    Social,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectReference {
    pub project_reference_id: String,
    pub kind: ProjectReferenceKind,
    pub order: u16,
    pub visibility: Visibility,
    pub title: String,
    pub purpose: String,
    pub contribution: String,
    pub technical_decisions: Vec<TechnicalDecision>,
    pub links: Vec<ProjectLink>,
    pub evidence: Vec<ProjectEvidence>,
    pub authorized_deployment_facts_id: Option<String>,
    pub displayed_status: DisplayedStatus,
    pub demo_readiness: DemoReadiness,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ProjectReferenceKind {
    HostedProject { project_id: String },
    ExternalCaseStudy { external_reference_id: String },
}

impl ProjectReferenceKind {
    /// Referencing an external case study never reserves hosted compute.
    pub const fn hosted_slots_consumed(&self) -> u16 {
        0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TechnicalDecision {
    pub id: String,
    pub summary: String,
    pub rationale: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectLink {
    pub kind: ProjectLinkKind,
    pub link: PublicLink,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectLinkKind {
    Source,
    Demo,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectEvidence {
    pub id: String,
    pub kind: EvidenceKind,
    pub title: String,
    pub url: String,
    pub caption: Option<String>,
    pub alt_text: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceKind {
    Screenshot,
    Document,
    DemoRecording,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DisplayedStatus {
    pub deployment_timestamp: bool,
    pub availability: bool,
    pub release_identifier: bool,
    pub source_commit: bool,
    pub demo_readiness: bool,
}

/// Readiness is an owner attestation for one release, independent of health.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
pub enum DemoReadiness {
    ReadyToShare {
        attestation: ReadinessAttestation,
    },
    NeedsRecheck {
        previous_attestation: Option<ReadinessAttestation>,
        reason: ReadinessRecheckReason,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadinessAttestation {
    pub release_id: String,
    pub checked_at: String,
    pub demo_page_verified: bool,
    pub synthetic_example_data_verified: bool,
    pub restricted_access_verified: bool,
    pub visitor_instructions_verified: bool,
    pub visitor_instructions: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadinessRecheckReason {
    NeverChecked,
    NewRelease,
    DemoAccessChanged,
    OwnerRequested,
}

/// Server-owned mutable draft state. `draft` remains the only owner content.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PortfolioDraftRecord {
    pub draft_id: String,
    pub owner_id: String,
    pub draft_version: u64,
    pub draft: PortfolioDraft,
    pub last_owner_edit_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl PortfolioDraftRecord {
    pub fn validate(&self) -> Result<(), ValidationErrors> {
        let mut errors = errors_from(self.draft.validate());
        validate_id(&mut errors, "draft_id", &self.draft_id);
        validate_id(&mut errors, "owner_id", &self.owner_id);
        if self.draft_version == 0 {
            push_error(
                &mut errors,
                "draft_version",
                "invalid_version",
                "draft version must be at least one",
            );
        }
        validate_optional_id(
            &mut errors,
            "last_owner_edit_id",
            self.last_owner_edit_id.as_deref(),
        );
        validate_timestamp(&mut errors, "created_at", &self.created_at);
        validate_timestamp(&mut errors, "updated_at", &self.updated_at);
        finish(errors)
    }
}

/// An append-only descriptor for an owner change to a persisted draft.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OwnerEditDescriptor {
    pub edit_id: String,
    pub draft_id: String,
    pub base_draft_version: u64,
    pub resulting_draft_version: u64,
    pub changed_paths: Vec<String>,
    pub resulting_content_digest: String,
    pub audit: AuditDescriptor,
}

impl OwnerEditDescriptor {
    pub fn validate(&self) -> Result<(), ValidationErrors> {
        let mut errors = Vec::new();
        validate_id(&mut errors, "edit_id", &self.edit_id);
        validate_id(&mut errors, "draft_id", &self.draft_id);
        if self.base_draft_version == 0
            || self.resulting_draft_version != self.base_draft_version.saturating_add(1)
        {
            push_error(
                &mut errors,
                "resulting_draft_version",
                "invalid_edit_version",
                "an owner edit must advance the draft version by exactly one",
            );
        }
        validate_count(&mut errors, "changed_paths", self.changed_paths.len(), 64);
        if self.changed_paths.is_empty() {
            push_error(
                &mut errors,
                "changed_paths",
                "empty_edit",
                "an owner edit must name at least one changed path",
            );
        }
        for (index, path) in self.changed_paths.iter().enumerate() {
            validate_text(
                &mut errors,
                &format!("changed_paths[{index}]"),
                path,
                1,
                240,
            );
        }
        validate_digest(
            &mut errors,
            "resulting_content_digest",
            &self.resulting_content_digest,
        );
        validate_audit(&mut errors, "audit", &self.audit);
        finish(errors)
    }
}

/// Metadata identifying one immutable, owner-approved snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApprovedRevisionMetadata {
    pub revision_id: String,
    pub draft_id: String,
    pub draft_version: u64,
    pub owner_id: String,
    pub content_digest: String,
    pub approved_at: String,
    pub previous_revision_id: Option<String>,
    pub audit: AuditDescriptor,
}

impl ApprovedRevisionMetadata {
    pub fn validate(&self) -> Result<(), ValidationErrors> {
        let mut errors = Vec::new();
        validate_id(&mut errors, "revision_id", &self.revision_id);
        validate_id(&mut errors, "draft_id", &self.draft_id);
        validate_id(&mut errors, "owner_id", &self.owner_id);
        if self.draft_version == 0 {
            push_error(
                &mut errors,
                "draft_version",
                "invalid_version",
                "approved draft version must be at least one",
            );
        }
        validate_digest(&mut errors, "content_digest", &self.content_digest);
        validate_timestamp(&mut errors, "approved_at", &self.approved_at);
        validate_optional_id(
            &mut errors,
            "previous_revision_id",
            self.previous_revision_id.as_deref(),
        );
        validate_audit(&mut errors, "audit", &self.audit);
        finish(errors)
    }
}

/// Complete immutable publication input. Revisions are append-only after insert.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApprovedPortfolioRevision {
    pub metadata: ApprovedRevisionMetadata,
    pub snapshot: PortfolioDraft,
    pub approval_manifest: Vec<ApprovalRequirement>,
    pub approvals: Vec<FieldApproval>,
    pub authorized_deployment_fact_ids: Vec<String>,
    pub static_artifact_contract: StaticArtifactContract,
}

impl ApprovedPortfolioRevision {
    pub fn validate(&self) -> Result<(), ValidationErrors> {
        let mut errors = errors_from(self.metadata.validate());
        errors.extend(errors_from(self.snapshot.validate()));
        validate_count(
            &mut errors,
            "approval_manifest",
            self.approval_manifest.len(),
            512,
        );
        validate_count(&mut errors, "approvals", self.approvals.len(), 512);

        let required_targets = self.snapshot.required_approval_targets();
        for target in &required_targets {
            let matches = self
                .approval_manifest
                .iter()
                .filter(|requirement| &requirement.target == target)
                .count();
            if matches != 1 {
                push_error(
                    &mut errors,
                    "approval_manifest",
                    "approval_requirement_mismatch",
                    "every shown field must have exactly one server-derived approval requirement",
                );
            }
        }
        for requirement in &self.approval_manifest {
            if !required_targets.contains(&requirement.target) {
                push_error(
                    &mut errors,
                    "approval_manifest",
                    "unexpected_approval_requirement",
                    "approval manifest contains a target that is not shown in the snapshot",
                );
            }
            validate_digest(
                &mut errors,
                "approval_manifest.value_digest",
                &requirement.value_digest,
            );
            let matching_approvals: Vec<_> = self
                .approvals
                .iter()
                .filter(|approval| approval.target == requirement.target)
                .collect();
            if matching_approvals.len() != 1 {
                push_error(
                    &mut errors,
                    "approvals",
                    "missing_or_duplicate_approval",
                    "every approval requirement must have exactly one owner approval",
                );
            } else {
                let approval = matching_approvals[0];
                if approval.value_digest != requirement.value_digest {
                    push_error(
                        &mut errors,
                        "approvals",
                        "approval_value_changed",
                        "approval value digest must match the approved field value",
                    );
                }
                if approval.revision_content_digest != self.metadata.content_digest {
                    push_error(
                        &mut errors,
                        "approvals",
                        "approval_revision_changed",
                        "approval must cover this immutable revision digest",
                    );
                }
                if approval.approved_by_owner_id != self.metadata.owner_id {
                    push_error(
                        &mut errors,
                        "approvals",
                        "approval_owner_mismatch",
                        "approval must come from the portfolio owner",
                    );
                }
            }
        }
        for approval in &self.approvals {
            validate_digest(
                &mut errors,
                "approvals.value_digest",
                &approval.value_digest,
            );
            validate_digest(
                &mut errors,
                "approvals.revision_content_digest",
                &approval.revision_content_digest,
            );
            validate_id(
                &mut errors,
                "approvals.approved_by_owner_id",
                &approval.approved_by_owner_id,
            );
            validate_timestamp(&mut errors, "approvals.approved_at", &approval.approved_at);
            validate_audit(&mut errors, "approvals.audit", &approval.audit);
            if !self
                .approval_manifest
                .iter()
                .any(|requirement| requirement.target == approval.target)
            {
                push_error(
                    &mut errors,
                    "approvals",
                    "unexpected_approval",
                    "approval does not correspond to a server-derived requirement",
                );
            }
        }

        let mut fact_ids = HashSet::new();
        for (index, id) in self.authorized_deployment_fact_ids.iter().enumerate() {
            validate_id(
                &mut errors,
                &format!("authorized_deployment_fact_ids[{index}]"),
                id,
            );
            validate_unique(
                &mut errors,
                &format!("authorized_deployment_fact_ids[{index}]"),
                id,
                &mut fact_ids,
            );
        }
        validate_static_contract(&mut errors, &self.static_artifact_contract);
        finish(errors)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApprovalRequirement {
    pub target: ApprovalTarget,
    pub value_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FieldApproval {
    pub target: ApprovalTarget,
    pub value_digest: String,
    pub revision_content_digest: String,
    pub approved_by_owner_id: String,
    pub approved_at: String,
    pub audit: AuditDescriptor,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ApprovalTarget {
    Narrative {
        field: NarrativeField,
        project_reference_id: Option<String>,
    },
    Contact {
        contact_id: String,
    },
    Link {
        link_id: String,
        project_reference_id: Option<String>,
    },
    Screenshot {
        project_reference_id: String,
        evidence_id: String,
    },
    Contribution {
        project_reference_id: String,
    },
    TechnicalDecision {
        project_reference_id: String,
        decision_id: String,
    },
    Status {
        project_reference_id: String,
        field: StatusField,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NarrativeField {
    DisplayName,
    Headline,
    Introduction,
    TargetRole,
    Skills,
    ProjectTitle,
    ProjectPurpose,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StatusField {
    DeploymentTimestamp,
    Availability,
    ReleaseIdentifier,
    SourceCommit,
    DemoReadiness,
}

/// Deployment facts that an owner has authorized for a public portfolio.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuthorizedDeploymentFacts {
    pub contract_version: PortfolioContractVersion,
    pub facts_id: String,
    pub owner_id: String,
    pub project_reference_id: String,
    pub deployment_id: String,
    pub release_id: String,
    pub managed_demo_url: String,
    pub deployed_at: String,
    pub availability: AvailabilityLabel,
    pub status_label: String,
    pub public_source_commit: Option<PublicSourceCommit>,
    pub fact_refresh: Option<FactRefreshAuthorization>,
    pub audit: AuditDescriptor,
}

impl AuthorizedDeploymentFacts {
    pub fn validate(&self) -> Result<(), ValidationErrors> {
        let mut errors = Vec::new();
        validate_id(&mut errors, "facts_id", &self.facts_id);
        validate_id(&mut errors, "owner_id", &self.owner_id);
        validate_id(
            &mut errors,
            "project_reference_id",
            &self.project_reference_id,
        );
        validate_id(&mut errors, "deployment_id", &self.deployment_id);
        validate_id(&mut errors, "release_id", &self.release_id);
        validate_url(
            &mut errors,
            "managed_demo_url",
            &self.managed_demo_url,
            LinkScheme::Https,
        );
        validate_timestamp(&mut errors, "deployed_at", &self.deployed_at);
        validate_text(&mut errors, "status_label", &self.status_label, 1, 80);
        if let Some(source_commit) = &self.public_source_commit {
            validate_text(
                &mut errors,
                "public_source_commit.commit",
                &source_commit.commit,
                7,
                64,
            );
            if !source_commit
                .commit
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            {
                push_error(
                    &mut errors,
                    "public_source_commit.commit",
                    "invalid_commit",
                    "public source commit must be a hexadecimal commit identifier",
                );
            }
            validate_id(
                &mut errors,
                "public_source_commit.opted_in_by_owner_id",
                &source_commit.opted_in_by_owner_id,
            );
            if source_commit.opted_in_by_owner_id != self.owner_id {
                push_error(
                    &mut errors,
                    "public_source_commit.opted_in_by_owner_id",
                    "owner_mismatch",
                    "source commit display opt-in must come from the portfolio owner",
                );
            }
            validate_timestamp(
                &mut errors,
                "public_source_commit.opted_in_at",
                &source_commit.opted_in_at,
            );
        }
        if let Some(refresh) = &self.fact_refresh {
            validate_fact_refresh(&mut errors, refresh, &self.owner_id);
        }
        validate_audit(&mut errors, "audit", &self.audit);
        finish(errors)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AvailabilityLabel {
    Available,
    Degraded,
    DemoOffline,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublicSourceCommit {
    pub commit: String,
    pub opted_in_by_owner_id: String,
    pub opted_in_at: String,
}

/// Narrow opt-in for background refreshes of previously approved managed facts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FactRefreshAuthorization {
    pub fields: Vec<RefreshableDeploymentFact>,
    pub authorized_by_owner_id: String,
    pub authorized_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RefreshableDeploymentFact {
    ManagedDemoDestination,
    DeploymentTimestamp,
    AvailabilityLabel,
}

/// Static output has no runtime dependency on Hostlet or customer systems.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StaticArtifactContract {
    pub page_load_dependencies: Vec<PageLoadDependency>,
    pub portfolio_slots_consumed: u16,
    pub external_case_study_slots_consumed: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PageLoadDependency {
    Dashboard,
    Github,
    TenantApplication,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuditDescriptor {
    pub event_id: String,
    pub kind: AuditEventKind,
    pub actor_id: String,
    pub occurred_at: String,
    pub reason: String,
    pub correlation_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditEventKind {
    OwnerEdit,
    OwnerApproval,
    DeploymentFactsAuthorized,
    DeploymentFactsRefreshed,
    RevisionApproved,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FieldViolation {
    pub path: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ValidationErrors {
    pub violations: Vec<FieldViolation>,
}

impl fmt::Display for ValidationErrors {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "portfolio contract has {} violation(s)",
            self.violations.len()
        )
    }
}

impl std::error::Error for ValidationErrors {}

#[derive(Debug, Clone, Copy)]
enum LinkScheme {
    Https,
    Mailto,
}

fn validate_project(
    errors: &mut Vec<FieldViolation>,
    path: &str,
    project: &ProjectReference,
    project_reference_ids: &mut HashSet<String>,
    project_orders: &mut HashSet<u16>,
) {
    validate_id(
        errors,
        &format!("{path}.project_reference_id"),
        &project.project_reference_id,
    );
    validate_unique(
        errors,
        &format!("{path}.project_reference_id"),
        &project.project_reference_id,
        project_reference_ids,
    );
    if !project_orders.insert(project.order) {
        push_error(
            errors,
            &format!("{path}.order"),
            "duplicate_order",
            "project order values must be unique",
        );
    }
    match &project.kind {
        ProjectReferenceKind::HostedProject { project_id } => {
            validate_id(errors, &format!("{path}.kind.project_id"), project_id)
        }
        ProjectReferenceKind::ExternalCaseStudy {
            external_reference_id,
        } => validate_id(
            errors,
            &format!("{path}.kind.external_reference_id"),
            external_reference_id,
        ),
    }
    validate_text(errors, &format!("{path}.title"), &project.title, 1, 160);
    validate_text(
        errors,
        &format!("{path}.purpose"),
        &project.purpose,
        1,
        4_000,
    );
    validate_text(
        errors,
        &format!("{path}.contribution"),
        &project.contribution,
        1,
        4_000,
    );

    validate_count(
        errors,
        &format!("{path}.technical_decisions"),
        project.technical_decisions.len(),
        MAX_DECISIONS,
    );
    let mut decision_ids = HashSet::new();
    for (index, decision) in project.technical_decisions.iter().enumerate() {
        let item_path = format!("{path}.technical_decisions[{index}]");
        validate_id(errors, &format!("{item_path}.id"), &decision.id);
        validate_unique(
            errors,
            &format!("{item_path}.id"),
            &decision.id,
            &mut decision_ids,
        );
        validate_text(
            errors,
            &format!("{item_path}.summary"),
            &decision.summary,
            1,
            1_000,
        );
        validate_text(
            errors,
            &format!("{item_path}.rationale"),
            &decision.rationale,
            1,
            2_000,
        );
    }

    validate_count(
        errors,
        &format!("{path}.links"),
        project.links.len(),
        MAX_LINKS,
    );
    let mut link_ids = HashSet::new();
    for (index, link) in project.links.iter().enumerate() {
        let item_path = format!("{path}.links[{index}].link");
        validate_link(errors, &item_path, &link.link, LinkScheme::Https);
        validate_unique(
            errors,
            &format!("{item_path}.id"),
            &link.link.id,
            &mut link_ids,
        );
    }

    validate_count(
        errors,
        &format!("{path}.evidence"),
        project.evidence.len(),
        MAX_EVIDENCE,
    );
    let mut evidence_ids = HashSet::new();
    for (index, evidence) in project.evidence.iter().enumerate() {
        let item_path = format!("{path}.evidence[{index}]");
        validate_id(errors, &format!("{item_path}.id"), &evidence.id);
        validate_unique(
            errors,
            &format!("{item_path}.id"),
            &evidence.id,
            &mut evidence_ids,
        );
        if evidence.kind != EvidenceKind::Screenshot {
            validate_unique(
                errors,
                &format!("{item_path}.id"),
                &evidence.id,
                &mut link_ids,
            );
        }
        validate_text(
            errors,
            &format!("{item_path}.title"),
            &evidence.title,
            1,
            160,
        );
        validate_url(
            errors,
            &format!("{item_path}.url"),
            &evidence.url,
            LinkScheme::Https,
        );
        validate_optional_text(
            errors,
            &format!("{item_path}.caption"),
            evidence.caption.as_deref(),
            500,
        );
        validate_optional_text(
            errors,
            &format!("{item_path}.alt_text"),
            evidence.alt_text.as_deref(),
            500,
        );
        if evidence.kind == EvidenceKind::Screenshot
            && evidence.alt_text.as_deref().is_none_or(str::is_empty)
        {
            push_error(
                errors,
                &format!("{item_path}.alt_text"),
                "missing_alt_text",
                "shown screenshot evidence requires alternative text",
            );
        }
    }

    validate_optional_id(
        errors,
        &format!("{path}.authorized_deployment_facts_id"),
        project.authorized_deployment_facts_id.as_deref(),
    );
    if (project.displayed_status.deployment_timestamp
        || project.displayed_status.availability
        || project.displayed_status.release_identifier
        || project.displayed_status.source_commit)
        && project.authorized_deployment_facts_id.is_none()
    {
        push_error(
            errors,
            &format!("{path}.authorized_deployment_facts_id"),
            "missing_authorized_facts",
            "displayed deployment fields require an authorized deployment-facts record",
        );
    }
    validate_readiness(
        errors,
        &format!("{path}.demo_readiness"),
        &project.demo_readiness,
    );
}

fn validate_readiness(errors: &mut Vec<FieldViolation>, path: &str, readiness: &DemoReadiness) {
    let attestation = match readiness {
        DemoReadiness::ReadyToShare { attestation } => {
            if !(attestation.demo_page_verified
                && attestation.synthetic_example_data_verified
                && attestation.restricted_access_verified
                && attestation.visitor_instructions_verified)
            {
                push_error(
                    errors,
                    path,
                    "incomplete_readiness",
                    "ready-to-share requires every owner readiness check",
                );
            }
            Some(attestation)
        }
        DemoReadiness::NeedsRecheck {
            previous_attestation,
            reason,
        } => {
            if *reason == ReadinessRecheckReason::NeverChecked && previous_attestation.is_some() {
                push_error(
                    errors,
                    path,
                    "inconsistent_readiness_history",
                    "never-checked readiness cannot retain a previous attestation",
                );
            }
            previous_attestation.as_ref()
        }
    };
    if let Some(attestation) = attestation {
        validate_id(
            errors,
            &format!("{path}.release_id"),
            &attestation.release_id,
        );
        validate_timestamp(
            errors,
            &format!("{path}.checked_at"),
            &attestation.checked_at,
        );
        validate_text(
            errors,
            &format!("{path}.visitor_instructions"),
            &attestation.visitor_instructions,
            1,
            2_000,
        );
    }
}

fn validate_fact_refresh(
    errors: &mut Vec<FieldViolation>,
    refresh: &FactRefreshAuthorization,
    owner_id: &str,
) {
    if refresh.fields.is_empty() {
        push_error(
            errors,
            "fact_refresh.fields",
            "empty_refresh_scope",
            "fact refresh opt-in must name at least one supported field",
        );
    }
    if refresh.fields.len() > 3 {
        push_error(
            errors,
            "fact_refresh.fields",
            "too_many_items",
            "fact refresh can cover only the three supported managed fields",
        );
    }
    let mut fields = HashSet::new();
    for field in &refresh.fields {
        if !fields.insert(*field) {
            push_error(
                errors,
                "fact_refresh.fields",
                "duplicate_refresh_field",
                "fact refresh fields must be unique",
            );
        }
    }
    validate_id(
        errors,
        "fact_refresh.authorized_by_owner_id",
        &refresh.authorized_by_owner_id,
    );
    if refresh.authorized_by_owner_id != owner_id {
        push_error(
            errors,
            "fact_refresh.authorized_by_owner_id",
            "owner_mismatch",
            "fact refresh opt-in must come from the portfolio owner",
        );
    }
    validate_timestamp(errors, "fact_refresh.authorized_at", &refresh.authorized_at);
}

fn validate_static_contract(errors: &mut Vec<FieldViolation>, contract: &StaticArtifactContract) {
    if !contract.page_load_dependencies.is_empty() {
        push_error(
            errors,
            "static_artifact_contract.page_load_dependencies",
            "runtime_dependency_forbidden",
            "static artifacts cannot depend on the dashboard, GitHub, or tenant applications at page load",
        );
    }
    if contract.portfolio_slots_consumed != 0 {
        push_error(
            errors,
            "static_artifact_contract.portfolio_slots_consumed",
            "slot_consumption_forbidden",
            "a portfolio consumes zero hosted project slots",
        );
    }
    if contract.external_case_study_slots_consumed != 0 {
        push_error(
            errors,
            "static_artifact_contract.external_case_study_slots_consumed",
            "slot_consumption_forbidden",
            "an external case study consumes zero hosted project slots",
        );
    }
}

fn validate_link(
    errors: &mut Vec<FieldViolation>,
    path: &str,
    link: &PublicLink,
    scheme: LinkScheme,
) {
    validate_id(errors, &format!("{path}.id"), &link.id);
    validate_text(errors, &format!("{path}.label"), &link.label, 1, 80);
    validate_url(errors, &format!("{path}.url"), &link.url, scheme);
}

fn validate_url(errors: &mut Vec<FieldViolation>, path: &str, value: &str, scheme: LinkScheme) {
    validate_text(errors, path, value, 1, MAX_URL_LEN);
    if value.chars().any(char::is_whitespace) || value.contains('\\') {
        push_error(
            errors,
            path,
            "invalid_url",
            "URLs cannot contain whitespace or backslashes",
        );
        return;
    }
    let parsed = match Url::parse(value) {
        Ok(parsed) => parsed,
        Err(_) => {
            push_error(
                errors,
                path,
                "invalid_url",
                "URL must be absolute and well formed",
            );
            return;
        }
    };
    let valid = match scheme {
        LinkScheme::Https => {
            parsed.scheme() == "https"
                && parsed.has_host()
                && parsed.host_str().is_some_and(|host| !host.is_empty())
                && parsed.username().is_empty()
                && parsed.password().is_none()
        }
        LinkScheme::Mailto => {
            let address = parsed.path();
            let mut parts = address.split('@');
            parsed.scheme() == "mailto"
                && parsed.query().is_none()
                && parsed.fragment().is_none()
                && parts.next().is_some_and(|part| !part.is_empty())
                && parts.next().is_some_and(|part| part.contains('.'))
                && parts.next().is_none()
        }
    };
    if !valid {
        let message = match scheme {
            LinkScheme::Https => "public links must use an absolute https URL",
            LinkScheme::Mailto => "email contacts must use a valid mailto URL",
        };
        push_error(errors, path, "unsupported_url_scheme", message);
    }
}

fn validate_text(
    errors: &mut Vec<FieldViolation>,
    path: &str,
    value: &str,
    min: usize,
    max: usize,
) {
    let length = value.chars().count();
    if length < min || length > max {
        push_error(
            errors,
            path,
            "invalid_length",
            &format!("value must contain between {min} and {max} characters"),
        );
    }
    if value
        .chars()
        .any(|character| character.is_control() && character != '\n' && character != '\t')
    {
        push_error(
            errors,
            path,
            "control_character",
            "value contains an unsupported control character",
        );
    }
}

fn validate_optional_text(
    errors: &mut Vec<FieldViolation>,
    path: &str,
    value: Option<&str>,
    max: usize,
) {
    if let Some(value) = value {
        validate_text(errors, path, value, 1, max);
    }
}

fn validate_id(errors: &mut Vec<FieldViolation>, path: &str, value: &str) {
    validate_text(errors, path, value, 1, MAX_ID_LEN);
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        push_error(
            errors,
            path,
            "invalid_id",
            "identifier may contain only ASCII letters, digits, dash, underscore, dot, and colon",
        );
    }
}

fn validate_optional_id(errors: &mut Vec<FieldViolation>, path: &str, value: Option<&str>) {
    if let Some(value) = value {
        validate_id(errors, path, value);
    }
}

fn validate_digest(errors: &mut Vec<FieldViolation>, path: &str, value: &str) {
    validate_text(errors, path, value, MAX_DIGEST_LEN, MAX_DIGEST_LEN);
    let valid = value.strip_prefix("sha256:").is_some_and(|digest| {
        digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
    });
    if !valid {
        push_error(
            errors,
            path,
            "invalid_digest",
            "digest must be sha256 followed by 64 hexadecimal characters",
        );
    }
}

fn validate_timestamp(errors: &mut Vec<FieldViolation>, path: &str, value: &str) {
    validate_text(errors, path, value, 1, MAX_TIMESTAMP_LEN);
    if !value.contains('T') || !(value.ends_with('Z') || value.contains('+')) {
        push_error(
            errors,
            path,
            "invalid_timestamp",
            "timestamp must be a bounded RFC 3339 UTC or offset value",
        );
    }
}

fn validate_audit(errors: &mut Vec<FieldViolation>, path: &str, audit: &AuditDescriptor) {
    validate_id(errors, &format!("{path}.event_id"), &audit.event_id);
    validate_id(errors, &format!("{path}.actor_id"), &audit.actor_id);
    validate_timestamp(errors, &format!("{path}.occurred_at"), &audit.occurred_at);
    validate_text(
        errors,
        &format!("{path}.reason"),
        &audit.reason,
        1,
        MAX_AUDIT_REASON_LEN,
    );
    validate_id(
        errors,
        &format!("{path}.correlation_id"),
        &audit.correlation_id,
    );
}

fn validate_count(errors: &mut Vec<FieldViolation>, path: &str, count: usize, max: usize) {
    if count > max {
        push_error(
            errors,
            path,
            "too_many_items",
            &format!("collection cannot contain more than {max} items"),
        );
    }
}

fn validate_unique(
    errors: &mut Vec<FieldViolation>,
    path: &str,
    value: &str,
    seen: &mut HashSet<String>,
) {
    if !seen.insert(value.to_owned()) {
        push_error(
            errors,
            path,
            "duplicate_id",
            "identifier must be unique within its collection",
        );
    }
}

fn push_error(errors: &mut Vec<FieldViolation>, path: &str, code: &str, message: &str) {
    errors.push(FieldViolation {
        path: path.to_owned(),
        code: code.to_owned(),
        message: message.to_owned(),
    });
}

fn errors_from(result: Result<(), ValidationErrors>) -> Vec<FieldViolation> {
    result.map_or_else(|error| error.violations, |()| Vec::new())
}

fn finish(errors: Vec<FieldViolation>) -> Result<(), ValidationErrors> {
    if errors.is_empty() {
        Ok(())
    } else {
        Err(ValidationErrors { violations: errors })
    }
}
