//! Relay-side implementation of [`ActionSink`] for workflow actions.
//!
//! Builds Nostr events, persists them, and delegates post-persist side effects
//! (WebSocket fan-out, Redis pub/sub, search indexing, audit logging) to the
//! existing [`dispatch_persistent_event`] helper.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Weak};

use buzz_core::kind::KIND_STREAM_MESSAGE;
use buzz_core::tenant::CommunityId;
use buzz_workflow::action_sink::{ActionSink, ActionSinkError};
use chrono::Utc;
use nostr::{EventBuilder, Kind, Tag};
use tracing::info;
use uuid::Uuid;

use crate::handlers::event::dispatch_persistent_event;
use crate::interrupt_runtime::{resolve_owner_mention_route, OwnerMentionRoute};
use crate::state::AppState;

/// Resolves `@Name` mentions in workflow message text to the pubkeys of the
/// channel members they name, so the emitted kind:9 carries the `p` tags that
/// ACP agent-wake (`event_mentions_agent`) is gated on.
///
/// The client resolves mentions to `p` tags at compose time from an interactive
/// autocomplete pick; the workflow path has only free text, so this reverse-parse
/// *defines* the matching contract. It is deliberately conservative to avoid
/// waking the wrong agent:
///
/// - **Members only.** Candidates are the destination channel's members; global
///   users are never matched.
/// - **Exact display name.** No substring, prefix, or fuzzy matching. Names may
///   contain spaces/punctuation (`"Will Pfleger"`, `"Lep (Subagent)"`), so the
///   match is anchored on `@` and terminated by a non-name boundary rather than
///   whitespace.
/// - **Greedy-longest, non-overlapping.** Longer names are matched first and
///   consume their span, so `@Will Pfleger` binds *Pfleger* and a bare `@Will`
///   does not match the member `"Will Pfleger"`.
/// - **Ambiguous names wake no one.** If two or more members share the matched
///   display name, no `p` tag is emitted for it — arbitrary selection would
///   silently misroute and tagging all of them is a false-wake firehose.
///
/// Returns deduplicated pubkey hexes, in first-appearance order in `text`.
fn resolve_mention_pubkeys(text: &str, members: &[(String, String)]) -> Vec<String> {
    // Name → pubkey, folding case (client matches case-insensitively). A name
    // that maps to more than one distinct pubkey is ambiguous → wake no one.
    let mut by_name: std::collections::HashMap<String, Option<String>> =
        std::collections::HashMap::new();
    for (name, pubkey) in members {
        if name.trim().is_empty() {
            continue;
        }
        by_name
            .entry(name.to_lowercase())
            .and_modify(|slot| {
                if slot.as_deref() != Some(pubkey.as_str()) {
                    *slot = None; // ambiguous
                }
            })
            .or_insert_with(|| Some(pubkey.clone()));
    }

    // Match longest names first so a longer name consumes its span before a
    // shorter substring name can claim part of it.
    let mut names: Vec<&(String, String)> = members.iter().collect();
    names.sort_by_key(|(name, _)| std::cmp::Reverse(name.chars().count()));

    let chars: Vec<char> = text.chars().collect();
    let mut consumed = vec![false; chars.len()];

    // Case-insensitivity folds *both* sides through `char::to_lowercase`, which
    // can change length: `İ` (U+0130) lowercases to two code points (`i` +
    // U+0307 combining dot). Comparing a pre-lowercased copy of the whole text
    // against a lowercased name by index silently desyncs once any earlier char
    // expands. Instead, fold on the fly: walk the original `chars` at the
    // candidate `@`, folding each char, and match against the folded-name char
    // stream — tracking how many *original* chars were consumed so
    // boundary/`consumed` accounting stays in original coordinates. `None` = no
    // match; `Some(n)` = matched, consuming `n` original chars after the `@`.
    let match_name_len = |start: usize, folded_name: &[char]| -> Option<usize> {
        let mut ci = start;
        let mut ni = 0;
        while ni < folded_name.len() {
            let c = *chars.get(ci)?;
            for fc in c.to_lowercase() {
                if folded_name.get(ni) != Some(&fc) {
                    return None;
                }
                ni += 1;
            }
            ci += 1;
        }
        Some(ci - start)
    };

    // A mention is anchored on `@` at a left boundary (start / whitespace / `(`)
    // and the matched name must not be followed by a name-continuation char —
    // otherwise `@Will` would match inside `@Willow`. Combined with matching the
    // longest member name first, this is the whole rule: no punctuation allowlist
    // to get wrong, and it is unicode-safe (em-dash, emoji all terminate a name).
    let is_left_boundary = |i: usize| i == 0 || chars[i - 1].is_whitespace() || chars[i - 1] == '(';
    let extends_name = |c: char| c.is_alphanumeric() || c == '_';

    let mut out: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut hits: Vec<(usize, String)> = Vec::new();

    for (name, _) in &names {
        let folded_name: Vec<char> = name.to_lowercase().chars().collect();
        if folded_name.is_empty() {
            continue;
        }
        let mut at = 0;
        while at < chars.len() {
            // Anchor on `@` at a left boundary and an unconsumed span; only then
            // attempt the fold-match. `name_len` is measured in *original* chars,
            // so `at + 1 + name_len` is the true position just past the name.
            let name_len = (chars[at] == '@' && is_left_boundary(at) && !consumed[at])
                .then(|| match_name_len(at + 1, &folded_name))
                .flatten()
                .filter(|&n| {
                    chars[at + 1 + n..]
                        .first()
                        .is_none_or(|&c| !extends_name(c))
                });
            if let Some(name_len) = name_len {
                let span = 1 + name_len;
                if let Some(Some(pubkey)) = by_name.get(&name.to_lowercase()) {
                    hits.push((at, pubkey.clone()));
                }
                for slot in consumed.iter_mut().skip(at).take(span) {
                    *slot = true;
                }
                at += span;
            } else {
                at += 1;
            }
        }
    }

    hits.sort_by_key(|(at, _)| *at);
    for (_, pubkey) in hits {
        if seen.insert(pubkey.clone()) {
            out.push(pubkey);
        }
    }
    out
}

