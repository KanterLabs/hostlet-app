//! Versioned wire values shared by Hostlet services and agents.

use std::fmt;

use serde::{Deserialize, Serialize};

pub mod project;

/// The only agent protocol accepted by this first release.
pub const PROTOCOL_VERSION: &str = "hostlet.agent/v1";

/// Browser-facing API prefix for this first release.
pub const API_PREFIX: &str = "/v1";

/// The response served by a service's version endpoint.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VersionResponse {
    pub service: String,
    pub version: String,
    pub protocol_version: String,
}

impl VersionResponse {
    pub fn new(
        service: impl Into<String>,
        version: impl Into<String>,
        protocol_version: impl Into<String>,
    ) -> Self {
        Self {
            service: service.into(),
            version: version.into(),
            protocol_version: protocol_version.into(),
        }
    }
}

/// Returned when a message asks to use a protocol version that this binary
/// does not understand. Callers should map this to `protocol_incompatible`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnsupportedProtocolVersion {
    pub received: String,
}

impl fmt::Display for UnsupportedProtocolVersion {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "unsupported protocol version: {}", self.received)
    }
}

impl std::error::Error for UnsupportedProtocolVersion {}

/// Validate an incoming protocol version without fallback or downgrade.
pub fn validate_protocol_version(version: &str) -> Result<(), UnsupportedProtocolVersion> {
    if version == PROTOCOL_VERSION {
        Ok(())
    } else {
        Err(UnsupportedProtocolVersion {
            received: version.to_owned(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_the_current_protocol() {
        assert!(validate_protocol_version(PROTOCOL_VERSION).is_ok());

        let error = validate_protocol_version("hostlet.agent/v2").unwrap_err();
        assert_eq!(error.received, "hostlet.agent/v2");
    }
}
