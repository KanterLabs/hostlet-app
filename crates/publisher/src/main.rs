mod render;
mod server;
mod worker;

use std::process::ExitCode;

#[tokio::main]
async fn main() -> ExitCode {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let result = match args.first().map(String::as_str) {
        Some("worker") => {
            let worker_args = args[1..].to_vec();
            tokio::task::spawn_blocking(move || worker::run(&worker_args))
                .await
                .map_err(|_| "publisher_worker_join_failed".to_owned())
                .and_then(|result| result.map_err(str::to_owned))
        }
        Some("serve") => server::run(&args[1..]).await.map_err(|error| error.to_string()),
        Some("--version") if args.len() == 1 => {
            println!("hostlet-publisher {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        _ => Err("usage: hostlet-publisher worker --control-url http://127.0.0.1:PORT --worker-id ID [--once] | serve --root ABSOLUTE_PATH --bind IP:PORT --expected-host HOST".to_owned()),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::from(2)
        }
    }
}
