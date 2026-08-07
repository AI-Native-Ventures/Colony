//! Anthropic response parsing.
//!
//! Pure functions over response bytes. Nothing here does I/O, so every shape
//! the checkpoint has to understand is covered by a fixture test below.

use buzz_core::usage_record::UsageBreakdown;
use serde_json::Value;

use crate::cost::observed_cost_nanousd;
use crate::sse::data_payloads;
use crate::ParsedUsage;

/// Read a `u64` field, treating an absent or non-numeric field as zero.
///
/// Providers omit a count only when it is zero, so this is faithful rather
/// than lossy: the surrounding code decides whether a usage block exists at
/// all, and only then reads its fields.
fn u64_field(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|text| !text.is_empty())
}

/// Map an Anthropic `usage` object onto the ledger's breakdown.
fn breakdown(usage: &Value) -> UsageBreakdown {
    let (write_5m, write_1h) = match usage.get("cache_creation") {
        Some(creation) if creation.is_object() => (
            u64_field(creation, "ephemeral_5m_input_tokens"),
            u64_field(creation, "ephemeral_1h_input_tokens"),
        ),
        // No itemized object: the flat total is all 5-minute cache writes.
        _ => (u64_field(usage, "cache_creation_input_tokens"), 0),
    };

    UsageBreakdown {
        input_uncached_tokens: u64_field(usage, "input_tokens"),
        cache_read_tokens: u64_field(usage, "cache_read_input_tokens"),
        cache_write_5m_tokens: write_5m,
        cache_write_1h_tokens: write_1h,
        output_tokens: u64_field(usage, "output_tokens"),
    }
}

/// Parse a non-streaming Anthropic Messages response body.
///
/// Reads `usage.input_tokens`, `usage.cache_read_input_tokens`, the two
/// `usage.cache_creation.ephemeral_*_input_tokens` fields (falling back to the
/// flat `usage.cache_creation_input_tokens` as the 5-minute value when the
/// `cache_creation` object is absent), and `usage.output_tokens`.
///
/// The returned `request_id` is the body `id`. The caller prefers the
/// `request-id` response header when the provider sent one.
///
/// A body that is not JSON, or that carries no `usage` object, yields a
/// [`ParsedUsage`] with `tokens: None` rather than a record of zeroes.
pub fn parse_json_response(body: &[u8]) -> ParsedUsage {
    let Ok(root) = serde_json::from_slice::<Value>(body) else {
        return ParsedUsage::default();
    };

    let usage = root.get("usage").filter(|usage| usage.is_object());
    ParsedUsage {
        tokens: usage.map(breakdown),
        model: string_field(&root, "model"),
        request_id: string_field(&root, "id"),
        // Anthropic itself states no cost. A reseller speaking Anthropic's
        // dialect may, and the dialect is not the vendor, so we look.
        observed_cost_nanousd: usage.and_then(observed_cost_nanousd),
    }
}

