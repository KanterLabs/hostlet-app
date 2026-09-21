use std::process::ExitCode;

#[tokio::main]
async fn main() -> ExitCode {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let migrate = match arguments.as_slice() {
        [] => false,
        [command] if command == "migrate" => true,
        _ => {
            eprintln!("usage: hostlet-control [migrate]");
            return ExitCode::from(2);
        }
    };
    let config = match hostlet_control::config::ProcessConfig::from_env() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("configuration error: {error}");
            return ExitCode::from(2);
        }
    };

    if migrate {
        match hostlet_control::migrate(config).await {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("{error}");
                ExitCode::from(1)
            }
        }
    } else {
        match hostlet_control::serve_process(config).await {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("control API stopped with an error: {error}");
                ExitCode::from(1)
            }
        }
    }
}
