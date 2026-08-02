//! OpenAI response parsing and the one permitted streaming request rewrite.
//!
//! Pure functions over request/response bytes. Nothing here does I/O.
//!
//! OpenAI prompt caching has no write charge, so both cache-write fields of
//! the produced breakdown are always zero.

use buzz_core::usage_record::UsageBreakdown;
use serde_json::{Map, Value};

use crate::sse::data_payloads;
use crate::ParsedUsage;

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|text| !text.is_empty())
}

fn cached_tokens(usage: &Value, details_key: &str) -> u64 {
    usage
        .get(details_key)
        .and_then(|details| details.get("cached_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0)
}

/// Map an OpenAI `usage` object onto the ledger's breakdown.
///
/// Returns `None` when the object matches neither the Chat Completions nor the
/// Responses shape, so an unrecognized future shape produces no record rather
/// than a record of zeroes. Cache writes are always zero: OpenAI's automatic
/// prompt caching carries no write charge.
fn breakdown(usage: &Value) -> Option<UsageBreakdown> {
    if let Some(prompt) = usage.get("prompt_tokens").and_then(Value::as_u64) {
        let cached = cached_tokens(usage, "prompt_tokens_details");
        return Some(UsageBreakdown {
            input_uncached_tokens: prompt.saturating_sub(cached),
            cache_read_tokens: cached,
            cache_write_5m_tokens: 0,
            cache_write_1h_tokens: 0,
            output_tokens: usage
                .get("completion_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0),
        });
    }

    if let Some(input) = usage.get("input_tokens").and_then(Value::as_u64) {
        let cached = cached_tokens(usage, "input_tokens_details");
        return Some(UsageBreakdown {
            input_uncached_tokens: input.saturating_sub(cached),
            cache_read_tokens: cached,
            cache_write_5m_tokens: 0,
            cache_write_1h_tokens: 0,
            output_tokens: usage
                .get("output_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0),
        });
    }

    None
}

/// Read the usage block, the model, and the id out of one response document.
///
/// Responses API streaming nests all three under `response`, so both
/// placements are checked.
fn read_document(document: &Value) -> Option<ParsedUsage> {
    for scope in [Some(document), document.get("response")]
        .into_iter()
        .flatten()
    {
        let Some(usage) = scope.get("usage").filter(|usage| usage.is_object()) else {
            continue;
        };
        let Some(tokens) = breakdown(usage) else {
            continue;
        };
        return Some(ParsedUsage {
            tokens: Some(tokens),
            model: string_field(scope, "model"),
            request_id: string_field(scope, "id"),
        });
    }
    None
}

/// Parse a non-streaming OpenAI response body.
///
/// Handles both shapes:
///
/// - Chat Completions: `usage.prompt_tokens` is the *total* input, of which
///   `usage.prompt_tokens_details.cached_tokens` was served from cache, so the
///   uncached count is the saturating difference. Output is
///   `usage.completion_tokens`.
/// - Responses API: `usage.input_tokens` with
///   `usage.input_tokens_details.cached_tokens`, and `usage.output_tokens`.
///
/// The returned `request_id` is the body `id`.
pub fn parse_json_response(body: &[u8]) -> ParsedUsage {
    let Ok(root) = serde_json::from_slice::<Value>(body) else {
        return ParsedUsage::default();
    };

    read_document(&root).unwrap_or(ParsedUsage {
        tokens: None,
        model: string_field(&root, "model"),
        request_id: string_field(&root, "id"),
    })
}

/// Parse a streaming (SSE) OpenAI response body.
///
/// Takes the LAST `data:` chunk that carries a non-null `usage`, since the
/// intermediate chunks report `usage: null` until the terminal one. Chunks
/// that nest the block under `response.usage` (Responses API streaming) are
/// read the same way.
pub fn parse_sse_response(body: &[u8]) -> ParsedUsage {
    let text = String::from_utf8_lossy(body);
    let mut parsed = ParsedUsage::default();

    for payload in data_payloads(&text) {
        let Ok(document) = serde_json::from_str::<Value>(payload) else {
            continue;
        };
        // Every chunk carries the id and model; keep the most recent so a
        // stream whose terminal usage chunk omits them still identifies itself.
        if let Some(model) = string_field(&document, "model") {
            parsed.model = Some(model);
        }
        if let Some(id) = string_field(&document, "id") {
            parsed.request_id = Some(id);
        }
        if let Some(from_chunk) = read_document(&document) {
            parsed = ParsedUsage {
                tokens: from_chunk.tokens,
                model: from_chunk.model.or(parsed.model),
                request_id: from_chunk.request_id.or(parsed.request_id),
            };
        }
    }

    parsed
}

/// Merge `stream_options.include_usage = true` into a streaming request body.
///
/// Returns `Some(rewritten)` only when the body is a JSON object with
/// `"stream": true` and the flag is not already set, so a non-streaming or
/// already-correct request is forwarded byte for byte. Pre-existing
/// `stream_options` keys are preserved.
pub fn ensure_stream_usage(body: &[u8]) -> Option<Vec<u8>> {
    let mut root: Value = serde_json::from_slice(body).ok()?;
    let object = root.as_object_mut()?;

    if object.get("stream").and_then(Value::as_bool) != Some(true) {
        return None;
    }

    match object.get_mut("stream_options") {
        Some(Value::Object(options)) => {
            if options.get("include_usage").and_then(Value::as_bool) == Some(true) {
                return None;
            }
            options.insert("include_usage".to_string(), Value::Bool(true));
        }
        // Absent, null, or some non-object the API would reject anyway.
        _ => {
            let mut options = Map::new();
            options.insert("include_usage".to_string(), Value::Bool(true));
            object.insert("stream_options".to_string(), Value::Object(options));
        }
    }

    serde_json::to_vec(&root).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::usage_record::UsageBreakdown;
    use serde_json::{json, Value};

    const CHAT_COMPLETION: &str = r#"{
      "id": "chatcmpl-BqXf2NonStreaming",
      "object": "chat.completion",
      "model": "gpt-4o-2024-08-06",
      "choices": [{"index": 0, "message": {"role": "assistant", "content": "hi"}}],
      "usage": {
        "prompt_tokens": 900,
        "completion_tokens": 120,
        "total_tokens": 1020,
        "prompt_tokens_details": {"cached_tokens": 768, "audio_tokens": 0}
      }
    }"#;

    const RESPONSES_API: &str = r#"{
      "id": "resp_68NonStreaming",
      "object": "response",
      "model": "gpt-5",
      "usage": {
        "input_tokens": 900,
        "input_tokens_details": {"cached_tokens": 768},
        "output_tokens": 120,
        "output_tokens_details": {"reasoning_tokens": 64},
        "total_tokens": 1020
      }
    }"#;

    const CHAT_SSE: &str = concat!(
        r#"data: {"id":"chatcmpl-Stream1","object":"chat.completion.chunk","model":"gpt-4o-2024-08-06","choices":[{"index":0,"delta":{"content":"he"}}],"usage":null}"#,
        "\n\n",
        r#"data: {"id":"chatcmpl-Stream1","object":"chat.completion.chunk","model":"gpt-4o-2024-08-06","choices":[{"index":0,"delta":{"content":"llo"}}],"usage":null}"#,
        "\n\n",
        r#"data: {"id":"chatcmpl-Stream1","object":"chat.completion.chunk","model":"gpt-4o-2024-08-06","choices":[],"usage":{"prompt_tokens":410,"completion_tokens":58,"total_tokens":468,"prompt_tokens_details":{"cached_tokens":256}}}"#,
        "\n\n",
        "data: [DONE]\n\n",
    );

    #[test]
    fn chat_completion_subtracts_cached_from_prompt_tokens() {
        let parsed = parse_json_response(CHAT_COMPLETION.as_bytes());
        assert_eq!(
            parsed.tokens,
            Some(UsageBreakdown {
                input_uncached_tokens: 132,
                cache_read_tokens: 768,
                cache_write_5m_tokens: 0,
                cache_write_1h_tokens: 0,
                output_tokens: 120,
            })
        );
        assert_eq!(parsed.model.as_deref(), Some("gpt-4o-2024-08-06"));
        assert_eq!(
            parsed.request_id.as_deref(),
            Some("chatcmpl-BqXf2NonStreaming")
        );
    }

    #[test]
    fn responses_api_shape_is_supported() {
        let parsed = parse_json_response(RESPONSES_API.as_bytes());
        assert_eq!(
            parsed.tokens,
            Some(UsageBreakdown {
                input_uncached_tokens: 132,
                cache_read_tokens: 768,
                cache_write_5m_tokens: 0,
                cache_write_1h_tokens: 0,
                output_tokens: 120,
            })
        );
        assert_eq!(parsed.model.as_deref(), Some("gpt-5"));
        assert_eq!(parsed.request_id.as_deref(), Some("resp_68NonStreaming"));
    }

    #[test]
    fn missing_cached_details_means_all_input_is_uncached() {
        let body = r#"{"id":"chatcmpl-x","model":"gpt-4o-mini","usage":{"prompt_tokens":30,"completion_tokens":4}}"#;
        let parsed = parse_json_response(body.as_bytes());
        let tokens = parsed.tokens.expect("tokens");
        assert_eq!(tokens.input_uncached_tokens, 30);
        assert_eq!(tokens.cache_read_tokens, 0);
    }

    #[test]
    fn cached_larger_than_prompt_saturates_instead_of_wrapping() {
        let body = r#"{"id":"chatcmpl-x","model":"gpt-4o","usage":{"prompt_tokens":10,"completion_tokens":1,"prompt_tokens_details":{"cached_tokens":99}}}"#;
        let tokens = parse_json_response(body.as_bytes()).tokens.expect("tokens");
        assert_eq!(tokens.input_uncached_tokens, 0);
        assert_eq!(tokens.cache_read_tokens, 99);
    }

    #[test]
    fn json_without_usage_yields_no_tokens() {
        let parsed = parse_json_response(br#"{"id":"chatcmpl-x","model":"gpt-4o"}"#);
        assert_eq!(parsed.tokens, None);
        assert_eq!(parsed.request_id.as_deref(), Some("chatcmpl-x"));
    }

    #[test]
    fn sse_takes_the_last_chunk_with_usage() {
        let parsed = parse_sse_response(CHAT_SSE.as_bytes());
        assert_eq!(
            parsed.tokens,
            Some(UsageBreakdown {
                input_uncached_tokens: 154,
                cache_read_tokens: 256,
                cache_write_5m_tokens: 0,
                cache_write_1h_tokens: 0,
                output_tokens: 58,
            })
        );
        assert_eq!(parsed.model.as_deref(), Some("gpt-4o-2024-08-06"));
        assert_eq!(parsed.request_id.as_deref(), Some("chatcmpl-Stream1"));
    }

    #[test]
    fn sse_reads_usage_nested_under_response() {
        let sse = concat!(
            r#"data: {"type":"response.output_text.delta","delta":"hi"}"#,
            "\n\n",
            r#"data: {"type":"response.completed","response":{"id":"resp_Stream","model":"gpt-5","usage":{"input_tokens":80,"input_tokens_details":{"cached_tokens":16},"output_tokens":9}}}"#,
            "\n\n",
        );
        let parsed = parse_sse_response(sse.as_bytes());
        assert_eq!(
            parsed.tokens,
            Some(UsageBreakdown {
                input_uncached_tokens: 64,
                cache_read_tokens: 16,
                cache_write_5m_tokens: 0,
                cache_write_1h_tokens: 0,
                output_tokens: 9,
            })
        );
        assert_eq!(parsed.request_id.as_deref(), Some("resp_Stream"));
        assert_eq!(parsed.model.as_deref(), Some("gpt-5"));
    }

    #[test]
    fn sse_with_only_null_usage_yields_no_tokens() {
        let sse = concat!(
            r#"data: {"id":"chatcmpl-x","model":"gpt-4o","usage":null}"#,
            "\n\n",
            "data: [DONE]\n\n",
        );
        assert_eq!(parse_sse_response(sse.as_bytes()).tokens, None);
    }

    #[test]
    fn stream_options_merge_preserves_existing_keys() {
        let body = br#"{"model":"gpt-4o","stream":true,"stream_options":{"chunk_size_hint":8}}"#;
        let rewritten = ensure_stream_usage(body).expect("streaming request must be rewritten");
        let value: Value = serde_json::from_slice(&rewritten).expect("valid json");
        assert_eq!(value["stream_options"]["include_usage"], json!(true));
        assert_eq!(
            value["stream_options"]["chunk_size_hint"],
            json!(8),
            "pre-existing stream_options keys must survive the merge"
        );
        assert_eq!(value["model"], json!("gpt-4o"));
        assert_eq!(value["stream"], json!(true));
    }

    #[test]
    fn stream_options_are_created_when_absent() {
        let body = br#"{"model":"gpt-4o","stream":true}"#;
        let rewritten = ensure_stream_usage(body).expect("streaming request must be rewritten");
        let value: Value = serde_json::from_slice(&rewritten).expect("valid json");
        assert_eq!(value["stream_options"]["include_usage"], json!(true));
    }

    #[test]
    fn non_streaming_request_is_left_alone() {
        assert_eq!(
            ensure_stream_usage(br#"{"model":"gpt-4o","stream":false}"#),
            None
        );
        assert_eq!(ensure_stream_usage(br#"{"model":"gpt-4o"}"#), None);
    }

    #[test]
    fn already_correct_request_is_left_alone() {
        let body = br#"{"model":"gpt-4o","stream":true,"stream_options":{"include_usage":true}}"#;
        assert_eq!(ensure_stream_usage(body), None);
    }

    #[test]
    fn non_json_request_is_left_alone() {
        assert_eq!(ensure_stream_usage(b"not json at all"), None);
        assert_eq!(ensure_stream_usage(b"[1,2,3]"), None);
    }
}
