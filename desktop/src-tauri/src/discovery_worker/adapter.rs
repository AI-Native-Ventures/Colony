use buzz_core_pkg::discovery_worker::{
    DiscoveryCheckpointKind, DiscoveryProvider, DiscoveryWorkerCheckpoint,
    DiscoveryWorkerLeaseProjection,
};
use zeroize::Zeroizing;

/// Proof-only adapter with no provider network capability.
pub(super) struct FakeOutscraperAdapter<'a> {
    _credential: &'a str,
}

impl<'a> FakeOutscraperAdapter<'a> {
    pub(super) fn new(credential: &'a Zeroizing<String>) -> Self {
        Self {
            _credential: credential.as_str(),
        }
    }

    pub(super) fn remaining_checkpoints(
        &self,
        lease: &DiscoveryWorkerLeaseProjection,
    ) -> Vec<DiscoveryWorkerCheckpoint> {
        let next_sequence = lease
            .last_checkpoint
            .as_ref()
            .map_or(1, |checkpoint| checkpoint.sequence.saturating_add(1));
        let mut checkpoints = Vec::new();
        if next_sequence <= 1 {
            checkpoints.push(DiscoveryWorkerCheckpoint {
                sequence: 1,
                kind: DiscoveryCheckpointKind::ProviderSubmitted,
                provider: DiscoveryProvider::Outscraper,
                provider_request_id: Some(format!("fixture-{}", lease.run.run_id)),
                item_count: None,
            });
        }
        if next_sequence <= 2 {
            checkpoints.push(DiscoveryWorkerCheckpoint {
                sequence: 2,
                kind: DiscoveryCheckpointKind::ProviderResultsReady,
                provider: DiscoveryProvider::Outscraper,
                provider_request_id: None,
                item_count: Some(3),
            });
        }
        checkpoints
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn fake_adapter_source_has_no_network_capability() {
        let source = include_str!("adapter.rs")
            .split("#[cfg(test)]")
            .next()
            .expect("production adapter source")
            .to_ascii_lowercase();
        for forbidden in ["reqwest", "http://", "https://", "tcpstream", "udp"] {
            assert!(!source.contains(forbidden), "forbidden token: {forbidden}");
        }
    }
}
