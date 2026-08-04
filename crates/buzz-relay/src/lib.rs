#![deny(unsafe_code)]
#![warn(missing_docs)]
//! NIP-01 WebSocket relay for Buzz private team communication.

mod admission;
mod block_broker;
/// Validation for chat-native Block event envelopes.
pub mod blocks;
mod company_broker;
mod discovery_broker;
/// Restart-safe Discovery worker runtime.
pub mod discovery_runtime;
mod discovery_worker_broker;
mod discovery_workspace_broker;
mod ledger_broker;
mod party_broker;

/// REST API route handlers.
pub mod api;
/// WebSocket audio relay for huddle voice channels.
pub mod audio;
/// Relay configuration from environment variables.
pub mod config;
/// Runtime conformance harness — abstract trace emission at the
/// ingest/read accept-reject boundary, replayed against
/// `docs/spec/MultiTenantRelay.tla` by the independent `buzz-conformance`
/// checker.
pub mod conformance;
/// WebSocket connection lifecycle and state.
pub mod connection;
/// Relay-bundled Core Block manifests and deterministic event construction.
pub mod core_blocks;
/// Relay error types.
pub mod error;
/// WebSocket message handlers for NIP-01 client commands.
pub mod handlers;
/// Colony interrupt-core: tier lookup and the owner-contact gate.
pub mod interrupt_gate;
/// Stateless HMAC-signed relay invite tokens (mint/verify).
pub mod invite_token;
/// Inter-relay mesh startup wiring (`BUZZ_MESH` seam).
pub mod mesh_boot;
/// Prometheus metrics: recorder, upkeep, HTTP middleware.
pub mod metrics;
/// NIP-11 relay information document.
pub mod nip11;
pub mod price_catalog;
/// NIP-01 client/relay message parsing.
pub mod protocol;
/// Durable NIP-PL matcher and delivery worker.
pub mod push_runtime;
/// Axum router construction.
pub mod router;
/// Shared application state.
pub mod state;
pub mod storage_sweep;
/// Subscription registry with (channel, kind) fan-out index.
pub mod subscription;
/// OpenTelemetry tracing initialisation (tracer provider + OTLP exporter).
pub mod telemetry;
/// Row-zero host binding: resolve the request community from the connection host.
pub mod tenant;
/// Relay-side tunnel session directory and routing.
pub mod tunnel;
/// Webhook secret generation and constant-time comparison.
pub mod webhook_secret;
/// Workflow action sink — relay-side implementation of [`buzz_workflow::ActionSink`].
pub mod workflow_sink;

pub use config::Config;
pub use error::{RelayError, Result};
pub use state::AppState;
