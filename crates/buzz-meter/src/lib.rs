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

/// Anthropic response parsing: non-streaming JSON and streaming SSE.
pub mod anthropic;
/// OpenAI response parsing plus the streaming request rewrite.
pub mod openai;

mod server;
mod sse;

use buzz_core::usage_record::UsageBreakdown;

pub use server::{start_meter, CallCredential, MeterConfig, MeterError, MeterHandle, MeteredCall};

/// What one provider response yielded when parsed.
///
/// Every field is optional because a provider response can legitimately carry
/// none of them (an error body, a truncated stream). `tokens: None` means
/// "not observed", never "zero".
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParsedUsage {
    /// Provider-itemized token counts, when the response carried a usage block.
    pub tokens: Option<UsageBreakdown>,
    /// Model identifier as the provider named it.
    pub model: Option<String>,
    /// Provider request id read out of the response body.
    pub request_id: Option<String>,
}
