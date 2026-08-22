//! Reading the company's cost ledger.
//!
//! The renderer cannot compute this itself. Usage records are NIP-44
//! ciphertext addressed to the owner, so reading them needs the owner's
//! secret key, which only this process holds. The arithmetic then runs
//! through `buzz_core::ledger`, the same engine the CLI reports from — a
//! second implementation in TypeScript would let the two disagree about what
//! a company spent.
//!
//! Spec: `docs/nips/NIP-CL.md`.

use serde::Serialize;
use tauri::State;

use buzz_core_pkg::{
    kind::{KIND_ATTRIBUTION_RULEBOOK, KIND_CORRECTION_BOOK, KIND_LEDGER_BUDGET, KIND_PRICE_BOOK},
    ledger::{
        attribution::{CorrectionBook, Rulebook},
        engine::{compute_ledger, LedgerReport},
        prices::PriceBook,
        reconcile::diagnose,
    },
};

use crate::{
    app_state::AppState, commands::identity_archive::fetch_relay_self, relay::query_relay,
};

mod usage_records;

use usage_records::read_usage_records;

/// `d` tag addressing each singleton book. One coordinate per community.
const PRICE_BOOK_D_TAG: &str = "pricebook";
const RULEBOOK_D_TAG: &str = "rulebook";
const CORRECTION_BOOK_D_TAG: &str = "corrections";

/// Upper bound on budget heads read in one pass. A company with more cost
/// centres than this has outgrown a single screen anyway.
const MAX_BUDGETS: usize = 500;

// ── Wire view ───────────────────────────────────────────────────────────────
//
// Money crosses to the renderer as decimal strings, never JSON numbers.
// nanoUSD passes 2^53 at about $9,007, which a real company spends inside a
// year; past that a JSON number has already been rounded by the time
// JavaScript sees it, and a rounded total presented as money is a lie the UI
// cannot detect. The TypeScript contracts parse these strings to `bigint`.

/// Spend totals by accounting classification.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassTotalsView {
    /// Cost of goods sold: direct client delivery.
    pub cogs: String,
    /// Operating expense: internal work.
    pub opex: String,
    /// Unresolved: the engine could not place it.
    pub needs_review: String,
}

/// One priced, attributed usage record.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerEntryView {
    /// Hex event id of the underlying usage record.
    pub event_id: String,
    /// UTC day in `YYYY-MM-DD` form.
    pub day: String,
    /// Provider slug.
    pub provider: String,
    /// Model, when the record was token-priced.
    pub model: Option<String>,
    /// Serialized [`buzz_core_pkg::usage_record::PaymentMode`].
    pub payment_mode: serde_json::Value,
    /// Serialized [`buzz_core_pkg::usage_record::UsageSource`].
    pub source: serde_json::Value,
    /// Cost in nanoUSD, or `null` when the model is unpriced. An unpriced
    /// model is an open question, never a zero.
    pub cost_nanousd: Option<String>,
    /// Which kind of price row supplied the rate: `providerRow` when a row
    /// named this call's provider, `listRow` when it was the vendor's list
    /// price. `null` for unpriced and flat-amount records, which consulted no
    /// book.
    ///
    /// A rate wrong by a reseller's margin looks exactly like a right one, so
    /// the basis travels with the number rather than being inferred from it.
    pub price_basis: Option<serde_json::Value>,
    /// Classification before any correction. Never changes.
    pub original_classification: serde_json::Value,
    /// Classification in force now, after corrections.
    pub effective_classification: serde_json::Value,
    /// Assignment in force now, when one was established.
    pub effective_assignment: Option<serde_json::Value>,
    /// How the effective attribution was established.
    pub attributed_by: serde_json::Value,
}

/// A budget and what was actually spent against it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetStatusView {
    /// Cost centre the budget governs.
    pub cost_centre_id: String,
    /// Month in `YYYY-MM` form.
    pub period: String,
    /// The limit in nanoUSD.
    pub budget_nanousd: String,
    /// Spend recorded against it in nanoUSD.
    pub actual_nanousd: String,
}

