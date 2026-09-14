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

/// Append legacy routing tags from rendered output and authority-bearing tags
/// only for targets also named in the workflow owner's stored step template.
///
/// Test-only here. Colony's `send_message` applies the same authored-versus-
/// rendered split inline, interleaved with the owner-contact routing (Option C)
/// that re-emits an owner mention as a reference-only `mention` tag — a routing
/// decision this helper has no way to make. The helper stays as the executable
/// statement of the split rule, exercised by the unit tests below.
#[cfg(test)]
fn append_workflow_mention_tags(
    tags: &mut Vec<Tag>,
    rendered_text: &str,
    authored_text: &str,
    members: &[(String, String)],
    author_pubkey_hex: &str,
) -> Result<(), ActionSinkError> {
    let rendered_mentions = resolve_mention_pubkeys(rendered_text, members);
    let authored_mentions: std::collections::HashSet<String> =
        resolve_mention_pubkeys(authored_text, members)
            .into_iter()
            .collect();

    for mentioned in rendered_mentions {
        if mentioned != author_pubkey_hex {
            tags.push(
                Tag::parse(["p", &mentioned])
                    .map_err(|e| ActionSinkError::EventBuild(format!("mention p tag: {e}")))?,
            );
        }
        if authored_mentions.contains(&mentioned) {
            tags.push(
                Tag::parse(["buzz:workflow-mention", &mentioned]).map_err(|e| {
                    ActionSinkError::EventBuild(format!("workflow mention tag: {e}"))
                })?,
            );
        }
    }
    Ok(())
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
        authored_text: &str,
        author_pubkey: &str,
        reply_to: Option<&str>,
    ) -> Pin<Box<dyn Future<Output = Result<String, ActionSinkError>> + Send + '_>> {
        let channel_id = channel_id.to_owned();
        let text = text.to_owned();
        let authored_text = authored_text.to_owned();
        let author_pubkey = author_pubkey.to_owned();
        let reply_to = reply_to.map(str::to_owned);

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
                .get_channel_for_event_write(tenant.community(), channel_uuid)
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
            //    - `buzz:workflow-owner` lets harnesses apply the owner's
            //      inbound-author policy after verifying the relay signature
            //    - one `p` tag for every resolved mention in the rendered output,
            //      preserving legacy wake/feed behavior
            //    - one `buzz:workflow-mention` tag only when the same target was
            //      named in the workflow owner's stored step template. This is the
            //      authority-bearing provenance used by ACP; trigger-controlled
            //      template substitutions cannot create it.
            let mut tags = vec![
                Tag::parse(["p", &author_pubkey_hex])
                    .map_err(|e| ActionSinkError::EventBuild(format!("p tag: {e}")))?,
                Tag::parse(["h", &channel_id_canonical])
                    .map_err(|e| ActionSinkError::EventBuild(format!("h tag: {e}")))?,
                Tag::parse(["buzz:workflow", "true"])
                    .map_err(|e| ActionSinkError::EventBuild(format!("workflow tag: {e}")))?,
                Tag::parse(["buzz:workflow-owner", &author_pubkey_hex])
                    .map_err(|e| ActionSinkError::EventBuild(format!("workflow owner tag: {e}")))?,
            ];

            // Resolve thread ancestry when this is a threaded reply, so the
            // built event carries NIP-10 `root`/`reply` e-tags and persists real
            // thread metadata (matching the ingest path) instead of top-level.
            let reply_ancestry = match reply_to.as_deref() {
                Some(parent_hex) => Some(
                    crate::handlers::ingest::resolve_relay_reply_thread_meta(
                        tenant.community(),
                        parent_hex,
                        channel_uuid,
                        &state,
                    )
                    .await
                    .map_err(ActionSinkError::InvalidInput)?,
                ),
                None => None,
            };

            // NIP-10 e-tags for the thread. Marked `root`/`reply` so clients and
            // the ingest resolver read the ancestry the same way. A direct reply
            // (parent == root) emits a single `reply` tag; a nested reply emits
            // the `root` + `reply` pair — matching `buzz_sdk::builders::thread_tags`
            // so every writer produces one wire shape per reply kind.
            if let Some(ancestry) = &reply_ancestry {
                let root_hex = ancestry.root_hex();
                let parent_hex = ancestry.parent_hex();
                if root_hex == parent_hex {
                    tags.push(
                        Tag::parse(["e", &root_hex, "", "reply"]).map_err(|e| {
                            ActionSinkError::EventBuild(format!("reply e tag: {e}"))
                        })?,
                    );
                } else {
                    tags.push(
                        Tag::parse(["e", &root_hex, "", "root"])
                            .map_err(|e| ActionSinkError::EventBuild(format!("root e tag: {e}")))?,
                    );
                    tags.push(
                        Tag::parse(["e", &parent_hex, "", "reply"]).map_err(|e| {
                            ActionSinkError::EventBuild(format!("reply e tag: {e}"))
                        })?,
                    );
                }
            }

            let members = state
                .db
                .get_members_for_event_write(tenant.community(), channel_uuid)
                .await
                .map_err(|e| ActionSinkError::Database(e.to_string()))?;
            let member_pubkeys: Vec<Vec<u8>> = members.iter().map(|m| m.pubkey.clone()).collect();
            let users = state
                .db
                .get_users_bulk_for_event_write(tenant.community(), &member_pubkeys)
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
            //
            // Authority split (#6953): the `p` tag follows the RENDERED text,
            // because that is what the reader sees and what wake is gated on.
            // The authority-bearing `buzz:workflow-mention` tag follows the
            // AUTHORED step template, so a trigger that injects an `@Name` into
            // rendered output cannot manufacture a verified workflow mention.
            let mentions = resolve_mention_pubkeys(&text, &named_members);
            let authored_mentions: std::collections::HashSet<String> =
                resolve_mention_pubkeys(&authored_text, &named_members)
                    .into_iter()
                    .collect();
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
                if authored_mentions.contains(mentioned) {
                    tags.push(
                        Tag::parse(["buzz:workflow-mention", mentioned]).map_err(|e| {
                            ActionSinkError::EventBuild(format!("workflow mention tag: {e}"))
                        })?,
                    );
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
            //    Threaded replies persist the resolved parent/root/depth; a
            //    non-reply workflow message stays top-level (depth=0, no parent).
            let thread_meta_owned = reply_ancestry.map(|ancestry| {
                ancestry.into_thread_meta(event_id_bytes.clone(), event_created_at, channel_uuid)
            });
            let thread_meta = Some(match &thread_meta_owned {
                Some(owned) => owned.as_params(),
                None => buzz_db::event::ThreadMetadataParams {
                    event_id: &event_id_bytes,
                    event_created_at,
                    channel_id: channel_uuid,
                    parent_event_id: None,
                    parent_event_created_at: None,
                    root_event_id: None,
                    root_event_created_at: None,
                    depth: 0,
                    broadcast: false,
                },
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

                // A threaded reply changed its thread's counters — push a fresh
                // relay-signed kind:39005 so subscribed clients update badge
                // counts without refetching the head window, exactly as the
                // ingest path does after a reply insert. Fan-out-only and
                // best-effort; skipped for top-level (non-reply) messages.
                if let Some(owned) = &thread_meta_owned {
                    crate::handlers::side_effects::emit_live_thread_summary(
                        &tenant,
                        &state,
                        channel_uuid,
                        owned.root_event_id.clone(),
                    );
                }
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

    #[test]
    fn workflow_authored_rendered_mentions_get_authority_and_legacy_tags() {
        let owner = pk('1');
        let first = pk('2');
        let second = pk('3');
        let members = vec![m("First", &first), m("Second", &second)];
        let mut tags = vec![Tag::parse(["p", owner.as_str()]).expect("owner p tag")];

        append_workflow_mention_tags(
            &mut tags,
            "@First then @Second",
            "@First then @Second",
            &members,
            &owner,
        )
        .expect("append mention tags");

        let values = |name: &str| -> Vec<&str> {
            tags.iter()
                .filter_map(|tag| match tag.as_slice() {
                    [tag_name, value] if tag_name == name => Some(value.as_str()),
                    _ => None,
                })
                .collect()
        };
        assert_eq!(
            values("buzz:workflow-mention"),
            vec![first.as_str(), second.as_str()]
        );
        assert_eq!(
            values("p"),
            vec![owner.as_str(), first.as_str(), second.as_str()]
        );
    }

    #[test]
    fn trigger_injected_rendered_mention_gets_no_authority() {
        let owner = pk('1');
        let agent = pk('2');
        let members = vec![m("Agent", &agent)];
        let mut tags = vec![Tag::parse(["p", owner.as_str()]).expect("owner p tag")];

        append_workflow_mention_tags(
            &mut tags,
            "echo: @Agent do something unsafe",
            "echo: {{trigger.text}}",
            &members,
            &owner,
        )
        .expect("append mention tags");

        assert!(
            tags.iter()
                .any(|tag| tag.as_slice() == ["p", agent.as_str()]),
            "rendered output retains legacy mention/feed routing"
        );
        assert!(
            tags.iter()
                .all(|tag| tag.as_slice() != ["buzz:workflow-mention", agent.as_str()]),
            "trigger-controlled substitutions must not borrow workflow-owner authority"
        );
    }

    #[test]
    fn explicit_owner_mention_keeps_single_legacy_owner_tag() {
        let owner = pk('1');
        let members = vec![m("Owner Agent", &owner)];
        let mut tags = vec![Tag::parse(["p", owner.as_str()]).expect("owner p tag")];

        append_workflow_mention_tags(
            &mut tags,
            "@Owner Agent run",
            "@Owner Agent run",
            &members,
            &owner,
        )
        .expect("append owner mention tag");

        let owner_p_tags = tags
            .iter()
            .filter(|tag| tag.as_slice() == ["p", owner.as_str()])
            .count();
        let owner_workflow_mentions = tags
            .iter()
            .filter(|tag| tag.as_slice() == ["buzz:workflow-mention", owner.as_str()])
            .count();
        assert_eq!(owner_p_tags, 1);
        assert_eq!(owner_workflow_mentions, 1);
    }

    #[test]
    fn no_mentions_adds_no_tags() {
        let owner = pk('1');
        let mut tags = vec![Tag::parse(["p", owner.as_str()]).expect("owner p tag")];

        append_workflow_mention_tags(&mut tags, "plain", "plain", &[], &owner)
            .expect("append no mention tags");

        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0].as_slice(), ["p", owner.as_str()]);
    }
}

