#![deny(unsafe_code)]

//! Buzz instance administration CLI.
//!
//! # Member management (NIP-43)
//!
//! ## Why only kind:13534 (membership list), not kind:8000/8001 (deltas)
//!
//! CLI intentionally does not emit kind 8000/8001 deltas —
//! `publish_nip43_delta` is in-process-only (no Redis hop), so a sidecar call
//! stores but never pushes. The 13534 list snapshot is the authoritative roster
//! and rides Redis to live clients. Do not wire a delta call that passes
//! in-process tests and silently no-ops in the deployed `compose exec` path.
//!
//! ## Same-second domination guard
//!
//! The `custom_created_at = max(now, newest_existing_13534 + 1s)` bump defeats
//! same-second domination for serial invocations; it does NOT serialize
//! concurrent CLI processes — two near-simultaneous adds can read the same
//! newest timestamp and collide on the bumped second. run.sh serialization is
//! the guard against parallel adds (e.g. `xargs -P`).

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{bail, Result};
use buzz_core::kind::KIND_NIP43_MEMBERSHIP_LIST;
use buzz_core::tenant::{relay_url_authority, TenantContext};
use buzz_db::credits::{self, NANOUSD_PER_USD};
use buzz_db::{Db, DbConfig};
use buzz_pubsub::{EventTopic, PubSubManager};
use chrono::NaiveDate;
use clap::{Parser, Subcommand};
use nostr::{EventBuilder, Keys, Kind, Tag};
use tracing::warn;

#[derive(Parser)]
#[command(name = "buzz-admin", about = "Buzz instance administration")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Add a pubkey to the relay membership list.
    ///
    /// Accepts a bech32 npub or 64-char hex pubkey. After inserting the DB row,
    /// publishes a kind:13534 membership roster via Redis so live clients see
    /// the updated list immediately.
    AddMember {
        /// Nostr public key — bech32 npub or 64-char hex.
        #[arg(long)]
        pubkey: String,

        /// Role: "admin" or "member" (default: member). Cannot be "owner" —
        /// use RELAY_OWNER_PUBKEY config to set the relay owner.
        #[arg(long, default_value = "member")]
        role: String,
    },
    /// Remove a pubkey from the relay membership list.
    ///
    /// Accepts a bech32 npub or 64-char hex pubkey. After removing the DB row,
    /// publishes a kind:13534 membership roster via Redis. Cannot remove the
    /// relay owner — change RELAY_OWNER_PUBKEY config instead.
    RemoveMember {
        /// Nostr public key — bech32 npub or 64-char hex.
        #[arg(long)]
        pubkey: String,

        /// Only remove if the member's current role matches this value.
        /// Omit to remove regardless of role.
        #[arg(long)]
        role: Option<String>,
    },
    /// List all relay members.
    ListMembers,
    /// Generate a new Nostr keypair (for bootstrapping).
    GenerateKey,
    /// Run pending database migrations.
    Migrate,
    /// Inspect deployment-wide Buzz product feedback.
    ProductFeedback {
        #[command(subcommand)]
        command: ProductFeedbackCommand,
    },
    /// Emit kind:39000/39002 events for channels missing them.
    ///
    /// Channels created via direct SQL (seed scripts, pre-migration data) won't
    /// have Nostr discovery events. This command creates them so pure-nostr
    /// clients can see those channels. Idempotent — safe to run multiple times.
    ReconcileChannels {
        /// Relay private key (hex) for signing events. Falls back to
        /// BUZZ_RELAY_PRIVATE_KEY env var. If neither is set, generates
        /// an ephemeral key (events will be unverifiable after restart).
        #[arg(long)]
        relay_key: Option<String>,
    },
    /// Colony Credits: seed balances, read balances, reconcile against the
    /// Vercel usage export. Money is nanoUSD integers end to end.
    Credits {
        #[command(subcommand)]
        command: CreditsCommand,
    },
}

