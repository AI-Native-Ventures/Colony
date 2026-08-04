//! Colony interrupt-core: relay-side tier lookup and owner-contact gate
//! (spec: tiers).
//!
//! Workers and leaders may never address a community owner directly; only
//! the executive (Chief of Staff) may. The one exemption is thread-scoped:
//! an agent may reply inside a thread the owner started, or a thread where
//! the owner has already p-tagged that agent, so a specialist the owner
//! deliberately pulled in can still answer them. Enforced here, at ingest,
//! rather than in a client or a prompt, because a relay write-rule cannot be
//! skipped on a bad day the way a prompt can. See `docs/nips/NIP-IQ.md`.

use buzz_core::interrupt::{parse_grant, AgentTier, ParsedDecisionLog, ParsedGrant};
use buzz_core::kind::{
    KIND_DELEGATION_GRANT, KIND_DM_OPEN, KIND_MANAGED_AGENT, KIND_STREAM_MESSAGE,
    KIND_STREAM_MESSAGE_EDIT, KIND_STREAM_MESSAGE_V2,
};
use buzz_core::tenant::TenantContext;
use nostr::{Event, PublicKey};

use crate::state::AppState;

/// Kinds this gate inspects: stream messages (v1/v2), message edits, and DM
/// open. Every other kind returns `Ok(())` from [`enforce_owner_contact`]
/// before it reads the database.
fn is_gated_kind(kind: u32) -> bool {
    matches!(
        kind,
        KIND_STREAM_MESSAGE | KIND_STREAM_MESSAGE_V2 | KIND_STREAM_MESSAGE_EDIT | KIND_DM_OPEN
    )
}

/// Upper bound on how many of the most recent managed-agent heads at a
/// pubkey's `d` tag [`agent_tier`] will scan looking for one authored by a
/// current owner.
///
/// `KIND_MANAGED_AGENT` carries only `Scope::UsersWrite` at ingest (see
/// `handlers::ingest::required_scope_for_kind`), so any authenticated
/// member -- including the very agent a head describes -- can publish one.
/// Managed-agent heads are owner-authored by convention (NIP-AP), not by
/// ingest-enforced restriction. Trusting whichever head happens to be
/// newest would let a worker publish an impostor head at its own pubkey to
/// either self-declare `"tier": "executive"`, or simply shadow its real,
/// owner-authored tier and fall through to `None` -- unrestricted either
/// way, since this gate treats "no tier" the same as "Executive". Scanning
/// past a bounded number of candidates finds the legitimate head underneath
/// a handful of impostors without an unbounded query; a flood of more than
/// this many impostor heads is a write-volume problem for rate limiting,
/// not something this gate can absorb on every message it checks.
const MAX_CANDIDATE_TIER_HEADS: i64 = 20;

/// Resolve `pubkey`'s interrupt tier from its managed-agent head (kind
/// 30177), scoped to `tenant`.
///
/// Scans the most recent [`MAX_CANDIDATE_TIER_HEADS`] heads at this `d` tag,
/// newest first, and uses the first one whose author currently holds the
/// community's `owner` role -- see [`MAX_CANDIDATE_TIER_HEADS`] for why an
/// untrusted newer head must not simply shadow a legitimate older one.
///
/// Returns `Ok(None)` when there is no managed-agent head for this pubkey at
/// all (a human or an unmanaged client), when none of the scanned
/// candidates were authored by a current owner, or when the trusted head's
/// `tier` field is absent or unrecognized.
pub async fn agent_tier(
    tenant: &TenantContext,
    state: &AppState,
    pubkey: &PublicKey,
) -> Result<Option<AgentTier>, String> {
    // Fail closed: a DB error resolving tier must not leave the signer
    // treated as an unrestricted human.
    let rows = state
        .db
        .query_events(&buzz_db::event::EventQuery {
            kinds: Some(vec![KIND_MANAGED_AGENT as i32]),
            d_tag: Some(pubkey.to_hex()),
            global_only: true,
            limit: Some(MAX_CANDIDATE_TIER_HEADS),
            ..buzz_db::event::EventQuery::for_community(tenant.community())
        })
        .await
        .map_err(|error| format!("error: internal error loading managed-agent head: {error}"))?;

    for stored in rows {
        // Fail closed: same reasoning as above, applied to each candidate's
        // author.
        let author_hex = stored.event.pubkey.to_hex();
        let author_is_owner = state
            .db
            .get_relay_member(tenant.community(), &author_hex)
            .await
            .map_err(|error| {
                format!("error: internal error checking managed-agent head author: {error}")
            })?
            .is_some_and(|member| member.role == "owner");
        if !author_is_owner {
            continue;
        }

        // This is the authoritative head (NIP-33 latest-wins among the
        // owner's own heads) -- stop here even if its content turns out to
        // be malformed, rather than falling through to an older head the
        // owner has already superseded.
        let Ok(content) = serde_json::from_str::<serde_json::Value>(&stored.event.content) else {
            return Ok(None);
        };
        return Ok(content
            .get("tier")
            .and_then(|value| value.as_str())
            .and_then(AgentTier::parse));
    }

    Ok(None)
}