/// Spend attributed to one cost centre.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostCentreTotalView {
    /// Cost centre, or `needs-review` for unattributed money.
    pub cost_centre_id: String,
    /// Spend in nanoUSD.
    pub amount_nanousd: String,
}

/// Metered spend for one provider on one UTC day.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailySumView {
    /// Provider slug.
    pub provider: String,
    /// Day in `YYYY-MM-DD` form.
    pub day: String,
    /// Metered spend in nanoUSD.
    pub metered_nanousd: String,
}

/// Something the engine could not resolve, with its plain-language reading.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExceptionView {
    /// The exception as the engine emitted it.
    pub exception: serde_json::Value,
    /// What it most likely means, when the engine can say.
    pub diagnosis: Option<String>,
}

/// The full computed ledger, as the renderer receives it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerReportView {
    /// One entry per counted record, ordered by `(created_at, event_id)`.
    pub entries: Vec<LedgerEntryView>,
    /// Totals by effective classification.
    pub totals: ClassTotalsView,
    /// Real money spent.
    pub metered_nanousd: String,
    /// Subscription-backed spend at API-equivalent prices.
    pub imputed_nanousd: String,
    /// Spend per cost centre; unattributed money is under `needs-review`.
    pub by_cost_centre: Vec<CostCentreTotalView>,
    /// Metered wire spend per provider-day.
    pub by_day: Vec<DailySumView>,
    /// Budgets and their actuals.
    pub budget_status: Vec<BudgetStatusView>,
    /// Everything the engine could not resolve.
    pub exceptions: Vec<ExceptionView>,
    /// Records addressed to this owner that could not be decrypted or
    /// parsed. Reported rather than dropped: a spend total computed over
    /// fewer records than exist is understated, and the UI has to be able to
    /// say so.
    pub unreadable_records: usize,
    /// True when no price book has been published, which makes every model
    /// unpriced. Distinguishes "nothing has been priced yet" from "this
    /// particular model is missing".
    pub price_book_missing: bool,
}

impl LedgerReportView {
    fn from_report(
        report: LedgerReport,
        unreadable_records: usize,
        price_book_missing: bool,
    ) -> Self {
        Self {
            entries: report
                .entries
                .into_iter()
                .map(|entry| LedgerEntryView {
                    event_id: entry.event_id,
                    day: entry.day,
                    provider: entry.provider,
                    model: entry.model,
                    payment_mode: serde_json::to_value(entry.payment_mode)
                        .unwrap_or(serde_json::Value::Null),
                    source: serde_json::to_value(entry.source).unwrap_or(serde_json::Value::Null),
                    cost_nanousd: entry.cost_nanousd.map(|cost| cost.to_string()),
                    price_basis: entry
                        .price_basis
                        .and_then(|basis| serde_json::to_value(basis).ok()),
                    original_classification: serde_json::to_value(entry.original_classification)
                        .unwrap_or(serde_json::Value::Null),
                    effective_classification: serde_json::to_value(entry.effective_classification)
                        .unwrap_or(serde_json::Value::Null),
                    effective_assignment: entry
                        .effective_assignment
                        .and_then(|assignment| serde_json::to_value(assignment).ok()),
                    attributed_by: serde_json::to_value(entry.attributed_by)
                        .unwrap_or(serde_json::Value::Null),
                })
                .collect(),
            totals: ClassTotalsView {
                cogs: report.totals.cogs.to_string(),
                opex: report.totals.opex.to_string(),
                needs_review: report.totals.needs_review.to_string(),
            },
            metered_nanousd: report.metered_nanousd.to_string(),
            imputed_nanousd: report.imputed_nanousd.to_string(),
            by_cost_centre: report
                .by_cost_centre
                .into_iter()
                .map(|(cost_centre_id, amount)| CostCentreTotalView {
                    cost_centre_id,
                    amount_nanousd: amount.to_string(),
                })
                .collect(),
            by_day: report
                .by_day
                .into_iter()
                .map(|sum| DailySumView {
                    provider: sum.provider,
                    day: sum.day,
                    metered_nanousd: sum.metered_nanousd.to_string(),
                })
                .collect(),
            budget_status: report
                .budget_status
                .into_iter()
                .map(|status| BudgetStatusView {
                    cost_centre_id: status.cost_centre_id,
                    period: status.period,
                    budget_nanousd: status.budget_nanousd.to_string(),
                    actual_nanousd: status.actual_nanousd.to_string(),
                })
                .collect(),
            exceptions: report
                .exceptions
                .into_iter()
                .map(|exception| ExceptionView {
                    diagnosis: diagnose(&exception).map(str::to_owned),
                    exception: serde_json::to_value(exception).unwrap_or(serde_json::Value::Null),
                })
                .collect(),
            unreadable_records,
            price_book_missing,
        }
    }
}

