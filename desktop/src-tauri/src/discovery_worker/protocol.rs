use std::{future::Future, pin::Pin, time::Duration};

use buzz_core_pkg::{
    discovery_worker::{
        DiscoveryWorkerCheckpointRequest, DiscoveryWorkerClaimRequest, DiscoveryWorkerLeaseRequest,
        DiscoveryWorkerObservationBatchRequest, DiscoveryWorkerOperation,
        DiscoveryWorkerReceiptOutcome,
    },
    kind::KIND_DISCOVERY_WORKER_RECEIPT,
};
use buzz_sdk_pkg::discovery_worker::{
    build_discovery_worker_checkpoint_action, build_discovery_worker_claim_action,
    build_discovery_worker_complete_action, build_discovery_worker_fail_action,
    build_discovery_worker_heartbeat_action, build_discovery_worker_store_observations_action,
    parse_discovery_worker_receipt,
};
use nostr::{Event, EventBuilder, EventId, Keys, PublicKey};
use serde_json::json;
use uuid::Uuid;

use crate::{app_state::AppState, relay};

pub(super) type ProtocolFuture<'a> =
    Pin<Box<dyn Future<Output = Result<DiscoveryWorkerReceiptOutcome, String>> + Send + 'a>>;

pub(super) trait WorkerProtocol: Send + Sync {
    fn claim(&self, request: DiscoveryWorkerClaimRequest) -> ProtocolFuture<'_>;
    fn heartbeat(&self, request: DiscoveryWorkerLeaseRequest) -> ProtocolFuture<'_>;
    fn checkpoint(&self, request: DiscoveryWorkerCheckpointRequest) -> ProtocolFuture<'_>;
    fn store_observations(
        &self,
        request: DiscoveryWorkerObservationBatchRequest,
    ) -> ProtocolFuture<'_>;
    fn fail(&self, request: DiscoveryWorkerLeaseRequest) -> ProtocolFuture<'_>;
    fn complete(&self, request: DiscoveryWorkerLeaseRequest) -> ProtocolFuture<'_>;
}

#[derive(Clone, Copy)]
struct ExpectedReceipt {
    action_event_id: EventId,
    relay_pubkey: PublicKey,
    actor_pubkey: PublicKey,
    operation: DiscoveryWorkerOperation,
    request_id: Uuid,
    idempotency_key: Uuid,
    worker_id: Uuid,
}

pub(super) struct RelayWorkerProtocol<'a> {
    state: &'a AppState,
    keys: Keys,
    api_base_url: String,
    relay_pubkey: PublicKey,
    worker_id: Uuid,
    workspace_generation: u64,
}

impl<'a> RelayWorkerProtocol<'a> {
    pub(super) async fn connect(
        state: &'a AppState,
        keys: Keys,
        api_base_url: String,
        worker_id: Uuid,
        workspace_generation: u64,
    ) -> Result<Self, String> {
        let relay_pubkey = fetch_relay_pubkey(state, &api_base_url).await?;
        Ok(Self {
            state,
            keys,
            api_base_url,
            relay_pubkey,
            worker_id,
            workspace_generation,
        })
    }

    async fn execute(
        &self,
        builder: EventBuilder,
        operation: DiscoveryWorkerOperation,
        request_id: Uuid,
        idempotency_key: Uuid,
    ) -> Result<DiscoveryWorkerReceiptOutcome, String> {
        self.ensure_current()?;
        let event = builder
            .sign_with_keys(&self.keys)
            .map_err(|_| "failed to sign Discovery worker action".to_string())?;
        let expected = ExpectedReceipt {
            action_event_id: event.id,
            relay_pubkey: self.relay_pubkey,
            actor_pubkey: self.keys.public_key(),
            operation,
            request_id,
            idempotency_key,
            worker_id: self.worker_id,
        };
        let response = relay::submit_signed_event_at_with_keys(
            &event,
            self.state,
            &self.api_base_url,
            &self.keys,
        )
        .await?;
        let message: serde_json::Value = serde_json::from_str(&response.message)
            .map_err(|_| "Discovery worker response is malformed".to_string())?;
        let receipt_id = message
            .get("receipt_event_id")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "Discovery worker response has no receipt".to_string())?;

