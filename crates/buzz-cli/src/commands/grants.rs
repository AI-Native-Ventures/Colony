//! `buzz grants`: the owner-facing surface for Colony delegation grants
//! (kind 30189), the owner-signed heads that let a leader or executive
//! decide a bounded category autonomously.
//!
//! Mirrors `commands/asks.rs`: `create` and `revoke` build the event, then
//! self-validate it against [`buzz_core::interrupt::parse_grant`] before
//! submitting, since the relay enforces the same parser, so a CLI-side
//! rejection here is guaranteed to also be a relay-side rejection, and the
//! agent gets it without a network round trip.

use nostr::{EventBuilder, Kind, Tag};

use buzz_core::interrupt::parse_grant;
use buzz_core::kind::{KIND_DELEGATION_GRANT, KIND_NIP43_MEMBERSHIP_LIST};

use crate::client::{extract_d_tag, normalize_write_response, write_conflict_reason, BuzzClient};
use crate::error::CliError;

/// Build a two-element string tag, e.g. `["d", "grant-copy"]`.
fn tag(parts: &[&str]) -> Result<Tag, CliError> {
    Tag::parse(parts.iter().copied())
        .map_err(|error| CliError::Other(format!("tag error: {error}")))
}

/// Build the `EventBuilder` for a delegation grant head (kind
/// [`KIND_DELEGATION_GRANT`]) from validated fields.
///
/// This function only emits tags/content: it does not replicate
/// `buzz_core::interrupt::parse_grant`'s rules (hard-list category, vague
/// scope, non-negative cap, ...). Callers MUST self-validate the signed
/// event with [`parse_grant`] before submitting it; see `cmd_create`.
fn build_grant_event(
    id: &str,
    category: &str,
    scope: &str,
    cap_nano_usd: Option<i64>,
    active: bool,
) -> Result<EventBuilder, CliError> {
    let tags = vec![tag(&["d", id])?];

    let mut content = serde_json::json!({
        "category": category,
        "scope": scope,
        "active": active,
    });
    if let Some(cap) = cap_nano_usd {
        content["cap_nano_usd"] = serde_json::json!(cap);
    }

    Ok(EventBuilder::new(
        Kind::Custom(KIND_DELEGATION_GRANT as u16),
        content.to_string(),
    )
    .tags(tags))
}

/// Publish (or update) a delegation grant head (kind
/// [`KIND_DELEGATION_GRANT`]). A fresh `create` (and every `revoke`, which
/// republishes through this same builder) is always `active: true` at the
/// call site that isn't a revoke; the relay separately enforces that only a
/// current community owner may sign this kind.
async fn cmd_create(
    client: &BuzzClient,
    id: &str,
    category: &str,
    scope: &str,
    cap_nano_usd: Option<i64>,
) -> Result<(), CliError> {
    let builder = build_grant_event(id, category, scope, cap_nano_usd, true)?;
    let event = client.sign_event(builder)?;
    parse_grant(&event).map_err(|error| {
        CliError::Usage(format!(
            "constructed grant event failed the relay's own validation ({error}); fix the named \
             field and retry"
        ))
    })?;

    submit_grant_write(client, event).await
}

/// Revoke a grant: read the head the relay itself would honour (the newest
/// owner-authored head at this `d` tag), then republish the same
/// category/scope/cap with `active: false`. The record stays; only its
/// `active` flag flips.
async fn cmd_revoke(client: &BuzzClient, id: &str) -> Result<(), CliError> {
    let filter = serde_json::json!({ "kinds": [KIND_DELEGATION_GRANT] });
    let heads: Vec<serde_json::Value> = client
        .query_all(filter)
        .await?
        .into_iter()
        .filter(|event| extract_d_tag(event) == id)
        .collect();
    let any_head_exists = !heads.is_empty();
    let owners = current_owner_pubkeys(client).await?;

    let current = newest_head(retain_owner_authored(heads, owners.as_ref())).ok_or_else(|| {
        if any_head_exists {
            CliError::Usage(format!(
                "grant '{id}' has heads, but none authored by a current community owner. The \
                 relay ignores those heads too, so this grant is already unenforceable and \
                 there is nothing to revoke."
            ))
        } else {
            CliError::Usage(format!("no grant head found with id '{id}'"))
        }
    })?;

    let existing: nostr::Event = serde_json::from_value(current).map_err(|error| {
        CliError::Other(format!(
            "failed to parse existing grant head as an event: {error}"
        ))
    })?;
    let parsed = parse_grant(&existing).map_err(|error| {
        CliError::Usage(format!(
            "existing grant head with id '{id}' failed the relay's own validation ({error})"
        ))
    })?;

    let builder = build_grant_event(
        id,
        &parsed.category,
        &parsed.scope,
        parsed.cap_nano_usd,
        false,
    )?;
    let event = client.sign_event(builder)?;
    parse_grant(&event).map_err(|error| {
        CliError::Usage(format!(
            "constructed grant event failed the relay's own validation ({error})"
        ))
    })?;

    submit_grant_write(client, event).await
}