// ── Reads ───────────────────────────────────────────────────────────────────

/// The newest head for a replaceable coordinate.
///
/// A relay may return more than one; the newest `created_at` wins, ties
/// broken by the lower event id so every reader picks the same one.
fn newest_head(events: Vec<nostr::Event>) -> Option<nostr::Event> {
    events
        .into_iter()
        .fold(None, |winner: Option<nostr::Event>, event| match winner {
            Some(current)
                if current.created_at > event.created_at
                    || (current.created_at == event.created_at && current.id <= event.id) =>
            {
                Some(current)
            }
            _ => Some(event),
        })
}

/// Read one book head, or `None` when none has been published.
///
/// Pinned to `authors: [relay]`: a book is only canonical if the tenant
/// relay's own key wrote it, and a member-authored event at the same
/// coordinate is not this company's price list.
async fn fetch_book_head(
    state: &AppState,
    relay_pubkey: &str,
    kind: u32,
    d_tag: &str,
) -> Result<Option<nostr::Event>, String> {
    let events = query_relay(
        state,
        &[serde_json::json!({
            "kinds": [kind],
            "authors": [relay_pubkey],
            "#d": [d_tag],
            "limit": 1,
        })],
    )
    .await?;
    Ok(newest_head(events))
}

/// Read a book, defaulting to empty when none has been published.
///
/// A head that exists but does not parse is an error rather than an empty
/// default: silently treating a corrupt price book as "no prices" would
/// report every model as unpriced and hide the real fault.
async fn load_book<T: serde::de::DeserializeOwned + Default>(
    state: &AppState,
    relay_pubkey: &str,
    kind: u32,
    d_tag: &str,
) -> Result<(T, bool), String> {
    match fetch_book_head(state, relay_pubkey, kind, d_tag).await? {
        None => Ok((T::default(), true)),
        Some(event) => serde_json::from_str::<T>(&event.content)
            .map(|book| (book, false))
            .map_err(|error| format!("the stored {d_tag} is unreadable: {error}")),
    }
}

