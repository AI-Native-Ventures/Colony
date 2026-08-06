//! Token estimation and per-task budget ledger.

/// Estimate the token cost of `chars` of text (4 chars/token).
pub fn estimate_tokens(chars: usize) -> usize {
    ((chars + 3) / 4).max(1)
}

#[cfg(test)]
mod tests {
    #[test]
    fn module_loads() {}
}
