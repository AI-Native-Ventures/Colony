//! Token estimation and per-task budget ledger.

use crate::contracts::{BudgetEntry, BudgetReport};

/// Estimate the token cost of `chars` of text (4 chars/token).
pub fn estimate_tokens(chars: usize) -> usize {
    ((chars + 3) / 4).max(1)
}

/// Task-scoped budget ledger. Caps: 25 calls / 40k estimated tokens.
pub const MAX_CALLS: usize = 25;
pub const MAX_TOKENS: usize = 40_000;

#[derive(Debug, Default)]
pub struct BudgetLedger {
    entries: Vec<BudgetEntry>,
}

impl BudgetLedger {
    pub fn record(&mut self, tool: &str, chars: usize) {
        let tokens = estimate_tokens(chars);
        let cumulative = self.total_tokens() + tokens;
        self.entries.push(BudgetEntry {
            tool: tool.to_string(),
            chars,
            est_tokens: tokens,
            cumulative_tokens: cumulative,
        });
    }

    pub fn total_calls(&self) -> usize {
        self.entries.len()
    }

    pub fn total_tokens(&self) -> usize {
        self.entries.iter().map(|e| e.est_tokens).sum()
    }

    pub fn report(&self) -> BudgetReport {
        BudgetReport {
            entries: self.entries.clone(),
            total_calls: self.total_calls(),
            total_tokens: self.total_tokens(),
        }
    }

    pub fn within_budget(&self) -> bool {
        self.total_calls() <= MAX_CALLS && self.total_tokens() <= MAX_TOKENS
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ledger_records_and_reports() {
        let mut ledger = BudgetLedger::default();
        ledger.record("browser_snapshot", 800);
        ledger.record("browser_click", 500);
        assert_eq!(ledger.total_calls(), 2);
        assert_eq!(ledger.total_tokens(), 200 + 125);
        let report = ledger.report();
        assert_eq!(report.entries.len(), 2);
        assert_eq!(report.entries[1].cumulative_tokens, 325);
    }

    #[test]
    fn ledger_enforces_task_cap() {
        let mut ledger = BudgetLedger::default();
        for _ in 0..41 {
            ledger.record("browser_snapshot", 4_000);
        }
        assert!(ledger.total_tokens() > 40_000);
        assert!(!ledger.within_budget());
    }

    #[test]
    fn module_loads() {}
}
