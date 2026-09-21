//! Versioned standard-project values shared by the control API and workers.
//!
//! These types describe intent and references. A slot state is not evidence
//! that entitlement or capacity admission occurred, and no value in this module
//! authorizes execution of customer code.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

pub const PROJECT_CONTRACT_VERSION: &str = "hostlet.project/v1";
pub const MAX_SERVICE_NAME_BYTES: usize = 64;
pub const MAX_COMMAND_BYTES: usize = 4096;
pub const MAX_RELATIVE_PATH_BYTES: usize = 1024;

macro_rules! string_id {
    ($name:ident) => {
        #[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub String);
    };
}

string_id!(AccountId);
string_id!(ProjectId);
string_id!(RepositoryId);
string_id!(ServiceId);
string_id!(ConfigurationRevisionId);
string_id!(DeploymentId);
string_id!(SecretVersionId);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AccountRecord {
    pub id: AccountId,
    pub email: String,
    pub display_name: String,
    pub revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectRecord {
    pub id: ProjectId,
    pub owner_account_id: AccountId,
    pub name: String,
    pub mode: ProjectMode,
    pub slot: SlotRelationship,
    pub revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectReference {
    pub account_id: AccountId,
    pub project_id: ProjectId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServiceReference {
    pub account_id: AccountId,
    pub project_id: ProjectId,
    pub service_id: ServiceId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConfigurationRevision {
    pub id: ConfigurationRevisionId,
    pub project_id: ProjectId,
    pub revision: u64,
    pub spec: StandardProjectSpec,
    pub public_environment_names: Vec<String>,
    pub secret_version_refs: Vec<SecretVersionReference>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConfigurationRevisionReference {
    pub project_id: ProjectId,
    pub configuration_revision_id: ConfigurationRevisionId,
    pub revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SecretVersionReference {
    pub service_id: ServiceId,
    pub secret_version_id: SecretVersionId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeploymentRecord {
    pub id: DeploymentId,
    pub project_id: ProjectId,
    pub configuration_revision_id: ConfigurationRevisionId,
    pub source_commit: String,
    pub lifecycle: DeploymentLifecycle,
    pub release: ReleaseReferences,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeploymentReference {
    pub project_id: ProjectId,
    pub deployment_id: DeploymentId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReleaseReferences {
    pub static_artifact: Option<ArtifactReference>,
    pub application_artifact: Option<ArtifactReference>,
    pub health_result_ref: Option<String>,
    pub database_migration_revision: Option<String>,
    pub secret_version_refs: Vec<SecretVersionReference>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactReference {
    pub service_id: ServiceId,
    pub digest: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeploymentLifecycle {
    Intent,
    AdmissionRequired,
    Queued,
    Healthy,
    FailedNoResources,
    FailedResourcesRetained,
    RollbackRequested,
    Removed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectMode {
    Draft,
    CompatibilityCheck,
    DeploymentIntent,
    ShowcaseOnly,
    PortfolioOnly,
    ExternalCaseStudy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SlotRelationship {
    pub hosted_slots: u8,
    pub state: SlotState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SlotState {
    NoSlot,
    AdmissionRequired,
    Reserved,
    ResourcesRetained,
    ReleasePending,
    Released,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RepositorySpec {
    pub layout: RepositoryLayout,
    pub package_manager: PackageManager,
    pub lockfile_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RepositoryRecord {
    pub id: RepositoryId,
    pub project_id: ProjectId,
    pub configuration: RepositorySpec,
    pub revision: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RepositoryLayout {
    SingleProject,
    Monorepo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PackageManager {
    Npm,
    Pnpm,
    Yarn,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServiceSpec {
    pub name: String,
    pub kind: ServiceKind,
    pub root: Option<String>,
    pub framework: FrameworkPattern,
    pub node: Option<NodeRuntime>,
    pub build_command: Option<String>,
    pub output_directory: Option<String>,
    pub start_command: Option<String>,
    pub health_check: Option<HealthCheck>,
    pub uses_durable_data: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServiceRecord {
    pub id: ServiceId,
    pub project_id: ProjectId,
    pub configuration: ServiceSpec,
    pub revision: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ServiceKind {
    StaticFrontend,
    Application,
    Postgres,
    Worker,
    ScheduledJob,
    AdditionalBackend,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FrameworkPattern {
    ViteStatic,
    StaticExport,
    NodeHttp,
    Nextjs16Standalone,
    Postgresql18,
    DockerCompose,
    CustomNextServer,
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NodeRuntime {
    pub major: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HealthCheck {
    pub protocol: HealthCheckProtocol,
    pub path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HealthCheckProtocol {
    Http,
    Tcp,
    Command,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResourceEnvelope {
    pub limits: Vec<BenchmarkLimit>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BenchmarkLimit {
    pub resource: ResourceKind,
    pub amount: Option<u64>,
    pub unit: ResourceUnit,
    pub scope: ResourceScope,
    pub enforcement: EnforcementBehavior,
    pub status: LimitStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceKind {
    ApplicationMemory,
    ApplicationCpu,
    DatabaseStorage,
    DatabaseConnections,
    ScratchStorage,
    BuildCpu,
    BuildMemory,
    BuildTimeout,
    ConcurrentBuilds,
    MonthlyBuildExecution,
    StaticReleaseArtifact,
    RuntimeReleaseArtifact,
    RetainedSuccessfulReleases,
    PublicOutboundTransfer,
    PortfolioAssets,
    LogStorage,
    LogRetention,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceUnit {
    Mebibytes,
    Gibibytes,
    Millicpu,
    Connections,
    Minutes,
    Count,
    Days,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceScope {
    HostedProject,
    ProjectDatabase,
    Build,
    Account,
    PurchasedSlotBillingMonth,
    Release,
    PortfolioAccount,
    ProjectLogs,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnforcementBehavior {
    ReportMemoryTerminationWithBoundedRestartBackoff,
    ThrottleCpu,
    WarnAt80PreventGrowthPreserveReadsAndExport,
    CapApplicationConnections,
    FailExcessEphemeralWrites,
    FailBuildPreserveLiveRelease,
    TimeOutBuildPreserveLiveRelease,
    QueueBuildsUntilCapacity,
    QueueBuildsUntilBillingRenewal,
    RejectOversizedReplacementPreserveCurrent,
    RetainCurrentPlusTwoPrevious,
    WarnAt80And95ThenLimitPublicTraffic,
    RejectNewAssetsPreservePublishedRevision,
    RotateOldestAndRedactSecrets,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LimitStatus {
    BenchmarkCandidate,
    ApprovedPromise,
    Unbounded,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StandardProjectSpec {
    pub contract_version: String,
    pub repositories: Vec<RepositorySpec>,
    pub services: Vec<ServiceSpec>,
    pub resources: ResourceEnvelope,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectValidationIssue {
    pub code: ProjectIssueCode,
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectIssueCode {
    UnsupportedContractVersion,
    RepositoryCount,
    MissingLockfile,
    UnsupportedLockfile,
    UnsafeLockfilePath,
    MissingRunnableService,
    InvalidServiceName,
    DuplicateServiceName,
    TextFieldTooLong,
    UnsafeServiceRoot,
    ExtraStaticFrontend,
    ExtraApplicationService,
    ExtraDatabase,
    UnsupportedServiceKind,
    UnsupportedFrameworkPattern,
    MissingNodeRuntime,
    UnsupportedNodeVersion,
    MissingBuildCommand,
    MissingOutputDirectory,
    MissingStartCommand,
    MissingHealthCheck,
    UnsupportedHealthCheck,
    DatabaseRequired,
    DatabaseWithoutApplication,
    UnexpectedServiceConfiguration,
    MissingResourceLimit,
    DuplicateResourceLimit,
    UnboundedResourceLimit,
    ResourceAmountMismatch,
    ResourceUnitMismatch,
    ResourceScopeMismatch,
    ResourceEnforcementMismatch,
    ResourceNotBenchmarkCandidate,
}

impl StandardProjectSpec {
    /// Return deterministic, public-safe issues for this contract.
    ///
    /// Validation is pure: it performs no source checkout, package install,
    /// command execution, network access, capacity admission, or persistence.
    pub fn validate(&self) -> Vec<ProjectValidationIssue> {
        let mut issues = Vec::new();

        if self.contract_version != PROJECT_CONTRACT_VERSION {
            issue(
                &mut issues,
                ProjectIssueCode::UnsupportedContractVersion,
                "contract_version",
                "the project contract version is not supported",
            );
        }
        self.validate_repositories(&mut issues);
        self.validate_services(&mut issues);
        self.validate_resources(&mut issues);
        issues
    }

    fn validate_repositories(&self, issues: &mut Vec<ProjectValidationIssue>) {
        if self.repositories.len() != 1 {
            issue(
                issues,
                ProjectIssueCode::RepositoryCount,
                "repositories",
                "a standard project must contain exactly one repository or monorepo",
            );
        }

        for (index, repository) in self.repositories.iter().enumerate() {
            if repository.package_manager != PackageManager::Npm {
                issue(
                    issues,
                    ProjectIssueCode::UnsupportedLockfile,
                    format!("repositories[{index}].package_manager"),
                    "the initial contract supports locked npm installs only",
                );
            }
            match repository.lockfile_path.as_deref() {
                None | Some("") => issue(
                    issues,
                    ProjectIssueCode::MissingLockfile,
                    format!("repositories[{index}].lockfile_path"),
                    "an npm package-lock.json is required",
                ),
                Some(path) if !safe_relative_path(path) => issue(
                    issues,
                    ProjectIssueCode::UnsafeLockfilePath,
                    format!("repositories[{index}].lockfile_path"),
                    "the lockfile path must be a safe repository-relative path",
                ),
                Some(path) if path.rsplit('/').next() != Some("package-lock.json") => issue(
                    issues,
                    ProjectIssueCode::UnsupportedLockfile,
                    format!("repositories[{index}].lockfile_path"),
                    "the initial contract requires package-lock.json",
                ),
                Some(_) => {}
            }
            bounded_text(
                repository.lockfile_path.as_deref(),
                MAX_RELATIVE_PATH_BYTES,
                format!("repositories[{index}].lockfile_path"),
                issues,
            );
        }
    }

    fn validate_services(&self, issues: &mut Vec<ProjectValidationIssue>) {
        let mut service_names = HashSet::new();
        let mut static_count = 0;
        let mut application_count = 0;
        let mut database_count = 0;
        let mut needs_database = false;

        for (index, service) in self.services.iter().enumerate() {
            let base = format!("services[{index}]");
            if service.name.trim().is_empty()
                || service.name.len() > MAX_SERVICE_NAME_BYTES
                || service.name.chars().any(char::is_control)
            {
                issue(
                    issues,
                    ProjectIssueCode::InvalidServiceName,
                    format!("{base}.name"),
                    "a service name must be nonblank, control-free, and at most 64 bytes",
                );
            }
            bounded_text(
                service.root.as_deref(),
                MAX_RELATIVE_PATH_BYTES,
                format!("{base}.root"),
                issues,
            );
            if service
                .root
                .as_deref()
                .is_some_and(|path| !safe_relative_path(path))
            {
                issue(
                    issues,
                    ProjectIssueCode::UnsafeServiceRoot,
                    format!("{base}.root"),
                    "a service root must be a safe repository-relative path",
                );
            }
            bounded_text(
                service.output_directory.as_deref(),
                MAX_RELATIVE_PATH_BYTES,
                format!("{base}.output_directory"),
                issues,
            );
            bounded_text(
                service.build_command.as_deref(),
                MAX_COMMAND_BYTES,
                format!("{base}.build_command"),
                issues,
            );
            bounded_text(
                service.start_command.as_deref(),
                MAX_COMMAND_BYTES,
                format!("{base}.start_command"),
                issues,
            );
            if let Some(health) = &service.health_check {
                bounded_text(
                    Some(health.path.as_str()),
                    MAX_RELATIVE_PATH_BYTES,
                    format!("{base}.health_check.path"),
                    issues,
                );
            }
            if !service_names.insert(&service.name) {
                issue(
                    issues,
                    ProjectIssueCode::DuplicateServiceName,
                    format!("{base}.name"),
                    "service names must be unique within a project",
                );
            }
            needs_database |= service.uses_durable_data;

            match service.kind {
                ServiceKind::StaticFrontend => {
                    static_count += 1;
                    validate_source_service(service, index, issues);
                    validate_node(service, index, issues);
                    if !matches!(
                        service.framework,
                        FrameworkPattern::ViteStatic | FrameworkPattern::StaticExport
                    ) {
                        unsupported_framework(index, issues);
                    }
                    require_text(
                        service.build_command.as_deref(),
                        ProjectIssueCode::MissingBuildCommand,
                        format!("{base}.build_command"),
                        "a static service requires a build command",
                        issues,
                    );
                    require_safe_path(
                        service.output_directory.as_deref(),
                        ProjectIssueCode::MissingOutputDirectory,
                        format!("{base}.output_directory"),
                        "a static service requires a safe output directory",
                        issues,
                    );
                }
                ServiceKind::Application => {
                    application_count += 1;
                    validate_source_service(service, index, issues);
                    validate_node(service, index, issues);
                    if !matches!(
                        service.framework,
                        FrameworkPattern::NodeHttp | FrameworkPattern::Nextjs16Standalone
                    ) {
                        unsupported_framework(index, issues);
                    }
                    if service.framework == FrameworkPattern::Nextjs16Standalone {
                        require_text(
                            service.build_command.as_deref(),
                            ProjectIssueCode::MissingBuildCommand,
                            format!("{base}.build_command"),
                            "a Next.js standalone service requires a build command",
                            issues,
                        );
                    }
                    require_text(
                        service.start_command.as_deref(),
                        ProjectIssueCode::MissingStartCommand,
                        format!("{base}.start_command"),
                        "an application service requires a start command",
                        issues,
                    );
                    match &service.health_check {
                        None => issue(
                            issues,
                            ProjectIssueCode::MissingHealthCheck,
                            format!("{base}.health_check"),
                            "an application service requires an HTTP health endpoint",
                        ),
                        Some(health)
                            if health.protocol != HealthCheckProtocol::Http
                                || !safe_http_path(&health.path) =>
                        {
                            issue(
                                issues,
                                ProjectIssueCode::UnsupportedHealthCheck,
                                format!("{base}.health_check"),
                                "the health check must be an absolute HTTP path",
                            );
                        }
                        Some(_) => {}
                    }
                }
                ServiceKind::Postgres => {
                    database_count += 1;
                    if service.framework != FrameworkPattern::Postgresql18 {
                        unsupported_framework(index, issues);
                    }
                    if service.root.is_some()
                        || service.node.is_some()
                        || service.build_command.is_some()
                        || service.output_directory.is_some()
                        || service.start_command.is_some()
                        || service.health_check.is_some()
                        || service.uses_durable_data
                    {
                        issue(
                            issues,
                            ProjectIssueCode::UnexpectedServiceConfiguration,
                            base,
                            "the managed PostgreSQL service does not accept source, command, runtime, or health configuration",
                        );
                    }
                }
                ServiceKind::Worker
                | ServiceKind::ScheduledJob
                | ServiceKind::AdditionalBackend => issue(
                    issues,
                    ProjectIssueCode::UnsupportedServiceKind,
                    format!("{base}.kind"),
                    "extra workers, scheduled jobs, and additional backends are unsupported",
                ),
            }
        }

        if static_count + application_count == 0 {
            issue(
                issues,
                ProjectIssueCode::MissingRunnableService,
                "services",
                "a standard project needs a static frontend or application service",
            );
        }
        count_limit(static_count, ProjectIssueCode::ExtraStaticFrontend, issues);
        count_limit(
            application_count,
            ProjectIssueCode::ExtraApplicationService,
            issues,
        );
        count_limit(database_count, ProjectIssueCode::ExtraDatabase, issues);
        if needs_database && database_count == 0 {
            issue(
                issues,
                ProjectIssueCode::DatabaseRequired,
                "services",
                "a service with durable data requires the project PostgreSQL service",
            );
        }
        if database_count > 0 && application_count == 0 {
            issue(
                issues,
                ProjectIssueCode::DatabaseWithoutApplication,
                "services",
                "a database requires an application service in the initial contract",
            );
        }
    }

    fn validate_resources(&self, issues: &mut Vec<ProjectValidationIssue>) {
        let mut seen = HashSet::new();
        for (index, limit) in self.resources.limits.iter().enumerate() {
            if !seen.insert(limit.resource) {
                issue(
                    issues,
                    ProjectIssueCode::DuplicateResourceLimit,
                    format!("resources.limits[{index}].resource"),
                    "each benchmark resource must appear exactly once",
                );
                continue;
            }
            let Some(expected) = expected_limit(limit.resource) else {
                continue;
            };
            let base = format!("resources.limits[{index}]");
            match limit.amount {
                None | Some(0) => issue(
                    issues,
                    ProjectIssueCode::UnboundedResourceLimit,
                    format!("{base}.amount"),
                    "resource limits must be finite positive benchmark candidates",
                ),
                Some(amount) if amount != expected.amount => issue(
                    issues,
                    ProjectIssueCode::ResourceAmountMismatch,
                    format!("{base}.amount"),
                    "the value does not match the adopted starting benchmark",
                ),
                Some(_) => {}
            }
            mismatch(
                limit.unit != expected.unit,
                ProjectIssueCode::ResourceUnitMismatch,
                format!("{base}.unit"),
                issues,
            );
            mismatch(
                limit.scope != expected.scope,
                ProjectIssueCode::ResourceScopeMismatch,
                format!("{base}.scope"),
                issues,
            );
            mismatch(
                limit.enforcement != expected.enforcement,
                ProjectIssueCode::ResourceEnforcementMismatch,
                format!("{base}.enforcement"),
                issues,
            );
            if limit.status != LimitStatus::BenchmarkCandidate {
                issue(
                    issues,
                    ProjectIssueCode::ResourceNotBenchmarkCandidate,
                    format!("{base}.status"),
                    "the starting limit is a benchmark candidate, not an approved promise",
                );
            }
        }
        for expected in EXPECTED_LIMITS {
            if !seen.contains(&expected.resource) {
                issue(
                    issues,
                    ProjectIssueCode::MissingResourceLimit,
                    "resources.limits",
                    format!("missing starting benchmark for {:?}", expected.resource),
                );
            }
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct ExpectedLimit {
    resource: ResourceKind,
    amount: u64,
    unit: ResourceUnit,
    scope: ResourceScope,
    enforcement: EnforcementBehavior,
}

const EXPECTED_LIMITS: &[ExpectedLimit] = &[
    expected(
        ResourceKind::ApplicationMemory,
        512,
        ResourceUnit::Mebibytes,
        ResourceScope::HostedProject,
        EnforcementBehavior::ReportMemoryTerminationWithBoundedRestartBackoff,
    ),
    expected(
        ResourceKind::ApplicationCpu,
        250,
        ResourceUnit::Millicpu,
        ResourceScope::HostedProject,
        EnforcementBehavior::ThrottleCpu,
    ),
    expected(
        ResourceKind::DatabaseStorage,
        1,
        ResourceUnit::Gibibytes,
        ResourceScope::ProjectDatabase,
        EnforcementBehavior::WarnAt80PreventGrowthPreserveReadsAndExport,
    ),
    expected(
        ResourceKind::DatabaseConnections,
        10,
        ResourceUnit::Connections,
        ResourceScope::ProjectDatabase,
        EnforcementBehavior::CapApplicationConnections,
    ),
    expected(
        ResourceKind::ScratchStorage,
        256,
        ResourceUnit::Mebibytes,
        ResourceScope::HostedProject,
        EnforcementBehavior::FailExcessEphemeralWrites,
    ),
    expected(
        ResourceKind::BuildCpu,
        2000,
        ResourceUnit::Millicpu,
        ResourceScope::Build,
        EnforcementBehavior::FailBuildPreserveLiveRelease,
    ),
    expected(
        ResourceKind::BuildMemory,
        2,
        ResourceUnit::Gibibytes,
        ResourceScope::Build,
        EnforcementBehavior::FailBuildPreserveLiveRelease,
    ),
    expected(
        ResourceKind::BuildTimeout,
        10,
        ResourceUnit::Minutes,
        ResourceScope::Build,
        EnforcementBehavior::TimeOutBuildPreserveLiveRelease,
    ),
    expected(
        ResourceKind::ConcurrentBuilds,
        1,
        ResourceUnit::Count,
        ResourceScope::Account,
        EnforcementBehavior::QueueBuildsUntilCapacity,
    ),
    expected(
        ResourceKind::MonthlyBuildExecution,
        60,
        ResourceUnit::Minutes,
        ResourceScope::PurchasedSlotBillingMonth,
        EnforcementBehavior::QueueBuildsUntilBillingRenewal,
    ),
    expected(
        ResourceKind::StaticReleaseArtifact,
        250,
        ResourceUnit::Mebibytes,
        ResourceScope::Release,
        EnforcementBehavior::RejectOversizedReplacementPreserveCurrent,
    ),
    expected(
        ResourceKind::RuntimeReleaseArtifact,
        1,
        ResourceUnit::Gibibytes,
        ResourceScope::Release,
        EnforcementBehavior::RejectOversizedReplacementPreserveCurrent,
    ),
    expected(
        ResourceKind::RetainedSuccessfulReleases,
        3,
        ResourceUnit::Count,
        ResourceScope::HostedProject,
        EnforcementBehavior::RetainCurrentPlusTwoPrevious,
    ),
    expected(
        ResourceKind::PublicOutboundTransfer,
        10,
        ResourceUnit::Gibibytes,
        ResourceScope::PurchasedSlotBillingMonth,
        EnforcementBehavior::WarnAt80And95ThenLimitPublicTraffic,
    ),
    expected(
        ResourceKind::PortfolioAssets,
        100,
        ResourceUnit::Mebibytes,
        ResourceScope::PortfolioAccount,
        EnforcementBehavior::RejectNewAssetsPreservePublishedRevision,
    ),
    expected(
        ResourceKind::LogStorage,
        100,
        ResourceUnit::Mebibytes,
        ResourceScope::ProjectLogs,
        EnforcementBehavior::RotateOldestAndRedactSecrets,
    ),
    expected(
        ResourceKind::LogRetention,
        7,
        ResourceUnit::Days,
        ResourceScope::ProjectLogs,
        EnforcementBehavior::RotateOldestAndRedactSecrets,
    ),
];

const fn expected(
    resource: ResourceKind,
    amount: u64,
    unit: ResourceUnit,
    scope: ResourceScope,
    enforcement: EnforcementBehavior,
) -> ExpectedLimit {
    ExpectedLimit {
        resource,
        amount,
        unit,
        scope,
        enforcement,
    }
}

fn expected_limit(resource: ResourceKind) -> Option<ExpectedLimit> {
    EXPECTED_LIMITS
        .iter()
        .copied()
        .find(|limit| limit.resource == resource)
}

fn validate_source_service(
    service: &ServiceSpec,
    index: usize,
    issues: &mut Vec<ProjectValidationIssue>,
) {
    let base = format!("services[{index}]");
    if service.root.is_none() {
        issue(
            issues,
            ProjectIssueCode::UnsafeServiceRoot,
            format!("{base}.root"),
            "a service root must be a safe repository-relative path",
        );
    }
}

fn validate_node(service: &ServiceSpec, index: usize, issues: &mut Vec<ProjectValidationIssue>) {
    match &service.node {
        None => issue(
            issues,
            ProjectIssueCode::MissingNodeRuntime,
            format!("services[{index}].node"),
            "a source service requires Node 24 or the tested Node 22 alternative",
        ),
        Some(runtime) if !matches!(runtime.major, 22 | 24) => issue(
            issues,
            ProjectIssueCode::UnsupportedNodeVersion,
            format!("services[{index}].node.major"),
            "the initial contract supports Node 24 and Node 22",
        ),
        Some(_) => {}
    }
}

fn unsupported_framework(index: usize, issues: &mut Vec<ProjectValidationIssue>) {
    issue(
        issues,
        ProjectIssueCode::UnsupportedFrameworkPattern,
        format!("services[{index}].framework"),
        "the service framework does not match an initial supported pattern",
    );
}

fn require_text(
    value: Option<&str>,
    code: ProjectIssueCode,
    path: String,
    message: &'static str,
    issues: &mut Vec<ProjectValidationIssue>,
) {
    if value.is_none_or(|value| value.trim().is_empty()) {
        issue(issues, code, path, message);
    }
}

fn require_safe_path(
    value: Option<&str>,
    code: ProjectIssueCode,
    path: String,
    message: &'static str,
    issues: &mut Vec<ProjectValidationIssue>,
) {
    if value.is_none_or(|value| !safe_relative_path(value)) {
        issue(issues, code, path, message);
    }
}

fn bounded_text(
    value: Option<&str>,
    maximum: usize,
    path: String,
    issues: &mut Vec<ProjectValidationIssue>,
) {
    if value.is_some_and(|value| value.len() > maximum) {
        issue(
            issues,
            ProjectIssueCode::TextFieldTooLong,
            path,
            format!("the field must be at most {maximum} bytes"),
        );
    }
}

fn count_limit(count: usize, code: ProjectIssueCode, issues: &mut Vec<ProjectValidationIssue>) {
    if count > 1 {
        issue(
            issues,
            code,
            "services",
            "a standard project permits at most one service of this kind",
        );
    }
}

fn safe_relative_path(path: &str) -> bool {
    if path == "." {
        return true;
    }
    if path.is_empty()
        || path.starts_with('/')
        || path.starts_with('\\')
        || path.contains('\\')
        || path.contains('\0')
        || path.contains(':')
    {
        return false;
    }
    path.split('/')
        .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

fn safe_http_path(path: &str) -> bool {
    path.starts_with('/') && !path.starts_with("//") && !path.contains(['\r', '\n'])
}

fn mismatch(
    condition: bool,
    code: ProjectIssueCode,
    path: String,
    issues: &mut Vec<ProjectValidationIssue>,
) {
    if condition {
        issue(
            issues,
            code,
            path,
            "the value does not match the adopted starting benchmark",
        );
    }
}

fn issue(
    issues: &mut Vec<ProjectValidationIssue>,
    code: ProjectIssueCode,
    path: impl Into<String>,
    message: impl Into<String>,
) {
    issues.push(ProjectValidationIssue {
        code,
        path: path.into(),
        message: message.into(),
    });
}