/// Relay-side action sink — executes workflow side-effects directly.
///
/// Holds a **weak** reference to `AppState` to avoid an `Arc` reference cycle:
/// `AppState` → `WorkflowEngine` → `ActionSink` → `AppState`. Using `Weak`
/// breaks the cycle so all structs can be dropped on shutdown.
///
/// Post-persist side effects are delegated to [`dispatch_persistent_event`]
/// for consistency with the REST/WebSocket paths.
pub struct RelayActionSink {
    state: Weak<AppState>,
}

impl RelayActionSink {
    /// Create a new `RelayActionSink` from the shared application state.
    pub fn new(state: &Arc<AppState>) -> Self {
        Self {
            state: Arc::downgrade(state),
        }
    }
}

impl ActionSink for RelayActionSink {
    fn send_message(
        &self,
        community_id: CommunityId,
        channel_id: &str,
        text: &str,
        author_pubkey: &str,
    ) -> Pin<Box<dyn Future<Output = Result<String, ActionSinkError>> + Send + '_>> {
        let channel_id = channel_id.to_owned();
        let text = text.to_owned();
        let author_pubkey = author_pubkey.to_owned();

        Box::pin(async move {
            // 0. Upgrade weak reference — fails only during shutdown.
            let state = self
                .state
                .upgrade()
                .ok_or_else(|| ActionSinkError::Database("relay is shutting down".into()))?;

            // The run carries its owning community (`community_id`); the
            // relay-signed kind:9 message belongs to *that* community, never the
            // deployment default. Re-deriving the tenant from `config.relay_url`
            // would post a community-B workflow's output into the deployment/
            // default community under N>1. Read the community's host back to
            // form a complete TenantContext (host is for labelling only — the
            // community is already fixed and is never re-derived from it). Fail
            // closed if the community no longer maps to a host.
            let host = state
                .db
                .lookup_community_host(community_id)
                .await
                .map_err(|e| ActionSinkError::Database(e.to_string()))?
                .ok_or_else(|| {
                    ActionSinkError::Database(format!(
                        "workflow run community {community_id} is not mapped to a host"
                    ))
                })?;
            let tenant = buzz_core::tenant::TenantContext::resolved(community_id, host);

            // 1. Validate content is not empty/whitespace-only
            if text.trim().is_empty() {
                return Err(ActionSinkError::EmptyContent);
            }

            // 2. Parse and validate channel — canonicalize UUID immediately
            let channel_uuid = Uuid::parse_str(&channel_id)
                .map_err(|e| ActionSinkError::InvalidInput(format!("invalid UUID: {e}")))?;
            let channel_id_canonical = channel_uuid.to_string();

            let channel = state
                .db
                .get_channel(tenant.community(), channel_uuid)
                .await
                .map_err(|e| match &e {
                    buzz_db::DbError::ChannelNotFound(_) | buzz_db::DbError::NotFound(_) => {
                        ActionSinkError::ChannelNotFound(channel_id_canonical.clone())
                    }
                    _ => ActionSinkError::Database(e.to_string()),
                })?;

            if channel.archived_at.is_some() {
                return Err(ActionSinkError::ChannelArchived(
                    channel_id_canonical.clone(),
                ));
            }

            let author_pubkey = nostr::PublicKey::from_hex(&author_pubkey).map_err(|e| {
                ActionSinkError::InvalidInput(format!("invalid author pubkey: {e}"))
            })?;
            let author_pubkey_bytes = author_pubkey.to_bytes().to_vec();
            let author_pubkey_hex = author_pubkey.to_hex();
            let is_member = state
                .is_member_cached(tenant.community(), channel_uuid, &author_pubkey_bytes)
                .await
                .map_err(|e| ActionSinkError::Database(e.to_string()))?;
            if !is_member && channel.visibility != "open" {
                return Err(ActionSinkError::InvalidInput(
                    "workflow owner does not have access to destination channel".into(),
                ));
            }

            // 3. Build kind:9 Nostr event
            //    - Signed by relay keypair (event.pubkey = relay pubkey)
            //    - `p` tag attributes the message to the workflow owner
            //    - `h` tag scopes to the channel (NIP-29, canonical UUID)
            //    - `buzz:workflow` tag prevents recursive workflow triggering
            //    - one `p` tag per `@Name` that resolves to a channel member,
            //      so mentioned agents are woken (wake is `p`-tag gated)
            let mut tags = vec![
                Tag::parse(["p", &author_pubkey_hex])
                    .map_err(|e| ActionSinkError::EventBuild(format!("p tag: {e}")))?,
                Tag::parse(["h", &channel_id_canonical])
                    .map_err(|e| ActionSinkError::EventBuild(format!("h tag: {e}")))?,
                Tag::parse(["buzz:workflow", "true"])
                    .map_err(|e| ActionSinkError::EventBuild(format!("workflow tag: {e}")))?,
            ];

            let members = state
                .db
                .get_members(tenant.community(), channel_uuid)
                .await
                .map_err(|e| ActionSinkError::Database(e.to_string()))?;
            let member_pubkeys: Vec<Vec<u8>> = members.iter().map(|m| m.pubkey.clone()).collect();
            let users = state
                .db
                .get_users_bulk(tenant.community(), &member_pubkeys)
                .await
                .map_err(|e| ActionSinkError::Database(e.to_string()))?;
            let named_members: Vec<(String, String)> = users
                .into_iter()
                .filter_map(|u| {
                    let name = u.display_name?;
                    Some((name, nostr::PublicKey::from_slice(&u.pubkey).ok()?.to_hex()))
                })
                .collect();
            // Resolve `@Name` mentions to channel-member pubkeys and append a
            // `p` tag for each (skipping the author, already tagged above).
            //
            // Owner-contact hierarchy (Option C): a mention that resolves to a
            // community owner is only legal from an Executive or an untiered
            // actor (gate parity). From a Worker/Leader the mention is routed
            // to the next-in-line agent -- own team lead, else the unique
            // executive -- and the owner is re-emitted as a reference-only
            // `mention` tag: the @chip still renders and resolves, but the
            // owner is never woken (wake is `p`-tag gated) nor indexed in
            // `event_mentions`. If no next-in-line resolves, the step fails:
            // never guess a target, never silently drop the mention.
            let mentions = resolve_mention_pubkeys(&text, &named_members);
            let mut owner_targets: Vec<&str> = Vec::new();
            for mentioned in &mentions {
                if mentioned == &author_pubkey_hex {
                    continue;
                }
                let member = state
                    .db
                    .get_relay_member(tenant.community(), mentioned)
                    .await
                    .map_err(|e| ActionSinkError::Database(e.to_string()))?;
                if member.is_some_and(|member| member.role == "owner") {
                    owner_targets.push(mentioned.as_str());
                }
            }

            let route = if owner_targets.is_empty() {
                None
            } else {
                Some(
                    resolve_owner_mention_route(&tenant, &state, &author_pubkey)
                        .await
                        .map_err(ActionSinkError::OwnerContactUnroutable)?,
                )
            };

            let mut routed: Vec<String> = Vec::new();
            for mentioned in &mentions {
                if mentioned == &author_pubkey_hex {
                    continue;
                }
                match route {
                    Some(OwnerMentionRoute::Route(target))
                        if owner_targets.contains(&mentioned.as_str()) =>
                    {
                        let target_hex = target.to_hex();
                        if !routed.contains(&target_hex) {
                            tags.push(Tag::parse(["p", &target_hex]).map_err(|e| {
                                ActionSinkError::EventBuild(format!("routed p tag: {e}"))
                            })?);
                            routed.push(target_hex);
                        }
                        tags.push(Tag::parse(["mention", mentioned]).map_err(|e| {
                            ActionSinkError::EventBuild(format!("mention ref tag: {e}"))
                        })?);
                    }
                    _ => {
                        tags.push(Tag::parse(["p", mentioned]).map_err(|e| {
                            ActionSinkError::EventBuild(format!("mention p tag: {e}"))
                        })?);
                    }
                }
            }

            let kind = Kind::from(KIND_STREAM_MESSAGE as u16);
            let event = EventBuilder::new(kind, &text)
                .tags(tags)
                .sign_with_keys(&state.relay_keypair)
                .map_err(|e| ActionSinkError::EventBuild(format!("signing: {e}")))?;

            let event_id_hex = event.id.to_hex();
            let event_id_bytes = event.id.as_bytes().to_vec();
            let kind_u32 = KIND_STREAM_MESSAGE;

            let event_created_at = {
                let ts = event.created_at.as_secs() as i64;
                chrono::DateTime::from_timestamp(ts, 0).unwrap_or_else(Utc::now)
            };

            info!(
                event_id = %event_id_hex,
                channel_id = %channel_id_canonical,
                author = %author_pubkey,
                "Workflow SendMessage: posting kind {kind_u32} event"
            );

            // 4. Persist event with thread metadata (matches REST handler path).
            //    Workflow messages are always top-level: depth=0, no parent/root.
            let thread_meta = Some(buzz_db::event::ThreadMetadataParams {
                event_id: &event_id_bytes,
                event_created_at,
                channel_id: channel_uuid,
                parent_event_id: None,
                parent_event_created_at: None,
                root_event_id: None,
                root_event_created_at: None,
                depth: 0,
                broadcast: false,
            });

            let (stored_event, was_inserted) = state
                .db
                .insert_event_with_thread_metadata(
                    tenant.community(),
                    &event,
                    Some(channel_uuid),
                    thread_meta,
                )
                .await
                .map_err(|e| ActionSinkError::Database(e.to_string()))?;

            // 5. Post-persist side effects (fan-out, search, audit)
            //    Only if actually inserted (idempotency guard).
            if was_inserted {
                let _ = dispatch_persistent_event(
                    &tenant,
                    &state,
                    &stored_event,
                    kind_u32,
                    &author_pubkey_hex,
                    None,
                )
                .await;
            }

            Ok(event_id_hex)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(name: &str, pubkey: &str) -> (String, String) {
        (name.to_string(), pubkey.to_string())
    }

    // A 64-char hex pubkey built from a single repeated nibble, for readable tests.
    fn pk(nibble: char) -> String {
        std::iter::repeat_n(nibble, 64).collect()
    }

    #[test]
    fn resolves_exact_member_name() {
        let members = vec![m("Robby", &pk('a'))];
        assert_eq!(
            resolve_mention_pubkeys("heads up @Robby — please take a look", &members),
            vec![pk('a')]
        );
    }

    #[test]
    fn matches_case_insensitively() {
        let members = vec![m("Robby", &pk('a'))];
        assert_eq!(
            resolve_mention_pubkeys("ping @robby", &members),
            vec![pk('a')]
        );
    }

    #[test]
    fn ignores_non_member_and_bare_at() {
        let members = vec![m("Robby", &pk('a'))];
        assert!(resolve_mention_pubkeys("hey @Stranger and @", &members).is_empty());
    }

    #[test]
    fn greedy_longest_binds_full_name_not_prefix() {
        // Both "Will" and "Will Pfleger" are members. `@Will Pfleger` must bind
        // Pfleger's key only; a bare `@Will` binds Will.
        let members = vec![m("Will", &pk('1')), m("Will Pfleger", &pk('2'))];
        assert_eq!(
            resolve_mention_pubkeys("cc @Will Pfleger on this", &members),
            vec![pk('2')]
        );
        assert_eq!(
            resolve_mention_pubkeys("cc @Will on this", &members),
            vec![pk('1')]
        );
    }

    #[test]
    fn at_mid_token_does_not_match() {
        // `@` must sit at a left boundary (start / whitespace / `(`). An email-ish
        // or mid-token `@` (`alice@Robby`) must not wake Robby.
        let members = vec![m("Robby", &pk('a'))];
        assert!(resolve_mention_pubkeys("alice@Robby", &members).is_empty());
    }

    #[test]
    fn prefix_member_does_not_match_inside_longer_word() {
        // "Sam" is a member; `@Sami` (no "Sami" member) must not wake Sam.
        let members = vec![m("Sam", &pk('3'))];
        assert!(resolve_mention_pubkeys("hi @Sami", &members).is_empty());
    }

    #[test]
    fn name_with_spaces_and_punctuation() {
        let members = vec![m("Lep (Subagent)", &pk('4'))];
        assert_eq!(
            resolve_mention_pubkeys("@Lep (Subagent) take it", &members),
            vec![pk('4')]
        );
    }

    #[test]
    fn em_dash_terminates_name() {
        // Generated prose often writes `@Name—text` with no space.
        let members = vec![m("Robby", &pk('a'))];
        assert_eq!(
            resolve_mention_pubkeys("@Robby—please look", &members),
            vec![pk('a')]
        );
    }

    #[test]
    fn non_ascii_member_name() {
        let members = vec![m("Zoë", &pk('5'))];
        assert_eq!(
            resolve_mention_pubkeys("welcome @Zoë!", &members),
            vec![pk('5')]
        );
    }

    #[test]
    fn lowercase_expansion_does_not_shift_later_mentions() {
        // Regression (Wren's redteam counterexample): `İ` (U+0130) lowercases to
        // TWO code points (`i` + U+0307). A design that pre-lowercases the whole
        // text and indexes it in parallel with the original chars desyncs after
        // the expansion, dropping every later valid mention. `@İ @Robby` must
        // resolve BOTH members, in order.
        let members = vec![m("İ", &pk('c')), m("Robby", &pk('a'))];
        assert_eq!(
            resolve_mention_pubkeys("@İ @Robby", &members),
            vec![pk('c'), pk('a')]
        );
    }

    #[test]
    fn sharp_s_matches_case_insensitively() {
        // `ẞ` (U+1E9E capital sharp s) lowercases to `ß` (U+00DF) — a single
        // char, NOT `ss` (that's uppercase/full-case-fold behavior, not
        // `char::to_lowercase`). Covers non-ASCII case-insensitive matching, and
        // that a later mention still resolves after it.
        let members = vec![m("ẞ", &pk('d')), m("Max", &pk('b'))];
        assert_eq!(
            resolve_mention_pubkeys("@ẞ and @Max", &members),
            vec![pk('d'), pk('b')]
        );
    }

    // Adversarial rows from Quinn's re-review (the two `ẞ→ss`-premised ones were
    // dropped as vacuous — `ẞ` lowercases to `ß`, one char, so it never inverts
    // original-vs-folded length; only `İ` does).

    #[test]
    fn combining_mark_in_name_matches() {
        // A name carrying a combining mark (`é` as `e` + U+0301) matches the same
        // sequence in text (1:1 folding) and terminates cleanly.
        let members = vec![m("Jos\u{0065}\u{0301}", &pk('4'))]; // "José" decomposed
        assert_eq!(
            resolve_mention_pubkeys("hi @Jos\u{0065}\u{0301}!", &members),
            vec![pk('4')]
        );
    }

    #[test]
    fn expanding_name_at_trailing_boundary() {
        // Expansion at the very end: `@İ` with nothing after must match, and
        // `@İx` (x extends the name, no `İx` member) must NOT match `İ`.
        let members = vec![m("İ", &pk('5'))];
        assert_eq!(resolve_mention_pubkeys("@İ", &members), vec![pk('5')]);
        assert!(resolve_mention_pubkeys("@İx", &members).is_empty());
    }

    #[test]
    fn back_to_back_at_is_one_mention() {
        // `@İ@Robby`: the second `@` is preceded by a name char (`İ`), so it is
        // NOT at a left boundary — same rule as `alice@Robby`. Back-to-back
        // `@a@b` is intentionally one mention; a separator is required to wake
        // both. The expanding first name (`İ` → 2 folded chars) also proves the
        // span accounting stays in original coordinates.
        let members = vec![m("İ", &pk('5')), m("Robby", &pk('a'))];
        assert_eq!(resolve_mention_pubkeys("@İ@Robby", &members), vec![pk('5')]);
        // ASCII control: same shape, same outcome — it's the boundary rule, not
        // a Unicode span-accounting bug.
        let ascii = vec![m("Sam", &pk('6')), m("Robby", &pk('a'))];
        assert_eq!(resolve_mention_pubkeys("@Sam@Robby", &ascii), vec![pk('6')]);
        // With a separator, both wake.
        assert_eq!(
            resolve_mention_pubkeys("@İ @Robby", &members),
            vec![pk('5'), pk('a')]
        );
    }

    #[test]
    fn ambiguous_name_wakes_no_one() {
        // Six "Fizz" agents (real team case) with distinct pubkeys → tag none.
        let members = vec![
            m("Fizz", &pk('6')),
            m("Fizz", &pk('7')),
            m("Fizz", &pk('8')),
        ];
        assert!(resolve_mention_pubkeys("@Fizz status?", &members).is_empty());
    }

    #[test]
    fn duplicate_name_same_pubkey_is_not_ambiguous() {
        // Same identity listed twice (e.g. two channels) is not a conflict.
        let members = vec![m("Fizz", &pk('6')), m("Fizz", &pk('6'))];
        assert_eq!(resolve_mention_pubkeys("@Fizz go", &members), vec![pk('6')]);
    }

    #[test]
    fn dedupes_repeated_mentions_in_first_appearance_order() {
        let members = vec![m("Robby", &pk('a')), m("Max", &pk('b'))];
        assert_eq!(
            resolve_mention_pubkeys("@Max then @Robby then @Max again", &members),
            vec![pk('b'), pk('a')]
        );
    }
}

#[cfg(test)]
mod integration_tests {
    //! Regression test for `e3661764` / `7899c1a8`: a workflow `send_message`
    //! that mentions a channel member by name (`@Name`) must emit a `p` tag for
    //! that member so ACP agent wake (`event_mentions_agent`, p-tag gated) fires.
    //!
    //! Postgres-gated like the other DB-backed relay tests. Run with:
    //!   `cargo test -p buzz-relay --lib workflow_sink -- --ignored`
    use super::*;
    use buzz_core::channel::{ChannelType, ChannelVisibility, MemberRole};
    use buzz_db::CreateCommunityWithOwnerResult;
    use std::sync::Arc;

    /// Real-PG state mirroring `handlers::event::tests::test_state_with_redis_url`.
    async fn test_state() -> Arc<AppState> {
        let mut config = crate::config::Config::from_env().expect("default config loads");
        config.require_relay_membership = false;
        config.redis_url = "redis://127.0.0.1:1".to_string();
        let pool = sqlx::PgPool::connect_lazy(&config.database_url).expect("lazy pg pool");
        // The relay applies migrations at startup; a fresh test database has
        // none, so apply them here before any table is touched. CI's Postgres
        // is provisioned from schema/schema.sql by pgschema instead, so the
        // migrator is skipped there rather than replaying 0001 over live
        // objects.
        buzz_db::migration::run_migrations_unless_provisioned(&pool)
            .await
            .expect("apply migrations");
        let db = buzz_db::Db::from_pool(pool.clone());
        let redis_pool = deadpool_redis::Config::from_url(&config.redis_url)
            .create_pool(Some(deadpool_redis::Runtime::Tokio1))
            .expect("redis pool");
        let pubsub = Arc::new(
            buzz_pubsub::PubSubManager::new(&config.redis_url, redis_pool.clone())
                .await
                .expect("pubsub manager"),
        );
        let audit = buzz_audit::AuditService::new(pool.clone());
        let auth = buzz_auth::AuthService::new(config.auth.clone());
        let search = buzz_search::SearchService::new(pool.clone());
        let workflow_engine = Arc::new(buzz_workflow::WorkflowEngine::new(
            db.clone(),
            buzz_workflow::WorkflowConfig::default(),
        ));
        let media_storage = buzz_media::MediaStorage::new(&config.media).expect("media storage");
        let (state, _audit_shutdown) = AppState::new(
            config,
            db,
            redis_pool,
            audit,
            pubsub,
            auth,
            search,
            workflow_engine,
            nostr::Keys::generate(),
            media_storage,
        );
        Arc::new(state)
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn workflow_send_message_p_tags_mentioned_member() {
        let state = test_state().await;

        let author = nostr::Keys::generate();
        let author_hex = author.public_key().to_hex();
        let agent = nostr::Keys::generate();
        let agent_hex = agent.public_key().to_hex();
        let agent_bytes = agent.public_key().to_bytes().to_vec();

        let host = format!("wf-ptag-{}.example", uuid::Uuid::new_v4().simple());
        let community = match state
            .db
            .create_community_with_owner(&host, &author_hex)
            .await
            .expect("create community")
        {
            CreateCommunityWithOwnerResult::Created(rec) => rec.id,
            other => panic!("expected fresh community, got {other:?}"),
        };

        // Open channel; the creator (author) is bootstrapped as an owner-member.
        let channel = state
            .db
            .create_channel(
                community,
                "wf-ptag",
                ChannelType::Stream,
                ChannelVisibility::Open,
                None,
                &author.public_key().to_bytes(),
                None,
            )
            .await
            .expect("create channel");

        // The mentioned agent is a real member with a resolvable display name.
        state
            .db
            .ensure_user(community, &agent_bytes)
            .await
            .expect("ensure agent user row");
        state
            .db
            .update_user_profile(community, &agent_bytes, Some("Robby"), None, None, None)
            .await
            .expect("set agent display name");
        state
            .db
            .add_member(
                community,
                channel.id,
                &agent_bytes,
                MemberRole::Bot,
                Some(&author.public_key().to_bytes()),
            )
            .await
            .expect("add agent member");

        let sink = RelayActionSink::new(&state);
        let event_id_hex = sink
            .send_message(
                community,
                &channel.id.to_string(),
                "heads up @Robby — please take a look",
                &author_hex,
            )
            .await
            .expect("send_message");

        let id_bytes = nostr::EventId::from_hex(&event_id_hex)
            .expect("event id")
            .as_bytes()
            .to_vec();
        let stored = state
            .db
            .get_event_by_id(community, &id_bytes)
            .await
            .expect("query event")
            .expect("event persisted");

        let p_tag_targets: Vec<&str> = stored
            .event
            .tags
            .iter()
            .filter(|t| t.as_slice().first().map(|s| s.as_str()) == Some("p"))
            .filter_map(|t| t.as_slice().get(1).map(|s| s.as_str()))
            .collect();

        assert!(
            p_tag_targets.contains(&author_hex.as_str()),
            "author should still be attributed via p tag; got {p_tag_targets:?}"
        );
        assert!(
            p_tag_targets.contains(&agent_hex.as_str()),
            "mentioned member {agent_hex} must be p-tagged so it wakes; got {p_tag_targets:?}"
        );
    }

    // ---------------------------------------------------------------------
    // Owner-contact routing (Option C): a Worker/Leader workflow author whose
    // send_message mentions an owner must have the mention routed to the
    // next-in-line agent (own team lead, else the unique executive) and the
    // owner re-emitted as a reference-only `mention` tag. The owner is never
    // p-tagged, so it is never woken or mention-indexed.
    // ---------------------------------------------------------------------

    use buzz_core::kind::{KIND_MANAGED_AGENT, KIND_TEAM};
    use buzz_db::event::EventQuery;
    use nostr::PublicKey;

    /// Write an owner-authored managed-agent head (kind 30177) at `agent_hex`
    /// declaring `tier` and, when given, a `persona_id` (the team-roster key).
    async fn write_agent_head(
        db: &buzz_db::Db,
        community: buzz_core::CommunityId,
        owner: &nostr::Keys,
        agent_hex: &str,
        tier: &str,
        persona_id: Option<&str>,
    ) {
        let content = match persona_id {
            Some(pid) => format!(r#"{{"tier":"{tier}","persona_id":"{pid}"}}"#),
            None => format!(r#"{{"tier":"{tier}"}}"#),
        };
        let event = EventBuilder::new(Kind::Custom(KIND_MANAGED_AGENT as u16), content)
            .tags(vec![Tag::parse(["d", agent_hex]).expect("d tag")])
            .sign_with_keys(owner)
            .expect("sign managed-agent head");
        let (_, inserted) = db
            .insert_event(community, &event, None)
            .await
            .expect("store managed-agent head");
        assert!(inserted);
    }

    /// Write an owner-authored team head (kind 30176).
    async fn write_team(
        db: &buzz_db::Db,
        community: buzz_core::CommunityId,
        owner: &nostr::Keys,
        team_id: &str,
        persona_ids: &[&str],
        lead_persona_id: Option<&str>,
    ) {
        let lead = match lead_persona_id {
            Some(l) => format!(r#""{l}""#),
            None => "null".to_string(),
        };
        let pids = persona_ids
            .iter()
            .map(|p| format!(r#""{p}""#))
            .collect::<Vec<_>>()
            .join(",");
        let content =
            format!(r#"{{"name":"Test Team","persona_ids":[{pids}],"lead_persona_id":{lead}}}"#);
        let event = EventBuilder::new(Kind::Custom(KIND_TEAM as u16), content)
            .tags(vec![Tag::parse(["d", team_id]).expect("d tag")])
            .sign_with_keys(owner)
            .expect("sign team head");
        let (_, inserted) = db
            .insert_event(community, &event, None)
            .await
            .expect("store team head");
        assert!(inserted);
    }

    /// Fresh open channel whose member set includes the owner under a
    /// resolvable display name (so `@Boss` resolves to the owner pubkey).
    async fn open_channel_with_owner_member(
        state: &Arc<AppState>,
        community: buzz_core::CommunityId,
        creator: &nostr::Keys,
        owner_hex: &str,
        owner_display_name: &str,
        name: &str,
    ) -> Uuid {
        let channel = state
            .db
            .create_channel(
                community,
                name,
                ChannelType::Stream,
                ChannelVisibility::Open,
                None,
                &creator.public_key().to_bytes(),
                None,
            )
            .await
            .expect("create channel");
        let owner_bytes = PublicKey::from_hex(owner_hex)
            .expect("owner pubkey")
            .to_bytes()
            .to_vec();
        state
            .db
            .ensure_user(community, &owner_bytes)
            .await
            .expect("ensure owner user row");
        state
            .db
            .update_user_profile(
                community,
                &owner_bytes,
                Some(owner_display_name),
                None,
                None,
                None,
            )
            .await
            .expect("set owner display name");
        state
            .db
            .add_member(
                community,
                channel.id,
                &owner_bytes,
                MemberRole::Owner,
                Some(&creator.public_key().to_bytes()),
            )
            .await
            .expect("add owner channel member");
        channel.id
    }

    async fn stored_event(
        state: &Arc<AppState>,
        community: buzz_core::CommunityId,
        event_id_hex: &str,
    ) -> buzz_core::StoredEvent {
        let id_bytes = nostr::EventId::from_hex(event_id_hex)
            .expect("event id")
            .as_bytes()
            .to_vec();
        state
            .db
            .get_event_by_id(community, &id_bytes)
            .await
            .expect("query event")
            .expect("event persisted")
    }

    fn p_tag_targets(stored: &buzz_core::StoredEvent) -> Vec<String> {
        stored
            .event
            .tags
            .iter()
            .filter(|t| t.as_slice().first().map(|s| s.as_str()) == Some("p"))
            .filter_map(|t| t.as_slice().get(1).map(|s| s.to_string()))
            .collect()
    }

    fn mention_tag_targets(stored: &buzz_core::StoredEvent) -> Vec<String> {
        stored
            .event
            .tags
            .iter()
            .filter(|t| t.as_slice().first().map(|s| s.as_str()) == Some("mention"))
            .filter_map(|t| t.as_slice().get(1).map(|s| s.to_string()))
            .collect()
    }

    async fn mention_indexed(
        state: &Arc<AppState>,
        community: buzz_core::CommunityId,
        channel_id: Uuid,
        pubkey_hex: &str,
    ) -> Vec<buzz_core::StoredEvent> {
        state
            .db
            .query_events(&EventQuery {
                community_id: community,
                kinds: Some(vec![KIND_STREAM_MESSAGE as i32]),
                channel_id: Some(channel_id),
                p_tag_hex: Some(pubkey_hex.to_ascii_lowercase()),
                limit: Some(10),
                ..EventQuery::for_community(community)
            })
            .await
            .expect("query mention index")
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn workflow_send_message_worker_mentioning_owner_routes_to_team_lead() {
        let state = test_state().await;
        let owner = nostr::Keys::generate();
        let owner_hex = owner.public_key().to_hex();
        let worker = nostr::Keys::generate();
        let worker_hex = worker.public_key().to_hex();
        let lead = nostr::Keys::generate();
        let lead_hex = lead.public_key().to_hex();

        let host = format!("wf-route-lead-{}.example", uuid::Uuid::new_v4().simple());
        let community = match state
            .db
            .create_community_with_owner(&host, &owner_hex)
            .await
            .expect("create community")
        {
            CreateCommunityWithOwnerResult::Created(rec) => rec.id,
            other => panic!("expected fresh community, got {other:?}"),
        };

        // Org: worker belongs to team-1 whose lead is `lead` (Leader tier).
        write_agent_head(
            &state.db,
            community,
            &owner,
            &worker_hex,
            "worker",
            Some("p-worker"),
        )
        .await;
        write_agent_head(
            &state.db,
            community,
            &owner,
            &lead_hex,
            "leader",
            Some("p-lead"),
        )
        .await;
        write_team(
            &state.db,
            community,
            &owner,
            "team-1",
            &["p-worker", "p-lead"],
            Some("p-lead"),
        )
        .await;

        let channel_id = open_channel_with_owner_member(
            &state, community, &owner, &owner_hex, "Boss", "wf-route",
        )
        .await;

        let sink = RelayActionSink::new(&state);
        let event_id_hex = sink
            .send_message(
                community,
                &channel_id.to_string(),
                "cc @Boss on this",
                &worker_hex,
            )
            .await
            .expect("send_message");

        let stored = stored_event(&state, community, &event_id_hex).await;
        let p_tags = p_tag_targets(&stored);
        assert!(
            p_tags.contains(&lead_hex),
            "owner mention must route to the team lead; got {p_tags:?}"
        );
        assert!(
            !p_tags.contains(&owner_hex),
            "owner must never be p-tagged; got {p_tags:?}"
        );
        let mention_refs = mention_tag_targets(&stored);
        assert!(
            mention_refs.contains(&owner_hex),
            "owner must remain as a reference-only mention tag; got {mention_refs:?}"
        );
        assert!(
            mention_indexed(&state, community, channel_id, &owner_hex)
                .await
                .is_empty(),
            "owner must not be mention-indexed"
        );
        assert!(
            !mention_indexed(&state, community, channel_id, &lead_hex)
                .await
                .is_empty(),
            "team lead must be mention-indexed so it wakes"
        );
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn workflow_send_message_worker_mentioning_owner_falls_back_to_unique_executive() {
        let state = test_state().await;
        let owner = nostr::Keys::generate();
        let owner_hex = owner.public_key().to_hex();
        let worker = nostr::Keys::generate();
        let worker_hex = worker.public_key().to_hex();
        let executive = nostr::Keys::generate();
        let executive_hex = executive.public_key().to_hex();

        let host = format!("wf-route-exec-{}.example", uuid::Uuid::new_v4().simple());
        let community = match state
            .db
            .create_community_with_owner(&host, &owner_hex)
            .await
            .expect("create community")
        {
            CreateCommunityWithOwnerResult::Created(rec) => rec.id,
            other => panic!("expected fresh community, got {other:?}"),
        };

        // No team contains the worker: unique executive is the fallback.
        write_agent_head(
            &state.db,
            community,
            &owner,
            &worker_hex,
            "worker",
            Some("p-worker"),
        )
        .await;
        write_agent_head(
            &state.db,
            community,
            &owner,
            &executive_hex,
            "executive",
            Some("p-exec"),
        )
        .await;

        let channel_id = open_channel_with_owner_member(
            &state, community, &owner, &owner_hex, "Boss", "wf-route",
        )
        .await;

        let sink = RelayActionSink::new(&state);
        let event_id_hex = sink
            .send_message(
                community,
                &channel_id.to_string(),
                "cc @Boss on this",
                &worker_hex,
            )
            .await
            .expect("send_message");

        let stored = stored_event(&state, community, &event_id_hex).await;
        let p_tags = p_tag_targets(&stored);
        assert!(
            p_tags.contains(&executive_hex),
            "owner mention must fall back to the unique executive; got {p_tags:?}"
        );
        assert!(
            !p_tags.contains(&owner_hex),
            "owner must never be p-tagged; got {p_tags:?}"
        );
        assert!(
            mention_tag_targets(&stored).contains(&owner_hex),
            "owner must remain as a reference-only mention tag"
        );
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn workflow_send_message_worker_mentioning_owner_without_any_route_fails_step() {
        let state = test_state().await;
        let owner = nostr::Keys::generate();
        let owner_hex = owner.public_key().to_hex();
        let worker = nostr::Keys::generate();
        let worker_hex = worker.public_key().to_hex();

        let host = format!("wf-route-fail-{}.example", uuid::Uuid::new_v4().simple());
        let community = match state
            .db
            .create_community_with_owner(&host, &owner_hex)
            .await
            .expect("create community")
        {
            CreateCommunityWithOwnerResult::Created(rec) => rec.id,
            other => panic!("expected fresh community, got {other:?}"),
        };

        // Worker exists but has no team and no executive: never guess a target.
        write_agent_head(
            &state.db,
            community,
            &owner,
            &worker_hex,
            "worker",
            Some("p-worker"),
        )
        .await;
        let channel_id = open_channel_with_owner_member(
            &state, community, &owner, &owner_hex, "Boss", "wf-route",
        )
        .await;

        let sink = RelayActionSink::new(&state);
        let result = sink
            .send_message(
                community,
                &channel_id.to_string(),
                "cc @Boss on this",
                &worker_hex,
            )
            .await;
        assert!(
            matches!(result, Err(ActionSinkError::OwnerContactUnroutable(_))),
            "unroutable owner mention must fail the step, got {result:?}"
        );

        let persisted = state
            .db
            .query_events(&EventQuery {
                community_id: community,
                kinds: Some(vec![KIND_STREAM_MESSAGE as i32]),
                channel_id: Some(channel_id),
                limit: Some(10),
                ..EventQuery::for_community(community)
            })
            .await
            .expect("query channel messages");
        assert!(
            persisted.is_empty(),
            "a failed step must not persist a message"
        );
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn workflow_send_message_leader_mentioning_owner_routes_to_executive() {
        let state = test_state().await;
        let owner = nostr::Keys::generate();
        let owner_hex = owner.public_key().to_hex();
        let leader = nostr::Keys::generate();
        let leader_hex = leader.public_key().to_hex();
        let executive = nostr::Keys::generate();
        let executive_hex = executive.public_key().to_hex();

        let host = format!("wf-route-leader-{}.example", uuid::Uuid::new_v4().simple());
        let community = match state
            .db
            .create_community_with_owner(&host, &owner_hex)
            .await
            .expect("create community")
        {
            CreateCommunityWithOwnerResult::Created(rec) => rec.id,
            other => panic!("expected fresh community, got {other:?}"),
        };

        write_agent_head(
            &state.db,
            community,
            &owner,
            &leader_hex,
            "leader",
            Some("p-leader"),
        )
        .await;
        write_agent_head(
            &state.db,
            community,
            &owner,
            &executive_hex,
            "executive",
            Some("p-exec"),
        )
        .await;

        let channel_id = open_channel_with_owner_member(
            &state, community, &owner, &owner_hex, "Boss", "wf-route",
        )
        .await;

        let sink = RelayActionSink::new(&state);
        let event_id_hex = sink
            .send_message(
                community,
                &channel_id.to_string(),
                "cc @Boss on this",
                &leader_hex,
            )
            .await
            .expect("send_message");

        let stored = stored_event(&state, community, &event_id_hex).await;
        let p_tags = p_tag_targets(&stored);
        assert!(
            p_tags.contains(&executive_hex),
            "leader owner mention must route to the unique executive; got {p_tags:?}"
        );
        assert!(
            !p_tags.contains(&owner_hex),
            "owner must never be p-tagged; got {p_tags:?}"
        );
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn workflow_send_message_untiered_author_mentioning_owner_is_not_rewritten() {
        let state = test_state().await;
        // The workflow author is a human owner with no managed-agent head:
        // parity with the gate, which lets untiered actors through untouched.
        let author = nostr::Keys::generate();
        let author_hex = author.public_key().to_hex();
        let co_owner = nostr::Keys::generate();
        let co_owner_hex = co_owner.public_key().to_hex();

        let host = format!(
            "wf-route-untiered-{}.example",
            uuid::Uuid::new_v4().simple()
        );
        let community = match state
            .db
            .create_community_with_owner(&host, &author_hex)
            .await
            .expect("create community")
        {
            CreateCommunityWithOwnerResult::Created(rec) => rec.id,
            other => panic!("expected fresh community, got {other:?}"),
        };

        // Second relay owner, so the @mention target is genuinely an owner.
        state
            .db
            .add_relay_member(community, &co_owner_hex, "owner", Some(&author_hex))
            .await
            .expect("add co-owner");

        let channel_id = open_channel_with_owner_member(
            &state,
            community,
            &author,
            &co_owner_hex,
            "Boss",
            "wf-route",
        )
        .await;

        let sink = RelayActionSink::new(&state);
        let event_id_hex = sink
            .send_message(
                community,
                &channel_id.to_string(),
                "cc @Boss on this",
                &author_hex,
            )
            .await
            .expect("send_message");

        let stored = stored_event(&state, community, &event_id_hex).await;
        let p_tags = p_tag_targets(&stored);
        assert!(
            p_tags.contains(&co_owner_hex),
            "untiered author keeps a direct owner p-tag (gate parity); got {p_tags:?}"
        );
        assert!(
            mention_tag_targets(&stored).is_empty(),
            "untiered author must not introduce reference-only mention tags"
        );
    }
}

#[cfg(test)]
mod write_path_guard {
    //! CI-detectable seam guard (Option E). `insert_event_with_thread_metadata`
    //! is the near-chokepoint every member-facing message write passes through.
    //! The owner-contact hierarchy must be enforced on every path that reaches
    //! it: the ingest path calls `enforce_owner_contact`, the workflow sink
    //! calls `resolve_owner_mention_route`. A new caller that references
    //! neither would silently reopen the workflow bypass the regression tests
    //! above close, so this test fails the build when one appears.

    use std::fs;
    use std::path::PathBuf;

    const CALL_MARKER: &str = "insert_event_with_thread_metadata(";
    const GATE_SYMBOLS: [&str; 2] = ["enforce_owner_contact", "resolve_owner_mention_route"];

    fn rust_files(dir: &PathBuf, out: &mut Vec<PathBuf>) {
        for entry in fs::read_dir(dir).expect("read src dir") {
            let path = entry.expect("dir entry").path();
            if path.is_dir() {
                rust_files(&path, out);
            } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
                out.push(path);
            }
        }
    }

    #[test]
    fn every_message_write_path_enforces_owner_contact() {
        let src = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        rust_files(&src, &mut files);

        let offenders: Vec<String> = files
            .into_iter()
            .filter_map(|path| {
                let content = fs::read_to_string(&path).expect("read source file");
                if content.contains(CALL_MARKER)
                    && !GATE_SYMBOLS.iter().any(|symbol| content.contains(symbol))
                {
                    Some(path.display().to_string())
                } else {
                    None
                }
            })
            .collect();

        assert!(
            offenders.is_empty(),
            "callers of {CALL_MARKER} must also enforce owner contact \
             ({}) -- a write path that can p-tag an owner without the \
             hierarchy is a bypass: {}",
            GATE_SYMBOLS.join(" or "),
            offenders.join(", ")
        );
    }
}
