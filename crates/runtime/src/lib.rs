//! Runtime reconciler command scaffold.

use std::io::Write;

use hostlet_contracts::{PROTOCOL_VERSION, validate_protocol_version};

pub const SERVICE_NAME: &str = "hostlet-runtime";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Version,
    CheckConfig,
    Run,
}

pub fn parse_action(args: &[String]) -> Result<Action, String> {
    match args {
        [] => Ok(Action::Run),
        [flag] if flag == "--version" => Ok(Action::Version),
        [flag] if flag == "--check-config" => Ok(Action::CheckConfig),
        [flag] => Err(format!(
            "unknown argument {flag}; use --version or --check-config"
        )),
        _ => Err("expected at most one argument; use --version or --check-config".to_owned()),
    }
}

pub fn execute<W: Write, E: Write>(args: &[String], output: &mut W, error: &mut E) -> i32 {
    let action = match parse_action(args) {
        Ok(action) => action,
        Err(message) => {
            let _ = writeln!(error, "{message}");
            return 2;
        }
    };

    match action {
        Action::Version => {
            let _ = writeln!(output, "{SERVICE_NAME} {}", env!("CARGO_PKG_VERSION"));
            0
        }
        Action::CheckConfig => match validate_protocol_version(PROTOCOL_VERSION) {
            Ok(()) => {
                let _ = writeln!(
                    error,
                    "{SERVICE_NAME} scaffold is not configured; enrollment is not configured"
                );
                1
            }
            Err(protocol_error) => {
                let _ = writeln!(error, "protocol configuration error: {protocol_error}");
                2
            }
        },
        Action::Run => {
            let _ = writeln!(
                error,
                "{SERVICE_NAME} scaffold not enrolled; no agent work is executed"
            );
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scaffold_commands_are_explicit() {
        assert_eq!(parse_action(&[]).unwrap(), Action::Run);
        assert_eq!(
            parse_action(&["--version".to_owned()]).unwrap(),
            Action::Version
        );
        assert_eq!(
            parse_action(&["--check-config".to_owned()]).unwrap(),
            Action::CheckConfig
        );
    }

    #[test]
    fn default_execution_refuses_to_simulate_a_reconciler() {
        let mut output = Vec::new();
        let mut error = Vec::new();
        assert_eq!(execute(&[], &mut output, &mut error), 1);
        assert!(
            String::from_utf8(error)
                .unwrap()
                .contains("scaffold not enrolled")
        );
    }
}