#[derive(Subcommand)]
enum CreditsCommand {
    /// Seed a credit balance (Phase 1 money in). Idempotent on --ref.
    Seed {
        /// Account pubkey — bech32 npub or 64-char hex.
        #[arg(long)]
        pubkey: String,
        /// Amount in US dollars (converted to nanoUSD; never stored as a float).
        #[arg(long)]
        usd: f64,
        /// Idempotency reference — the same ref twice credits once.
        #[arg(long)]
        r#ref: String,
    },
    /// Show an account's current balance.
    Balance {
        /// Account pubkey — bech32 npub or 64-char hex.
        #[arg(long)]
        pubkey: String,
    },
    /// Reconcile credit_ledger debits for one UTC day against the Vercel AI
    /// Gateway usage export. Exits non-zero when drift exceeds 1%.
    Reconcile {
        /// UTC day to reconcile, YYYY-MM-DD.
        #[arg(long)]
        date: String,
        /// Path to the Vercel usage CSV export.
        #[arg(long)]
        vercel_csv: PathBuf,
    },
}

#[derive(Subcommand)]
enum ProductFeedbackCommand {
    /// List feedback across every community as JSON.
    List {
        /// Maximum records to return.
        #[arg(long, default_value_t = 100, value_parser = clap::value_parser!(u16).range(1..=1000))]
        limit: u16,
    },
}

#[tokio::main]
async fn main() {
    // Install the ring CryptoProvider for rustls. The workspace redis TLS
    // feature compiles both aws-lc-rs and ring in transitively, so rustls can't
    // auto-select a provider and would panic on the first rediss:// (ElastiCache)
    // Redis TLS connection without this. Mirrors buzz-relay's main().
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("failed to install rustls crypto provider");

    let cli = Cli::parse();

    let code = match run(cli).await {
        Ok(code) => code,
        Err(e) => {
            eprintln!("error: {e}");
            5
        }
    };
    std::process::exit(code);
}

async fn run(cli: Cli) -> Result<i32> {
    match cli.command {
        Command::GenerateKey => {
            let keys = Keys::generate();
            println!("Public key:  {}", keys.public_key().to_hex());
            println!("Secret key:  {}", keys.secret_key().display_secret());
            println!("\nSet BUZZ_PRIVATE_KEY to the secret key to use this identity.");
            Ok(0)
        }
        Command::Migrate => {
            let db = connect_db().await?;
            db.migrate().await?;
            println!("Database migrations complete.");
            Ok(0)
        }
        Command::AddMember { pubkey, role } => cmd_add_member(pubkey, role).await,
        Command::RemoveMember { pubkey, role } => cmd_remove_member(pubkey, role).await,
        Command::ListMembers => cmd_list_members().await,
        Command::ProductFeedback {
            command: ProductFeedbackCommand::List { limit },
        } => cmd_list_product_feedback(limit).await,
        Command::ReconcileChannels { relay_key } => {
            reconcile_channels(relay_key).await?;
            Ok(0)
        }
        Command::Credits { command } => cmd_credits(command).await,
    }
}

async fn cmd_add_member(pubkey_arg: String, role: String) -> Result<i32> {
    if let Err(msg) = validate_role(&role) {
        eprintln!("error: {msg}");
        return Ok(1);
    }

    let pubkey_hex = match parse_pubkey_hex(&pubkey_arg) {
        Ok(h) => h,
        Err(msg) => {
            eprintln!("error: {msg}");
            return Ok(1);
        }
    };

    let (db, pubsub, relay_keypair) = connect_member_services().await?;

    let tenant = resolve_admin_tenant(&db).await?;
    match db
        .add_relay_member(tenant.community(), &pubkey_hex, &role, None)
        .await
    {
        Ok(true) => println!("added {pubkey_hex} as {role}"),
        Ok(false) => println!("already a member: {pubkey_hex} (no change)"),
        Err(e) => {
            eprintln!("error: DB write failed: {e}");
            return Ok(5);
        }
    }

    if let Err(e) = publish_membership_list_with_bump(&db, &pubsub, &relay_keypair, &tenant).await {
        eprintln!("warning: member added to DB but list publish failed: {e}");
    }

    Ok(0)
}