/// List delegation grant heads (kind [`KIND_DELEGATION_GRANT`]), keeping
/// only the head the relay would honour per `d` tag, newest first,
/// optionally filtered to grants whose honoured head is `active`.
async fn cmd_list(client: &BuzzClient, active_only: bool) -> Result<(), CliError> {
    let filter = serde_json::json!({ "kinds": [KIND_DELEGATION_GRANT] });
    let heads = client.query_all(filter).await?;
    let owners = current_owner_pubkeys(client).await?;
    let mut newest = newest_heads_by_d_tag(retain_owner_authored(heads, owners.as_ref()));

    if active_only {
        newest.retain(|event| {
            serde_json::from_value::<nostr::Event>(event.clone())
                .ok()
                .and_then(|parsed_event| parse_grant(&parsed_event).ok())
                .map(|grant| grant.active)
                .unwrap_or(false)
        });
    }

    println!(
        "{}",
        serde_json::to_string(&newest).unwrap_or_else(|_| "[]".to_string())
    );
    Ok(())
}

/// Reduce a list of grant-head events to the one head per `d` tag the relay
/// would honour, sorted newest first.
fn newest_heads_by_d_tag(events: Vec<serde_json::Value>) -> Vec<serde_json::Value> {
    let mut newest: std::collections::HashMap<String, serde_json::Value> =
        std::collections::HashMap::new();
    for event in events {
        let d_tag = extract_d_tag(&event);
        let should_replace = newest
            .get(&d_tag)
            .map(|existing| head_is_newer(&event, existing))
            .unwrap_or(true);
        if should_replace {
            newest.insert(d_tag, event);
        }
    }

    let mut result: Vec<serde_json::Value> = newest.into_values().collect();
    // Deterministic across runs: `HashMap` iteration order is not, so a
    // created_at tie would otherwise reorder the output between invocations.
    result.sort_by(|a, b| {
        created_at_of(b)
            .cmp(&created_at_of(a))
            .then_with(|| event_id_of(a).cmp(event_id_of(b)))
    });
    result
}

/// A head event's `created_at`, or 0 when absent or not an integer.
fn created_at_of(event: &serde_json::Value) -> i64 {
    event
        .get("created_at")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(0)
}

