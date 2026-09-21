# Infrastructure boundary

No deploy or provisioning automation is installed by this scaffold.

The plan separates trusted control/data, private OCI registry, tenant runtime,
builder supervisor and ingress. Customer builds run in fresh disposable VMs;
tenant applications run in the isolated Docker/gVisor zone. Organization CI is
reserved for platform validation and must not execute customer workloads.

Define fresh environment-scoped resources and identities when infrastructure
implementation begins. Preserve all existing Hostlet guests, data, routes,
registry artifacts and billing records. The shared homelab failure domain is
not an HA deployment.