async fn cmd_remove_member(pubkey_arg: String, role_filter: Option<String>) -> Result<i32> {
    if let Some(ref role) = role_filter {
        if let Err(msg) = validate_role(role) {
            eprintln!("error: {msg}");
            return Ok(1);
        }
    }

    let pubkey_hex = match parse_pubkey_hex(&pubkey_arg) {
        Ok(h) => h,
        Err(msg) => {
            eprintln!("error: {msg}");
            return Ok(1);
        }
    };

    let (db, pubsub, relay_keypair) = connect_member_services().await?;

    let tenant = resolve_admin_tenant(&db).await?;
    use buzz_db::relay_members::RemoveResult;
    let result = if let Some(ref role) = role_filter {
        db.remove_relay_member_if_role(tenant.community(), &pubkey_hex, role)
            .await
    } else {
        db.remove_relay_member(tenant.community(), &pubkey_hex)
            .await
    };

    match result {
        Ok(RemoveResult::Removed) => println!("removed {pubkey_hex}"),
        Ok(RemoveResult::NotFound) => {
            eprintln!("error: member not found: {pubkey_hex}");
            return Ok(2);
        }
        Ok(RemoveResult::IsOwner) => {
            eprintln!(
                "error: cannot remove relay owner: {pubkey_hex}\n\
                 To change the owner, update RELAY_OWNER_PUBKEY and restart."
            );
            return Ok(3);
        }
        Ok(RemoveResult::RoleMismatch) => {
            let role_str = role_filter.as_deref().unwrap_or("(unknown)");
            eprintln!("error: role mismatch — {pubkey_hex} is not currently '{role_str}'");
            return Ok(4);
        }
        Err(e) => {
            eprintln!("error: DB write failed: {e}");
            return Ok(5);
        }
    }

    if let Err(e) = publish_membership_list_with_bump(&db, &pubsub, &relay_keypair, &tenant).await {
        eprintln!("warning: member removed from DB but list publish failed: {e}");
    }

    Ok(0)
}

async fn cmd_list_product_feedback(limit: u16) -> Result<i32> {
    let db = connect_db().await?;
    let feedback = db.list_product_feedback(i64::from(limit)).await?;
    println!("{}", serde_json::to_string_pretty(&feedback)?);
    Ok(0)
}

async fn cmd_list_members() -> Result<i32> {
    let db = connect_db().await?;
    let tenant = resolve_admin_tenant(&db).await?;
    let members = db.list_relay_members(tenant.community()).await?;

    if members.is_empty() {
        println!("(no relay members)");
        return Ok(0);
    }

    println!(
        "{:<66} {:<8} {:<66} created_at",
        "pubkey", "role", "added_by"
    );
    println!("{}", "-".repeat(160));
    for m in &members {
        let added_by = m.added_by.as_deref().unwrap_or("-");
        println!(
            "{:<66} {:<8} {:<66} {}",
            m.pubkey,
            m.role,
            added_by,
            m.created_at.format("%Y-%m-%dT%H:%M:%SZ")
        );
    }

    Ok(0)
}

/// Validate that `role` is `"member"` or `"admin"`. Rejects `"owner"`.
fn validate_role(role: &str) -> std::result::Result<(), String> {
    match role {
        "member" | "admin" => Ok(()),
        "owner" => {
            Err("role 'owner' cannot be set via CLI — use RELAY_OWNER_PUBKEY config".to_string())
        }
        other => Err(format!(
            "invalid role '{other}': must be 'member' or 'admin'"
        )),
    }
}

/// Parse a bech32 npub or 64-char hex pubkey into lowercase hex.
fn parse_pubkey_hex(input: &str) -> std::result::Result<String, String> {
    nostr::PublicKey::parse(input)
        .map(|pk| pk.to_hex())
        .map_err(|e| format!("invalid pubkey '{input}': {e}"))
}

