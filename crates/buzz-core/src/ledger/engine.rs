//! The deterministic cost ledger engine.
//!
//! [`compute_ledger`] is a pure function: same inputs, same report, every
//! time. No clock, no randomness, no I/O. Everything time-dependent arrives
//! in the records themselves, which is what makes reprocessing idempotent and
//! makes a report reproducible months later from the same evidence.

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};

use crate::company::{classify_cost, CostClassification};
use crate::ledger::attribution::{Budget, CorrectionBook, RuleAssignment, Rulebook};
use crate::ledger::conditions::CallFacts;
use crate::ledger::prices::{total_input_tokens, PriceBasis, PriceBook};
use crate::usage_record::{PaymentMode, UsageRecordPayload, UsageSource};

/// A usage record as it was stored: the payload plus its event identity.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredUsageRecord {
    /// Hex event id.
    pub event_id: String,
    /// Event `created_at`, unix seconds. Used to order records and as the
    /// pricing instant when the payload timestamp is unparseable.
    pub created_at: u64,
    /// Decrypted payload.
    pub payload: UsageRecordPayload,
}

/// How the engine established an entry's attribution.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "id")]
pub enum AttributionMethod {
    /// The record carried a work context captured at spend time.
    Explicit,
    /// An attribution rule matched; carries the rule id.
    Rule(String),
    /// The owner corrected it; carries the correction id.
    Correction(String),
    /// Nothing established it.
    NeedsReview,
}

/// Which side of a reconciliation was missing a day.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MissingSide {
    /// The ledger has no entries for that provider-day.
    Ledger,
    /// The provider's cost report has no row for that provider-day.
    ProviderReport,
}

/// Something the ledger could not resolve on its own.
///
/// Exceptions are surfaced, never swallowed. A cost the engine cannot place
/// is visible as a problem rather than silently absent or silently zero.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum LedgerException {
    /// Two records claimed the same provider request with different content.
    /// The first is kept; this names both so the disagreement is auditable.
    DuplicateConflict {
        /// Dedupe key that collided.
        key: String,
        /// Event id that was counted.
        kept_event_id: String,
        /// Event id that was dropped.
        dropped_event_id: String,
    },
    /// The price book has no rate for this model at this instant. The tokens
    /// are recorded; the money is unknown until a price entry is added.
    UnpricedModel {
        /// Event id of the affected record.
        event_id: String,
        /// Model that has no price.
        model: String,
    },
    /// The payload timestamp could not be parsed; the event's `created_at`
    /// was used for pricing and day bucketing instead.
    BadTimestamp {
        /// Event id of the affected record.
        event_id: String,
        /// The unparseable value.
        timestamp: String,
    },
    /// Ledger and provider disagree about one provider-day beyond tolerance.
    ReconcileDrift {
        /// Provider slug.
        provider: String,
        /// Day in `YYYY-MM-DD` form.
        day: String,
        /// What the ledger totalled.
        ledger_nanousd: u128,
        /// What the provider reported.
        provider_nanousd: u128,
    },
    /// A provider-day exists on only one side of the comparison.
    ReconcileMissingDay {
        /// Provider slug.
        provider: String,
        /// Day in `YYYY-MM-DD` form.
        day: String,
        /// Which side lacked it.
        side: MissingSide,
    },
}

/// One priced, attributed usage record.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerEntry {
    /// Hex event id of the underlying record.
    pub event_id: String,
    /// UTC day in `YYYY-MM-DD` form.
    pub day: String,
    /// Provider slug.
    pub provider: String,
    /// Evidence source for the underlying usage record.
    pub source: UsageSource,
    /// Model, when the record was token-priced.
    pub model: Option<String>,
    /// Metered (real money) or imputed (subscription shadow cost).
    pub payment_mode: PaymentMode,
    /// Cost in nanoUSD, or `None` when the model is unpriced.
    pub cost_nanousd: Option<u128>,
    /// Which kind of price row supplied the rate, when the entry was
    /// token-priced.
    ///
    /// `None` for an unpriced model and for a flat-amount record, neither of
    /// which consulted the book. A wrong price is invisible in the number, so
    /// the basis travels with it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub price_basis: Option<PriceBasis>,
    /// Classification before any correction. Never changes.
    pub original_classification: CostClassification,
    /// Classification in force now, after corrections.
    pub effective_classification: CostClassification,
    /// Assignment in force now, when one was established.
    pub effective_assignment: Option<RuleAssignment>,
    /// How the effective attribution was established.
    pub attributed_by: AttributionMethod,
}

/// Spend totals by accounting classification, in nanoUSD.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassTotals {
    /// Cost of goods sold: direct client delivery.
    pub cogs: u128,
    /// Operating expense: internal work.
    pub opex: u128,
    /// Unresolved: the engine could not place it.
    pub needs_review: u128,
}

/// Metered spend for one provider on one UTC day. The reconciliation input.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailySum {
    /// Provider slug.
    pub provider: String,
    /// Day in `YYYY-MM-DD` form.
    pub day: String,
    /// Metered spend in nanoUSD.
    pub metered_nanousd: u128,
}

