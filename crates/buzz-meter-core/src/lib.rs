#![deny(unsafe_code)]
#![warn(missing_docs)]
//! `buzz-meter-core`: transport-independent usage parsing for the metering
//! checkpoint.
//!
//! Everything here is a pure function over bytes or already-parsed JSON: the
//! SSE `data:` payload reader, OpenAI- and Anthropic-dialect usage parsing,
//! and the cost a provider itself stated, in nanoUSD.
//!
//! The loopback server in `buzz-meter` consumes this surface, and the hosted
//! gateway in the relay consumes the same one, so both paths compute the same
//! number from the same wire bytes.

/// Anthropic response parsing: non-streaming JSON and streaming SSE.
pub mod anthropic;
/// Reading a cost the provider states it charged.
pub mod cost;
/// OpenAI response parsing plus the streaming request rewrite.
pub mod openai;
/// Minimal server-sent-events reader.
pub mod sse;

use buzz_core::usage_record::UsageBreakdown;

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
    /// What the provider said this call cost, in nanoUSD, when it said.
    ///
    /// Beats anything the price book can work out, because it is the charge
    /// rather than a model of the charge. `None` means the provider reported
    /// no usable cost and the book has to answer instead.
    pub observed_cost_nanousd: Option<u64>,
}
