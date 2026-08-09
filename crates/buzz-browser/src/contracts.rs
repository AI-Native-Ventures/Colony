//! Caps, schemas, and error types for the browser engine.

use serde::{Deserialize, Serialize};

/// Caps that keep tool results small enough for agent context.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SnapshotCaps {
    pub max_nodes: usize,
    pub max_chars: usize,
    pub full_max_chars: usize,
}

impl Default for SnapshotCaps {
    fn default() -> Self {
        Self {
            max_nodes: 400,
            max_chars: 4_000,
            full_max_chars: 24_000,
        }
    }
}

/// One recorded tool call in the per-task budget.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BudgetEntry {
    pub tool: String,
    pub chars: usize,
    pub est_tokens: usize,
    pub cumulative_tokens: usize,
}

/// Per-task budget summary, written as JSON evidence.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BudgetReport {
    pub entries: Vec<BudgetEntry>,
    pub total_calls: usize,
    pub total_tokens: usize,
}

/// All errors from the browser engine spike.
#[derive(Debug, thiserror::Error)]
pub enum BrowserError {
    #[error("cdp error: {0}")]
    Cdp(String),
    #[error("browser host error: {0}")]
    Host(String),
    #[error("snapshot error: {0}")]
    Snapshot(String),
    #[error("input error: {0}")]
    Input(String),
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// Actionable AX roles that receive `rN` refs in a snapshot.
pub const ACTIONABLE_ROLES: &[&str] = &[
    "button",
    "link",
    "textbox",
    "searchbox",
    "combobox",
    "checkbox",
    "radio",
    "menuitem",
    "tab",
    "switch",
    "slider",
    "option",
    "listbox",
];

/// Roles whose subtree is label, not structure.
pub const LABEL_ONLY_ROLES: &[&str] = &["button", "link", "menuitem", "tab", "option", "switch"];

/// Roles never emitted in an outline.
pub const SKIP_ROLES: &[&str] = &[
    "none",
    "generic",
    "InlineTextBox",
    "LineBreak",
    "presentation",
    "LayoutTable",
    "LayoutTableRow",
    "LayoutTableCell",
    "LayoutTableColumn",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_caps_have_expected_defaults() {
        let caps = SnapshotCaps::default();
        assert_eq!(caps.max_nodes, 400);
        assert_eq!(caps.max_chars, 4_000);
        assert_eq!(caps.full_max_chars, 24_000);
    }

    #[test]
    fn budget_report_serializes_entries() {
        let report = BudgetReport {
            entries: vec![BudgetEntry {
                tool: "browser_snapshot".into(),
                chars: 800,
                est_tokens: 200,
                cumulative_tokens: 200,
            }],
            total_calls: 1,
            total_tokens: 200,
        };
        let json = serde_json::to_string(&report).unwrap();
        assert!(json.contains("browser_snapshot"));
        assert!(json.contains("200"));
    }

    #[test]
    fn browser_error_display_keeps_message() {
        let err = BrowserError::Cdp("boom".into());
        assert_eq!(err.to_string(), "cdp error: boom");
    }
}
