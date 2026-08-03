//! Agent-first access to the Colony cost ledger.
//!
//! Same asymmetry as parties: reads resolve relay-authored heads, writes never
//! author one. A write publishes an owner-signed `KIND_LEDGER_ACTION` and lets
//! the broker validate it, sign the replacement book, and return a receipt.
//!
//! Money crosses this boundary exactly once. The user speaks dollars per
//! million tokens; everything inside is integer nanoUSD. The conversion lives
//! here and refuses anything it cannot represent exactly, because a price that
//! silently rounds is a ledger that silently lies.

use buzz_core::agent_turn_metric::decrypt_agent_turn_metric;
use buzz_core::kind::{
    KIND_AGENT_TURN_METRIC, KIND_ATTRIBUTION_RULEBOOK, KIND_CORRECTION_BOOK, KIND_LEDGER_BUDGET,
    KIND_LEDGER_RECEIPT, KIND_PRICE_BOOK, KIND_USAGE_RECORD,
};
use buzz_core::ledger::attribution::{
    AttributionRule, Budget, Correction, CorrectionBook, RuleAssignment, Rulebook,
};
use buzz_core::ledger::crosscheck::{
    cross_check, diagnose as diagnose_cross_check, SelfReportedTurn,
};
use buzz_core::ledger::engine::{compute_ledger, StoredUsageRecord};
use buzz_core::ledger::prices::{PriceBook, PriceEntry, PriceRates};
use buzz_core::ledger::reconcile::{diagnose, reconcile, ProviderDailyCost};
use buzz_core::usage_record::decrypt_usage_record;
use buzz_sdk::ledger::{build_ledger_action, ledger_coordinate, LedgerAction, LedgerActionPayload};
use nostr::{Event, JsonUtil, PublicKey};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::client::BuzzClient;
use crate::commands::provider_costs::{fetch_provider_costs, CostProvider};
use crate::error::CliError;
use crate::LedgerCmd;

/// Route `buzz ledger ...`.
pub async fn dispatch_ledger(command: LedgerCmd, client: &BuzzClient) -> Result<(), CliError> {
    match command {
        LedgerCmd::PricesAdd {
            model,
            input,
            cache_read,
            cache_write_5m,
            cache_write_1h,
            output,
            effective_from,
            note,
        } => {
            let rates = PriceRates {
                input_nanousd_per_token: per_mtok_to_nanousd(&input, "--input")?,
                cache_read_nanousd_per_token: per_mtok_to_nanousd(&cache_read, "--cache-read")?,
                cache_write_5m_nanousd_per_token: per_mtok_to_nanousd(
                    &cache_write_5m,
                    "--cache-write-5m",
                )?,
                cache_write_1h_nanousd_per_token: per_mtok_to_nanousd(
                    &cache_write_1h,
                    "--cache-write-1h",
                )?,
                output_nanousd_per_token: per_mtok_to_nanousd(&output, "--output")?,
            };
            let entry = PriceEntry {
                model,
                effective_from: parse_effective_from(effective_from.as_deref())?,
                rates,
                note,
            };
            publish_action(client, LedgerActionPayload::PriceEntry(entry)).await
        }
        LedgerCmd::PricesList => print_head(client, KIND_PRICE_BOOK, "pricebook").await,
        LedgerCmd::RulesList => print_head(client, KIND_ATTRIBUTION_RULEBOOK, "rulebook").await,
        LedgerCmd::CorrectionsList => print_head(client, KIND_CORRECTION_BOOK, "corrections").await,
        LedgerCmd::RulesAdd {
            id,
            priority,
            match_provider,
            match_harness,
            match_model,
            match_channel,
            match_agent,
            company,
            cost_centre,
            team,
            purpose,
            client_org,
            task,
        } => {
            let rule = AttributionRule {
                id,
                priority,
                match_provider,
                match_harness,
                match_agent_pubkey: match_agent,
                match_channel_id: match_channel,
                match_model,
                assign: assignment(company, cost_centre, team, &purpose, client_org, task)?,
            };
            publish_action(client, LedgerActionPayload::Rule(rule)).await
        }
        LedgerCmd::Correct {
            record,
            company,
            cost_centre,
            team,
            purpose,
            client_org,
            task,
            reason,
            corrected_at,
        } => {
            let correction = Correction {
                id: Uuid::new_v4().to_string(),
                usage_record_event_id: record,
                assign: assignment(company, cost_centre, team, &purpose, client_org, task)?,
                reason,
                corrected_at: parse_effective_from(corrected_at.as_deref())?,
            };
            publish_action(client, LedgerActionPayload::Correction(correction)).await
        }
        LedgerCmd::BudgetSet {
            cost_centre,
            period,
            amount,
        } => {
            let budget = Budget {
                cost_centre_id: cost_centre,
                period,
                amount_nanousd: usd_to_nanousd(&amount, "--amount")?,
            };
            publish_action(client, LedgerActionPayload::Budget(budget)).await
        }
        LedgerCmd::Report => report(client, None).await,
        LedgerCmd::Reconcile {
            provider_costs,
            from_provider,
            since,
            until,
            tolerance,
        } => {
            let rows = match (provider_costs.as_deref(), from_provider.as_deref()) {
                (Some(path), _) => read_provider_costs(path)?,
                (None, Some(vendor)) => {
                    let provider = CostProvider::parse(vendor)?;
                    let (starting_at, ending_at) = reconcile_window(since, until)?;
                    fetch_provider_costs(provider, &starting_at, &ending_at).await?
                }
                (None, None) => {
                    return Err(CliError::Usage(
                        "reconcile needs either --provider-costs <csv> or \
                         --from-provider <anthropic|openai>"
                            .to_owned(),
                    ))
                }
            };
            let tolerance = usd_to_nanousd(&tolerance, "--tolerance")?;
            report(client, Some((rows, u128::from(tolerance)))).await
        }
        LedgerCmd::CrossCheck {
            tolerance_bps,
            floor_tokens,
        } => cross_check_report(client, tolerance_bps, floor_tokens).await,
    }
}