/// Reject writes where a `Worker` or `Leader` agent addresses a community
/// owner, per the interrupt hierarchy (spec: tiers). `Executive` agents and
/// pubkeys with no managed-agent head (humans, unmanaged clients) are
/// unrestricted.
///
/// Scope: kinds 9, 40002, 40003 (stream messages) and 41010 (DM open). Any
/// other kind, or an in-scope event carrying no `p` tags, returns `Ok(())`
/// before any database read, so ordinary traffic pays nothing for this gate.
///
/// For DM open, an owner among the participant `p` tags is always rejected;
/// opening a new DM has no reply exemption. For message kinds, an owner
/// among the `p` tags is allowed only under the reply exemption: the event's
/// `e` tags must name a thread root that either the owner authored, or that
/// the owner has posted into while p-tagging the acting agent (see
/// [`owner_thread_permits`]). The exemption must hold for every owner
/// p-tagged on the event, not just one of them.
///
/// Fails closed: a database error resolving tier, membership, or the
/// exemption rejects the write rather than allowing it.
pub async fn enforce_owner_contact(
    tenant: &TenantContext,
    state: &AppState,
    event: &Event,
) -> Result<(), String> {
    let kind = event.kind.as_u16() as u32;
    if !is_gated_kind(kind) {
        return Ok(());
    }

    let targets = extract_p_tags(event);
    if targets.is_empty() {
        return Ok(());
    }

    let Some(tier) = agent_tier(tenant, state, &event.pubkey).await? else {
        return Ok(());
    };
    if tier == AgentTier::Executive {
        return Ok(());
    }

    // Fail closed: a DB error resolving a target's membership role must not
    // let a Worker or Leader address a pubkey that might be the owner.
    let mut owner_targets: Vec<Vec<u8>> = Vec::new();
    for target_hex in &targets {
        let member = state
            .db
            .get_relay_member(tenant.community(), target_hex)
            .await
            .map_err(|error| format!("error: internal error checking relay membership: {error}"))?;
        if member.is_some_and(|member| member.role == "owner") {
            let owner_bytes = hex::decode(target_hex).map_err(|_| {
                "error: internal error: stored member pubkey is not valid hex".to_string()
            })?;
            owner_targets.push(owner_bytes);
        }
    }

    if owner_targets.is_empty() {
        return Ok(());
    }

    if kind == KIND_DM_OPEN {
        return Err(format!(
            "restricted: {} agents cannot open a DM with an owner",
            tier.as_str()
        ));
    }

    let Some(thread_root) = extract_thread_root(event) else {
        return Err(owner_contact_denied(tier));
    };

    let agent_bytes = event.pubkey.to_bytes().to_vec();
    for owner_bytes in &owner_targets {
        let permitted =
            owner_thread_permits(tenant, state, &thread_root, owner_bytes, &agent_bytes).await?;
        if !permitted {
            return Err(owner_contact_denied(tier));
        }
    }

    Ok(())
}

fn owner_contact_denied(tier: AgentTier) -> String {
    format!(
        "restricted: {} agents cannot address an owner",
        tier.as_str()
    )
}

