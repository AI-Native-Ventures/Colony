//! Colony cost ledger: pricing, attribution, and the deterministic engine
//! that turns immutable usage records into a company cost report.
//!
//! The ledger never trusts an agent's account of what it spent. Usage records
//! are captured at the provider wire (see [`crate::usage_record`]), priced by
//! an effective-dated price book, attributed by explicit work context or
//! rules, corrected by the owner without ever rewriting the original record,
//! and reconciled against what the provider says it billed.

pub mod attribution;
pub mod catalog;
pub mod crosscheck;
pub mod engine;
pub mod prices;
pub mod reconcile;

pub use attribution::{
    AttributionRule, Budget, Correction, CorrectionBook, RuleAssignment, Rulebook,
};
pub use crosscheck::{
    cross_check, CrossCheckFinding, CrossCheckReport, CrossCheckRow, SelfReportedTurn,
};
pub use engine::{
    compute_ledger, AttributionMethod, BudgetStatus, ClassTotals, DailySum, LedgerEntry,
    LedgerException, LedgerReport, MissingSide, StoredUsageRecord,
};
pub use prices::{PriceBook, PriceEntry, PriceRates};
pub use reconcile::{diagnose, reconcile, ProviderDailyCost};