/// Convert a dollars-per-million-tokens string to nanoUSD per token.
///
/// `3.00` per MTok is 3000 nanoUSD per token. Refuses anything finer than one
/// nanoUSD per token rather than rounding it away.
fn per_mtok_to_nanousd(value: &str, flag: &str) -> Result<u64, CliError> {
    let nanos = usd_to_nanousd(value, flag)?;
    if nanos % 1_000_000 != 0 {
        return Err(CliError::Usage(format!(
            "{flag} {value} is finer than one nanoUSD per token; the ledger will not round it"
        )));
    }
    Ok(nanos / 1_000_000)
}

/// Convert a plain dollar amount to integer nanoUSD.
///
/// Parsed as text, not through a float, so a value like 0.1 cannot arrive as
/// 0.09999999999999999.
fn usd_to_nanousd(value: &str, flag: &str) -> Result<u64, CliError> {
    let trimmed = value.trim();
    let bad = || CliError::Usage(format!("{flag} {value} is not a plain dollar amount"));
    if trimmed.is_empty() || trimmed.starts_with('-') {
        return Err(bad());
    }
    let (whole, fraction) = match trimmed.split_once('.') {
        Some((whole, fraction)) => (whole, fraction),
        None => (trimmed, ""),
    };
    if whole.is_empty() || !whole.bytes().all(|b| b.is_ascii_digit()) {
        return Err(bad());
    }
    if !fraction.bytes().all(|b| b.is_ascii_digit()) {
        return Err(bad());
    }
    if fraction.len() > 9 {
        return Err(CliError::Usage(format!(
            "{flag} {value} has more precision than one nanoUSD"
        )));
    }
    let dollars: u64 = whole.parse().map_err(|_| bad())?;
    let mut padded = fraction.to_owned();
    while padded.len() < 9 {
        padded.push('0');
    }
    let nanos: u64 = if padded.is_empty() {
        0
    } else {
        padded.parse().map_err(|_| bad())?
    };
    dollars
        .checked_mul(1_000_000_000)
        .and_then(|d| d.checked_add(nanos))
        .ok_or_else(bad)
}

/// Parse an RFC 3339 instant, defaulting to now.
fn parse_effective_from(value: Option<&str>) -> Result<u64, CliError> {
    match value {
        None => Ok(chrono::Utc::now().timestamp().max(0) as u64),
        Some(raw) => chrono::DateTime::parse_from_rfc3339(raw)
            .map_err(|error| CliError::Usage(format!("{raw} is not an RFC 3339 instant: {error}")))
            .map(|parsed| parsed.timestamp().max(0) as u64),
    }
}