/// Whether `agent` may address `owner` inside the thread rooted at
/// `thread_root`, in `tenant`'s community.
///
/// `true` when either:
/// - the root event exists and was authored by `owner` (the owner started
///   this thread), or
/// - the root event exists and some event stored in the thread was authored
///   by `owner` and carries a `p` tag naming `agent` (the owner pulled
///   `agent` into a thread they did not start).
///
/// `false` otherwise, including when the referenced root event does not
/// exist. Fails closed on database errors, matching
/// [`enforce_owner_contact`]'s reasoning: a lookup failure or a dangling
/// reference must never grant the exemption.
pub async fn owner_thread_permits(
    tenant: &TenantContext,
    state: &AppState,
    thread_root: &[u8],
    owner: &[u8],
    agent: &[u8],
) -> Result<bool, String> {
    // Fail closed: a DB error resolving the root must not grant the
    // exemption -- treat it the same as a dangling reference.
    let root = state
        .db
        .get_event_by_id(tenant.community(), thread_root)
        .await
        .map_err(|error| format!("error: internal error loading thread root: {error}"))?;
    let Some(root) = root else {
        return Ok(false);
    };
    if root.event.pubkey.to_bytes().as_slice() == owner {
        return Ok(true);
    }

    // Bounded to the same page size the bridge's live thread-read path uses
    // (`BRIDGE_THREAD_MAX_LIMIT` in `api/bridge.rs`) -- enough for any thread
    // a human is actually reading, without an unbounded scan per gated write.
    const MAX_THREAD_REPLIES: u32 = 500;
    // Fail closed: same reasoning as the root lookup above.
    let replies = state
        .db
        .get_thread_replies(
            tenant.community(),
            thread_root,
            None,
            MAX_THREAD_REPLIES,
            None,
        )
        .await
        .map_err(|error| format!("error: internal error loading thread replies: {error}"))?;

    let agent_hex = hex::encode(agent);
    let permitted = replies.iter().any(|reply| {
        reply.pubkey.as_slice() == owner && reply_p_tags_contain(&reply.tags, &agent_hex)
    });
    Ok(permitted)
}

/// Whether a stored event's JSON `tags` array (as persisted in
/// `thread_metadata`-joined rows) carries a `p` tag matching `target_hex`.
fn reply_p_tags_contain(tags: &serde_json::Value, target_hex: &str) -> bool {
    tags.as_array().is_some_and(|tags| {
        tags.iter().any(|tag| {
            tag.as_array().is_some_and(|parts| {
                parts.len() >= 2
                    && parts[0].as_str() == Some("p")
                    && parts[1].as_str() == Some(target_hex)
            })
        })
    })
}

/// Extract all `p` tag values (hex pubkeys) from an event.
fn extract_p_tags(event: &Event) -> Vec<String> {
    event
        .tags
        .iter()
        .filter_map(|tag| {
            if tag.kind().to_string() == "p" {
                tag.content().map(|value| value.to_string())
            } else {
                None
            }
        })
        .collect()
}

/// Extract the thread root referenced by an event's `e` tags, preferring the
/// NIP-10 `root` marker and falling back to `reply` (a first-level reply
/// carries only a `reply` marker, itself pointing at the root). `None` when
/// neither marker is present: the event is not inside a thread, so no reply
/// exemption is possible.
///
/// `pub(crate)`: also used by `ask_broker::try_auto_resolve_from_reply` to
/// find the thread an owner just replied in, so it can match that thread
/// against open asks' `origin_thread`.
pub(crate) fn extract_thread_root(event: &Event) -> Option<Vec<u8>> {
    find_marked_e_tag(event, "root").or_else(|| find_marked_e_tag(event, "reply"))
}

fn find_marked_e_tag(event: &Event, marker: &str) -> Option<Vec<u8>> {
    event.tags.iter().find_map(|tag| {
        let parts = tag.as_slice();
        if parts.len() >= 4 && parts[0] == "e" && parts[3] == marker {
            hex::decode(&parts[1])
                .ok()
                .filter(|bytes| bytes.len() == 32)
        } else {
            None
        }
    })
}

/// Upper bound on how many of the most recent delegation-grant heads at a
/// given `d` tag [`active_grant`] will scan looking for one authored by a
/// current owner.
///
/// Same reasoning as [`MAX_CANDIDATE_TIER_HEADS`]: `KIND_DELEGATION_GRANT`
/// is a NIP-33 head addressed by `(pubkey, kind, d_tag)`, so ANY authenticated
/// author could in principle publish a grant at a `d` tag they do not
/// legitimately own. Trusting whichever head is newest, unconditionally,
/// would let a non-owner shadow a real grant (or an expired one shadow its
/// own revocation). Scanning a bounded number of candidates, newest first,
/// finds the legitimate owner-authored head underneath a handful of
/// impostors without an unbounded query.
const MAX_CANDIDATE_GRANT_HEADS: i64 = 20;

