use std::process::ExitCode;

#[tokio::main]
async fn main() -> ExitCode {
    let config = match hostlet_control::Config::from_env() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("configuration error: {error}");
            return ExitCode::from(2);
        }
    };

    if let Err(error) = hostlet_control::serve(config).await {
        eprintln!("control API stopped with an error: {error}");
        ExitCode::from(1)
    } else {
        ExitCode::SUCCESS
    }
}