/// Publish kind:13534 with `custom_created_at = max(now, newest_existing + 1s)`.
///
/// Guarantees the new event is not dominated by a same-second prior invocation,
/// so `replace_addressable_event` always inserts and dispatches to Redis.
///
/// See module-level doc for the TOCTOU caveat on concurrent CLI processes.
async fn publish_membership_list_with_bump(
    db: &Db,
    pubsub: &Arc<PubSubManager>,
    relay_keypair: &Keys,
    tenant: &TenantContext,
) -> Result<()> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let relay_pubkey = relay_keypair.public_key();
    let relay_pubkey_bytes = relay_pubkey.to_bytes();

    // Query the newest existing kind:13534 for this relay's pubkey (channel_id=None).
    let newest_ts = db
        .get_latest_global_replaceable(
            tenant.community(),
            KIND_NIP43_MEMBERSHIP_LIST as i32,
            &relay_pubkey_bytes,
        )
        .await?
        .map(|e| e.event.created_at.as_secs());

    // custom_created_at = max(now, existing + 1s) — defeats same-second domination.
    let ts = match newest_ts {
        Some(existing) => (existing + 1).max(now),
        None => now,
    };

    let members = db.list_relay_members(tenant.community()).await?;

    let mut tags: Vec<Tag> = Vec::with_capacity(members.len() + 1);
    // NIP-70 protected-event marker — prevents re-broadcasting by third parties.
    tags.push(Tag::parse(["-"]).map_err(|e| anyhow::anyhow!("failed to build '-' tag: {e}"))?);
    for member in &members {
        tags.push(
            Tag::parse(["member", &member.pubkey, &member.role])
                .map_err(|e| anyhow::anyhow!("failed to build member tag: {e}"))?,
        );
    }

    let event = EventBuilder::new(Kind::Custom(KIND_NIP43_MEMBERSHIP_LIST as u16), "")
        .tags(tags)
        .custom_created_at(nostr::Timestamp::from(ts))
        .sign_with_keys(relay_keypair)
        .map_err(|e| anyhow::anyhow!("failed to sign kind:13534: {e}"))?;

    let (stored, was_inserted) = db
        .replace_addressable_event(tenant.community(), &event, None)
        .await?;
    if was_inserted.was_inserted() {
        // Publish to Redis so live clients receive the updated roster.
        // Community-global scope (EventTopic::Global) matches the relay's own
        // membership-list publish path; the tenant fixes the community.
        if let Err(e) = pubsub
            .publish_event(tenant, EventTopic::Global, &stored.event)
            .await
        {
            warn!("Redis publish of kind:13534 failed: {e}");
        }
    }

    tracing::info!(
        member_count = members.len(),
        ts,
        "NIP-43 membership list published by buzz-admin"
    );
    Ok(())
}

/// Connect to DB, Redis pub/sub, and load the relay keypair.
///
/// `BUZZ_RELAY_PRIVATE_KEY` is required — the CLI signs kind:13534 events.
async fn connect_member_services() -> Result<(Db, Arc<PubSubManager>, Keys)> {
    let db = connect_db().await?;

    let relay_keypair = {
        let hex = std::env::var("BUZZ_RELAY_PRIVATE_KEY").map_err(|_| {
            anyhow::anyhow!(
                "BUZZ_RELAY_PRIVATE_KEY is required for add-member/remove-member.\n\
                 The relay must have a stable signing key to publish kind:13534 events."
            )
        })?;
        Keys::parse(&hex).map_err(|e| anyhow::anyhow!("invalid BUZZ_RELAY_PRIVATE_KEY: {e}"))?
    };

    let redis_url =
        std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://localhost:6379".to_string());

    let redis_pool = {
        let cfg = deadpool_redis::Config::from_url(&redis_url);
        cfg.create_pool(Some(deadpool_redis::Runtime::Tokio1))
            .map_err(|e| anyhow::anyhow!("Redis pool creation failed: {e}"))?
    };

    let pubsub = Arc::new(
        PubSubManager::new(&redis_url, redis_pool)
            .await
            .map_err(|e| anyhow::anyhow!("PubSub init failed: {e}"))?,
    );

    Ok((db, pubsub, relay_keypair))
}

async fn connect_db() -> Result<Db> {
    let db_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://buzz:buzz_dev@localhost:5432/buzz".to_string());
    let db = Db::new(&DbConfig {
        database_url: db_url,
        ..DbConfig::default()
    })
    .await?;
    Ok(db)
}

