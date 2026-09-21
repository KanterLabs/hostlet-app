use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut output = std::io::stdout().lock();
    let mut error = std::io::stderr().lock();
    match hostlet_builder::execute(&args, &mut output, &mut error) {
        0 => ExitCode::SUCCESS,
        code => ExitCode::from(code as u8),
    }
}