fn assignment(
    company_id: String,
    cost_centre_id: String,
    owning_team_id: String,
    purpose: &str,
    client_organization_id: Option<String>,
    task_id: Option<String>,
) -> Result<RuleAssignment, CliError> {
    let commercial_purpose = serde_json::from_value(Value::String(purpose.to_owned()))
        .map_err(|_| CliError::Usage(format!("unknown commercial purpose: {purpose}")))?;
    Ok(RuleAssignment {
        company_id,
        cost_centre_id,
        owning_team_id,
        commercial_purpose,
        client_organization_id,
        task_id,
    })
}

/// The tenant relay pubkey, which authors every book head.
async fn relay_self(client: &BuzzClient) -> Result<PublicKey, CliError> {
    let raw = client.get_public("/").await?;
    let document: Value = serde_json::from_str(&raw)
        .map_err(|error| CliError::Other(format!("relay info is malformed: {error}")))?;
    let value = document
        .get("self")
        .and_then(Value::as_str)
        .ok_or_else(|| CliError::Other("relay info is missing self pubkey".to_owned()))?;
    PublicKey::parse(value)
        .map_err(|error| CliError::Other(format!("relay self pubkey is invalid: {error}")))
}

/// Fetch one relay-authored book head, or `None` when it does not exist yet.
async fn fetch_head(
    client: &BuzzClient,
    kind: u32,
    d_tag: &str,
) -> Result<Option<Event>, CliError> {
    let relay = relay_self(client).await?;
    let events = client
        .query_paginated(
            json!({
                "kinds": [kind],
                "authors": [relay.to_hex()],
                "#d": [d_tag],
                "limit": 1
            }),
            1,
        )
        .await?;
    match events.into_iter().next() {
        None => Ok(None),
        Some(raw) => Event::from_json(raw.to_string())
            .map(Some)
            .map_err(|error| CliError::Other(format!("book head is not a valid event: {error}"))),
    }
}

/// Decode a book head, treating absence as an empty book.
async fn load_book<T: serde::de::DeserializeOwned + Default>(
    client: &BuzzClient,
    kind: u32,
    d_tag: &str,
) -> Result<T, CliError> {
    match fetch_head(client, kind, d_tag).await? {
        None => Ok(T::default()),
        Some(event) => serde_json::from_str(&event.content)
            .map_err(|error| CliError::Other(format!("stored {d_tag} is unreadable: {error}"))),
    }
}

async fn print_head(client: &BuzzClient, kind: u32, d_tag: &str) -> Result<(), CliError> {
    match fetch_head(client, kind, d_tag).await? {
        None => {
            println!("{}", json!({ "d": d_tag, "exists": false }));
            Ok(())
        }
        Some(event) => {
            let content: Value = serde_json::from_str(&event.content).map_err(|error| {
                CliError::Other(format!("stored {d_tag} is unreadable: {error}"))
            })?;
            println!(
                "{}",
                json!({ "d": d_tag, "exists": true, "event_id": event.id.to_hex(), "content": content })
            );
            Ok(())
        }
    }
}

/// Publish one owner-signed ledger action and report the relay's verdict.
async fn publish_action(client: &BuzzClient, payload: LedgerActionPayload) -> Result<(), CliError> {
    let relay = relay_self(client).await?;
    let relay_hex = relay.to_hex();
    let d_tag = payload.head_d_tag();

    // Discover the compare-and-set token: an existing head makes this an
    // append, its absence makes it the first version. Getting it wrong is not
    // destructive, because the broker refuses the mismatch.
    let expected_head = fetch_head(client, payload.head_kind(), &d_tag)
        .await?
        .map(|event| event.id.to_hex());

    let action = LedgerAction {
        relay_pubkey: relay_hex.clone(),
        operation: payload.operation(),
        request_id: Uuid::new_v4(),
        idempotency_key: Uuid::new_v4(),
        target: ledger_coordinate(&relay_hex, &payload),
        expected_head,
        payload,
    };
    let builder = build_ledger_action(&action)
        .map_err(|error| CliError::Usage(format!("invalid ledger action: {error}")))?;
    let event = client.sign_event(builder)?;
    let event_id = event.id.to_hex();
    let response = client.submit_event(event).await?;

    let accepted = response_accepted(&response);
    let receipt = fetch_receipt(client, &event_id).await.ok();
    println!(
        "{}",
        json!({
            "event_id": event_id,
            "accepted": accepted,
            "message": response_message(&response),
            "target": action.target,
            "request_id": action.request_id,
            "idempotency_key": action.idempotency_key,
            "receipt": receipt
        })
    );
    if accepted {
        Ok(())
    } else {
        let message = response_message(&response);
        let reason = message
            .strip_prefix("conflict: ")
            .unwrap_or(&message)
            .to_owned();
        Err(CliError::Conflict(reason))
    }
}