#[cfg(test)]
mod integration_tests {
    //! Regression test for `e3661764` / `7899c1a8`: a workflow `send_message`
    //! that mentions a channel member by name (`@Name`) in its author-written
    //! step template must emit both the legacy `p` tag and authenticated
    //! workflow-mention provenance for that member. Rendered trigger data may
    //! still create a legacy `p` tag, but never authority-bearing provenance.
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
        let state = Arc::new(state);
        // Production wires the sink once at startup (main.rs), not in
        // AppState::new, and set_action_sink panics on a second call. Wiring it
        // here gives every executed run a sink while keeping it to one call per
        // state, however many workflows a test runs.
        state
            .workflow_engine
            .set_action_sink(Arc::new(RelayActionSink::new(&state)));
        state
    }

    async fn execute_send_message_workflow(
        state: &Arc<AppState>,
        community: CommunityId,
        channel_id: Uuid,
        owner_pubkey: &[u8],
        name: &str,
        authored_text: &str,
        trigger_text: &str,
    ) -> String {
        let definition = serde_json::json!({
            "name": name,
            "trigger": {"on": "message_posted"},
            "steps": [{
                "id": "send",
                "action": "send_message",
                "text": authored_text,
            }],
            "enabled": true,
        });
        let definition_hash_byte = name.as_bytes().first().copied().unwrap_or_default();
        let workflow_id = state
            .db
            .create_workflow(
                community,
                Some(channel_id),
                owner_pubkey,
                name,
                &definition.to_string(),
                &[definition_hash_byte; 32],
            )
            .await
            .expect("create workflow");
        let trigger_ctx = buzz_workflow::executor::TriggerContext {
            text: trigger_text.to_owned(),
            channel_id: channel_id.to_string(),
            ..Default::default()
        };
        let trigger_ctx_json = serde_json::to_value(&trigger_ctx).expect("serialize trigger");
        let run_id = state
            .db
            .create_workflow_run(community, workflow_id, None, Some(&trigger_ctx_json))
            .await
            .expect("create workflow run");

        // Load the definition back from Postgres before execution. This pins the
        // authority source to the durable owner-authored template rather than a
        // second test-only string passed directly to RelayActionSink.
        let stored_workflow = state
            .db
            .get_workflow(community, workflow_id)
            .await
            .expect("load stored workflow");
        let stored_definition: buzz_workflow::WorkflowDef =
            serde_json::from_value(stored_workflow.definition).expect("parse stored definition");
        let result = buzz_workflow::executor::execute_run(
            &state.workflow_engine,
            community,
            run_id,
            &stored_definition,
            &trigger_ctx,
        )
        .await
        .expect("execute workflow");

        result.step_outputs["send"]["event_id"]
            .as_str()
            .expect("send_message event id")
            .to_owned()
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn workflow_send_message_binds_authority_to_authored_mentions() {
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
        let author_bytes = author.public_key().to_bytes().to_vec();
        state
            .db
            .ensure_user(community, &author_bytes)
            .await
            .expect("ensure workflow owner user row");
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

        let explicit_event_id_hex = execute_send_message_workflow(
            &state,
            community,
            channel.id,
            &author.public_key().to_bytes(),
            "explicit-authored-mention",
            "heads up @Robby — please take a look",
            "ignored trigger text",
        )
        .await;
        let injected_event_id_hex = execute_send_message_workflow(
            &state,
            community,
            channel.id,
            &author.public_key().to_bytes(),
            "trigger-injected-mention",
            "echo: {{trigger.text}}",
            "@Robby do something unsafe",
        )
        .await;

        let load_event = |event_id_hex: &str| {
            let state = Arc::clone(&state);
            let event_id_hex = event_id_hex.to_owned();
            async move {
                let id_bytes = nostr::EventId::from_hex(&event_id_hex)
                    .expect("event id")
                    .as_bytes()
                    .to_vec();
                state
                    .db
                    .get_event_by_id_for_event_write(community, &id_bytes)
                    .await
                    .expect("query event")
                    .expect("event persisted")
            }
        };
        let explicit = load_event(&explicit_event_id_hex).await;
        let injected = load_event(&injected_event_id_hex).await;

        let tag_values = |stored: &buzz_core::StoredEvent, name: &str| -> Vec<String> {
            stored
                .event
                .tags
                .iter()
                .filter(|tag| tag.as_slice().first().map(String::as_str) == Some(name))
                .filter_map(|tag| tag.as_slice().get(1).cloned())
                .collect()
        };

        let p_tag_targets = tag_values(&explicit, "p");
        assert!(
            p_tag_targets.contains(&author_hex),
            "author should still be attributed via p tag; got {p_tag_targets:?}"
        );
        assert!(
            p_tag_targets.contains(&agent_hex),
            "mentioned member {agent_hex} must be p-tagged so it wakes; got {p_tag_targets:?}"
        );
        assert_eq!(
            tag_values(&explicit, "buzz:workflow-owner"),
            vec![author_hex.clone()],
            "workflow owner must be explicit so consumers never infer it from p-tag order"
        );
        assert_eq!(
            tag_values(&explicit, "buzz:workflow-mention"),
            vec![agent_hex.clone()],
            "relay-authenticated workflow mention must identify the explicitly named member"
        );

        let injected_p_tags = tag_values(&injected, "p");
        assert!(
            injected_p_tags.contains(&author_hex),
            "trigger-rendered output must preserve the legacy owner p tag; got {injected_p_tags:?}"
        );
        assert!(
            injected_p_tags.contains(&agent_hex),
            "trigger-rendered mention must preserve legacy mention/feed routing; got {injected_p_tags:?}"
        );
        assert!(
            tag_values(&injected, "buzz:workflow-mention").is_empty(),
            "a mention introduced solely by trigger data must not receive owner-delegated authority"
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

    /// Write an owner-authored managed-agent head the way the PRODUCT writes
    /// one: naming a `role_id`, never a `tier`.
    ///
    /// [`write_agent_head`] above writes `tier`, which nothing outside these
    /// tests has ever written. That is exactly how a dead `tier`-only lookup
    /// survived on the escalation path: the suite seeded the field the code
    /// read, so the tests passed while every real workspace failed. Tests for
    /// the role path must seed the role, and pair it with [`employ_role`].
    async fn write_agent_head_with_role(
        db: &buzz_db::Db,
        community: buzz_core::CommunityId,
        owner: &nostr::Keys,
        agent_hex: &str,
        role_id: &str,
        persona_id: Option<&str>,
    ) {
        let content = match persona_id {
            Some(pid) => format!(r#"{{"role_id":"{role_id}","persona_id":"{pid}"}}"#),
            None => format!(r#"{{"role_id":"{role_id}"}}"#),
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

    /// Put a role on the payroll at `rank`. The employee identity is
    /// relay-held and nothing signs as it; what matters is the
    /// `role_id -> rank` mapping the rank lookup resolves through.
    async fn employ_role(
        db: &buzz_db::Db,
        community: buzz_core::CommunityId,
        owner: &nostr::Keys,
        role_id: &str,
        rank: &str,
    ) {
        let identity = nostr::Keys::generate();
        let stored = db
            .insert_employee(
                community,
                buzz_db::employees::NewEmployee {
                    pubkey: &identity.public_key().to_bytes(),
                    sealed_key: b"sealed-test-key",
                    role_id,
                    display_name: "Test Employee",
                    rank,
                    hired_by: &owner.public_key().to_bytes(),
                    hire_event: &identity.public_key().to_bytes(),
                    manager: None,
                },
            )
            .await
            .expect("insert employee");
        assert!(stored.is_some(), "employee row must be inserted");
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
            .get_event_by_id_for_event_write(community, &id_bytes)
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
                "cc @Boss on this",
                &worker_hex,
                None,
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

    /// The same route as the test above, seeded the way the product seeds it:
    /// the heads name a `role_id` and the payroll maps that role to a rank.
    /// Nothing writes `content.tier`, so before the role join this returned
    /// `Ok(None)` from the team-lead rung and the worker's mention fell
    /// through to the community executive instead of its own lead.
    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn workflow_send_message_worker_mentioning_owner_routes_to_the_team_lead_named_only_by_role(
    ) {
        let state = test_state().await;
        let owner = nostr::Keys::generate();
        let owner_hex = owner.public_key().to_hex();
        let worker = nostr::Keys::generate();
        let worker_hex = worker.public_key().to_hex();
        let lead = nostr::Keys::generate();
        let lead_hex = lead.public_key().to_hex();
        // An executive exists and is a valid fallback target, so routing to
        // the lead proves the team-lead rung fired rather than falling
        // through. Without it a dead rung would still look like a pass.
        let executive = nostr::Keys::generate();
        let executive_hex = executive.public_key().to_hex();

        let host = format!("wf-route-role-{}.example", uuid::Uuid::new_v4().simple());
        let community = match state
            .db
            .create_community_with_owner(&host, &owner_hex)
            .await
            .expect("create community")
        {
            CreateCommunityWithOwnerResult::Created(rec) => rec.id,
            other => panic!("expected fresh community, got {other:?}"),
        };

        employ_role(&state.db, community, &owner, "ic", "worker").await;
        employ_role(&state.db, community, &owner, "team-lead", "leader").await;
        employ_role(&state.db, community, &owner, "chief-of-staff", "executive").await;

        write_agent_head_with_role(
            &state.db,
            community,
            &owner,
            &worker_hex,
            "ic",
            Some("p-worker"),
        )
        .await;
        write_agent_head_with_role(
            &state.db,
            community,
            &owner,
            &lead_hex,
            "team-lead",
            Some("p-lead"),
        )
        .await;
        write_agent_head_with_role(
            &state.db,
            community,
            &owner,
            &executive_hex,
            "chief-of-staff",
            Some("p-exec"),
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
                "cc @Boss on this",
                &worker_hex,
                None,
            )
            .await
            .expect("send_message");

        let stored = stored_event(&state, community, &event_id_hex).await;
        let p_tags = p_tag_targets(&stored);
        assert!(
            p_tags.contains(&lead_hex),
            "a lead named only by its role must still be the route target; got {p_tags:?}"
        );
        assert!(
            !p_tags.contains(&executive_hex),
            "routing to the executive means the team-lead rung never fired; got {p_tags:?}"
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
                "cc @Boss on this",
                &worker_hex,
                None,
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
                "cc @Boss on this",
                &worker_hex,
                None,
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
                "cc @Boss on this",
                &leader_hex,
                None,
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
                "cc @Boss on this",
                &author_hex,
                None,
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
    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn workflow_reply_in_thread_threads_onto_parent() {
        let state = test_state().await;

        let author = nostr::Keys::generate();
        let author_hex = author.public_key().to_hex();

        let host = format!("wf-thread-{}.example", uuid::Uuid::new_v4().simple());
        let community = match state
            .db
            .create_community_with_owner(&host, &author_hex)
            .await
            .expect("create community")
        {
            CreateCommunityWithOwnerResult::Created(rec) => rec.id,
            other => panic!("expected fresh community, got {other:?}"),
        };

        let channel = state
            .db
            .create_channel(
                community,
                "wf-thread",
                ChannelType::Stream,
                ChannelVisibility::Open,
                None,
                &author.public_key().to_bytes(),
                None,
            )
            .await
            .expect("create channel");

        let sink = RelayActionSink::new(&state);

        // 1. A top-level workflow message becomes the thread root.
        let root_hex = sink
            .send_message(
                community,
                &channel.id.to_string(),
                "root message",
                "root message",
                &author_hex,
                None,
            )
            .await
            .expect("send root");

        // 2. A reply_in_thread message threads onto it.
        let reply_hex = sink
            .send_message(
                community,
                &channel.id.to_string(),
                "threaded reply",
                "threaded reply",
                &author_hex,
                Some(&root_hex),
            )
            .await
            .expect("send reply");

        // A direct reply carries a single NIP-10 reply e-tag at the root (no
        // root marker), matching SDK `thread_tags`.
        let reply_id_bytes = nostr::EventId::from_hex(&reply_hex)
            .expect("reply id")
            .as_bytes()
            .to_vec();
        let stored = state
            .db
            .get_event_by_id(community, &reply_id_bytes)
            .await
            .expect("query reply")
            .expect("reply persisted");
        let marker = |m: &str| -> Option<String> {
            stored.event.tags.iter().find_map(|t| {
                let p = t.as_slice();
                if p.len() >= 4 && p[0] == "e" && p[3] == m {
                    Some(p[1].clone())
                } else {
                    None
                }
            })
        };
        assert_eq!(
            marker("reply").as_deref(),
            Some(root_hex.as_str()),
            "direct reply emits a single reply marker at the root"
        );
        assert_eq!(
            marker("root"),
            None,
            "direct reply omits the root marker (matches SDK thread_tags)"
        );

        // Thread metadata reflects a depth-1 reply parented on the root.
        let meta = state
            .db
            .get_thread_metadata_by_event(community, &reply_id_bytes)
            .await
            .expect("query meta")
            .expect("reply has thread metadata");
        assert_eq!(
            meta.depth, 1,
            "direct reply to a top-level message is depth 1"
        );
        let root_bytes = nostr::EventId::from_hex(&root_hex)
            .expect("root id")
            .as_bytes()
            .to_vec();
        assert_eq!(meta.parent_event_id.as_deref(), Some(root_bytes.as_slice()));
        assert_eq!(meta.root_event_id.as_deref(), Some(root_bytes.as_slice()));
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn workflow_replies_recover_metadata_less_parent_ancestry() {
        // A parent that carries NIP-10 root/reply markers but has NO
        // thread_metadata row (legacy or not-yet-indexed) must be recognized as
        // nested: the workflow reply threads at depth 2 onto the parent's own
        // root, not a false top-level depth 1.
        let state = test_state().await;

        let author = nostr::Keys::generate();
        let author_hex = author.public_key().to_hex();

        let host = format!("wf-legacy-{}.example", uuid::Uuid::new_v4().simple());
        let community = match state
            .db
            .create_community_with_owner(&host, &author_hex)
            .await
            .expect("create community")
        {
            CreateCommunityWithOwnerResult::Created(rec) => rec.id,
            other => panic!("expected fresh community, got {other:?}"),
        };

        let channel = state
            .db
            .create_channel(
                community,
                "wf-legacy",
                ChannelType::Stream,
                ChannelVisibility::Open,
                None,
                &author.public_key().to_bytes(),
                None,
            )
            .await
            .expect("create channel");

        let channel_hex = channel.id.to_string();

        // A top-level root message, inserted WITHOUT any thread metadata row.
        let root_event = EventBuilder::new(Kind::from(KIND_STREAM_MESSAGE as u16), "root")
            .tags([Tag::parse(["h", &channel_hex]).expect("h tag")])
            .sign_with_keys(&author)
            .expect("sign root");
        let root_hex = root_event.id.to_hex();
        state
            .db
            .insert_event(community, &root_event, Some(channel.id))
            .await
            .expect("insert root");

        // A nested parent that marks its root/reply — but, crucially, is stored
        // with NO thread_metadata row (the legacy/unindexed case F1 addresses).
        let parent_event =
            EventBuilder::new(Kind::from(KIND_STREAM_MESSAGE as u16), "nested parent")
                .tags([
                    Tag::parse(["h", &channel_hex]).expect("h tag"),
                    Tag::parse(["e", &root_hex, "", "root"]).expect("root tag"),
                    Tag::parse(["e", &root_hex, "", "reply"]).expect("reply tag"),
                ])
                .sign_with_keys(&author)
                .expect("sign parent");
        let parent_hex = parent_event.id.to_hex();
        state
            .db
            .insert_event(community, &parent_event, Some(channel.id))
            .await
            .expect("insert parent");
        assert!(
            state
                .db
                .get_thread_metadata_by_event(community, parent_event.id.as_bytes())
                .await
                .expect("query parent meta")
                .is_none(),
            "test premise: the nested parent must have no thread_metadata row"
        );

        // A workflow reply onto the metadata-less nested parent.
        let reply_hex = RelayActionSink::new(&state)
            .send_message(
                community,
                &channel_hex,
                "workflow reply",
                "workflow reply",
                &author_hex,
                Some(&parent_hex),
            )
            .await
            .expect("send reply");

        let reply_id_bytes = nostr::EventId::from_hex(&reply_hex)
            .expect("reply id")
            .as_bytes()
            .to_vec();
        let meta = state
            .db
            .get_thread_metadata_by_event(community, &reply_id_bytes)
            .await
            .expect("query meta")
            .expect("reply has thread metadata");

        assert_eq!(
            meta.depth, 2,
            "reply to a marked-but-unindexed nested parent is depth 2, not top-level"
        );
        let root_bytes = nostr::EventId::from_hex(&root_hex)
            .expect("root id")
            .as_bytes()
            .to_vec();
        let parent_bytes = parent_event.id.as_bytes().to_vec();
        assert_eq!(
            meta.root_event_id.as_deref(),
            Some(root_bytes.as_slice()),
            "root recovered from the parent's own NIP-10 markers"
        );
        assert_eq!(
            meta.parent_event_id.as_deref(),
            Some(parent_bytes.as_slice())
        );

        // The reply's own NIP-10 e-tags point root→the recovered root,
        // reply→the immediate parent (matching the ingest resolver).
        let stored = state
            .db
            .get_event_by_id(community, &reply_id_bytes)
            .await
            .expect("query reply")
            .expect("reply persisted");
        let marker = |m: &str| -> Option<String> {
            stored.event.tags.iter().find_map(|t| {
                let p = t.as_slice();
                if p.len() >= 4 && p[0] == "e" && p[3] == m {
                    Some(p[1].clone())
                } else {
                    None
                }
            })
        };
        assert_eq!(marker("root").as_deref(), Some(root_hex.as_str()));
        assert_eq!(marker("reply").as_deref(), Some(parent_hex.as_str()));

        // A root-only parent is top-level under the shared collapse rule, even
        // without metadata. A workflow reply therefore starts a thread at P,
        // rather than incorrectly inheriting the marker's unrelated root R.
        let root_only_parent =
            EventBuilder::new(Kind::from(KIND_STREAM_MESSAGE as u16), "root-only parent")
                .tags([
                    Tag::parse(["h", &channel_hex]).expect("h tag"),
                    Tag::parse(["e", &root_hex, "", "root"]).expect("root tag"),
                ])
                .sign_with_keys(&author)
                .expect("sign root-only parent");
        let root_only_parent_hex = root_only_parent.id.to_hex();
        let root_only_parent_bytes = root_only_parent.id.as_bytes().to_vec();
        state
            .db
            .insert_event(community, &root_only_parent, Some(channel.id))
            .await
            .expect("insert root-only parent");

        let root_only_reply_hex = RelayActionSink::new(&state)
            .send_message(
                community,
                &channel_hex,
                "workflow reply to root-only parent",
                "workflow reply to root-only parent",
                &author_hex,
                Some(&root_only_parent_hex),
            )
            .await
            .expect("send root-only reply");
        let root_only_reply_bytes = nostr::EventId::from_hex(&root_only_reply_hex)
            .expect("reply id")
            .as_bytes()
            .to_vec();
        let root_only_meta = state
            .db
            .get_thread_metadata_by_event(community, &root_only_reply_bytes)
            .await
            .expect("query root-only reply meta")
            .expect("root-only reply has thread metadata");
        assert_eq!(root_only_meta.depth, 1);
        assert_eq!(
            root_only_meta.parent_event_id.as_deref(),
            Some(root_only_parent_bytes.as_slice())
        );
        assert_eq!(
            root_only_meta.root_event_id.as_deref(),
            Some(root_only_parent_bytes.as_slice())
        );
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn workflow_reply_to_missing_parent_errors() {
        let state = test_state().await;
        let author = nostr::Keys::generate();
        let author_hex = author.public_key().to_hex();
        let host = format!("wf-missing-{}.example", uuid::Uuid::new_v4().simple());
        let community = match state
            .db
            .create_community_with_owner(&host, &author_hex)
            .await
            .expect("create community")
        {
            CreateCommunityWithOwnerResult::Created(rec) => rec.id,
            other => panic!("expected fresh community, got {other:?}"),
        };
        let channel = state
            .db
            .create_channel(
                community,
                "wf-missing",
                ChannelType::Stream,
                ChannelVisibility::Open,
                None,
                &author.public_key().to_bytes(),
                None,
            )
            .await
            .expect("create channel");

        let unknown = nostr::Keys::generate().public_key().to_hex();
        let err = RelayActionSink::new(&state)
            .send_message(
                community,
                &channel.id.to_string(),
                "orphan reply",
                "orphan reply",
                &author_hex,
                Some(&unknown),
            )
            .await
            .expect_err("reply to a non-existent parent must fail");
        assert!(
            matches!(err, ActionSinkError::InvalidInput(_)),
            "expected InvalidInput, got {err:?}"
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