/// Resolve the deployment's tenant from the configured `RELAY_URL` host.
///
/// `buzz-admin` runs inside the relay container (`compose exec relay
/// buzz-admin …`), so it shares the relay's `RELAY_URL` and resolves the same
/// single community against the durable `communities` host map. This is
/// deliberately NOT a default tenant: an unmapped host fails closed with an
/// error, mirroring the relay's own `bind_community` row-zero seam. The CLI is
/// single-community per invocation — there is no cross-community sweep.
async fn resolve_admin_tenant(db: &Db) -> Result<TenantContext> {
    let relay_url =
        std::env::var("RELAY_URL").unwrap_or_else(|_| "ws://localhost:3000".to_string());
    // Derive the authority the *same* way startup seeding and live request
    // resolution do (`buzz_core::tenant::relay_url_authority`): host plus an
    // explicit non-default port, IPv6 brackets preserved. A plain
    // `Url::host_str()` drops the port/brackets, so for `ws://localhost:3000`
    // the admin would look up `localhost` while startup seeded `localhost:3000`
    // — and `wss://relay.example:8443` would resolve `relay.example`. Sharing
    // the helper keeps buzz-admin byte-identical to the community startup seeds.
    let host = relay_url_authority(&relay_url);
    let record = db.lookup_community_by_host(&host).await?.ok_or_else(|| {
        anyhow::anyhow!(
            "RELAY_URL host '{host}' is not mapped to a community.\n\
             buzz-admin operates on the configured relay's community; ensure the \
             relay has started and seeded its community (or set RELAY_URL to a \
             mapped host)."
        )
    })?;
    Ok(TenantContext::resolved(record.id, record.host))
}

async fn reconcile_channels(relay_key_arg: Option<String>) -> Result<()> {
    use buzz_core::kind::KIND_NIP29_GROUP_ADMINS;
    use buzz_db::event::EventQuery;

    let db = connect_db().await?;

    // Resolve relay signing key: arg > env > ephemeral
    let relay_keys = match relay_key_arg.or_else(|| std::env::var("BUZZ_RELAY_PRIVATE_KEY").ok()) {
        Some(key_hex) => {
            Keys::parse(&key_hex).map_err(|e| anyhow::anyhow!("invalid relay key: {e}"))?
        }
        None => {
            let k = Keys::generate();
            eprintln!(
                "Warning: no relay key provided — using ephemeral key {}",
                k.public_key().to_hex()
            );
            eprintln!("Events signed with this key won't be verifiable after this run.");
            eprintln!("Pass --relay-key or set BUZZ_RELAY_PRIVATE_KEY for production use.");
            k
        }
    };

    let tenant = resolve_admin_tenant(&db).await?;
    let channels = db.list_channels(tenant.community(), None).await?;
    if channels.is_empty() {
        println!("No channels in database.");
        return Ok(());
    }

    let mut reconciled = 0u32;
    let mut skipped = 0u32;

    for channel in &channels {
        let channel_id_str = channel.id.to_string();

        // Check if kind:39000 already exists
        let existing = db
            .query_events(&EventQuery {
                kinds: Some(vec![39000]),
                d_tag: Some(channel_id_str.clone()),
                limit: Some(1),
                ..EventQuery::for_community(tenant.community())
            })
            .await
            .unwrap_or_default();

        if !existing.is_empty() {
            skipped += 1;
            continue;
        }

        let members = db.get_members(tenant.community(), channel.id).await?;

        // kind:39000 — channel metadata
        {
            let mut tags: Vec<Tag> = vec![Tag::parse(["d", &channel_id_str])?];
            tags.push(Tag::parse(["name", &channel.name])?);
            if let Some(ref desc) = channel.description {
                if !desc.is_empty() {
                    tags.push(Tag::parse(["about", desc])?);
                }
            }
            if channel.visibility == "private" {
                tags.push(Tag::parse(["private"])?);
            } else {
                tags.push(Tag::parse(["public"])?);
            }
            if channel.channel_type == "dm" {
                tags.push(Tag::parse(["hidden"])?);
            }
            tags.push(Tag::parse(["closed"])?);
            tags.push(Tag::parse(["t", &channel.channel_type])?);

            let event = EventBuilder::new(Kind::Custom(39000), "")
                .tags(tags)
                .sign_with_keys(&relay_keys)
                .map_err(|e| anyhow::anyhow!("sign kind:39000: {e}"))?;
            db.replace_addressable_event(tenant.community(), &event, Some(channel.id))
                .await?;
        }

        // kind:39001 — admins
        {
            let mut tags: Vec<Tag> = vec![Tag::parse(["d", &channel_id_str])?];
            for m in members
                .iter()
                .filter(|m| m.role == "owner" || m.role == "admin")
            {
                let pk = hex::encode(&m.pubkey);
                tags.push(Tag::parse(["p", &pk, &m.role])?);
            }
            let event = EventBuilder::new(Kind::Custom(KIND_NIP29_GROUP_ADMINS as u16), "")
                .tags(tags)
                .sign_with_keys(&relay_keys)
                .map_err(|e| anyhow::anyhow!("sign kind:39001: {e}"))?;
            db.replace_addressable_event(tenant.community(), &event, Some(channel.id))
                .await?;
        }

        // kind:39002 — members
        {
            let mut tags: Vec<Tag> = vec![Tag::parse(["d", &channel_id_str])?];
            for m in &members {
                let pk = hex::encode(&m.pubkey);
                tags.push(Tag::parse(["p", &pk, "", &m.role])?);
            }
            let event = EventBuilder::new(Kind::Custom(39002), "")
                .tags(tags)
                .sign_with_keys(&relay_keys)
                .map_err(|e| anyhow::anyhow!("sign kind:39002: {e}"))?;
            db.replace_addressable_event(tenant.community(), &event, Some(channel.id))
                .await?;
        }

        reconciled += 1;
    }

    println!(
        "Reconciled {reconciled} channels ({skipped} already had events, {} total).",
        channels.len()
    );
    Ok(())
}

