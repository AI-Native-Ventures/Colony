//! Controlled operator analytics maintenance commands.

use anyhow::{bail, Result};
use buzz_core::CommunityId;
use chrono::{DateTime, NaiveDate, NaiveTime, Utc};
use clap::Subcommand;
use uuid::Uuid;

#[derive(Subcommand)]
pub(crate) enum Command {
    /// Rebuild a bounded historical UTC range from authoritative events.
    Backfill {
        /// Community UUID to rebuild. Repeat for multiple communities.
        #[arg(
            long,
            action = clap::ArgAction::Append,
            required_unless_present = "all",
            conflicts_with = "all"
        )]
        community: Vec<String>,

        /// Rebuild every active community in the deployment.
        #[arg(
            long,
            required_unless_present = "community",
            conflicts_with = "community"
        )]
        all: bool,

        /// Inclusive first UTC day, YYYY-MM-DD.
        #[arg(long)]
        from: String,

        /// Exclusive UTC day boundary, YYYY-MM-DD.
        #[arg(long)]
        to: String,

        /// Source events per transactional read batch.
        #[arg(long, default_value_t = 1_000, value_parser = clap::value_parser!(u16).range(100..=5_000))]
        batch_size: u16,
    },
}

pub(crate) async fn run(command: Command) -> Result<i32> {
    match command {
        Command::Backfill {
            community,
            all,
            from,
            to,
            batch_size,
        } => backfill(community, all, &from, &to, batch_size).await,
    }
}

async fn backfill(
    community_args: Vec<String>,
    all: bool,
    from: &str,
    to: &str,
    batch_size: u16,
) -> Result<i32> {
    let start = utc_day(from, "from")?;
    let end = utc_day(to, "to")?;
    if start >= end {
        bail!("--from must precede --to");
    }

    let db = super::connect_db().await?;
    let communities = if all {
        db.list_active_communities().await?
    } else {
        let mut selected = Vec::with_capacity(community_args.len());
        for value in community_args {
            let id =
                Uuid::parse_str(&value).map_err(|_| anyhow::anyhow!("invalid --community UUID"))?;
            let community_id = CommunityId::from_uuid(id);
            let host = db
                .lookup_community_host(community_id)
                .await?
                .ok_or_else(|| anyhow::anyhow!("community {id} does not exist"))?;
            selected.push(buzz_db::CommunityRecord {
                id: community_id,
                host,
            });
        }
        selected
    };
    if communities.is_empty() {
        println!("No communities selected; nothing to rebuild.");
        return Ok(0);
    }

    let mut failures = Vec::new();
    for community in communities {
        match db
            .operator_rebuild_activity_with_batch_size(
                community.id,
                start,
                end,
                i64::from(batch_size),
            )
            .await
        {
            Ok(result) => {
                let watermark = result
                    .cursor
                    .last_created_at
                    .map_or_else(|| "none".to_owned(), |value| value.to_rfc3339());
                println!(
                    "community={} host={} source_rows={} qualifying_rows={} aggregate_rows={} watermark={}",
                    community.id,
                    community.host,
                    result.source_rows,
                    result.qualifying_rows,
                    result.aggregate_rows,
                    watermark,
                );
            }
            Err(error) => {
                eprintln!(
                    "community={} host={} failed: {}",
                    community.id, community.host, error
                );
                failures.push(community.id.to_string());
            }
        }
    }
    if !failures.is_empty() {
        bail!(
            "analytics backfill failed for {} communities",
            failures.len()
        );
    }
    Ok(0)
}

fn utc_day(value: &str, flag: &str) -> Result<DateTime<Utc>> {
    let date = NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| anyhow::anyhow!("--{flag} must be YYYY-MM-DD"))?;
    Ok(DateTime::from_naive_utc_and_offset(
        date.and_time(NaiveTime::MIN),
        Utc,
    ))
}

#[cfg(test)]
mod tests {
    use clap::Parser;

    use super::*;
    use crate::Cli;

    #[test]
    fn backfill_requires_explicit_scope() {
        assert!(Cli::try_parse_from([
            "buzz-admin",
            "operator-analytics",
            "backfill",
            "--from",
            "2026-08-01",
            "--to",
            "2026-08-02",
        ])
        .is_err());
    }

    #[test]
    fn backfill_batch_size_is_bounded() {
        assert!(Cli::try_parse_from([
            "buzz-admin",
            "operator-analytics",
            "backfill",
            "--all",
            "--from",
            "2026-08-01",
            "--to",
            "2026-08-02",
            "--batch-size",
            "99",
        ])
        .is_err());
    }

    #[test]
    fn utc_range_parser_is_strict() {
        assert!(utc_day("2026-08-01", "from").is_ok());
        assert!(utc_day("08/01/2026", "from").is_err());
    }
}