/// A budget and what was actually spent against it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetStatus {
    /// Cost centre.
    pub cost_centre_id: String,
    /// Month in `YYYY-MM` form.
    pub period: String,
    /// The limit in nanoUSD.
    pub budget_nanousd: u128,
    /// Spend recorded against it in nanoUSD.
    pub actual_nanousd: u128,
}

/// The full computed ledger.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerReport {
    /// One entry per counted record, ordered by `(created_at, event_id)`.
    pub entries: Vec<LedgerEntry>,
    /// Totals by effective classification.
    pub totals: ClassTotals,
    /// Real money spent.
    pub metered_nanousd: u128,
    /// Subscription-backed spend at API-equivalent prices.
    pub imputed_nanousd: u128,
    /// Spend per cost centre; unattributed money is under `needs-review`.
    pub by_cost_centre: Vec<(String, u128)>,
    /// Metered wire spend per provider-day, for reconciliation.
    pub by_day: Vec<DailySum>,
    /// Budgets and their actuals.
    pub budget_status: Vec<BudgetStatus>,
    /// Everything the engine could not resolve.
    pub exceptions: Vec<LedgerException>,
}

/// Cost centre key used when no attribution was established.
pub const NEEDS_REVIEW_COST_CENTRE: &str = "needs-review";

/// Convert unix seconds to a UTC `YYYY-MM-DD` date.
///
/// Uses the civil-from-days algorithm rather than a date library so the
/// engine keeps zero I/O and zero clock dependencies.
fn utc_day(unix_seconds: u64) -> String {
    let days = (unix_seconds / 86_400) as i64;
    // Howard Hinnant's civil_from_days, shifted to a 0000-03-01 era origin.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    format!("{year:04}-{m:02}-{d:02}")
}

/// The UTC day a record is counted under.
///
/// Shared with the cross-check so both derive the day the same way: an
/// unparseable payload timestamp falls back to the event's `created_at`,
/// exactly as pricing does. Two different fallbacks would put the same
/// record on different days in two reports about the same spend.
pub fn utc_day_for(record: &StoredUsageRecord) -> String {
    utc_day(parse_rfc3339(&record.payload.timestamp).unwrap_or(record.created_at))
}

/// Parse an RFC 3339 timestamp to unix seconds.
///
/// Returns `None` for anything unparseable, which the caller turns into a
/// [`LedgerException::BadTimestamp`] rather than a guess.
fn parse_rfc3339(timestamp: &str) -> Option<u64> {
    let parsed = chrono::DateTime::parse_from_rfc3339(timestamp).ok()?;
    u64::try_from(parsed.timestamp()).ok()
}

/// Dedupe key for a record.
///
/// Wire records key on `provider:request_id`: the provider's own identifier
/// for the call, so a republished record cannot be counted twice, while two
/// providers that happen to issue the same id stay distinct. Manual records
/// key on their event id, since the owner's reference is not guaranteed
/// unique across vendors.
fn dedupe_key(record: &StoredUsageRecord) -> String {
    match record.payload.source {
        UsageSource::Wire | UsageSource::AdapterEstimate => {
            format!("{}:{}", record.payload.provider, record.payload.request_id)
        }
        UsageSource::Manual => record.event_id.clone(),
    }
}