// ---- Colony Credits -------------------------------------------------------

async fn cmd_credits(command: CreditsCommand) -> Result<i32> {
    match command {
        CreditsCommand::Seed { pubkey, usd, r#ref } => cmd_credits_seed(&pubkey, usd, &r#ref).await,
        CreditsCommand::Balance { pubkey } => cmd_credits_balance(&pubkey).await,
        CreditsCommand::Reconcile { date, vercel_csv } => {
            cmd_credits_reconcile(&date, &vercel_csv).await
        }
    }
}

async fn cmd_credits_seed(pubkey_arg: &str, usd: f64, reference: &str) -> Result<i32> {
    let pubkey_hex = match parse_pubkey_hex(pubkey_arg) {
        Ok(h) => h,
        Err(msg) => {
            eprintln!("error: {msg}");
            return Ok(1);
        }
    };
    let nanos = match usd_to_nanousd(usd) {
        Ok(n) => n,
        Err(msg) => {
            eprintln!("error: {msg}");
            return Ok(1);
        }
    };
    let db = connect_db().await?;
    let entry = credits::seed(db.pool(), &hex::decode(&pubkey_hex)?, nanos, reference).await?;
    println!(
        "seeded ${usd} ({nanos} nanoUSD) for {pubkey_hex} — ledger entry {} (kind {}, ref {reference})",
        entry.id, entry.kind
    );
    let bal = credits::balance(db.pool(), &hex::decode(&pubkey_hex)?).await?;
    println!(
        "new balance: {bal} nanoUSD (${:.6})",
        bal as f64 / NANOUSD_PER_USD
    );
    Ok(0)
}

async fn cmd_credits_balance(pubkey_arg: &str) -> Result<i32> {
    let pubkey_hex = match parse_pubkey_hex(pubkey_arg) {
        Ok(h) => h,
        Err(msg) => {
            eprintln!("error: {msg}");
            return Ok(1);
        }
    };
    let db = connect_db().await?;
    let bal = credits::balance(db.pool(), &hex::decode(&pubkey_hex)?).await?;
    println!(
        "{pubkey_hex}: {bal} nanoUSD (${:.6})",
        bal as f64 / NANOUSD_PER_USD
    );
    Ok(0)
}

async fn cmd_credits_reconcile(date_arg: &str, csv_path: &std::path::Path) -> Result<i32> {
    let day = NaiveDate::parse_from_str(date_arg, "%Y-%m-%d")
        .map_err(|e| anyhow::anyhow!("invalid --date '{date_arg}' (expected YYYY-MM-DD): {e}"))?;
    let db = connect_db().await?;
    let ledger = credits::debits_on_day(db.pool(), day).await?;
    let vercel = sum_vercel_csv(csv_path, day)?;

    let drift = if vercel == 0 {
        if ledger == 0 {
            0.0
        } else {
            f64::INFINITY
        }
    } else {
        (ledger as i128 - vercel as i128).unsigned_abs() as f64 / vercel as f64
    };

    println!(
        "reconcile {day}: ledger debits {ledger} nanoUSD (${:.6}) vs Vercel export {vercel} nanoUSD (${:.6})",
        ledger as f64 / NANOUSD_PER_USD,
        vercel as f64 / NANOUSD_PER_USD,
    );
    if drift > 0.01 {
        bail!(
            "drift {:.2}% exceeds the 1% threshold — ledger {} vs Vercel {} nanoUSD",
            drift * 100.0,
            ledger,
            vercel
        );
    }
    println!("drift {:.2}% — within the 1% threshold", drift * 100.0);
    Ok(0)
}

/// Convert a dollar amount to nanoUSD integers (rounding, sub-nano floor of
/// 1, negatives rejected) — the same money semantics as
/// `crates/buzz-meter/src/cost.rs::to_nanousd`.
fn usd_to_nanousd(usd: f64) -> std::result::Result<i64, String> {
    let nanos = (usd * NANOUSD_PER_USD).round();
    if !nanos.is_finite() || nanos < 0.0 || nanos > i64::MAX as f64 {
        return Err(format!("amount ${usd} cannot be represented in nanoUSD"));
    }
    if nanos == 0.0 && usd > 0.0 {
        return Ok(1);
    }
    Ok(nanos as i64)
}

/// Sum the cost column of a Vercel usage CSV export for one UTC day, in
/// nanoUSD. Column names are matched case-insensitively because Vercel's
/// export shape is not contractual; a row whose date column (if present) does
/// not fall on `day` is skipped.
fn sum_vercel_csv(path: &std::path::Path, day: NaiveDate) -> Result<i64> {
    let mut rdr = csv::Reader::from_path(path)
        .map_err(|e| anyhow::anyhow!("cannot read {}: {e}", path.display()))?;
    let headers = rdr
        .headers()
        .map_err(|e| anyhow::anyhow!("cannot read headers from {}: {e}", path.display()))?;

    let cost_col = headers
        .iter()
        .position(|h| {
            matches!(
                h.to_ascii_lowercase().as_str(),
                "cost"
                    | "total_cost"
                    | "totalcost"
                    | "cost_usd"
                    | "costusd"
                    | "amount"
                    | "amount_usd"
            )
        })
        .ok_or_else(|| {
            anyhow::anyhow!(
                "no cost column found in {} — headers: {}",
                path.display(),
                headers.iter().collect::<Vec<_>>().join(", ")
            )
        })?;
    let date_col = headers.iter().position(|h| {
        matches!(
            h.to_ascii_lowercase().as_str(),
            "date" | "created_at" | "createdat" | "timestamp" | "time" | "day" | "usage_date"
        )
    });

    let mut total: i128 = 0;
    for (i, record) in rdr.records().enumerate() {
        let record = record.map_err(|e| {
            anyhow::anyhow!("row {} in {} is not valid CSV: {e}", i + 2, path.display())
        })?;
        if let Some(dc) = date_col {
            if let Some(raw_date) = record.get(dc) {
                let raw_date = raw_date.trim();
                if !raw_date.is_empty() && !csv_date_matches(raw_date, day) {
                    continue;
                }
            }
        }
        let raw = record.get(cost_col).unwrap_or("").trim();
        if raw.is_empty() {
            continue;
        }
        let row_no = record
            .position()
            .map(|p| p.line())
            .unwrap_or((i + 2) as u64);
        let usd: f64 = raw
            .parse()
            .map_err(|e| anyhow::anyhow!("row {row_no} cost '{raw}' is not a number: {e}"))?;
        if !usd.is_finite() || usd < 0.0 {
            anyhow::bail!("row {row_no} cost '{raw}' is not a valid non-negative amount");
        }
        total += i128::from(usd_to_nanousd(usd).map_err(anyhow::Error::msg)?);
        if total > i64::MAX as i128 {
            anyhow::bail!("CSV total exceeds the nanoUSD i64 range");
        }
    }
    Ok(total as i64)
}

/// Does a CSV date cell (ISO date, ISO timestamp, or a bare YYYY-MM-DD) fall
/// on `day`? Unknown shapes are treated as matching — the CSV total is the
/// authority when the export has no usable date column.
fn csv_date_matches(raw: &str, day: NaiveDate) -> bool {
    let candidate = raw
        .split(['T', ' '])
        .next()
        .unwrap_or(raw)
        .chars()
        .take(10)
        .collect::<String>();
    NaiveDate::parse_from_str(&candidate, "%Y-%m-%d")
        .map(|d| d == day)
        .unwrap_or(true)
}
