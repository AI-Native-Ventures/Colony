//! Discovery worker feature flags and bounded legacy-run credential recovery.

use zeroize::Zeroizing;

use crate::secret_store::SecretStore;

#[derive(Debug, Clone, Copy)]
pub(crate) enum DiscoveryCredentialProvider {
    Outscraper,
    BraveSearch,
    ExaSearch,
}

impl DiscoveryCredentialProvider {
    const fn key(self) -> &'static str {
        match self {
            Self::Outscraper => "discovery.outscraper.api_key",
            Self::BraveSearch => "discovery.brave_search.api_key",
            Self::ExaSearch => "discovery.exa_search.api_key",
        }
    }
}

/// Load an existing key only for draining an already-created protocol 1/2 run.
/// No save, status, delete, or IPC surface is retained.
pub(crate) fn load_discovery_credential(
    provider: DiscoveryCredentialProvider,
) -> Result<Option<Zeroizing<String>>, String> {
    SecretStore::shared(crate::app_state::keyring_service())
        .load(provider.key())
        .map(|value| value.map(Zeroizing::new))
        .map_err(|_| "secure Discovery credential storage is unavailable".to_string())
}

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