/// A head event's `id` as lowercase hex, or `""` when absent.
///
/// Nostr event ids are lowercase hex of 32 bytes, so comparing these strings
/// lexicographically is the same comparison the relay makes on the raw
/// bytes.
fn event_id_of(event: &serde_json::Value) -> &str {
    event
        .get("id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
}

/// Whether `candidate` supersedes `incumbent` under the relay's own ordering
/// for NIP-33 heads, `created_at DESC, id ASC`
/// (`buzz-db`'s `query_events`, which backs `interrupt_gate::active_grant`).
///
/// The tie matters: Nostr `created_at` is whole seconds, so two heads
/// published inside one second collide, and the relay breaks that tie toward
/// the LOWEST event id. `grants revoke` used `max_by_key(created_at)`, which
/// returns the LAST maximum and therefore picked the highest id, the exact
/// opposite; `grants list` agreed with the relay only by accident of the
/// order the query happened to return rows in.
fn head_is_newer(candidate: &serde_json::Value, incumbent: &serde_json::Value) -> bool {
    match created_at_of(candidate).cmp(&created_at_of(incumbent)) {
        std::cmp::Ordering::Greater => true,
        std::cmp::Ordering::Less => false,
        std::cmp::Ordering::Equal => event_id_of(candidate) < event_id_of(incumbent),
    }
}

/// The single head the relay would honour among `heads`, or `None` when
/// `heads` is empty.
fn newest_head(heads: Vec<serde_json::Value>) -> Option<serde_json::Value> {
    heads.into_iter().reduce(|incumbent, candidate| {
        if head_is_newer(&candidate, &incumbent) {
            candidate
        } else {
            incumbent
        }
    })
}

/// Drop every head whose author does not CURRENTLY hold the community's
/// `owner` role, matching `interrupt_gate::active_grant`, which walks heads
/// newest-first and honours only the first owner-authored one.
///
/// Without this the operator's view and the enforcement path can disagree in
/// the dangerous direction. NIP-33 replacement is keyed on
/// `(kind, pubkey, d_tag)`, so heads from two different owners at one grant
/// id coexist as live rows and neither replaces the other. If owner B
/// revokes a grant and is later demoted, the relay skips B's head and
/// honours owner A's older `active: true` one, so the grant is live while an
/// authorship-blind `grants list --active` reads B's newest head and shows
/// nothing.
///
/// `owners == None` means the roster could not be read; see
/// [`current_owner_pubkeys`]. Filtering everything away on that basis would
/// report "no grants" for a relay that has them, so the heads pass through
/// unfiltered and the warning has already been printed.
fn retain_owner_authored(
    heads: Vec<serde_json::Value>,
    owners: Option<&std::collections::HashSet<String>>,
) -> Vec<serde_json::Value> {
    let Some(owners) = owners else {
        return heads;
    };
    heads
        .into_iter()
        .filter(|event| {
            event
                .get("pubkey")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|author| owners.contains(author))
        })
        .collect()
}

