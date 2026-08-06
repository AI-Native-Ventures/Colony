//! Caps, schemas, and error types for the browser engine.

use thiserror::Error;

/// Caps that keep tool results small enough for agent context.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SnapshotCaps {
    pub max_nodes: usize,
    pub max_chars: usize,
    pub full_max_chars: usize,
}

/// Errors surfaced by the browser engine.
#[derive(Debug, Error)]
pub enum BrowserError {
    #[error("cdp error: {0}")]
    Cdp(String),
    #[error("host error: {0}")]
    Host(String),
    #[error("input error: {0}")]
    Input(String),
    #[error("budget exceeded: {0}")]
    Budget(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn module_loads() {
        let caps = SnapshotCaps::default();
        assert_eq!(caps.max_nodes, 0);
    }
}