        let receipt = self.fetch_receipt(receipt_id, expected).await?;
        self.ensure_current()?;
        Ok(receipt)
    }

    async fn fetch_receipt(
        &self,
        receipt_id: &str,
        expected: ExpectedReceipt,
    ) -> Result<DiscoveryWorkerReceiptOutcome, String> {
        let filter = json!({
            "ids": [receipt_id],
            "authors": [self.relay_pubkey.to_hex()],
            "kinds": [KIND_DISCOVERY_WORKER_RECEIPT],
            "#p": [self.keys.public_key().to_hex()],
            "limit": 1
        });
        for _ in 0..10 {
            let events = relay::query_relay_at_with_keys(
                self.state,
                &self.api_base_url,
                std::slice::from_ref(&filter),
                &self.keys,
                None,
            )
            .await?;
            if let Some(event) = events.first() {
                return validate_receipt_event(event, expected);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        Err("Discovery worker receipt was not found".to_string())
    }

    fn ensure_current(&self) -> Result<(), String> {
        if super::workspace_generation() != self.workspace_generation {
            return Err("Discovery workspace changed".to_string());
        }
        if self
            .state
            .shutdown_started
            .load(std::sync::atomic::Ordering::Acquire)
        {
            return Err("Discovery worker is shutting down".to_string());
        }
        Ok(())
    }
}

impl WorkerProtocol for RelayWorkerProtocol<'_> {
    fn claim(&self, request: DiscoveryWorkerClaimRequest) -> ProtocolFuture<'_> {
        Box::pin(async move {
            let builder = build_discovery_worker_claim_action(self.relay_pubkey, &request)
                .map_err(|_| "invalid Discovery claim".to_string())?;
            self.execute(
                builder,
                DiscoveryWorkerOperation::Claim,
                request.request_id,
                request.idempotency_key,
            )
            .await
        })
    }

    fn heartbeat(&self, request: DiscoveryWorkerLeaseRequest) -> ProtocolFuture<'_> {
        Box::pin(async move {
            let builder = build_discovery_worker_heartbeat_action(self.relay_pubkey, &request)
                .map_err(|_| "invalid Discovery heartbeat".to_string())?;
            self.execute(
                builder,
                DiscoveryWorkerOperation::Heartbeat,
                request.request_id,
                request.idempotency_key,
            )
            .await
        })
    }

    fn checkpoint(&self, request: DiscoveryWorkerCheckpointRequest) -> ProtocolFuture<'_> {
        Box::pin(async move {
            let builder = build_discovery_worker_checkpoint_action(self.relay_pubkey, &request)
                .map_err(|_| "invalid Discovery checkpoint".to_string())?;
            self.execute(
                builder,
                DiscoveryWorkerOperation::Checkpoint,
                request.lease.request_id,
                request.lease.idempotency_key,
            )
            .await
        })
    }

    fn store_observations(
        &self,
        request: DiscoveryWorkerObservationBatchRequest,
    ) -> ProtocolFuture<'_> {
        Box::pin(async move {
            let builder =
                build_discovery_worker_store_observations_action(self.relay_pubkey, &request)
                    .map_err(|_| "invalid Discovery observation batch".to_string())?;
            self.execute(
                builder,
                DiscoveryWorkerOperation::StoreObservations,
                request.lease.request_id,
                request.lease.idempotency_key,
            )
            .await
        })
    }

    fn fail(&self, request: DiscoveryWorkerLeaseRequest) -> ProtocolFuture<'_> {
        Box::pin(async move {
            let builder = build_discovery_worker_fail_action(self.relay_pubkey, &request)
                .map_err(|_| "invalid Discovery failure".to_string())?;
            self.execute(
                builder,
                DiscoveryWorkerOperation::Fail,
                request.request_id,
                request.idempotency_key,
            )
            .await
        })
    }

    fn complete(&self, request: DiscoveryWorkerLeaseRequest) -> ProtocolFuture<'_> {
        Box::pin(async move {
            let builder = build_discovery_worker_complete_action(self.relay_pubkey, &request)
                .map_err(|_| "invalid Discovery completion".to_string())?;
            self.execute(
                builder,
                DiscoveryWorkerOperation::Complete,
                request.request_id,
                request.idempotency_key,
            )
            .await
        })
    }
}

pub(super) async fn fetch_relay_pubkey(
    state: &AppState,
    api_base_url: &str,
) -> Result<PublicKey, String> {
    let response = state
        .http_client
        .get(api_base_url)
        .header("Accept", "application/nostr+json")
        .send()
        .await
        .map_err(|_| "Discovery relay information is unavailable".to_string())?;
    if !response.status().is_success() {
        return Err("Discovery relay information is unavailable".to_string());
    }
    let document: serde_json::Value = response
        .json()
        .await
        .map_err(|_| "Discovery relay information is malformed".to_string())?;
    let value = document
        .get("self")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Discovery relay has no signing identity".to_string())?;
    PublicKey::parse(value).map_err(|_| "Discovery relay signing identity is invalid".to_string())
}

