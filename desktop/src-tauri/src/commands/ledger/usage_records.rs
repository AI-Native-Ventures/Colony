//! Reading usage records back off the relay for the cost ledger.
//!
//! A seat meter is the member's own machine, so the member both authors and
//! owns every usage record it posts. The relay drops a `p` tag that points
//! at the event's own author, which makes self-authored records invisible
//! to a `#p` query; the author side must be read too, and the two result
//! sets deduplicated on event id. The CLI report reads the same two shapes
//! (`crates/buzz-cli/src/commands/ledger.rs`); this is the desktop half of
//! that contract, split out so the file stays under the size ratchet.

use std::collections::HashSet;

use buzz_core_pkg::{
    kind::KIND_USAGE_RECORD, ledger::engine::StoredUsageRecord, usage_record::decrypt_usage_record,
};

/// The two query shapes a seat needs to see its own usage records.
///
/// A seat meter is the member's own machine, so the member both authors and
/// owns every record it posts. The relay drops a `p` tag that points at the
/// event's own author, so self-authored records carry no queryable `#p` tag;
/// the author side is the owner side for that shape. Keeping both filters in
/// one function makes the query shape assertable.
fn usage_record_filters(mine: &str) -> (serde_json::Value, serde_json::Value) {
    (
        serde_json::json!({ "kinds": [KIND_USAGE_RECORD], "#p": [mine] }),
        serde_json::json!({ "kinds": [KIND_USAGE_RECORD], "authors": [mine] }),
    )
}

/// Decrypt a batch of usage record events into stored records.
///
/// The same event can legitimately arrive twice, once per query shape:
/// someone else may `p`-tag this identity on a record this identity also
/// authored. Presence is decided by event id, never by payload contents, so
/// a duplicate never double-counts, and an unreadable record counts once
/// per unique event rather than once per query that returned it.
fn collect_usage_records(
    raw: Vec<nostr::Event>,
    keys: &nostr::Keys,
) -> (Vec<StoredUsageRecord>, usize) {
    let mut records = Vec::with_capacity(raw.len());
    let mut unreadable_records = 0usize;
    let mut seen = HashSet::new();
    for event in raw {
        if !seen.insert(event.id) {
            continue;
        }
        match decrypt_usage_record(keys, &event) {
            Ok(payload) => records.push(StoredUsageRecord {
                event_id: event.id.to_hex(),
                created_at: event.created_at.as_secs(),
                payload,
            }),
            Err(_) => unreadable_records += 1,
        }
    }
    (records, unreadable_records)
}

