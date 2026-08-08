use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use super::ManagedAgentProcess;

/// Exact Colony Credits lease generation attached to one live runtime pair.
/// Pair handoff matches all three fields (origin, owner, generation); a stale
/// callback can therefore never inject a token minted for another identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedAgentLeaseBinding {
    pub relay_origin: String,
    pub owner_pubkey: String,
    pub generation: u64,
}

impl ManagedAgentLeaseBinding {
    pub fn from_lease(lease: &crate::provisioned_credits::GatewayLease) -> Self {
        Self {
            relay_origin: lease.key.relay_origin.clone(),
            owner_pubkey: lease.key.owner_pubkey.clone(),
            generation: lease.generation,
        }
    }

    pub(crate) fn matches(&self, lease: &crate::provisioned_credits::GatewayLease) -> bool {
        self.relay_origin == lease.key.relay_origin
            && self.owner_pubkey == lease.key.owner_pubkey
            && self.generation == lease.generation
    }
}

/// Canonical identity of one managed-agent harness on one relay.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct ManagedAgentRuntimeKey {
    pub pubkey: String,
    pub relay_url: String,
}

impl ManagedAgentRuntimeKey {
    pub fn new(pubkey: impl Into<String>, relay_url: &str) -> Result<Self, String> {
        let pubkey = pubkey.into();
        if pubkey.len() != 64 || !pubkey.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("managed-agent pubkey must be 64 hexadecimal characters".into());
        }
        Ok(Self {
            pubkey: pubkey.to_ascii_lowercase(),
            relay_url: buzz_core_pkg::relay::normalize_relay_url(relay_url)
                .map_err(|error| error.to_string())?,
        })
    }

    /// Stable opaque identifier/path suffix derived only from canonical fields.
    pub fn runtime_id(&self) -> String {
        let relay_hash = hex::encode(Sha256::digest(self.relay_url.as_bytes()));
        format!("{}__{relay_hash}", self.pubkey)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ManagedAgentRuntimeLifecycle {
    Starting,
    Listening,
    Waking,
    Ready,
    Failed,
    Stopped,
}

#[derive(Debug)]
pub struct ManagedAgentPairRuntime {
    pub process: ManagedAgentProcess,
    pub lifecycle: ManagedAgentRuntimeLifecycle,
    pub error: Option<String>,
    /// Unpredictable identity for this exact harness generation. Lifecycle
    /// frames from prior processes are rejected even when the pair is live.
    pub start_nonce: String,
    /// `Some` only for a provisioned Colony Credits spawn. BYOK and
    /// subscription runtimes remain byte-for-byte unchanged.
    pub provisioned_lease: Option<ManagedAgentLeaseBinding>,
}

impl std::ops::Deref for ManagedAgentPairRuntime {
    type Target = ManagedAgentProcess;

    fn deref(&self) -> &Self::Target {
        &self.process
    }
}

impl std::ops::DerefMut for ManagedAgentPairRuntime {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.process
    }
}

impl ManagedAgentPairRuntime {
    pub fn starting(mut process: ManagedAgentProcess) -> Self {
        let start_nonce = process.start_nonce.clone();
        let provisioned_lease = process
            .provisioned_lease
            .take()
            .map(|lease| ManagedAgentLeaseBinding::from_lease(&lease));
        Self {
            process,
            lifecycle: ManagedAgentRuntimeLifecycle::Starting,
            error: None,
            start_nonce,
            provisioned_lease,
        }
    }

    pub fn starting_with_lease(
        mut process: ManagedAgentProcess,
        lease: &crate::provisioned_credits::GatewayLease,
    ) -> Self {
        let start_nonce = process.start_nonce.clone();
        process.provisioned_lease.take();
        Self {
            process,
            lifecycle: ManagedAgentRuntimeLifecycle::Starting,
            error: None,
            start_nonce,
            provisioned_lease: Some(ManagedAgentLeaseBinding::from_lease(lease)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ManagedAgentLeaseBinding;
    use crate::provisioned_credits::{GatewayLease, GatewayLeaseKey, RedactedToken};
    use chrono::{Duration, Utc};
    use nostr::Keys;
    use std::sync::Arc;

    #[test]
    fn lease_binding_requires_origin_owner_and_generation() {
        let key = GatewayLeaseKey::new("wss://relay.example", &"aa".repeat(32)).unwrap();
        let lease = GatewayLease {
            key: key.clone(),
            token: RedactedToken::new("token".to_string()).unwrap(),
            generation: 7,
            expires_at: Utc::now() + Duration::hours(1),
            refresh_at: Utc::now() + Duration::minutes(30),
            signer: Arc::new(Keys::generate()),
        };
        let binding = ManagedAgentLeaseBinding::from_lease(&lease);
        assert!(binding.matches(&lease));
        assert!(!ManagedAgentLeaseBinding {
            owner_pubkey: "bb".repeat(32),
            ..binding.clone()
        }
        .matches(&lease));
        assert!(!ManagedAgentLeaseBinding {
            generation: 8,
            ..binding.clone()
        }
        .matches(&lease));
        assert!(!ManagedAgentLeaseBinding {
            relay_origin: "https://other.example".to_string(),
            ..binding
        }
        .matches(&lease));
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedAgentRuntimeStatus {
    pub pubkey: String,
    pub relay_url: String,
    /// Exact descriptor URL echoed only by reconcile result rows so callers can
    /// correlate a canonical response without normalizing on the frontend.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_relay_url: Option<String>,
    pub local_setup: bool,
    pub lifecycle: ManagedAgentRuntimeLifecycle,
    pub pid: Option<u32>,
    pub error: Option<String>,
    pub log_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedAgentRuntimeLifecycleObserverPayload {
    pub pubkey: String,
    pub relay_url: String,
    pub start_nonce: String,
    pub lifecycle: ManagedAgentRuntimeLifecycle,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedAgentCommunityTarget {
    pub relay_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedAgentRuntimeReceipt {
    pub key: ManagedAgentRuntimeKey,
    pub pid: u32,
    pub desktop_instance_id: String,
    pub started_at: String,
}