/// Compute the company's cost ledger.
///
/// Reads the books, decrypts every usage record addressed to this identity
/// or authored by it (a seat meter authors the records it owns), and folds
/// them through `buzz_core::ledger`. Records that cannot be read are
/// counted into `unreadableRecords` rather than skipped silently.
#[tauri::command]
pub async fn ledger_report(state: State<'_, AppState>) -> Result<LedgerReportView, String> {
    let keys = state.signing_keys()?;
    let relay_pubkey = fetch_relay_self(&state).await?.ok_or_else(|| {
        "the relay does not publish its own key, so its books cannot be trusted as canonical"
            .to_string()
    })?;

    let (prices, price_book_missing) =
        load_book::<PriceBook>(&state, &relay_pubkey, KIND_PRICE_BOOK, PRICE_BOOK_D_TAG).await?;
    let (rules, _) = load_book::<Rulebook>(
        &state,
        &relay_pubkey,
        KIND_ATTRIBUTION_RULEBOOK,
        RULEBOOK_D_TAG,
    )
    .await?;
    let (corrections, _) = load_book::<CorrectionBook>(
        &state,
        &relay_pubkey,
        KIND_CORRECTION_BOOK,
        CORRECTION_BOOK_D_TAG,
    )
    .await?;

    let budget_events = query_relay(
        &state,
        &[serde_json::json!({
            "kinds": [KIND_LEDGER_BUDGET],
            "authors": [relay_pubkey],
            "limit": MAX_BUDGETS,
        })],
    )
    .await?;
    let budgets = budget_events
        .iter()
        .filter_map(|event| serde_json::from_str(&event.content).ok())
        .collect::<Vec<_>>();

    // Usage records are addressed to their owner by `p` tag and encrypted to
    // them, so the owner read returns only what this identity is entitled to
    // decrypt. A seat meter is the member's own machine, so the member both
    // authors and owns the record; the relay drops a `p` tag that points at
    // the event's own author, which makes those records invisible to the
    // owner read. Read the author side too and dedupe on event id, exactly
    // as the CLI report does.
    let mine = keys.public_key().to_hex();
    let (records, unreadable_records) = read_usage_records(
        |filters| {
            let state = state.clone();
            async move { query_relay(&state, &filters).await }
        },
        &mine,
        &keys,
    )
    .await?;

    let report = compute_ledger(records, &prices, &rules, &corrections, &budgets);
    Ok(LedgerReportView::from_report(
        report,
        unreadable_records,
        price_book_missing,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core_pkg::company::CostClassification;
    use buzz_core_pkg::{
        ledger::engine::{AttributionMethod, ClassTotals, LedgerEntry},
        usage_record::{PaymentMode, UsageSource},
    };

    /// $3 per million tokens is 3000 nanoUSD per token. Getting this wrong
    /// by a factor of a thousand would misstate every future total without
    /// anything looking broken.
    #[test]
    fn dollars_per_million_tokens_convert_exactly() {
        assert_eq!(per_mtok_to_nanousd("3", "Input").unwrap(), 3_000_000_000);
        assert_eq!(per_mtok_to_nanousd("15", "Output").unwrap(), 15_000_000_000);
        assert_eq!(
            per_mtok_to_nanousd("0.30", "Cache read").unwrap(),
            300_000_000
        );
        assert_eq!(
            per_mtok_to_nanousd("3.75", "Cache write").unwrap(),
            3_750_000_000
        );
        assert_eq!(per_mtok_to_nanousd("0", "Input").unwrap(), 0);
    }

    /// An owner must be able to publish the rate their vendor charges. This
    /// one was refused outright before the stored unit changed.
    #[test]
    fn a_sub_nanousd_per_token_vendor_rate_can_be_published() {
        assert_eq!(
            per_mtok_to_nanousd("0.0028", "Cache read").unwrap(),
            2_800_000
        );
    }

    /// Parsed as text, never through a float.
    #[test]
    fn a_decimal_that_a_float_would_mangle_stays_exact() {
        // 0.1 through an f64 is 0.09999999999999999.
        assert_eq!(usd_text_to_nanousd("0.1", "Input").unwrap(), 100_000_000);
        assert_eq!(
            usd_text_to_nanousd("0.000000001", "Input").unwrap(),
            1,
            "one nanoUSD must survive"
        );
    }

    /// Finer than the stored unit is still refused rather than rounded.
    #[test]
    fn precision_finer_than_the_stored_unit_is_refused() {
        assert_eq!(per_mtok_to_nanousd("0.000000001", "Input").unwrap(), 1);
        let error = per_mtok_to_nanousd("0.0000000001", "Input").unwrap_err();
        assert!(error.contains("finer than one nanoUSD"), "{error}");
    }

    #[test]
    fn a_malformed_amount_names_the_field() {
        for bad in ["", "  ", "-1", "1.2.3", "3x", "$3"] {
            let error = usd_text_to_nanousd(bad, "Input").unwrap_err();
            assert!(error.contains("Input"), "{bad} -> {error}");
        }
    }

    /// Larger than `Number.MAX_SAFE_INTEGER` (2^53 - 1), which is about
    /// $9,007 in nanoUSD.
    const PAST_SAFE_INTEGER: u128 = 9_007_199_254_740_993;

    fn report_with_money(amount: u128) -> LedgerReport {
        LedgerReport {
            entries: vec![LedgerEntry {
                event_id: "a".repeat(64),
                day: "2026-08-03".to_string(),
                provider: "anthropic".to_string(),
                model: Some("claude-sonnet-4-5".to_string()),
                source: UsageSource::Wire,
                payment_mode: PaymentMode::Metered,
                cost_nanousd: Some(amount),
                price_basis: None,
                original_classification: CostClassification::Opex,
                effective_classification: CostClassification::Opex,
                effective_assignment: None,
                attributed_by: AttributionMethod::NeedsReview,
            }],
            totals: ClassTotals {
                cogs: amount,
                opex: 0,
                needs_review: 0,
            },
            metered_nanousd: amount,
            imputed_nanousd: 0,
            by_cost_centre: vec![("web-delivery".to_string(), amount)],
            by_day: vec![buzz_core_pkg::ledger::engine::DailySum {
                provider: "anthropic".to_string(),
                day: "2026-08-03".to_string(),
                metered_nanousd: amount,
            }],
            budget_status: vec![buzz_core_pkg::ledger::engine::BudgetStatus {
                cost_centre_id: "web-delivery".to_string(),
                period: "2026-08".to_string(),
                budget_nanousd: amount,
                actual_nanousd: amount,
            }],
            exceptions: Vec::new(),
        }
    }

    /// Every money field must survive JSON as an exact decimal string. A
    /// JSON number would already have been rounded by the time the renderer
    /// parsed it, and a rounded total shown as money cannot be detected
    /// downstream.
    #[test]
    fn money_crosses_the_boundary_as_exact_strings() {
        let view = LedgerReportView::from_report(report_with_money(PAST_SAFE_INTEGER), 0, false);
        let json = serde_json::to_string(&view).expect("view must serialize");
        let round_tripped: serde_json::Value =
            serde_json::from_str(&json).expect("view must parse back");

        let expected = PAST_SAFE_INTEGER.to_string();
        for pointer in [
            "/meteredNanousd",
            "/totals/cogs",
            "/byCostCentre/0/amountNanousd",
            "/byDay/0/meteredNanousd",
            "/budgetStatus/0/budgetNanousd",
            "/budgetStatus/0/actualNanousd",
            "/entries/0/costNanousd",
        ] {
            let value = round_tripped
                .pointer(pointer)
                .unwrap_or_else(|| panic!("{pointer} must be present"));
            assert_eq!(
                value.as_str(),
                Some(expected.as_str()),
                "{pointer} must be an exact decimal string, got {value}"
            );
        }
    }

    /// An unpriced model has no cost. It must arrive as null, never as the
    /// string "0" — zero is a claim that the call was free.
    #[test]
    fn an_unpriced_entry_reports_no_cost_rather_than_zero() {
        let mut report = report_with_money(0);
        report.entries[0].cost_nanousd = None;
        let view = LedgerReportView::from_report(report, 0, true);
        assert_eq!(view.entries[0].cost_nanousd, None);
        assert!(view.price_book_missing);
    }

    #[test]
    fn adapter_source_crosses_the_boundary_with_the_protocol_spelling() {
        let mut report = report_with_money(1);
        report.entries[0].source = UsageSource::AdapterEstimate;
        let view = LedgerReportView::from_report(report, 0, false);
        let json = serde_json::to_value(view).expect("view must serialize");
        assert_eq!(json["entries"][0]["source"], "adapter_estimate");
    }

    /// The relay may answer a replaceable query with more than one head.
    #[test]
    fn the_newest_head_wins_and_ties_break_deterministically() {
        let keys = nostr::Keys::generate();
        let build = |created_at: u64, content: &str| {
            nostr::EventBuilder::new(nostr::Kind::Custom(KIND_PRICE_BOOK as u16), content)
                .tags([nostr::Tag::identifier("pricebook")])
                .custom_created_at(nostr::Timestamp::from_secs(created_at))
                .sign_with_keys(&keys)
                .expect("event must sign")
        };
        let older = build(1_785_628_800, "older");
        let newer = build(1_785_628_900, "newer");

        let picked = newest_head(vec![older.clone(), newer.clone()]).expect("a head");
        assert_eq!(picked.content, "newer");
        // Order of arrival must not change the answer.
        let picked = newest_head(vec![newer, older]).expect("a head");
        assert_eq!(picked.content, "newer");
        assert!(newest_head(Vec::new()).is_none());
    }
}

// ── Corrections ─────────────────────────────────────────────────────────────

/// A re-attribution the owner is asking for.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CorrectionRequest {
    /// Hex event id of the usage record being re-attributed.
    pub usage_record_event_id: String,
    /// Company charged.
    pub company_id: String,
    /// Cost centre charged.
    pub cost_centre_id: String,
    /// Team accountable.
    pub owning_team_id: String,
    /// Commercial reason for the work.
    pub commercial_purpose: String,
    /// Client receiving the work, when this is client delivery.
    pub client_organization_id: Option<String>,
    /// Task the work belonged to, when known.
    pub task_id: Option<String>,
    /// Why the original attribution was wrong.
    pub reason: String,
}

/// What the relay made of a correction.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CorrectionOutcome {
    /// Hex id of the submitted action event.
    pub event_id: String,
    /// Whether the relay accepted it.
    pub accepted: bool,
    /// The relay's own message, shown verbatim on refusal.
    pub message: String,
}

