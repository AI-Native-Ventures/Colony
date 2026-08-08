#![deny(unsafe_code)]
#![warn(missing_docs)]
//! `buzz-meter`: the Colony metering checkpoint.
//!
//! A loopback HTTP checkpoint that sits between agent subprocesses and model
//! providers. Agents are handed a per-agent virtual key and a
//! `http://127.0.0.1:<port>/<provider>` base URL; the real provider API key
//! never leaves this process.
//!
//! Two properties make the resulting cost ledger trustworthy:
//!
//! - **The agent cannot self-report.** Token counts are read off the
//!   provider's own response, which is the same meter the provider bills from.
//! - **The agent cannot spend anonymously.** Every call authenticates with a
//!   virtual key bound to a label, so usage is attributable, and revoking the
//!   key kills a leaked token with the agent process.
//!
//! The checkpoint is transparent: the response an agent receives is byte for
//! byte what upstream sent. The body is teed for parsing, never transformed.
//!
//! The transport-independent parsing itself lives in `buzz-meter-core`, so
//! the hosted gateway in the relay computes the same numbers from the same
//! wire bytes.

/// Anthropic response parsing: non-streaming JSON and streaming SSE.
pub use buzz_meter_core::anthropic;
/// Reading a cost the provider states it charged.
pub use buzz_meter_core::cost;
/// OpenAI response parsing plus the streaming request rewrite.
pub use buzz_meter_core::openai;
/// What one provider response yielded when parsed.
pub use buzz_meter_core::ParsedUsage;

mod server;

pub use server::{
    colony_credits_gateway_denial_body, start_meter, CallCredential, MeterConfig, MeterError,
    MeterHandle, MeteredCall, COLONY_CREDITS_GATEWAY_STATUS_401_MARKER,
    COLONY_CREDITS_GATEWAY_STATUS_402_MARKER, COLONY_CREDITS_STATUS_HEADER,
};
