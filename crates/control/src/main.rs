use std::{collections::HashMap, path::PathBuf, process::ExitCode, time::Duration};

use chrono::{DateTime, Utc};
use hostlet_control::{config::ProcessConfig, db, recovery};
use uuid::Uuid;

const USAGE: &str = "usage: hostlet-control [migrate [--repository DIR --backup-id UUID] | backup create --repository DIR [--intended-migration N] [--scheduled-for RFC3339] | backup verify --repository DIR --backup-id UUID | backup schedule --repository DIR [--effective-at RFC3339] | restore --repository DIR --backup-id UUID]";

enum Command {
    Serve,
    Migrate(Option<Selection>),
    Create {
        repository: PathBuf,
        intended: Option<i64>,
        scheduled: Option<DateTime<Utc>>,
    },
    Verify(Selection),
    Schedule {
        repository: PathBuf,
        effective_at: DateTime<Utc>,
    },
    Restore(Selection),
}

struct Selection {
    repository: PathBuf,
    backup_id: Uuid,
}

impl Selection {
    fn borrowed(&self) -> recovery::BackupSelection<'_> {
        recovery::BackupSelection {
            repository: &self.repository,
            backup_id: self.backup_id,
        }
    }
}

fn parse_command(args: &[String]) -> Result<Command, ()> {
    let (kind, remaining) = match args {
        [] => return Ok(Command::Serve),
        [first] if first == "migrate" => return Ok(Command::Migrate(None)),
        [first, rest @ ..] if first == "migrate" => ("migrate", rest),
        [first, rest @ ..] if first == "restore" => ("restore", rest),
        [first, second, rest @ ..]
            if first == "backup" && matches!(second.as_str(), "create" | "verify" | "schedule") =>
        {
            (second.as_str(), rest)
        }
        _ => return Err(()),
    };
    if !remaining.len().is_multiple_of(2) {
        return Err(());
    }
    let mut flags = HashMap::new();
    for pair in remaining.chunks_exact(2) {
        if pair[1].is_empty() || flags.insert(pair[0].as_str(), pair[1].as_str()).is_some() {
            return Err(());
        }
    }
    let repository = PathBuf::from(flags.remove("--repository").ok_or(())?);
    let result = match kind {
        "migrate" | "verify" | "restore" => {
            let backup_id =
                Uuid::parse_str(flags.remove("--backup-id").ok_or(())?).map_err(|_| ())?;
            let selection = Selection {
                repository,
                backup_id,
            };
            match kind {
                "migrate" => Command::Migrate(Some(selection)),
                "verify" => Command::Verify(selection),
                _ => Command::Restore(selection),
            }
        }
        "create" => {
            let intended = flags
                .remove("--intended-migration")
                .map(|value| value.parse::<i64>().ok().filter(|v| *v > 0).ok_or(()))
                .transpose()?;
            let scheduled = flags
                .remove("--scheduled-for")
                .map(parse_timestamp)
                .transpose()?;
            Command::Create {
                repository,
                intended,
                scheduled,
            }
        }
        "schedule" => Command::Schedule {
            repository,
            effective_at: flags
                .remove("--effective-at")
                .map(parse_timestamp)
                .transpose()?
                .unwrap_or_else(Utc::now),
        },
        _ => return Err(()),
    };
    if flags.is_empty() {
        Ok(result)
    } else {
        Err(())
    }
}

fn parse_timestamp(value: &str) -> Result<DateTime<Utc>, ()> {
    DateTime::parse_from_rfc3339(value)
        .map(|time| time.with_timezone(&Utc))
        .map_err(|_| ())
}

fn tool_mode() -> recovery::PgToolMode {
    match std::env::var("HOSTLET_PG_CONTAINER") {
        Ok(container) => recovery::PgToolMode::Docker { container },
        Err(_) => recovery::PgToolMode::Host,
    }
}

fn print_receipt(receipt: &impl serde::Serialize) -> Result<(), String> {
    let encoded = serde_json::to_string(receipt)
        .map_err(|_| "recovery receipt encoding failed".to_owned())?;
    println!("{encoded}");
    Ok(())
}

fn source_database_url() -> Result<String, String> {
    std::env::var("DATABASE_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "DATABASE_URL is required for this command".to_owned())
}

async fn execute(command: Command) -> Result<(), String> {
    if matches!(command, Command::Serve) {
        let config = ProcessConfig::from_env().map_err(|error| error.to_string())?;
        return hostlet_control::serve_process(config)
            .await
            .map_err(|error| error.to_string());
    }
    if matches!(command, Command::Migrate(None)) {
        return db::run_migrations(&source_database_url()?, None)
            .await
            .map_err(|error| error.to_string());
    }
    let key =
        hostlet_control::config::recovery_key_from_env().map_err(|error| error.to_string())?;
    let key = &key;
    match command {
        Command::Migrate(Some(selection)) => {
            let database_url = source_database_url()?;
            let maximum_age = match std::env::var("HOSTLET_BACKUP_MAX_AGE_SECONDS") {
                Ok(value) => value
                    .parse::<u64>()
                    .ok()
                    .filter(|seconds| (1..=3600).contains(seconds))
                    .ok_or_else(|| {
                        "HOSTLET_BACKUP_MAX_AGE_SECONDS must be from 1 through 3600".to_owned()
                    })?,
                Err(_) => 3600,
            };
            db::run_migrations(
                &database_url,
                Some(db::UpgradeBackup {
                    selection: selection.borrowed(),
                    key,
                    maximum_age: Duration::from_secs(maximum_age),
                }),
            )
            .await
            .map_err(|error| error.to_string())
        }
        Command::Create {
            repository,
            intended,
            scheduled,
        } => {
            let database_url = source_database_url()?;
            let receipt = recovery::create_backup(
                recovery::BackupRequest {
                    database_url: &database_url,
                    repository: &repository,
                    intended_migration: intended,
                    scheduled_for: scheduled,
                    tool_mode: tool_mode(),
                },
                key,
            )
            .await
            .map_err(|error| error.to_string())?;
            print_receipt(&receipt)
        }
        Command::Verify(selection) => {
            let receipt = recovery::verify_backup(selection.borrowed(), key)
                .await
                .map_err(|error| error.to_string())?;
            print_receipt(&receipt)
        }
        Command::Schedule {
            repository,
            effective_at,
        } => {
            let database_url = source_database_url()?;
            let receipt = recovery::run_scheduled_backup(
                recovery::ScheduledBackupRequest {
                    database_url: &database_url,
                    repository: &repository,
                    effective_at,
                    tool_mode: tool_mode(),
                },
                key,
            )
            .await
            .map_err(|error| error.to_string())?;
            print_receipt(&receipt)
        }
        Command::Restore(selection) => {
            let target_database_url = std::env::var("HOSTLET_RESTORE_DATABASE_URL")
                .map_err(|_| "HOSTLET_RESTORE_DATABASE_URL is required for restore".to_owned())?;
            let receipt = recovery::restore_backup(
                recovery::RestoreRequest {
                    target_database_url: &target_database_url,
                    selection: selection.borrowed(),
                    tool_mode: tool_mode(),
                },
                key,
            )
            .await
            .map_err(|error| error.to_string())?;
            print_receipt(&receipt)
        }
        Command::Serve | Command::Migrate(None) => unreachable!(),
    }
}

#[tokio::main]
async fn main() -> ExitCode {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let command = match parse_command(&arguments) {
        Ok(command) => command,
        Err(()) => {
            eprintln!("{USAGE}");
            return ExitCode::from(2);
        }
    };
    match execute(command).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::from(1)
        }
    }
}