/// Parse a streaming (SSE) Anthropic Messages response body.
///
/// Input-side counts come from the `message_start` event's `message.usage`.
/// Output tokens come from the LAST `message_delta` event carrying a
/// `usage.output_tokens`, because those counts are cumulative and only the
/// final one is the whole turn. When no `message_delta` carried usage, the
/// `message_start` output count is used.
pub fn parse_sse_response(body: &[u8]) -> ParsedUsage {
    let text = String::from_utf8_lossy(body);
    let mut parsed = ParsedUsage::default();
    let mut start_usage: Option<Value> = None;
    let mut final_output_tokens: Option<u64> = None;

    for payload in data_payloads(&text) {
        let Ok(event) = serde_json::from_str::<Value>(payload) else {
            continue;
        };
        match event.get("type").and_then(Value::as_str) {
            Some("message_start") => {
                let Some(message) = event.get("message") else {
                    continue;
                };
                parsed.model = string_field(message, "model");
                parsed.request_id = string_field(message, "id");
                if let Some(usage) = message.get("usage").filter(|usage| usage.is_object()) {
                    parsed.observed_cost_nanousd = observed_cost_nanousd(usage);
                    start_usage = Some(usage.clone());
                }
            }
            Some("message_delta") => {
                let Some(usage) = event.get("usage").filter(|usage| usage.is_object()) else {
                    continue;
                };
                // Cumulative, so the last one that reports usage is the turn.
                if let Some(output) = usage.get("output_tokens").and_then(Value::as_u64) {
                    final_output_tokens = Some(output);
                }
                if let Some(cost) = observed_cost_nanousd(usage) {
                    parsed.observed_cost_nanousd = Some(cost);
                }
            }
            _ => {}
        }
    }

    parsed.tokens = start_usage.map(|usage| {
        let mut tokens = breakdown(&usage);
        if let Some(output) = final_output_tokens {
            tokens.output_tokens = output;
        }
        tokens
    });
    parsed
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::usage_record::UsageBreakdown;

    const JSON_WITH_CACHE_CREATION: &str = r#"{
      "id": "msg_01NonStreaming",
      "type": "message",
      "role": "assistant",
      "model": "claude-sonnet-4-5-20250929",
      "content": [{"type": "text", "text": "hello"}],
      "stop_reason": "end_turn",
      "usage": {
        "input_tokens": 1200,
        "cache_read_input_tokens": 38000,
        "cache_creation_input_tokens": 2100,
        "cache_creation": {
          "ephemeral_5m_input_tokens": 100,
          "ephemeral_1h_input_tokens": 2000
        },
        "output_tokens": 750
      }
    }"#;

    const JSON_WITHOUT_CACHE_CREATION: &str = r#"{
      "id": "msg_01Fallback",
      "model": "claude-haiku-4-5-20251001",
      "usage": {
        "input_tokens": 42,
        "cache_read_input_tokens": 0,
        "cache_creation_input_tokens": 2100,
        "output_tokens": 7
      }
    }"#;

    const SSE_MULTI_DELTA: &str = concat!(
        "event: message_start\n",
        r#"data: {"type":"message_start","message":{"id":"msg_01Streaming","type":"message","role":"assistant","model":"claude-opus-4-1-20250805","usage":{"input_tokens":640,"cache_read_input_tokens":12000,"cache_creation":{"ephemeral_5m_input_tokens":300,"ephemeral_1h_input_tokens":900},"output_tokens":1}}}"#,
        "\n\n",
        "event: content_block_start\n",
        r#"data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
        "\n\n",
        "event: content_block_delta\n",
        r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"he"}}"#,
        "\n\n",
        "event: message_delta\n",
        r#"data: {"type":"message_delta","delta":{"stop_reason":null},"usage":{"output_tokens":11}}"#,
        "\n\n",
        "event: message_delta\n",
        r#"data: {"type":"message_delta","delta":{"stop_reason":null},"usage":{"output_tokens":47}}"#,
        "\n\n",
        "event: message_delta\n",
        r#"data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":233}}"#,
        "\n\n",
        "event: message_stop\n",
        r#"data: {"type":"message_stop"}"#,
        "\n\n",
    );

    #[test]
    fn json_response_maps_every_token_field() {
        let parsed = parse_json_response(JSON_WITH_CACHE_CREATION.as_bytes());
        assert_eq!(
            parsed.tokens,
            Some(UsageBreakdown {
                input_uncached_tokens: 1200,
                cache_read_tokens: 38000,
                cache_write_5m_tokens: 100,
                cache_write_1h_tokens: 2000,
                output_tokens: 750,
            })
        );
        assert_eq!(parsed.model.as_deref(), Some("claude-sonnet-4-5-20250929"));
        assert_eq!(parsed.request_id.as_deref(), Some("msg_01NonStreaming"));
    }

    #[test]
    fn cache_creation_object_wins_over_the_flat_field() {
        // The flat `cache_creation_input_tokens` is 2100 here; the itemized
        // object must be preferred so the 1h write is not billed as a 5m write.
        let parsed = parse_json_response(JSON_WITH_CACHE_CREATION.as_bytes());
        let tokens = parsed.tokens.expect("tokens");
        assert_eq!(tokens.cache_write_5m_tokens, 100);
        assert_eq!(tokens.cache_write_1h_tokens, 2000);
    }

    #[test]
    fn flat_cache_creation_is_the_5m_fallback() {
        let parsed = parse_json_response(JSON_WITHOUT_CACHE_CREATION.as_bytes());
        assert_eq!(
            parsed.tokens,
            Some(UsageBreakdown {
                input_uncached_tokens: 42,
                cache_read_tokens: 0,
                cache_write_5m_tokens: 2100,
                cache_write_1h_tokens: 0,
                output_tokens: 7,
            })
        );
    }

    #[test]
    fn json_without_usage_yields_no_tokens() {
        let parsed = parse_json_response(br#"{"id":"msg_x","model":"claude-x","type":"error"}"#);
        assert_eq!(parsed.tokens, None);
        assert_eq!(parsed.request_id.as_deref(), Some("msg_x"));
    }

    #[test]
    fn non_json_body_yields_nothing() {
        let parsed = parse_json_response(b"<html>gateway timeout</html>");
        assert_eq!(parsed, ParsedUsage::default());
    }

    #[test]
    fn sse_takes_input_from_message_start_and_output_from_the_last_delta() {
        let parsed = parse_sse_response(SSE_MULTI_DELTA.as_bytes());
        assert_eq!(
            parsed.tokens,
            Some(UsageBreakdown {
                input_uncached_tokens: 640,
                cache_read_tokens: 12000,
                cache_write_5m_tokens: 300,
                cache_write_1h_tokens: 900,
                // Not 1 (message_start) and not 11 or 47 (earlier deltas).
                output_tokens: 233,
            })
        );
        assert_eq!(parsed.model.as_deref(), Some("claude-opus-4-1-20250805"));
        assert_eq!(parsed.request_id.as_deref(), Some("msg_01Streaming"));
    }

    #[test]
    fn sse_without_any_usage_bearing_delta_falls_back_to_message_start() {
        let sse = concat!(
            "event: message_start\n",
            r#"data: {"type":"message_start","message":{"id":"msg_short","model":"claude-x","usage":{"input_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":3}}}"#,
            "\n\n",
            "event: message_stop\n",
            r#"data: {"type":"message_stop"}"#,
            "\n\n",
        );
        let parsed = parse_sse_response(sse.as_bytes());
        assert_eq!(
            parsed.tokens,
            Some(UsageBreakdown {
                input_uncached_tokens: 5,
                cache_read_tokens: 0,
                cache_write_5m_tokens: 0,
                cache_write_1h_tokens: 0,
                output_tokens: 3,
            })
        );
    }

    #[test]
    fn sse_without_message_start_yields_no_tokens() {
        let sse = concat!(
            "event: message_delta\n",
            r#"data: {"type":"message_delta","usage":{"output_tokens":9}}"#,
            "\n\n",
        );
        assert_eq!(parse_sse_response(sse.as_bytes()).tokens, None);
    }
}
