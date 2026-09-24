# Infrastructure boundary

M3.5 adds scoped private-preview automation under `scripts/beta/`. Its
placement and access boundary is [the preview contract](../docs/M3.5-PREVIEW-CONTRACT.md);
[tools.json](beta/tools.json) pins the edge and connector release artifacts.
These tools are not installed by CI and do not authorize a production launch.

Separate trusted platform data/control, artifact registry, build execution, tenant
runtime, project databases and public static portfolio delivery. Customer builds
are untrusted and isolated; organization CI validates only the platform. Evaluate
gVisor or microVM runtime isolation alongside network/resource controls.

The supplied brief recommends homelab development/testing and production hosting
that does not depend on residential connectivity. Production placement, providers,
capacity, budget and domain assignments remain unresolved. Earlier homelab-only
production instructions are not authority for this new project.

Included project databases need backups and tested restore/export before launch.
Choose retention, recovery targets and storage boundaries explicitly. Published
portfolio artifacts must keep serving independently of dashboard and app health.

Preserve existing Hostlet resources and billing records. M3.5 authorizes
an isolated preview and reversible exact-host cutover on existing resources.
Provider purchases, customer admission and production data changes remain
outside that scope.
