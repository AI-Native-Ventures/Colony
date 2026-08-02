//! Minimal server-sent-events reader, just enough to find usage blocks.
//!
//! Both providers send one complete JSON document per `data:` line, so this
//! deliberately does not implement the multi-line `data:` folding rule from
//! the SSE spec. A folded event would fail to parse as JSON and be skipped,
//! which costs a usage record but never produces a wrong one.

/// Yield the payload of every `data:` line, in order.
///
/// Leading whitespace after the colon is stripped, per the SSE convention.
/// Non-data lines (`event:`, `id:`, comments, blank separators) are skipped.
pub(crate) fn data_payloads(text: &str) -> impl Iterator<Item = &str> {
    text.lines().filter_map(|line| {
        line.strip_prefix("data:")
            .map(|payload| payload.strip_prefix(' ').unwrap_or(payload))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_data_lines_and_skips_everything_else() {
        let text = "event: ping\ndata: {\"a\":1}\n\n: comment\ndata:{\"b\":2}\n\nid: 7\n";
        let payloads: Vec<&str> = data_payloads(text).collect();
        assert_eq!(payloads, vec![r#"{"a":1}"#, r#"{"b":2}"#]);
    }

    #[test]
    fn handles_crlf_line_endings() {
        let text = "event: ping\r\ndata: {\"a\":1}\r\n\r\n";
        let payloads: Vec<&str> = data_payloads(text).collect();
        assert_eq!(payloads, vec![r#"{"a":1}"#]);
    }
}