/// Read every usage record this identity may see: records `p`-tagged to it
/// and records it authored.
///
/// Each query shape is issued as its own relay call, mirroring the CLI
/// report's dual read, and the results are merged on event id. The query
/// function is a parameter so the orchestration is testable without a live
/// relay.
///
/// `pub(super)` because only the parent `ledger` command module calls it;
/// nothing outside this command subtree needs the name.
pub(super) async fn read_usage_records<F, Fut>(
    query: F,
    mine: &str,
    keys: &nostr::Keys,
) -> Result<(Vec<StoredUsageRecord>, usize), String>
where
    F: Fn(Vec<serde_json::Value>) -> Fut,
    Fut: std::future::Future<Output = Result<Vec<nostr::Event>, String>>,
{
    let (by_owner, by_author) = usage_record_filters(mine);
    let mut raw = query(vec![by_owner]).await?;
    raw.extend(query(vec![by_author]).await?);
    Ok(collect_usage_records(raw, keys))
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core_pkg::usage_record::{
        encrypt_usage_record, PaymentMode, UsageBreakdown, UsageRecordPayload, UsageSource,
    };

    /// A usage record payload like the one a seat's metering checkpoint
    /// posts for a completed call.
    fn usage_record_payload(provider: &str, model: &str, http_status: u16) -> UsageRecordPayload {
        UsageRecordPayload {
            source: UsageSource::Wire,
            provider: provider.to_string(),
            request_id: format!("req-{provider}"),
            model: Some(model.to_string()),
            timestamp: "2026-08-03T10:00:00.000Z".to_string(),
            payment_mode: PaymentMode::Metered,
            tokens: Some(UsageBreakdown {
                input_uncached_tokens: 100,
                cache_read_tokens: 0,
                cache_write_5m_tokens: 0,
                cache_write_1h_tokens: 0,
                output_tokens: 40,
            }),
            amount_nanousd: None,
            observed_cost_nanousd: None,
            harness: Some("buzz-worker".to_string()),
            session_id: None,
            turn_id: Some("job-1".to_string()),
            http_status: Some(http_status),
            description: None,
            agent_pubkey: Some("a".repeat(64)),
            channel_id: None,
            work_context: None,
        }
    }

    /// Build the record a seat posts for its own call: encrypted to the
    /// owner and signed by the same key, with a `p` tag pointing at the
    /// author. The nostr builder discards that tag when it signs, which is
    /// the exact shape this fix exists for.
    fn self_usage_record_event(keys: &nostr::Keys, payload: &UsageRecordPayload) -> nostr::Event {
        let owner_hex = keys.public_key().to_hex();
        let ciphertext =
            encrypt_usage_record(keys, &keys.public_key(), payload).expect("record encrypts");
        nostr::EventBuilder::new(nostr::Kind::Custom(KIND_USAGE_RECORD as u16), ciphertext)
            .tags([nostr::Tag::parse(["p", &owner_hex]).expect("p tag parses")])
            .sign_with_keys(keys)
            .expect("record signs")
    }

    /// The bug this change exists for: a seat posts its own usage record, the
    /// relay can never return it for the owner `#p` read because the self
    /// `p` tag was dropped before signing, and only the author-side read
    /// finds it. A single-query implementation shows an empty Spend screen.
    #[tokio::test]
    async fn a_self_authored_usage_record_reaches_the_spend_screen() {
        let keys = nostr::Keys::generate();
        let payload = usage_record_payload("anthropic", "claude-sonnet-4-5", 200);
        let event = self_usage_record_event(&keys, &payload);
        let event_id = event.id;

        let p = nostr::SingleLetterTag::lowercase(nostr::Alphabet::P);
        let self_tagged = event.tags.iter().any(|tag| {
            tag.kind() == nostr::TagKind::SingleLetter(p)
                && tag.content() == Some(keys.public_key().to_hex().as_str())
        });
        assert!(!self_tagged, "the self `p` tag must not survive signing");

        // The relay answers the owner read with nothing for this shape; only
        // the author-side read returns the record. Both feeds must reach the
        // merge or the screen stays empty.
        let mine = keys.public_key().to_hex();
        let (records, unreadable_records) = read_usage_records(
            |filters: Vec<serde_json::Value>| {
                let by_author = filters.iter().any(|f| f.get("authors").is_some());
                let event = event.clone();
                async move {
                    if by_author {
                        Ok(vec![event])
                    } else {
                        Ok(Vec::new())
                    }
                }
            },
            &mine,
            &keys,
        )
        .await
        .expect("the ledger read must not fail");

        assert_eq!(unreadable_records, 0);
        assert_eq!(
            records.len(),
            1,
            "the self-authored record must reach the spend screen"
        );
        assert_eq!(records[0].event_id, event_id.to_hex());
        assert_eq!(records[0].payload.provider, "anthropic");
        assert_eq!(
            records[0].payload.model.as_deref(),
            Some("claude-sonnet-4-5")
        );
        assert_eq!(records[0].payload.http_status, Some(200));
    }

    #[tokio::test]
    async fn observed_meter_cost_survives_the_existing_desktop_reader() {
        let keys = nostr::Keys::generate();
        let mut payload = usage_record_payload("openai", "gpt-test", 200);
        payload.observed_cost_nanousd = Some(12_345_678);
        let event = self_usage_record_event(&keys, &payload);
        let mine = keys.public_key().to_hex();
        let (records, unreadable_records) = read_usage_records(
            |_filters: Vec<serde_json::Value>| {
                let event = event.clone();
                async move { Ok(vec![event]) }
            },
            &mine,
            &keys,
        )
        .await
        .expect("the existing ledger reader must accept the usage event");

        assert_eq!(unreadable_records, 0);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].payload.observed_cost_nanousd, Some(12_345_678));
    }

    /// The same event can match both query shapes: someone else `p`-tags
    /// this identity on a record this identity also authored. Dedupe is on
    /// event id, never on payload contents, and unreadable duplicates count
    /// once.
    #[test]
    fn a_record_returned_by_both_reads_counts_once() {
        let keys = nostr::Keys::generate();
        let payload = usage_record_payload("openai", "gpt-5.2", 200);
        let event = self_usage_record_event(&keys, &payload);

        let (records, unreadable_records) =
            collect_usage_records(vec![event.clone(), event.clone()], &keys);
        assert_eq!(records.len(), 1, "duplicates must dedupe on event id");
        assert_eq!(unreadable_records, 0);

        // Two events with identical payloads are two records: presence is
        // decided by event id, not by what the payload says.
        let twin = self_usage_record_event(&keys, &payload);
        assert_ne!(twin.id, event.id, "the twin must be a distinct event");
        let (records, _) = collect_usage_records(vec![event, twin], &keys);
        assert_eq!(records.len(), 2);

        // An unreadable record returned by both reads counts once too.
        let stranger = nostr::Keys::generate();
        let ciphertext = encrypt_usage_record(&stranger, &stranger.public_key(), &payload)
            .expect("alien record encrypts");
        let alien =
            nostr::EventBuilder::new(nostr::Kind::Custom(KIND_USAGE_RECORD as u16), ciphertext)
                .sign_with_keys(&stranger)
                .expect("alien record signs");
        let (records, unreadable_records) =
            collect_usage_records(vec![alien.clone(), alien], &keys);
        assert!(records.is_empty());
        assert_eq!(
            unreadable_records, 1,
            "unreadable duplicates must count once"
        );
    }

    /// The pre-existing path must survive the dual read: a record authored
    /// by someone else and `p`-tagged to this identity is found by the owner
    /// read, decrypts, and still counts exactly once after the merge.
    #[test]
    fn a_record_owned_but_not_authored_by_me_is_still_read() {
        let me = nostr::Keys::generate();
        let author = nostr::Keys::generate();
        let payload = usage_record_payload("deepseek", "deepseek-chat", 429);
        let mine_hex = me.public_key().to_hex();
        let ciphertext =
            encrypt_usage_record(&author, &me.public_key(), &payload).expect("record encrypts");
        let event =
            nostr::EventBuilder::new(nostr::Kind::Custom(KIND_USAGE_RECORD as u16), ciphertext)
                .tags([nostr::Tag::parse(["p", &mine_hex]).expect("p tag parses")])
                .sign_with_keys(&author)
                .expect("record signs");

        let (records, unreadable_records) = collect_usage_records(vec![event.clone(), event], &me);
        assert_eq!(unreadable_records, 0);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].payload.provider, "deepseek");
        assert_eq!(records[0].payload.model.as_deref(), Some("deepseek-chat"));
        assert_eq!(records[0].payload.http_status, Some(429));
    }

    /// The query shape is the contract the relay gates on: the owner read is
    /// scoped by `#p` and the author read by `authors`, both pinned to
    /// `KIND_USAGE_RECORD`. A future simplification that drops either shape
    /// re-introduces the bug this change exists for, so both must be
    /// asserted rather than implied by the merge.
    #[tokio::test]
    async fn the_spend_screen_queries_both_the_owner_and_author_shapes() {
        let keys = nostr::Keys::generate();
        let mine = keys.public_key().to_hex();
        let (by_owner, by_author) = usage_record_filters(&mine);

        assert_eq!(
            by_owner,
            serde_json::json!({
                "kinds": [KIND_USAGE_RECORD],
                "#p": [mine],
            })
        );
        assert_eq!(
            by_author,
            serde_json::json!({
                "kinds": [KIND_USAGE_RECORD],
                "authors": [mine],
            })
        );

        // The orchestration must issue both queries, in order, as separate
        // relay calls, not just define them.
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let recorder = seen.clone();
        let (records, unreadable_records) = read_usage_records(
            move |filters: Vec<serde_json::Value>| {
                let recorder = recorder.clone();
                async move {
                    recorder.lock().unwrap().push(filters);
                    Ok(Vec::new())
                }
            },
            &mine,
            &keys,
        )
        .await
        .expect("read must succeed");

        assert!(records.is_empty());
        assert_eq!(unreadable_records, 0);
        let calls = seen.lock().unwrap();
        assert_eq!(calls.len(), 2, "both query shapes must be issued");
        assert_eq!(calls[0], vec![by_owner]);
        assert_eq!(calls[1], vec![by_author]);
    }
}