/// Fold usage records and the books into a ledger report.
///
/// The ordering below is the contract, and the tests pin each step:
///
/// 1. **Sort** by `(created_at, event_id)`, so caller order never matters.
/// 2. **Dedupe** on [`dedupe_key`]. First occurrence wins. An identical
///    republish is dropped silently; a same-key record with different content
///    is dropped and raises [`LedgerException::DuplicateConflict`].
/// 3. **Price** token records through the price book at the record's own
///    timestamp; amount records use their stated amount. An unpriced model
///    yields `None` cost and forces Needs Review: money that cannot be
///    counted cannot be attributed.
/// 4. **Attribute** from the explicit work context, else the first matching
///    rule, else Needs Review.
/// 5. **Correct**: the last correction naming a record wins, replacing the
///    effective classification and assignment. The original classification is
///    never touched.
/// 6. **Aggregate** totals, the metered/imputed split, cost centres, metered
///    wire spend per provider-day, and budget actuals.
pub fn compute_ledger(
    records: Vec<StoredUsageRecord>,
    prices: &PriceBook,
    rules: &Rulebook,
    corrections: &CorrectionBook,
    budgets: &[Budget],
) -> LedgerReport {
    let mut exceptions = Vec::new();

    // 1. Sort.
    let mut ordered = records;
    ordered.sort_by(|a, b| {
        a.created_at
            .cmp(&b.created_at)
            .then_with(|| a.event_id.cmp(&b.event_id))
    });

    // 2. Dedupe.
    let mut seen: HashMap<String, &StoredUsageRecord> = HashMap::new();
    let mut counted: Vec<&StoredUsageRecord> = Vec::new();
    for record in &ordered {
        let key = dedupe_key(record);
        match seen.get(&key) {
            None => {
                seen.insert(key, record);
                counted.push(record);
            }
            Some(kept) => {
                if kept.payload != record.payload {
                    exceptions.push(LedgerException::DuplicateConflict {
                        key,
                        kept_event_id: kept.event_id.clone(),
                        dropped_event_id: record.event_id.clone(),
                    });
                }
            }
        }
    }

    // 5 (index first): last correction per record wins.
    let mut latest_correction: HashMap<&str, &crate::ledger::attribution::Correction> =
        HashMap::new();
    for correction in &corrections.corrections {
        latest_correction.insert(correction.usage_record_event_id.as_str(), correction);
    }

    let mut entries = Vec::with_capacity(counted.len());
    for record in counted {
        let payload = &record.payload;

        // 3. Price.
        let at_unix = match parse_rfc3339(&payload.timestamp) {
            Some(seconds) => seconds,
            None => {
                exceptions.push(LedgerException::BadTimestamp {
                    event_id: record.event_id.clone(),
                    timestamp: payload.timestamp.clone(),
                });
                record.created_at
            }
        };
        let day = utc_day(at_unix);

        let (cost_nanousd, price_basis) = match (&payload.tokens, payload.amount_nanousd) {
            // The provider stated what it charged. Nothing the book can work
            // out beats the charge itself, so the book is not consulted and an
            // unpriced model is not an exception: the money is already known.
            (Some(_), _) if payload.observed_cost_nanousd.is_some() => (
                payload.observed_cost_nanousd.map(u128::from),
                Some(PriceBasis::Observed),
            ),
            (Some(tokens), _) => {
                let model = payload.model.as_deref().unwrap_or_default();
                // The provider is on the record because the meter captured it
                // at the wire, and it decides whose price list applies: the
                // same model costs a different amount from the lab that
                // trained it, from a cloud reselling it, and from a router.
                let facts = CallFacts {
                    input_tokens: total_input_tokens(tokens),
                    at_unix,
                    provider: Some(payload.provider.clone()),
                    // The meter does not capture the service tier yet, so
                    // tier-conditioned rows never match and Batch and Flex
                    // calls price at the standard rate. Overstating spend is
                    // the safe direction, and it stays wrong until the meter
                    // records what the provider reported.
                    tier: None,
                };
                match prices.price_facts(model, tokens, &facts) {
                    Some(priced) => (Some(priced.cost_nanousd), Some(priced.basis)),
                    None => {
                        exceptions.push(LedgerException::UnpricedModel {
                            event_id: record.event_id.clone(),
                            model: model.to_string(),
                        });
                        (None, None)
                    }
                }
            }
            (None, Some(amount)) => (Some(u128::from(amount)), None),
            // validate() forbids this shape; treat it as unpriced rather than
            // inventing a number.
            (None, None) => (None, None),
        };

        // 4. Attribute.
        let (mut classification, mut assignment, mut method) = match &payload.work_context {
            Some(context) => (
                classify_cost(
                    context.commercial_purpose,
                    context.client_organization_id.as_deref(),
                ),
                Some(RuleAssignment {
                    company_id: context.company_id.clone(),
                    cost_centre_id: context.cost_centre_id.clone(),
                    owning_team_id: context.owning_team_id.clone(),
                    commercial_purpose: context.commercial_purpose,
                    client_organization_id: context.client_organization_id.clone(),
                    task_id: Some(context.task_id.clone()),
                }),
                AttributionMethod::Explicit,
            ),
            None => match rules.best_match(payload) {
                Some(rule) => (
                    classify_cost(
                        rule.assign.commercial_purpose,
                        rule.assign.client_organization_id.as_deref(),
                    ),
                    Some(rule.assign.clone()),
                    AttributionMethod::Rule(rule.id.clone()),
                ),
                None => (
                    CostClassification::NeedsReview,
                    None,
                    AttributionMethod::NeedsReview,
                ),
            },
        };
        let original_classification = classification;

        // 5. Correct.
        if let Some(correction) = latest_correction.get(record.event_id.as_str()) {
            classification = classify_cost(
                correction.assign.commercial_purpose,
                correction.assign.client_organization_id.as_deref(),
            );
            assignment = Some(correction.assign.clone());
            method = AttributionMethod::Correction(correction.id.clone());
        }

        // Unpriced money cannot be attributed to anything but review, and a
        // correction does not conjure a price.
        if cost_nanousd.is_none() {
            classification = CostClassification::NeedsReview;
        }

        entries.push(LedgerEntry {
            event_id: record.event_id.clone(),
            day,
            provider: payload.provider.clone(),
            source: payload.source,
            model: payload.model.clone(),
            payment_mode: payload.payment_mode,
            cost_nanousd,
            price_basis,
            original_classification,
            effective_classification: classification,
            effective_assignment: assignment,
            attributed_by: method,
        });
    }

    // 6. Aggregate.
    let mut totals = ClassTotals::default();
    let mut metered_nanousd: u128 = 0;
    let mut imputed_nanousd: u128 = 0;
    let mut by_cost_centre: BTreeMap<String, u128> = BTreeMap::new();
    let mut by_day: BTreeMap<(String, String), u128> = BTreeMap::new();
    let mut by_centre_period: BTreeMap<(String, String), u128> = BTreeMap::new();

    for entry in &entries {
        let Some(cost) = entry.cost_nanousd else {
            continue;
        };
        match entry.effective_classification {
            CostClassification::Cogs => totals.cogs += cost,
            CostClassification::Opex => totals.opex += cost,
            CostClassification::NeedsReview => totals.needs_review += cost,
        }
        match entry.payment_mode {
            PaymentMode::Metered => metered_nanousd += cost,
            PaymentMode::Imputed => imputed_nanousd += cost,
        }

        let centre = entry
            .effective_assignment
            .as_ref()
            .map(|a| a.cost_centre_id.clone())
            .unwrap_or_else(|| NEEDS_REVIEW_COST_CENTRE.to_string());
        *by_cost_centre.entry(centre.clone()).or_default() += cost;

        // Only metered spend appears on a provider invoice, so only metered
        // spend belongs in the reconciliation input.
        if entry.payment_mode == PaymentMode::Metered {
            *by_day
                .entry((entry.provider.clone(), entry.day.clone()))
                .or_default() += cost;
        }

        let period = entry.day.get(..7).unwrap_or(&entry.day).to_string();
        *by_centre_period.entry((centre, period)).or_default() += cost;
    }

    let budget_status = budgets
        .iter()
        .map(|budget| BudgetStatus {
            cost_centre_id: budget.cost_centre_id.clone(),
            period: budget.period.clone(),
            budget_nanousd: u128::from(budget.amount_nanousd),
            actual_nanousd: by_centre_period
                .get(&(budget.cost_centre_id.clone(), budget.period.clone()))
                .copied()
                .unwrap_or_default(),
        })
        .collect();

    LedgerReport {
        entries,
        totals,
        metered_nanousd,
        imputed_nanousd,
        by_cost_centre: by_cost_centre.into_iter().collect(),
        by_day: by_day
            .into_iter()
            .map(|((provider, day), metered_nanousd)| DailySum {
                provider,
                day,
                metered_nanousd,
            })
            .collect(),
        budget_status,
        exceptions,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::company::{AgentWorkContext, AttributionState, CommercialPurpose};
    use crate::ledger::attribution::{AttributionRule, Correction};
    use crate::ledger::prices::PriceOrigin;
    use crate::ledger::prices::{PriceEntry, PriceRates};
    use crate::usage_record::{UsageBreakdown, UsageSource};

    const DAY_2026_08_02: u64 = 1_785_628_800; // 2026-08-02T00:00:00Z

    fn tokens(input: u64, output: u64) -> UsageBreakdown {
        UsageBreakdown {
            input_uncached_tokens: input,
            cache_read_tokens: 0,
            cache_write_5m_tokens: 0,
            cache_write_1h_tokens: 0,
            output_tokens: output,
        }
    }

    fn book() -> PriceBook {
        PriceBook {
            entries: vec![PriceEntry {
                model: "m".to_string(),
                effective_from: 0,
                rates: PriceRates {
                    // $1 / MTok input, $5 / MTok output, at the stored
                    // per-million-token scale.
                    input_nanousd_per_mtok: 1_000_000_000,
                    cache_read_nanousd_per_mtok: 100_000_000,
                    cache_write_5m_nanousd_per_mtok: 0,
                    cache_write_1h_nanousd_per_mtok: 0,
                    output_nanousd_per_mtok: 5_000_000_000,
                },
                note: None,
                conditions: Default::default(),
                origin: PriceOrigin::Owner,
            }],
        }
    }

    fn assignment(
        centre: &str,
        purpose: CommercialPurpose,
        client: Option<&str>,
    ) -> RuleAssignment {
        RuleAssignment {
            company_id: "horizon-labs".to_string(),
            cost_centre_id: centre.to_string(),
            owning_team_id: "web-team".to_string(),
            commercial_purpose: purpose,
            client_organization_id: client.map(str::to_string),
            task_id: None,
        }
    }

    fn context(purpose: CommercialPurpose, client: Option<&str>) -> AgentWorkContext {
        AgentWorkContext {
            company_id: "horizon-labs".to_string(),
            task_id: "task-1".to_string(),
            initiative_id: None,
            owning_team_id: "web-team".to_string(),
            cost_centre_id: match purpose {
                CommercialPurpose::ClientDelivery => "web-delivery".to_string(),
                _ => "internal-ops".to_string(),
            },
            commercial_purpose: purpose,
            cost_classification: classify_cost(purpose, client),
            attribution_state: AttributionState::Explicit,
            client_organization_id: client.map(str::to_string),
        }
    }

    fn record(
        event_id: &str,
        created_at: u64,
        model: &str,
        breakdown: UsageBreakdown,
    ) -> StoredUsageRecord {
        StoredUsageRecord {
            event_id: event_id.to_string(),
            created_at,
            payload: UsageRecordPayload {
                source: UsageSource::Wire,
                provider: "anthropic".to_string(),
                request_id: format!("req-{event_id}"),
                model: Some(model.to_string()),
                timestamp: "2026-08-02T10:00:00Z".to_string(),
                payment_mode: PaymentMode::Metered,
                tokens: Some(breakdown),
                unknown_token_fields: Vec::new(),
                amount_nanousd: None,
                observed_cost_nanousd: None,
                harness: Some("buzz-acp".to_string()),
                session_id: None,
                turn_id: None,
                http_status: Some(200),
                description: None,
                agent_pubkey: None,
                channel_id: None,
                work_context: None,
            },
        }
    }

    fn fixture_set() -> (Vec<StoredUsageRecord>, PriceBook, Rulebook, CorrectionBook) {
        let mut internal = record("aa", DAY_2026_08_02, "m", tokens(1_000, 100));
        internal.payload.work_context = Some(context(CommercialPurpose::Administration, None));

        let mut client = record("bb", DAY_2026_08_02 + 10, "m", tokens(2_000, 200));
        client.payload.work_context = Some(context(
            CommercialPurpose::ClientDelivery,
            Some("tennant-group"),
        ));

        let orphan = record("cc", DAY_2026_08_02 + 20, "m", tokens(500, 50));

        (
            vec![internal, client, orphan],
            book(),
            Rulebook::default(),
            CorrectionBook::default(),
        )
    }

    /// End to end: the provider on the record has to actually reach the price
    /// book, and what it was priced from has to reach the report.
    ///
    /// The meter has always recorded the provider, and pricing ignored it, so
    /// a call a reseller served and invoiced was charged at the vendor's own
    /// rate. Read on 2026-08-05, that gap was up to 67% on `deepseek-v4-flash`.
    #[test]
    fn a_records_provider_selects_the_price_and_is_reported_on_the_entry() {
        let (records, _, rules, corrections) = fixture_set();

        let mut prices = book();
        // The same model at a reseller's own rate: half the list price.
        let mut resold = prices.entries[0].clone();
        resold.rates.input_nanousd_per_mtok /= 2;
        resold.rates.output_nanousd_per_mtok /= 2;
        resold.conditions = crate::ledger::conditions::PriceConditions {
            provider: Some("bedrock".to_string()),
            ..Default::default()
        };
        prices.entries.push(resold);

        // The fixture records are all `anthropic`; move one to Bedrock.
        let mut records = records;
        records[0].payload.provider = "bedrock".to_string();

        let report = compute_ledger(records, &prices, &rules, &corrections, &[]);
        let entry = |id: &str| {
            report
                .entries
                .iter()
                .find(|e| e.event_id == id)
                .unwrap_or_else(|| panic!("entry {id}"))
        };

        // 1_000 input at $0.50 / MTok and 100 output at $2.50 / MTok.
        let bedrock = entry("aa");
        assert_eq!(bedrock.cost_nanousd, Some(1_000 * 500 + 100 * 2_500));
        assert_eq!(
            bedrock.price_basis,
            Some(PriceBasis::ProviderRow),
            "priced from Bedrock's own row"
        );

        // 2_000 input at $1 / MTok and 200 output at $5 / MTok: unchanged,
        // because adding a Bedrock row must not touch anyone else's price.
        let direct = entry("bb");
        assert_eq!(direct.cost_nanousd, Some(2_000 * 1_000 + 200 * 5_000));
        assert_eq!(
            direct.price_basis,
            Some(PriceBasis::ListRow),
            "priced from list, and says so"
        );
    }

    /// A cost the provider stated beats any rate we could look up, including a
    /// rate we hold for that exact provider.
    ///
    /// The book models a charge. This is the charge, already carrying the
    /// margin, promotion and routing decision the book cannot see.
    #[test]
    fn a_cost_the_provider_stated_wins_over_every_row_in_the_book() {
        let (records, prices, rules, corrections) = fixture_set();
        let mut records = records;
        // A figure that matches no rate in the book, so a passing assertion
        // cannot be the book agreeing by coincidence.
        records[0].payload.observed_cost_nanousd = Some(7_777_777);

        let report = compute_ledger(records, &prices, &rules, &corrections, &[]);
        let entry = report
            .entries
            .iter()
            .find(|e| e.event_id == "aa")
            .expect("entry");
        assert_eq!(entry.cost_nanousd, Some(7_777_777));
        assert_eq!(entry.price_basis, Some(PriceBasis::Observed));
    }

    /// The whole point: a provider we have never priced still yields money.
    ///
    /// Without this the model lands in Needs Review and the spend reads as
    /// unknown, which is the state production is in today for every model
    /// missing from the catalog.
    #[test]
    fn a_stated_cost_prices_a_model_the_book_has_never_heard_of() {
        let (records, prices, rules, corrections) = fixture_set();
        let mut records = records;
        records[0].payload.model = Some("some-model-nobody-priced".to_string());
        records[0].payload.observed_cost_nanousd = Some(4_200_000);

        let report = compute_ledger(records, &prices, &rules, &corrections, &[]);
        let entry = report
            .entries
            .iter()
            .find(|e| e.event_id == "aa")
            .expect("entry");
        assert_eq!(entry.cost_nanousd, Some(4_200_000));
        assert_eq!(entry.price_basis, Some(PriceBasis::Observed));
        assert!(
            !report.exceptions.iter().any(|exception| matches!(
                exception,
                LedgerException::UnpricedModel { event_id, .. } if event_id == "aa"
            )),
            "the money is known, so nothing is unpriced"
        );
    }

    /// Negative control for the two tests above: with the stated cost removed
    /// and nothing else changed, an unknown model is unpriced again.
    #[test]
    fn without_a_stated_cost_an_unknown_model_is_still_unpriced() {
        let (records, prices, rules, corrections) = fixture_set();
        let mut records = records;
        records[0].payload.model = Some("some-model-nobody-priced".to_string());

        let report = compute_ledger(records, &prices, &rules, &corrections, &[]);
        let entry = report
            .entries
            .iter()
            .find(|e| e.event_id == "aa")
            .expect("entry");
        assert_eq!(entry.cost_nanousd, None);
        assert_eq!(entry.price_basis, None);
        assert!(report.exceptions.iter().any(|exception| matches!(
            exception,
            LedgerException::UnpricedModel { event_id, .. } if event_id == "aa"
        )));
    }

    /// A provider stating zero is a fact about a free call, and must survive
    /// as zero rather than being taken for "no figure" and sent to the book.
    #[test]
    fn a_stated_zero_is_a_free_call_not_a_missing_figure() {
        let (records, prices, rules, corrections) = fixture_set();
        let mut records = records;
        records[0].payload.observed_cost_nanousd = Some(0);

        let report = compute_ledger(records, &prices, &rules, &corrections, &[]);
        let entry = report
            .entries
            .iter()
            .find(|e| e.event_id == "aa")
            .expect("entry");
        assert_eq!(entry.cost_nanousd, Some(0));
        assert_eq!(entry.price_basis, Some(PriceBasis::Observed));
    }

    /// A flat-amount record never consults the book, so it must not claim a
    /// basis it did not use.
    #[test]
    fn an_amount_record_reports_no_price_basis() {
        let (records, prices, rules, corrections) = fixture_set();
        let mut records = records;
        records[0].payload.tokens = None;
        records[0].payload.model = None;
        records[0].payload.amount_nanousd = Some(12_345);

        let report = compute_ledger(records, &prices, &rules, &corrections, &[]);
        let entry = report
            .entries
            .iter()
            .find(|e| e.event_id == "aa")
            .expect("entry");
        assert_eq!(entry.cost_nanousd, Some(12_345));
        assert_eq!(entry.price_basis, None);
    }

    #[test]
    fn utc_day_converts_known_dates() {
        assert_eq!(utc_day(0), "1970-01-01");
        assert_eq!(utc_day(DAY_2026_08_02), "2026-08-02");
        assert_eq!(utc_day(DAY_2026_08_02 + 86_399), "2026-08-02");
        assert_eq!(utc_day(DAY_2026_08_02 + 86_400), "2026-08-03");
        // Leap day, to prove the civil-from-days arithmetic.
        assert_eq!(utc_day(1_709_164_800), "2024-02-29");
    }

    #[test]
    fn determinism_shuffled_input_produces_identical_report() {
        let (records, prices, rules, corrections) = fixture_set();
        let a = compute_ledger(records.clone(), &prices, &rules, &corrections, &[]);
        let mut shuffled = records;
        shuffled.reverse();
        let b = compute_ledger(shuffled, &prices, &rules, &corrections, &[]);
        assert_eq!(a, b);
    }

    #[test]
    fn idempotent_republish_counts_once_silently() {
        let (mut records, prices, rules, corrections) = fixture_set();
        let mut republished = records[0].clone();
        republished.event_id = "zz".to_string();
        records.push(republished);

        let report = compute_ledger(records, &prices, &rules, &corrections, &[]);
        assert_eq!(
            report.entries.len(),
            3,
            "the republish must not add an entry"
        );
        assert!(
            report.exceptions.is_empty(),
            "an identical republish is not an exception: {:?}",
            report.exceptions
        );
    }

    #[test]
    fn conflicting_duplicate_keeps_first_and_flags_exception() {
        let (mut records, prices, rules, corrections) = fixture_set();
        let mut conflicting = records[0].clone();
        conflicting.event_id = "zz".to_string();
        conflicting.created_at += 1;
        conflicting.payload.tokens = Some(tokens(9_999, 9_999));
        records.push(conflicting);

        let report = compute_ledger(records, &prices, &rules, &corrections, &[]);
        assert_eq!(report.entries.len(), 3);
        assert_eq!(report.entries[0].event_id, "aa", "the first record is kept");
        assert!(matches!(
            report.exceptions.as_slice(),
            [LedgerException::DuplicateConflict {
                kept_event_id,
                dropped_event_id,
                ..
            }] if kept_event_id == "aa" && dropped_event_id == "zz"
        ));
    }

    #[test]
    fn same_request_id_different_provider_counts_twice() {
        let (mut records, prices, rules, corrections) = fixture_set();
        let mut other_provider = records[0].clone();
        other_provider.event_id = "zz".to_string();
        other_provider.created_at += 1;
        other_provider.payload.provider = "openai".to_string();
        records.push(other_provider);

        let report = compute_ledger(records, &prices, &rules, &corrections, &[]);
        assert_eq!(
            report.entries.len(),
            4,
            "two providers may issue the same request id; both are real spend"
        );
        assert!(report.exceptions.is_empty());
    }

    #[test]
    fn unpriced_model_flags_exception_and_forces_needs_review() {
        let (mut records, prices, rules, corrections) = fixture_set();
        records[0].payload.model = Some("unknown-model".to_string());

        let report = compute_ledger(records, &prices, &rules, &corrections, &[]);
        let entry = report
            .entries
            .iter()
            .find(|e| e.event_id == "aa")
            .expect("entry");
        assert_eq!(entry.cost_nanousd, None, "never zero, never a guess");
        assert_eq!(
            entry.effective_classification,
            CostClassification::NeedsReview
        );
        assert!(report.exceptions.iter().any(|e| matches!(
            e,
            LedgerException::UnpricedModel { model, .. } if model == "unknown-model"
        )));
    }

    #[test]
    fn explicit_context_classifies_cogs_with_client_and_opex_for_internal() {
        let (records, prices, rules, corrections) = fixture_set();
        let report = compute_ledger(records, &prices, &rules, &corrections, &[]);

        let internal = &report.entries[0];
        assert_eq!(internal.effective_classification, CostClassification::Opex);
        assert_eq!(internal.attributed_by, AttributionMethod::Explicit);
        // 1_000 * 1_000 + 100 * 5_000
        assert_eq!(internal.cost_nanousd, Some(1_500_000));

        let client = &report.entries[1];
        assert_eq!(client.effective_classification, CostClassification::Cogs);
        // 2_000 * 1_000 + 200 * 5_000
        assert_eq!(client.cost_nanousd, Some(3_000_000));

        assert_eq!(report.totals.opex, 1_500_000);
        assert_eq!(report.totals.cogs, 3_000_000);
    }

    #[test]
    fn unmatched_record_lands_in_needs_review() {
        let (records, prices, rules, corrections) = fixture_set();
        let report = compute_ledger(records, &prices, &rules, &corrections, &[]);

        let orphan = &report.entries[2];
        assert_eq!(orphan.attributed_by, AttributionMethod::NeedsReview);
        assert_eq!(
            orphan.effective_classification,
            CostClassification::NeedsReview
        );
        assert_eq!(orphan.effective_assignment, None);
        // 500 * 1_000 + 50 * 5_000
        assert_eq!(report.totals.needs_review, 750_000);
        assert_eq!(
            report
                .by_cost_centre
                .iter()
                .find(|(centre, _)| centre == NEEDS_REVIEW_COST_CENTRE)
                .map(|(_, amount)| *amount),
            Some(750_000)
        );
    }

    #[test]
    fn rule_attribution_applies_when_no_explicit_context() {
        let (records, prices, _rules, corrections) = fixture_set();
        let rules = Rulebook {
            rules: vec![AttributionRule {
                id: "catch-all".to_string(),
                priority: 1,
                match_provider: Some("anthropic".to_string()),
                match_harness: None,
                match_agent_pubkey: None,
                match_channel_id: None,
                match_model: None,
                assign: assignment("internal-ops", CommercialPurpose::Marketing, None),
            }],
        };

        let report = compute_ledger(records, &prices, &rules, &corrections, &[]);
        let orphan = &report.entries[2];
        assert_eq!(
            orphan.attributed_by,
            AttributionMethod::Rule("catch-all".to_string())
        );
        assert_eq!(orphan.effective_classification, CostClassification::Opex);
        assert_eq!(report.totals.needs_review, 0);

        // The explicit records keep their own context; a rule does not
        // override what was captured at spend time.
        assert_eq!(report.entries[0].attributed_by, AttributionMethod::Explicit);
    }

    #[test]
    fn correction_overrides_classification_and_preserves_original() {
        let (mut records, prices, rules, _c) = fixture_set();
        records.truncate(1);
        let corrections = CorrectionBook {
            corrections: vec![Correction {
                id: "c1".to_string(),
                usage_record_event_id: "aa".to_string(),
                assign: assignment(
                    "web-delivery",
                    CommercialPurpose::ClientDelivery,
                    Some("tennant-group"),
                ),
                reason: "was billable client work".to_string(),
                corrected_at: 1_700_000_100,
            }],
        };

        let report = compute_ledger(records, &prices, &rules, &corrections, &[]);
        let entry = &report.entries[0];
        assert_eq!(
            entry.original_classification,
            CostClassification::Opex,
            "the original evidence survives the correction"
        );
        assert_eq!(entry.effective_classification, CostClassification::Cogs);
        assert_eq!(
            entry.attributed_by,
            AttributionMethod::Correction("c1".to_string())
        );
        assert_eq!(
            entry.effective_assignment.as_ref().unwrap().cost_centre_id,
            "web-delivery"
        );
        assert_eq!(report.totals.opex, 0);
        assert_eq!(report.totals.cogs, 1_500_000);
    }

    #[test]
    fn last_correction_for_a_record_wins() {
        let (mut records, prices, rules, _c) = fixture_set();
        records.truncate(1);
        let corrections = CorrectionBook {
            corrections: vec![
                Correction {
                    id: "c1".to_string(),
                    usage_record_event_id: "aa".to_string(),
                    assign: assignment(
                        "web-delivery",
                        CommercialPurpose::ClientDelivery,
                        Some("tennant-group"),
                    ),
                    reason: "first attempt".to_string(),
                    corrected_at: 1_700_000_100,
                },
                Correction {
                    id: "c2".to_string(),
                    usage_record_event_id: "aa".to_string(),
                    assign: assignment("internal-ops", CommercialPurpose::Sales, None),
                    reason: "actually sales".to_string(),
                    corrected_at: 1_700_000_200,
                },
            ],
        };

        let report = compute_ledger(records, &prices, &rules, &corrections, &[]);
        assert_eq!(
            report.entries[0].attributed_by,
            AttributionMethod::Correction("c2".to_string())
        );
        assert_eq!(
            report.entries[0].effective_classification,
            CostClassification::Opex
        );
    }

    #[test]
    fn manual_amount_record_flows_straight_to_totals() {
        let (mut records, prices, rules, corrections) = fixture_set();
        records.truncate(0);
        let mut manual = record("dd", DAY_2026_08_02, "unused", tokens(0, 0));
        manual.payload.source = UsageSource::Manual;
        manual.payload.provider = "figma".to_string();
        manual.payload.request_id = "invoice-123".to_string();
        manual.payload.model = None;
        manual.payload.tokens = None;
        manual.payload.amount_nanousd = Some(12_500_000_000);
        manual.payload.description = Some("design seat".to_string());
        manual.payload.work_context = Some(context(CommercialPurpose::Administration, None));
        records.push(manual);

        let report = compute_ledger(records, &prices, &rules, &corrections, &[]);
        assert_eq!(report.entries[0].cost_nanousd, Some(12_500_000_000));
        assert_eq!(report.totals.opex, 12_500_000_000);
        assert!(
            report.exceptions.is_empty(),
            "a manual amount needs no price book"
        );
    }

    #[test]
    fn imputed_records_split_from_metered_and_stay_out_of_by_day() {
        let (mut records, prices, rules, corrections) = fixture_set();
        records.truncate(2);
        records[1].payload.payment_mode = PaymentMode::Imputed;

        let report = compute_ledger(records, &prices, &rules, &corrections, &[]);
        assert_eq!(report.metered_nanousd, 1_500_000);
        assert_eq!(report.imputed_nanousd, 3_000_000);
        assert_eq!(
            report.totals.cogs, 3_000_000,
            "subscription work still counts toward unit economics"
        );

        assert_eq!(report.by_day.len(), 1);
        assert_eq!(
            report.by_day[0].metered_nanousd, 1_500_000,
            "a provider invoice contains metered spend only"
        );
    }

    #[test]
    fn budget_status_compares_actual_to_budget_for_the_period() {
        let (records, prices, rules, corrections) = fixture_set();
        let budgets = vec![
            Budget {
                cost_centre_id: "internal-ops".to_string(),
                period: "2026-08".to_string(),
                amount_nanousd: 10_000_000,
            },
            Budget {
                cost_centre_id: "web-delivery".to_string(),
                period: "2026-09".to_string(),
                amount_nanousd: 50_000_000,
            },
        ];

        let report = compute_ledger(records, &prices, &rules, &corrections, &budgets);
        assert_eq!(report.budget_status[0].actual_nanousd, 1_500_000);
        assert_eq!(report.budget_status[0].budget_nanousd, 10_000_000);
        assert_eq!(
            report.budget_status[1].actual_nanousd, 0,
            "a different month must not absorb this month's spend"
        );
    }

    #[test]
    fn bad_timestamp_falls_back_to_created_at_and_flags_exception() {
        let (mut records, prices, rules, corrections) = fixture_set();
        records.truncate(1);
        records[0].payload.timestamp = "not-a-timestamp".to_string();

        let report = compute_ledger(records, &prices, &rules, &corrections, &[]);
        assert_eq!(
            report.entries[0].day, "2026-08-02",
            "fell back to created_at"
        );
        assert!(report.exceptions.iter().any(|e| matches!(
            e,
            LedgerException::BadTimestamp { event_id, .. } if event_id == "aa"
        )));
    }
}
