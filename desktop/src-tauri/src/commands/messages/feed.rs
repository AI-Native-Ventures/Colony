pub(super) fn build_feed_projection_filter(
    pubkey: &str,
    feed_type: &str,
    limit: u32,
    since: Option<i64>,
) -> serde_json::Value {
    let mut filter = serde_json::json!({
        "#p": [pubkey],
        "feed_types": [feed_type],
        "limit": limit,
    });
    if let Some(since) = since {
        filter["since"] = serde_json::json!(since);
    }
    filter
}