fn blank(value: &str) -> bool {
    value.trim().is_empty()
}

/// Re-attribute one usage record.
///
/// A correction never rewrites the record it names. It is appended to the
/// correction book, and the engine applies the last correction for a record
/// when it computes the ledger, leaving the original classification intact.
/// That is what makes the ledger auditable rather than merely current.
///
/// The relay brokers the append and enforces that only the community's human
/// owner may write one; this builds the action, signs it with the local
/// identity, and reports what the relay said.
#[tauri::command]
pub async fn ledger_correct(
    state: State<'_, AppState>,
    request: CorrectionRequest,
) -> Result<CorrectionOutcome, String> {
    // An unexplained restatement is not an audit trail: months later the
    // reason is the only thing that says why the number changed.
    if blank(&request.reason) {
        return Err("a correction needs a reason: it is the audit trail".to_string());
    }
    if blank(&request.company_id)
        || blank(&request.cost_centre_id)
        || blank(&request.owning_team_id)
    {
        return Err("a correction needs a company, a cost centre, and an owning team".to_string());
    }
    if request.usage_record_event_id.len() != 64
        || !request
            .usage_record_event_id
            .chars()
            .all(|c| c.is_ascii_hexdigit())
    {
        return Err("the usage record must be named by its 64-hex event id".to_string());
    }

    let commercial_purpose: buzz_core_pkg::company::CommercialPurpose = serde_json::from_value(
        serde_json::Value::String(request.commercial_purpose.clone()),
    )
    .map_err(|_| format!("unknown commercial purpose: {}", request.commercial_purpose))?;

    let keys = state.signing_keys()?;
    let relay_pubkey = fetch_relay_self(&state)
        .await?
        .ok_or_else(|| "the relay does not publish its own key".to_string())?;

    let correction = buzz_core_pkg::ledger::attribution::Correction {
        id: uuid::Uuid::new_v4().to_string(),
        usage_record_event_id: request.usage_record_event_id,
        assign: buzz_core_pkg::ledger::attribution::RuleAssignment {
            company_id: request.company_id,
            cost_centre_id: request.cost_centre_id,
            owning_team_id: request.owning_team_id,
            commercial_purpose,
            client_organization_id: request.client_organization_id.filter(|value| !blank(value)),
            task_id: request.task_id.filter(|value| !blank(value)),
        },
        reason: request.reason.trim().to_string(),
        corrected_at: chrono::Utc::now().timestamp().max(0) as u64,
    };
    let payload = buzz_sdk_pkg::ledger::LedgerActionPayload::Correction(correction);

    // Compare-and-set against the head this correction was composed on top
    // of. Getting it wrong is not destructive: the broker refuses a mismatch
    // rather than clobbering a concurrent append.
    let expected_head = fetch_book_head(
        &state,
        &relay_pubkey,
        KIND_CORRECTION_BOOK,
        CORRECTION_BOOK_D_TAG,
    )
    .await?
    .map(|event| event.id.to_hex());

    let action = buzz_sdk_pkg::ledger::LedgerAction {
        relay_pubkey: relay_pubkey.clone(),
        operation: payload.operation(),
        request_id: uuid::Uuid::new_v4(),
        idempotency_key: uuid::Uuid::new_v4(),
        target: buzz_sdk_pkg::ledger::ledger_coordinate(&relay_pubkey, &payload),
        expected_head,
        payload,
    };
    let builder = buzz_sdk_pkg::ledger::build_ledger_action(&action)
        .map_err(|error| format!("invalid correction: {error}"))?;

    let response = crate::relay::submit_event_with_keys(builder, &state, &keys, None).await?;
    Ok(CorrectionOutcome {
        event_id: response.event_id,
        accepted: response.accepted,
        message: response.message,
    })
}