fn validate_receipt_event(
    event: &Event,
    expected: ExpectedReceipt,
) -> Result<DiscoveryWorkerReceiptOutcome, String> {
    event
        .verify()
        .map_err(|_| "Discovery worker receipt signature is invalid".to_string())?;
    if event.pubkey != expected.relay_pubkey {
        return Err("Discovery worker receipt has the wrong relay signer".to_string());
    }
    let parsed = parse_discovery_worker_receipt(event)
        .map_err(|_| "Discovery worker receipt envelope is invalid".to_string())?;
    if parsed.actor_pubkey != expected.actor_pubkey
        || parsed.action_event_id != expected.action_event_id
        || parsed.receipt.operation != expected.operation
        || parsed.receipt.request_id != expected.request_id
        || parsed.receipt.idempotency_key != expected.idempotency_key
        || parsed.receipt.worker_id != expected.worker_id
    {
        return Err("Discovery worker receipt does not match its action".to_string());
    }
    Ok(parsed.receipt.outcome)
}

#[cfg(test)]
mod tests {
    use buzz_core_pkg::discovery_worker::{DiscoveryWorkerClaimRequest, DiscoveryWorkerReceipt};
    use buzz_sdk_pkg::discovery_worker::{
        build_discovery_worker_claim_action, build_discovery_worker_receipt,
    };
    use nostr::JsonUtil as _;

    use super::*;

    fn fixture() -> (Event, Event, ExpectedReceipt, Keys, Keys) {
        let actor = Keys::generate();
        let relay = Keys::generate();
        let worker_id = Uuid::new_v4();
        let request_id = Uuid::new_v4();
        let idempotency_key = Uuid::new_v4();
        let request = DiscoveryWorkerClaimRequest {
            request_id,
            idempotency_key,
            worker_id,
        };
        let action = build_discovery_worker_claim_action(relay.public_key(), &request)
            .expect("claim builder")
            .sign_with_keys(&actor)
            .expect("signed claim");
        let receipt = DiscoveryWorkerReceipt {
            operation: DiscoveryWorkerOperation::Claim,
            request_id,
            idempotency_key,
            worker_id,
            outcome: DiscoveryWorkerReceiptOutcome::Idle,
        };
        let receipt_event = build_discovery_worker_receipt(actor.public_key(), action.id, &receipt)
            .expect("receipt builder")
            .sign_with_keys(&relay)
            .expect("signed receipt");
        let expected = ExpectedReceipt {
            action_event_id: action.id,
            relay_pubkey: relay.public_key(),
            actor_pubkey: actor.public_key(),
            operation: DiscoveryWorkerOperation::Claim,
            request_id,
            idempotency_key,
            worker_id,
        };
        (action, receipt_event, expected, actor, relay)
    }

    #[test]
    fn exact_relay_receipt_is_accepted() {
        let (_, receipt, expected, _, _) = fixture();
        assert_eq!(
            validate_receipt_event(&receipt, expected),
            Ok(DiscoveryWorkerReceiptOutcome::Idle)
        );
    }

    #[test]
    fn wrong_relay_actor_action_or_command_identity_is_rejected() {
        let (_, receipt, expected, _, _) = fixture();
        let mut wrong = expected;
        wrong.relay_pubkey = Keys::generate().public_key();
        assert!(validate_receipt_event(&receipt, wrong).is_err());
        wrong = expected;
        wrong.actor_pubkey = Keys::generate().public_key();
        assert!(validate_receipt_event(&receipt, wrong).is_err());
        wrong = expected;
        wrong.action_event_id = EventId::all_zeros();
        assert!(validate_receipt_event(&receipt, wrong).is_err());
        wrong = expected;
        wrong.request_id = Uuid::new_v4();
        assert!(validate_receipt_event(&receipt, wrong).is_err());
        wrong = expected;
        wrong.idempotency_key = Uuid::new_v4();
        assert!(validate_receipt_event(&receipt, wrong).is_err());
        wrong = expected;
        wrong.worker_id = Uuid::new_v4();
        assert!(validate_receipt_event(&receipt, wrong).is_err());
    }

    #[test]
    fn tampered_receipt_signature_is_rejected() {
        let (_, receipt, expected, _, _) = fixture();
        let mut json: serde_json::Value =
            serde_json::from_str(&receipt.as_json()).expect("receipt json");
        json["content"] = serde_json::Value::String("tampered".to_string());
        let tampered = Event::from_json(json.to_string()).expect("tampered event shape");
        assert!(validate_receipt_event(&tampered, expected).is_err());
    }
}