/// Extract the pubkeys holding the `owner` role from a NIP-43 membership
/// snapshot event (kind [`KIND_NIP43_MEMBERSHIP_LIST`]), whose members are
/// carried as `["member", <pubkey-hex>, <role>]` tags.
fn owner_pubkeys_from_snapshot(event: &serde_json::Value) -> std::collections::HashSet<String> {
    event
        .get("tags")
        .and_then(serde_json::Value::as_array)
        .map(|tags| {
            tags.iter()
                .filter_map(|tag| {
                    let parts = tag.as_array()?;
                    let is_owner_member = parts.first().and_then(serde_json::Value::as_str)
                        == Some("member")
                        && parts.get(2).and_then(serde_json::Value::as_str) == Some("owner");
                    is_owner_member
                        .then(|| parts.get(1).and_then(serde_json::Value::as_str))
                        .flatten()
                        .map(str::to_owned)
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The pubkeys that currently hold the community's `owner` role.
///
/// Read from the relay-signed NIP-43 membership snapshot (kind
/// [`KIND_NIP43_MEMBERSHIP_LIST`]), which the relay republishes on every
/// membership change and which carries the same `relay_members` rows the
/// relay's own `get_relay_member` consults. The snapshot is scoped to the
/// relay's advertised `self` pubkey from its NIP-11 document, the same
/// pattern `commands::company`'s canonical-head reads use: an unscoped
/// author list would let anyone who could get such an event stored define
/// who counts as an owner.
///
/// `Ok(None)` means the relay published no snapshot this client could read.
/// That is a degraded view, not "this community has no owners", so callers
/// fall back to authorship-blind selection rather than reporting an empty
/// grant list for a relay that has grants. A warning goes to stderr so the
/// degradation is never silent.
async fn current_owner_pubkeys(
    client: &BuzzClient,
) -> Result<Option<std::collections::HashSet<String>>, CliError> {
    let info = client.get_public("/").await?;
    let relay_self = serde_json::from_str::<serde_json::Value>(&info)
        .ok()
        .and_then(|document| {
            document
                .get("self")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        });
    let Some(relay_self) = relay_self else {
        eprintln!(
            "warning: this relay advertises no `self` pubkey, so the current owner roster \
             cannot be read; showing every grant head regardless of author. The relay honours \
             only heads authored by a current owner, so this view may disagree with what is \
             actually enforced."
        );
        return Ok(None);
    };

    let snapshot = client
        .query_all(serde_json::json!({
            "kinds": [KIND_NIP43_MEMBERSHIP_LIST],
            "authors": [relay_self],
        }))
        .await?;
    let Some(newest) = newest_head(snapshot) else {
        eprintln!(
            "warning: this relay has published no membership snapshot (kind \
             {KIND_NIP43_MEMBERSHIP_LIST}), so the current owner roster cannot be read; showing \
             every grant head regardless of author. The relay honours only heads authored by a \
             current owner, so this view may disagree with what is actually enforced."
        );
        return Ok(None);
    };

    Ok(Some(owner_pubkeys_from_snapshot(&newest)))
}

/// Submit a signed grant event and report the relay's write result. Same
/// shape as `commands::asks::submit_ask_write`: any response the relay did
/// not durably store is surfaced as a write conflict (exit code 5), after
/// printing the full response so nothing is flattened away.
///
/// Classification is [`write_conflict_reason`]'s, which is what makes a
/// NIP-33 dominance report (`accepted: true`, message `"duplicate:"`) a
/// conflict here. Revoking a grant republishes its head at the same `d` tag,
/// so a revoke issued inside the same whole second as the head it revokes is
/// exactly the write that loses that tiebreak; reporting it as a success
/// told an owner the grant came down while the relay still enforced it.
async fn submit_grant_write(client: &BuzzClient, event: nostr::Event) -> Result<(), CliError> {
    let raw = client.submit_event(event).await?;
    println!("{}", normalize_write_response(&raw));

    match write_conflict_reason(&raw) {
        Some(reason) => Err(CliError::Conflict(reason)),
        None => Ok(()),
    }
}

/// Dispatch a `buzz grants` subcommand.
pub async fn dispatch(cmd: crate::GrantsCmd, client: &BuzzClient) -> Result<(), CliError> {
    use crate::GrantsCmd;
    match cmd {
        GrantsCmd::Create {
            id,
            category,
            scope,
            cap_nano_usd,
        } => cmd_create(client, &id, &category, &scope, cap_nano_usd).await,
        GrantsCmd::Revoke { id } => cmd_revoke(client, &id).await,
        GrantsCmd::List { active } => cmd_list(client, active).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::Keys;

    fn signed_grant(
        id: &str,
        category: &str,
        scope: &str,
        cap_nano_usd: Option<i64>,
        active: bool,
    ) -> nostr::Event {
        let owner = Keys::generate();
        let builder = build_grant_event(id, category, scope, cap_nano_usd, active)
            .expect("build_grant_event");
        builder.sign_with_keys(&owner).expect("sign")
    }

    fn offline_client() -> BuzzClient {
        let keys = Keys::generate();
        BuzzClient::new("http://127.0.0.1:1".to_string(), keys, None, None)
            .expect("client construction is offline and infallible here")
    }

    /// Step 1 (RED before `build_grant_event` exists): a `create`-shaped
    /// event round-trips through the real parser, not a hand-asserted shape
    /// of our own. Category is lowercased on the way out; cap is preserved.
    #[test]
    fn build_grant_event_round_trips_through_parse_grant() {
        let event = signed_grant(
            "grant-copy",
            "Copy_Change",
            "blog post titles",
            Some(500_000),
            true,
        );
        let parsed =
            parse_grant(&event).expect("parse_grant should accept a CLI-constructed event");

        assert_eq!(parsed.grant_id, "grant-copy");
        assert_eq!(parsed.category, "copy_change");
        assert_eq!(parsed.scope, "blog post titles");
        assert_eq!(parsed.cap_nano_usd, Some(500_000));
        assert!(parsed.active);
    }

    #[test]
    fn build_grant_event_omits_cap_when_absent() {
        let event = signed_grant("grant-copy", "copy_change", "blog post titles", None, true);
        let parsed = parse_grant(&event).expect("parse_grant should accept this event");
        assert_eq!(parsed.cap_nano_usd, None);
    }

    #[test]
    fn build_grant_event_carries_active_false_for_revoke() {
        let event = signed_grant("grant-copy", "copy_change", "blog post titles", None, false);
        let parsed = parse_grant(&event).expect("parse_grant should accept this event");
        assert!(!parsed.active);
    }

    /// A hard-list `--category` (e.g. "spend") must be rejected by
    /// self-validation before any network call.
    #[tokio::test]
    async fn create_rejects_hard_list_category_before_any_network_call() {
        let client = offline_client();
        let error = cmd_create(&client, "grant-spend", "spend", "some scope", None)
            .await
            .expect_err("a hard-list category must be rejected");
        assert!(matches!(error, CliError::Usage(_)));
    }

    /// A wildcard `--scope` ("*") must be rejected by self-validation before
    /// any network call.
    #[tokio::test]
    async fn create_rejects_wildcard_scope_before_any_network_call() {
        let client = offline_client();
        let error = cmd_create(&client, "grant-copy", "copy_change", "*", None)
            .await
            .expect_err("a wildcard scope must be rejected");
        assert!(matches!(error, CliError::Usage(_)));
    }

    fn head(id: &str, created_at: i64, author: &str) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "pubkey": author,
            "created_at": created_at,
            "tags": [["d", "grant-copy"]],
        })
    }

    /// The relay orders heads `created_at DESC, id ASC` and takes the first,
    /// so a `created_at` tie is broken toward the LOWEST event id.
    /// `grants revoke`'s `max_by_key` returned the LAST maximum, picking the
    /// highest id: the opposite of what the relay honours.
    #[test]
    fn a_created_at_tie_is_broken_toward_the_lowest_event_id() {
        let low = head("aa", 100, "owner-a");
        let high = head("bb", 100, "owner-a");

        assert!(
            !head_is_newer(&high, &low),
            "a higher event id must not displace a lower one at the same created_at"
        );
        assert!(
            head_is_newer(&low, &high),
            "a lower event id must displace a higher one at the same created_at"
        );

        assert_eq!(
            newest_head(vec![low.clone(), high.clone()])
                .as_ref()
                .map(event_id_of),
            Some("aa")
        );
        assert_eq!(
            newest_head(vec![high, low]).as_ref().map(event_id_of),
            Some("aa"),
            "and the answer must not depend on the order the rows arrived in"
        );
    }

    /// A later `created_at` still wins outright, tie-break or not.
    #[test]
    fn a_later_created_at_wins_regardless_of_event_id() {
        let older_but_lower_id = head("aa", 100, "owner-a");
        let newer_but_higher_id = head("bb", 200, "owner-a");
        assert!(head_is_newer(&newer_but_higher_id, &older_but_lower_id));
        assert_eq!(
            newest_head(vec![older_but_lower_id, newer_but_higher_id])
                .as_ref()
                .map(event_id_of),
            Some("bb")
        );
    }

    /// The dangerous divergence Important 5 names: owner B revokes a grant,
    /// B is later demoted, and the relay falls back to owner A's older
    /// `active: true` head. An authorship-blind view reads B's newest head
    /// and reports "revoked" while the relay still enforces the grant.
    #[test]
    fn a_demoted_owners_head_is_not_the_one_the_relay_would_honour() {
        let current_owner_head = head("aa", 100, "owner-a");
        let demoted_owner_head = head("bb", 200, "owner-b");
        let owners = std::collections::HashSet::from(["owner-a".to_string()]);

        let honoured = newest_head(retain_owner_authored(
            vec![current_owner_head, demoted_owner_head.clone()],
            Some(&owners),
        ));
        assert_eq!(
            honoured.as_ref().map(event_id_of),
            Some("aa"),
            "the demoted owner's newer head must not be selected"
        );

        // The same list with no roster available falls back rather than
        // reporting an empty community.
        assert_eq!(
            newest_head(retain_owner_authored(vec![demoted_owner_head], None))
                .as_ref()
                .map(event_id_of),
            Some("bb")
        );
    }

    /// `newest_heads_by_d_tag` applies the same ordering, one head per `d`
    /// tag, newest first.
    #[test]
    fn list_keeps_one_head_per_d_tag_in_relay_order() {
        let mut older = head("cc", 100, "owner-a");
        older["tags"] = serde_json::json!([["d", "grant-other"]]);

        let kept = newest_heads_by_d_tag(vec![
            head("bb", 100, "owner-a"),
            head("aa", 100, "owner-a"),
            older,
        ]);

        let ids: Vec<&str> = kept.iter().map(event_id_of).collect();
        assert_eq!(
            ids,
            vec!["aa", "cc"],
            "one head per d tag, and the tie inside `grant-copy` resolved toward the lowest id"
        );
    }

    /// Owners are read off the relay-signed membership snapshot's `member`
    /// tags; every other role is ignored.
    #[test]
    fn owner_roster_reads_only_owner_role_member_tags() {
        let snapshot = serde_json::json!({
            "id": "aa",
            "created_at": 1,
            "tags": [
                ["-"],
                ["member", "owner-a", "owner"],
                ["member", "someone", "member"],
                ["member", "owner-b", "owner"],
                ["p", "not-a-member"],
                ["member"],
            ],
        });

        let owners = owner_pubkeys_from_snapshot(&snapshot);
        assert_eq!(
            owners,
            std::collections::HashSet::from(["owner-a".to_string(), "owner-b".to_string()])
        );
    }

    /// Serve one canned relay write response on `POST /events`.
    async fn events_server(body: &'static str) -> String {
        use axum::routing::post;
        let app = axum::Router::new().route(
            "/events",
            post(move || async move {
                axum::response::Response::builder()
                    .status(axum::http::StatusCode::OK)
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(body))
                    .expect("build canned response")
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test listener");
        let addr = listener.local_addr().expect("listener address");
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        format!("http://{addr}")
    }

    fn client_for(base_url: &str) -> BuzzClient {
        BuzzClient::new(base_url.to_string(), Keys::generate(), None, None)
            .expect("client construction")
    }

    /// The Critical this branch shipped: revoking a grant republishes its
    /// head at the same `d` tag, and a revoke that lands inside the same
    /// whole second as the head it revokes loses the NIP-33 tiebreak roughly
    /// half the time. `ingest_event` reports that discard as
    /// `accepted: true, message: "duplicate:"`, so a success test that reads
    /// only `accepted` printed success and exited 0 while the grant stayed
    /// active, with no stored event to audit.
    ///
    /// Fails before the fix: `submit_grant_write` returned `Ok(())` here.
    #[tokio::test]
    async fn a_dominated_grant_write_is_a_conflict_not_a_success() {
        let url =
            events_server(r#"{"event_id":"abc","accepted":true,"message":"duplicate:"}"#).await;
        let client = client_for(&url);
        let event = signed_grant("grant-copy", "copy_change", "blog post titles", None, false);

        let error = submit_grant_write(&client, event)
            .await
            .expect_err("a write the relay discarded must not report success");

        assert!(
            matches!(error, CliError::Conflict(_)),
            "a dominated write must exit 5 (conflict), got: {error:?}"
        );
    }

    /// The other half of the same test: a write the relay actually stored
    /// still succeeds, so the fix above did not turn every write into a
    /// conflict.
    #[tokio::test]
    async fn a_stored_grant_write_still_succeeds() {
        let url = events_server(r#"{"event_id":"abc","accepted":true,"message":""}"#).await;
        let client = client_for(&url);
        let event = signed_grant("grant-copy", "copy_change", "blog post titles", None, true);

        submit_grant_write(&client, event)
            .await
            .expect("a stored write is a success");
    }

    /// A negative `--cap-nano-usd` must be rejected by self-validation
    /// before any network call.
    #[tokio::test]
    async fn create_rejects_negative_cap_before_any_network_call() {
        let client = offline_client();
        let error = cmd_create(
            &client,
            "grant-copy",
            "copy_change",
            "blog post titles",
            Some(-1),
        )
        .await
        .expect_err("a negative cap must be rejected");
        assert!(matches!(error, CliError::Usage(_)));
    }
}
