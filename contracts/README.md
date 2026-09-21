# Wire contracts

`v1/version.json` is the shared version-response fixture for the development
control API at `GET /v1/version`. The agent protocol identifier is
`hostlet.agent/v1`; unknown versions must be rejected explicitly.

This is the first contract only. Future identity, jobs, leases, fences, errors
and agent messages need versioned types and focused compatibility checks before
they can accept real work. No enrollment or agent work endpoint exists yet.