// ── Prices ──────────────────────────────────────────────────────────────────

/// A price row the owner is publishing, quoted the way vendors quote.
///
/// Rates arrive as dollars per million tokens, because that is the unit on
/// every vendor's pricing page. Converting here rather than in the renderer
/// keeps one text-to-integer path for money in the whole app.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceRequest {
    /// Model identifier exactly as the provider names it.
    pub model: String,
    /// Uncached input, dollars per million tokens.
    pub input_per_mtok: String,
    /// Cache reads, dollars per million tokens.
    pub cache_read_per_mtok: String,
    /// 5-minute cache writes, dollars per million tokens.
    pub cache_write_5m_per_mtok: String,
    /// 1-hour cache writes, dollars per million tokens.
    pub cache_write_1h_per_mtok: String,
    /// Output, dollars per million tokens.
    pub output_per_mtok: String,
    /// RFC 3339 instant the price takes effect. Absent means now.
    pub effective_from: Option<String>,
    /// Free note for whoever reads the book later.
    pub note: Option<String>,
}

/// Convert a plain dollar amount to integer nanoUSD.
///
/// Parsed as text, never through a float, so 0.1 cannot arrive as
/// 0.09999999999999999. Sub-nanoUSD precision is refused rather than
/// rounded: a ledger that silently rounds is a ledger that silently lies.
fn usd_text_to_nanousd(value: &str, field: &str) -> Result<u64, String> {
    let trimmed = value.trim();
    let bad = || format!("{field} must be a plain dollar amount, got {value}");
    if trimmed.is_empty() || trimmed.starts_with('-') {
        return Err(bad());
    }
    let (whole, fraction) = trimmed.split_once('.').unwrap_or((trimmed, ""));
    if whole.is_empty() || !whole.bytes().all(|b| b.is_ascii_digit()) {
        return Err(bad());
    }
    if !fraction.bytes().all(|b| b.is_ascii_digit()) {
        return Err(bad());
    }
    if fraction.len() > 9 {
        return Err(format!("{field} is finer than one nanoUSD"));
    }
    let dollars: u64 = whole.parse().map_err(|_| bad())?;
    let mut padded = fraction.to_owned();
    while padded.len() < 9 {
        padded.push('0');
    }
    let nanos: u64 = padded.parse().map_err(|_| bad())?;
    dollars
        .checked_mul(1_000_000_000)
        .and_then(|scaled| scaled.checked_add(nanos))
        .ok_or_else(bad)
}

