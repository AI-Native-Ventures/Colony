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
    kind::{
        KIND_ATTRIBUTION_RULEBOOK, KIND_CORRECTION_BOOK, KIND_LEDGER_BUDGET, KIND_PRICE_BOOK,
        KIND_USAGE_RECORD,
    },
    ledger::{
        attribution::{CorrectionBook, Rulebook},
        engine::{compute_ledger, LedgerReport, StoredUsageRecord},
        prices::PriceBook,
        reconcile::diagnose,
    },
    usage_record::decrypt_usage_record,
};

use crate::{
    app_state::AppState, commands::identity_archive::fetch_relay_self, relay::query_relay,
};

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
    /// Cost in nanoUSD, or `null` when the model is unpriced. An unpriced
    /// model is an open question, never a zero.
    pub cost_nanousd: Option<String>,
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
                    cost_nanousd: entry.cost_nanousd.map(|cost| cost.to_string()),
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
/// Reads the books, decrypts every usage record addressed to this identity,
/// and folds them through `buzz_core::ledger`. Records that cannot be read
/// are counted into `unreadableRecords` rather than skipped silently.
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
    // them, so this returns only what this identity is entitled to read.
    let record_events = query_relay(
        &state,
        &[serde_json::json!({
            "kinds": [KIND_USAGE_RECORD],
            "#p": [keys.public_key().to_hex()],
        })],
    )
    .await?;

    let mut records = Vec::with_capacity(record_events.len());
    let mut unreadable_records = 0usize;
    for event in record_events {
        match decrypt_usage_record(&keys, &event) {
            Ok(payload) => records.push(StoredUsageRecord {
                event_id: event.id.to_hex(),
                created_at: event.created_at.as_secs(),
                payload,
            }),
            Err(_) => unreadable_records += 1,
        }
    }

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
        usage_record::PaymentMode,
    };

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
                payment_mode: PaymentMode::Metered,
                cost_nanousd: Some(amount),
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
