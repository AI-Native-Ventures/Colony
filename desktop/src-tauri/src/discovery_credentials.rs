//! Discovery worker feature flags.

/// Whether the proof-only fake worker is explicitly enabled.
pub(crate) fn fake_local_worker_enabled() -> bool {
    std::env::var_os("BUZZ_DISCOVERY_FAKE_LOCAL_WORKER_ENABLED")
        .as_deref()
        .and_then(std::ffi::OsStr::to_str)
        .is_some_and(|value| value == "1" || value.eq_ignore_ascii_case("true"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn fake_worker_flag_is_exact() {
        assert!(["1", "true", "TRUE"]
            .into_iter()
            .all(|value| value == "1" || value.eq_ignore_ascii_case("true")));
        assert!(!["", "0", "yes"]
            .into_iter()
            .any(|value| value == "1" || value.eq_ignore_ascii_case("true")));
    }
}
