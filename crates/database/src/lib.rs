mod archive;
mod control;
mod hca;
mod postgres;
mod worker;

use std::io::Write;

pub fn execute(args: &[String], output: &mut impl Write, error: &mut impl Write) -> i32 {
    if args.first().map(String::as_str) != Some("worker") {
        let _ = writeln!(error, "{}", worker::USAGE);
        return 2;
    }
    let options = match worker::Options::parse(&args[1..]) {
        Ok(options) => options,
        Err(failure) => {
            let _ = writeln!(error, "{}", failure.safe_message());
            let _ = writeln!(error, "{}", worker::USAGE);
            return failure.exit_code();
        }
    };
    match worker::run(options, output) {
        Ok(()) => 0,
        Err(failure) => {
            let _ = writeln!(error, "{}", failure.safe_message());
            failure.exit_code()
        }
    }
}