fn response_accepted(response: &str) -> bool {
    serde_json::from_str::<Value>(response)
        .ok()
        .and_then(|value| value.get("accepted").and_then(Value::as_bool))
        .unwrap_or(false)
}

fn response_message(response: &str) -> String {
    serde_json::from_str::<Value>(response)
        .ok()
        .and_then(|value| {
            value
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| response.to_owned())
}

/// Fetch the relay-signed receipt linked to one action, if it has landed.
async fn fetch_receipt(client: &BuzzClient, action_event_id: &str) -> Result<Value, CliError> {
    let relay = relay_self(client).await?;
    let events = client
        .query_paginated(
            json!({
                "kinds": [KIND_LEDGER_RECEIPT],
                "authors": [relay.to_hex()],
                "#e": [action_event_id],
                "limit": 1
            }),
            1,
        )
        .await?;
    events
        .into_iter()
        .next()
        .ok_or_else(|| CliError::NotFound("ledger receipt not found".to_owned()))
}

/// Compute and print the ledger, optionally reconciling against a provider's
/// own cost report.
async fn report(
    client: &BuzzClient,
    reconcile_with: Option<(Vec<ProviderDailyCost>, u128)>,
) -> Result<(), CliError> {
    let prices: PriceBook = load_book(client, KIND_PRICE_BOOK, "pricebook").await?;
    let rules: Rulebook = load_book(client, KIND_ATTRIBUTION_RULEBOOK, "rulebook").await?;
    let corrections: CorrectionBook =
        load_book(client, KIND_CORRECTION_BOOK, "corrections").await?;
    let budgets = load_budgets(client).await?;

    let (records, unreadable) = load_usage_records(client).await?;

    let mut ledger = compute_ledger(records, &prices, &rules, &corrections, &budgets);

    let mut reconciliation = Value::Null;
    if let Some((provider_rows, tolerance)) = reconcile_with {
        let exceptions = reconcile(&ledger.by_day, &provider_rows, tolerance);
        let drifted = !exceptions.is_empty();
        reconciliation = json!({
            "exceptions": exceptions
                .iter()
                .map(|exception| json!({
                    "exception": exception,
                    "diagnosis": diagnose(exception),
                }))
                .collect::<Vec<_>>(),
        });
        ledger.exceptions.extend(exceptions);
        print_report(&ledger, unreadable, &reconciliation);
        if drifted {
            return Err(CliError::Other(
                "ledger and provider report disagree; see exceptions".to_owned(),
            ));
        }
        return Ok(());
    }

    print_report(&ledger, unreadable, &reconciliation);
    Ok(())
}

fn print_report(
    ledger: &buzz_core::ledger::engine::LedgerReport,
    unreadable: usize,
    reconciliation: &Value,
) {
    println!(
        "{}",
        json!({
            "ledger": ledger,
            "unreadable_records": unreadable,
            "reconciliation": reconciliation,
        })
    );
}

/// Load every budget head the relay currently holds.
async fn load_budgets(client: &BuzzClient) -> Result<Vec<Budget>, CliError> {
    let relay = relay_self(client).await?;
    let events = client
        .query_all(json!({
            "kinds": [KIND_LEDGER_BUDGET],
            "authors": [relay.to_hex()]
        }))
        .await?;
    let mut budgets = Vec::with_capacity(events.len());
    for value in events {
        let Ok(event) = Event::from_json(value.to_string()) else {
            continue;
        };
        if let Ok(budget) = serde_json::from_str::<Budget>(&event.content) {
            budgets.push(budget);
        }
    }
    Ok(budgets)
}

/// Read a provider's exported daily cost from CSV: `provider,day,amount_usd`.
///
/// A header row naming the columns is accepted and skipped.
pub(crate) fn parse_provider_costs(text: &str) -> Result<Vec<ProviderDailyCost>, CliError> {
    let mut rows = Vec::new();
    for (index, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let fields: Vec<&str> = line.split(',').map(str::trim).collect();
        if fields.len() != 3 {
            return Err(CliError::Usage(format!(
                "line {}: expected provider,day,amount_usd",
                index + 1
            )));
        }
        if index == 0 && fields[0].eq_ignore_ascii_case("provider") {
            continue;
        }
        rows.push(ProviderDailyCost {
            provider: fields[0].to_owned(),
            day: fields[1].to_owned(),
            amount_nanousd: u128::from(usd_to_nanousd(fields[2], "amount_usd")?),
        });
    }
    Ok(rows)
}

fn read_provider_costs(path: &str) -> Result<Vec<ProviderDailyCost>, CliError> {
    let text = std::fs::read_to_string(path)
        .map_err(|error| CliError::Usage(format!("cannot read {path}: {error}")))?;
    parse_provider_costs(&text)
}

/// The window to ask a provider about.
///
/// Defaults to the last 30 days, which covers a monthly invoice cycle with
/// room either side. Both bounds are validated here rather than at the
/// provider, so a typo fails immediately instead of returning an empty
/// report that reads as "the provider billed nothing".
fn reconcile_window(
    since: Option<String>,
    until: Option<String>,
) -> Result<(String, String), CliError> {
    let parse = |value: &str, flag: &str| {
        chrono::DateTime::parse_from_rfc3339(value)
            .map(|at| at.with_timezone(&chrono::Utc))
            .map_err(|_| CliError::Usage(format!("{flag} {value} is not an RFC 3339 instant")))
    };
    let ending_at = match until.as_deref() {
        Some(value) => parse(value, "--until")?,
        None => chrono::Utc::now(),
    };
    let starting_at = match since.as_deref() {
        Some(value) => parse(value, "--since")?,
        None => ending_at - chrono::Duration::days(30),
    };
    if starting_at >= ending_at {
        return Err(CliError::Usage("--since must be before --until".to_owned()));
    }
    Ok((
        starting_at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        ending_at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
    ))
}

/// Load every usage record addressed to this identity.
///
/// Returns the readable records and a count of those that could not be
/// decrypted. Unreadable records are counted rather than dropped: a total
/// computed over fewer records than exist is understated, and a caller has
/// to be able to say so.
async fn load_usage_records(
    client: &BuzzClient,
) -> Result<(Vec<StoredUsageRecord>, usize), CliError> {
    let keys = client.keys();
    let raw = client
        .query_all(json!({
            "kinds": [KIND_USAGE_RECORD],
            "#p": [keys.public_key().to_hex()]
        }))
        .await?;

    let mut records = Vec::with_capacity(raw.len());
    let mut unreadable = 0usize;
    for value in raw {
        let Ok(event) = Event::from_json(value.to_string()) else {
            unreadable += 1;
            continue;
        };
        match decrypt_usage_record(keys, &event) {
            Ok(payload) => records.push(StoredUsageRecord {
                event_id: event.id.to_hex(),
                created_at: event.created_at.as_secs(),
                payload,
            }),
            Err(_) => unreadable += 1,
        }
    }
    Ok((records, unreadable))
}

/// Compare agents' own account of their spend against the metered wire.
///
/// The wire stays the source of record; this exists to catch the case the
/// ledger alone cannot see, where an agent made provider calls that never
/// crossed the checkpoint. Exits non-zero when anything is flagged, so it is
/// usable as a scheduled check rather than only read by a human.
async fn cross_check_report(
    client: &BuzzClient,
    tolerance_bps: u32,
    floor_tokens: u64,
) -> Result<(), CliError> {
    let keys = client.keys();
    let (wire_records, unreadable_wire) = load_usage_records(client).await?;

    let raw_metrics = client
        .query_all(json!({
            "kinds": [KIND_AGENT_TURN_METRIC],
            "#p": [keys.public_key().to_hex()]
        }))
        .await?;

    let mut self_reports = Vec::with_capacity(raw_metrics.len());
    let mut unreadable_metrics = 0usize;
    let mut turns_without_counts = 0usize;
    for value in raw_metrics {
        let Ok(event) = Event::from_json(value.to_string()) else {
            unreadable_metrics += 1;
            continue;
        };
        let Ok(payload) = decrypt_agent_turn_metric(keys, &event) else {
            unreadable_metrics += 1;
            continue;
        };
        // `turn` is the per-turn delta. `cumulative` restates the session
        // total every turn, so summing that instead would multiply-count
        // every session by its own length.
        let Some(counts) = payload.turn.as_ref() else {
            turns_without_counts += 1;
            continue;
        };
        let Some(day) = rfc3339_utc_day(&payload.timestamp) else {
            turns_without_counts += 1;
            continue;
        };
        self_reports.push(SelfReportedTurn {
            agent_pubkey: event.pubkey.to_hex(),
            day,
            input_tokens: counts.input_tokens.unwrap_or(0),
            output_tokens: counts.output_tokens.unwrap_or(0),
            delta_reliable: payload.delta_reliable,
        });
    }

    let report = cross_check(&wire_records, &self_reports, tolerance_bps, floor_tokens);
    let flagged = !report.findings.is_empty();

    println!(
        "{}",
        json!({
            "cross_check": {
                "rows": report.rows,
                "findings": report.findings
                    .iter()
                    .map(|finding| json!({
                        "finding": finding,
                        "diagnosis": diagnose_cross_check(finding),
                    }))
                    .collect::<Vec<_>>(),
                "skipped_unreliable_turns": report.skipped_unreliable_turns,
            },
            "unreadable_usage_records": unreadable_wire,
            "unreadable_turn_metrics": unreadable_metrics,
            "turn_metrics_without_usable_counts": turns_without_counts,
        })
    );

    if flagged {
        return Err(CliError::Other(
            "agent self-reports and metered spend disagree; see findings".to_owned(),
        ));
    }
    Ok(())
}

/// The UTC day of an RFC 3339 timestamp, or `None` when it cannot be parsed.
fn rfc3339_utc_day(timestamp: &str) -> Option<String> {
    chrono::DateTime::parse_from_rfc3339(timestamp)
        .ok()
        .map(|parsed| {
            parsed
                .with_timezone(&chrono::Utc)
                .format("%Y-%m-%d")
                .to_string()
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dollars_per_mtok_convert_exactly() {
        assert_eq!(per_mtok_to_nanousd("3.00", "--input").unwrap(), 3_000);
        assert_eq!(per_mtok_to_nanousd("0.30", "--cache-read").unwrap(), 300);
        assert_eq!(
            per_mtok_to_nanousd("3.75", "--cache-write-5m").unwrap(),
            3_750
        );
        assert_eq!(per_mtok_to_nanousd("15", "--output").unwrap(), 15_000);
        assert_eq!(per_mtok_to_nanousd("0.001", "--input").unwrap(), 1);
    }

    #[test]
    fn a_price_finer_than_one_nanousd_per_token_is_refused_not_rounded() {
        let error = per_mtok_to_nanousd("0.0001", "--input")
            .expect_err("sub-nano precision must be refused");
        assert!(
            format!("{error}").contains("will not round"),
            "got: {error}"
        );
    }

    #[test]
    fn dollar_amounts_parse_without_floating_point() {
        assert_eq!(usd_to_nanousd("0.1", "--amount").unwrap(), 100_000_000);
        assert_eq!(usd_to_nanousd("12.50", "--amount").unwrap(), 12_500_000_000);
        assert_eq!(usd_to_nanousd("500", "--amount").unwrap(), 500_000_000_000);
        assert_eq!(usd_to_nanousd("0", "--amount").unwrap(), 0);
        assert_eq!(usd_to_nanousd("0.000000001", "--amount").unwrap(), 1);
    }

    #[test]
    fn malformed_amounts_are_refused() {
        for bad in ["", "-1", "1.2.3", "abc", "1e9", " 1x ", "1.0000000001"] {
            assert!(
                usd_to_nanousd(bad, "--amount").is_err(),
                "{bad} must be refused"
            );
        }
    }

    #[test]
    fn provider_cost_csv_parses_with_and_without_a_header() {
        let with_header = "provider,day,amount_usd\nanthropic,2026-08-01,12.50\n";
        let rows = parse_provider_costs(with_header).expect("parse");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].provider, "anthropic");
        assert_eq!(rows[0].day, "2026-08-01");
        assert_eq!(rows[0].amount_nanousd, 12_500_000_000);

        let without = "openai,2026-08-02,1.00\nanthropic,2026-08-02,2.00\n";
        assert_eq!(parse_provider_costs(without).expect("parse").len(), 2);
    }

    #[test]
    fn a_malformed_csv_row_names_its_line() {
        let error = parse_provider_costs("anthropic,2026-08-01\n")
            .expect_err("a short row must be refused");
        assert!(format!("{error}").contains("line 1"), "got: {error}");
    }
}