/// Dollars per million tokens to nanoUSD per million tokens.
///
/// A pure scale by 10^9, because the stored unit is the unit vendors quote.
/// It used to divide by a further 10^6 to reach nanoUSD per *token* and
/// refuse any remainder, which meant an owner could not publish a rate their
/// vendor actually charges: DeepSeek V4 Flash bills cache hits at $0.0028
/// per million tokens, or 2.8 nanoUSD per token.
fn per_mtok_to_nanousd(value: &str, field: &str) -> Result<u64, String> {
    usd_text_to_nanousd(value, field)
}

/// Publish a price row for one model.
///
/// Prices are append-only and effective-dated: publishing a new row never
/// edits an older one, so a spend computed last month keeps the price that
/// was in force then. That is what lets a vendor's price change, or a promo
/// ending, be recorded without restating history.
#[tauri::command]
pub async fn ledger_add_price(
    state: State<'_, AppState>,
    request: PriceRequest,
) -> Result<CorrectionOutcome, String> {
    if request.model.trim().is_empty() {
        return Err("name the model this price applies to".to_string());
    }
    let rates = buzz_core_pkg::ledger::prices::PriceRates {
        input_nanousd_per_mtok: per_mtok_to_nanousd(&request.input_per_mtok, "Input")?,
        cache_read_nanousd_per_mtok: per_mtok_to_nanousd(
            &request.cache_read_per_mtok,
            "Cache read",
        )?,
        cache_write_5m_nanousd_per_mtok: per_mtok_to_nanousd(
            &request.cache_write_5m_per_mtok,
            "5-minute cache write",
        )?,
        cache_write_1h_nanousd_per_mtok: per_mtok_to_nanousd(
            &request.cache_write_1h_per_mtok,
            "1-hour cache write",
        )?,
        output_nanousd_per_mtok: per_mtok_to_nanousd(&request.output_per_mtok, "Output")?,
    };
    let effective_from = match request.effective_from.as_deref() {
        Some(value) => chrono::DateTime::parse_from_rfc3339(value)
            .map_err(|_| format!("{value} is not an RFC 3339 instant"))?
            .timestamp()
            .max(0) as u64,
        None => chrono::Utc::now().timestamp().max(0) as u64,
    };

    let keys = state.signing_keys()?;
    let relay_pubkey = fetch_relay_self(&state)
        .await?
        .ok_or_else(|| "the relay does not publish its own key".to_string())?;

    let payload = buzz_sdk_pkg::ledger::LedgerActionPayload::PriceEntry(
        buzz_core_pkg::ledger::prices::PriceEntry {
            model: request.model.trim().to_string(),
            effective_from,
            rates,
            // The dialog publishes an unconditional rate. Conditional rows
            // (a batch tier, a long-context tier, peak hours) come from
            // Colony's catalog; an owner entering one by hand is not a form
            // this screen should grow before anyone asks for it.
            conditions: Default::default(),
            note: request
                .note
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
            // Published from this app by the company's owner, so it wins its
            // instant against Colony's catalog: a rate somebody negotiated
            // must survive the next catalog refresh.
            origin: buzz_core_pkg::ledger::prices::PriceOrigin::Owner,
        },
    );

    let expected_head = fetch_book_head(&state, &relay_pubkey, KIND_PRICE_BOOK, PRICE_BOOK_D_TAG)
        .await?
        .map(|event| event.id.to_hex());

    let action = buzz_sdk_pkg::ledger::LedgerAction {
        relay_pubkey: relay_pubkey.clone(),
        operation: payload.operation(),
        request_id: uuid::Uuid::new_v4(),
        idempotency_key: uuid::Uuid::new_v4(),
        target: buzz_sdk_pkg::ledger::ledger_coordinate(&relay_pubkey, &payload),
        expected_head,
        payload,
    };
    let builder = buzz_sdk_pkg::ledger::build_ledger_action(&action)
        .map_err(|error| format!("invalid price: {error}"))?;

    let response = crate::relay::submit_event_with_keys(builder, &state, &keys, None).await?;
    Ok(CorrectionOutcome {
        event_id: response.event_id,
        accepted: response.accepted,
        message: response.message,
    })
}