/// Resolve the currently-active delegation grant head at `grant_id` (kind
/// [`KIND_DELEGATION_GRANT`]), scoped to `tenant`.
///
/// Scans the most recent [`MAX_CANDIDATE_GRANT_HEADS`] heads at this `d` tag,
/// newest first, and uses the first one whose author currently holds the
/// community's `owner` role -- mirroring [`agent_tier`]'s owner-authorship
/// scan: authorship of a grant head is never treated as authority to grant
/// on its own, since an agent with unrestricted `UsersWrite` scope could
/// otherwise self-publish a grant declaring its own autonomy at a `d` tag no
/// owner ever used.
///
/// Returns `Ok(None)` when there is no grant head at this id at all, when
/// none of the scanned candidates were authored by a current owner, or when
/// the trusted head's content fails [`parse_grant`].
pub async fn active_grant(
    tenant: &TenantContext,
    state: &AppState,
    grant_id: &str,
) -> Result<Option<ParsedGrant>, String> {
    let rows = state
        .db
        .query_events(&buzz_db::event::EventQuery {
            kinds: Some(vec![KIND_DELEGATION_GRANT as i32]),
            d_tag: Some(grant_id.to_owned()),
            global_only: true,
            limit: Some(MAX_CANDIDATE_GRANT_HEADS),
            ..buzz_db::event::EventQuery::for_community(tenant.community())
        })
        .await
        .map_err(|error| format!("error: internal error loading delegation grant head: {error}"))?;

    for stored in rows {
        // Fail closed: same reasoning as `agent_tier`'s per-candidate author
        // check.
        let author_hex = stored.event.pubkey.to_hex();
        let author_is_owner = state
            .db
            .get_relay_member(tenant.community(), &author_hex)
            .await
            .map_err(|error| {
                format!("error: internal error checking delegation grant author: {error}")
            })?
            .is_some_and(|member| member.role == "owner");
        if !author_is_owner {
            continue;
        }

        // NIP-33 latest-wins among the owner's own heads -- stop here even
        // if this head's content turns out to be malformed, rather than
        // falling through to an older head the owner has already superseded
        // (same reasoning as `agent_tier`'s malformed-content handling).
        return Ok(parse_grant(&stored.event).ok());
    }

    Ok(None)
}

/// Enforce that a delegation grant (kind [`KIND_DELEGATION_GRANT`]) is
/// authored by a pubkey that CURRENTLY holds the community's `owner` role
/// (spec: grants are owner-authored).
///
/// Authorship alone is never authority: `KIND_DELEGATION_GRANT` carries only
/// `Scope::UsersWrite` at ingest (any authenticated member can write one),
/// so without this check an agent could publish a grant declaring its own
/// autonomy. Fails closed on a database error.
pub async fn enforce_grant_authorship(
    tenant: &TenantContext,
    state: &AppState,
    event: &Event,
) -> Result<(), String> {
    let author_hex = event.pubkey.to_hex();
    let author_is_owner = state
        .db
        .get_relay_member(tenant.community(), &author_hex)
        .await
        .map_err(|error| {
            format!("error: internal error checking delegation grant author: {error}")
        })?
        .is_some_and(|member| member.role == "owner");
    if !author_is_owner {
        return Err(
            "restricted: delegation grants may only be signed by a current community owner"
                .to_string(),
        );
    }
    Ok(())
}

/// Enforce that a decision log (kind [`buzz_core::kind::KIND_DECISION_LOG`])
/// is signed by a `Leader` or `Executive` agent, and that the grant it cites
/// resolves to a currently ACTIVE, owner-authored delegation grant head
/// (spec: decision logs).
///
/// A decision log citing a revoked or absent grant is worse than no audit
/// trail at all -- it would let an agent's own record claim delegated
/// authority it does not currently hold. Fails closed on a database error.
pub async fn enforce_decision_log_authority(
    tenant: &TenantContext,
    state: &AppState,
    event: &Event,
    parsed: &ParsedDecisionLog,
) -> Result<(), String> {
    let signer_tier = agent_tier(tenant, state, &event.pubkey).await?;
    if !matches!(
        signer_tier,
        Some(AgentTier::Leader) | Some(AgentTier::Executive)
    ) {
        return Err(
            "restricted: only a leader or executive agent may record a decision log".to_string(),
        );
    }

    let grant = active_grant(tenant, state, &parsed.grant_id).await?;
    if !grant.is_some_and(|grant| grant.active) {
        return Err(format!(
            "restricted: decision log cites a grant that is not currently active: {}",
            parsed.grant_id
        ));
    }

    Ok(())
}
