//! Colony interrupt-core: relay-side tier lookup and owner-contact gate
//! (spec: tiers).
//!
//! Workers and leaders may never address a community owner directly; only
//! the executive (Chief of Staff) may. That covers every route an ordinary
//! agent has to a human's inbox: a stream message or edit p-tagging them
//! (kinds 9, 40002, 40003), opening a DM with them (41010), adding them to
//! an existing DM (41011), and a NIP-17 gift wrap addressed to them (1059).
//! The one exemption is thread-scoped: an agent may reply inside a thread
//! the owner started, or a thread where the owner has already p-tagged that
//! agent, so a specialist the owner deliberately pulled in can still answer
//! them. Enforced here, at ingest, rather than in a client or a prompt,
//! because a relay write-rule cannot be skipped on a bad day the way a
//! prompt can. See `docs/nips/NIP-IQ.md`.

use buzz_core::employee::is_valid_role_slug;
use buzz_core::interrupt::{parse_grant, AgentTier, ParsedDecisionLog, ParsedGrant};
use buzz_core::kind::{
    KIND_DELEGATION_GRANT, KIND_DM_ADD_MEMBER, KIND_DM_OPEN, KIND_GIFT_WRAP, KIND_MANAGED_AGENT,
    KIND_STREAM_MESSAGE, KIND_STREAM_MESSAGE_EDIT, KIND_STREAM_MESSAGE_V2,
};
use buzz_core::tenant::TenantContext;
use nostr::{Event, PublicKey};

use crate::state::AppState;

/// Kinds this gate inspects: stream messages (v1/v2), message edits, DM open,
/// DM add-member, and NIP-17 gift wraps. Every other kind returns `Ok(())`
/// from [`enforce_owner_contact`] before it reads the database.
fn is_gated_kind(kind: u32) -> bool {
    matches!(
        kind,
        KIND_STREAM_MESSAGE
            | KIND_STREAM_MESSAGE_V2
            | KIND_STREAM_MESSAGE_EDIT
            | KIND_DM_OPEN
            | KIND_DM_ADD_MEMBER
            | KIND_GIFT_WRAP
    )
}

/// Whether `kind` reaches an owner DIRECTLY rather than by replying near
/// them: opening a DM (41010), adding a participant to one (41011), or
/// sending a NIP-17 gift wrap (1059). None of these has a thread to carry
/// the reply exemption, so an owner among the `p` tags is refused outright.
fn is_direct_contact_kind(kind: u32) -> bool {
    matches!(kind, KIND_DM_OPEN | KIND_DM_ADD_MEMBER | KIND_GIFT_WRAP)
}

/// The refusal for a direct-contact kind, named per kind so an agent author
/// reading a rejected write can tell which door they walked into.
fn direct_contact_denied(kind: u32, tier: AgentTier) -> String {
    let what = match kind {
        KIND_DM_OPEN => "open a DM with an owner",
        KIND_DM_ADD_MEMBER => "add an owner to a DM",
        _ => "send a private message to an owner",
    };
    format!("restricted: {} agents cannot {what}", tier.as_str())
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

/// Resolve `pubkey`'s interrupt tier, scoped to `tenant`, in four steps:
///
/// 1. an `employees` row for this pubkey -> its `rank` (a hired employee);
/// 2. else an owner-authored managed-agent head -> its `role_id` -> the
///    active `employees` row filling that role -> that role's `rank`
///    (a managed agent staffing an employed role);
/// 3. else that same head's `content.tier` (the legacy path);
/// 4. else `None` -- a human or an unmanaged client, unrestricted.
///
/// # Why the employees row comes first
///
/// Rank is decided when an owner hires: `employee_broker` mints the keypair,
/// writes the `employees` row from the owner-signed hire request (kind 9045),
/// and records `rank` there. That row is relay-written and community-scoped,
/// so it needs no author-trust scan at all -- it cannot be published, shadowed
/// or flooded by the agent it describes, which is precisely the attack
/// [`MAX_CANDIDATE_TIER_HEADS`] exists to bound on the head path.
///
/// The head path remained the only source for a long time, and nothing in the
/// product ever wrote `content.tier` onto a head (the desktop's
/// `PersonaEventContent` has no such field). Every hired employee therefore
/// resolved to `None`, which this gate treats as unrestricted -- so the agents
/// the ladder exists to constrain could address owners freely, while
/// `ask_broker::check_altitude` refused their asks for having no tier. Agents
/// were told to escalate, refused when they did, and permitted when they
/// interrupted instead.
///
/// Rank is read regardless of employment `status` on step 1. Retiring an
/// employee stops it being given work; it must not silently strip its rank and
/// thereby promote a still-running process to unrestricted owner contact.
/// Step 2 is the opposite and deliberately so: it reads only *active* rows,
/// because there it is answering "who fills this role now" in order to grant
/// that rank to a **different** pubkey. A vacated role must not keep handing
/// out the authority its last holder had.
///
/// Falls back to the managed-agent head (kind 30177) for pubkeys with no
/// employees row: scans the most recent [`MAX_CANDIDATE_TIER_HEADS`] heads at
/// this `d` tag, newest first, and uses the first one whose author currently
/// holds the community's `owner` role -- see [`MAX_CANDIDATE_TIER_HEADS`] for
/// why an untrusted newer head must not simply shadow a legitimate older one.
///
/// # Why the role join exists
///
/// The agents that actually run are managed agents, not employees. The desktop
/// generates their keys locally and never sends a hire request, so no managed
/// agent has an `employees` row and step 1 never fires for one. `role_id` is
/// the join that already exists between the two: the desktop publishes it on
/// the head it already writes (`persona_events.rs`, set for every baseline
/// roster role by `company/seed.rs`), and `employees.role_id` is unique per
/// community among active rows. Reading rank through the role keeps
/// `employees` the single source of it rather than writing a second copy onto
/// the head, which is the two-sources-of-truth mistake that made the ladder
/// inert in the first place.
///
/// This depends on the community having an owner: "owner-authored" is
/// unsatisfiable otherwise, so step 2 and step 3 both go dark in a community
/// with no `owner` relay-membership row. `buzz-relay`'s startup warns about
/// exactly that state.
///
/// Returns `Ok(None)` when the pubkey is neither an employee, nor described by
/// an owner-authored head naming a staffed role, nor one carrying a recognized
/// `tier` -- a human or an unmanaged client. Callers must keep treating that as
/// "unrestricted", or every human would be blocked.
pub async fn agent_tier(
    tenant: &TenantContext,
    state: &AppState,
    pubkey: &PublicKey,
) -> Result<Option<AgentTier>, String> {
    // Fail closed: a DB error resolving tier must not leave the signer
    // treated as an unrestricted human.
    let employee = state
        .db
        .find_employee(tenant.community(), &pubkey.to_bytes())
        .await
        .map_err(|error| format!("error: internal error loading employee record: {error}"))?;
    if let Some(employee) = employee {
        // An employed pubkey whose stored rank does not parse is a corrupt
        // row, not an unmanaged human: fall closed to the most restricted
        // rank rather than granting it a human's freedom.
        return Ok(Some(
            AgentTier::parse(&employee.rank).unwrap_or(AgentTier::Worker),
        ));
    }

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

        // The role this head claims, resolved to the rank of whoever
        // currently fills it. Read only here, inside the owner-authorship
        // check: this is the entire security boundary. `KIND_MANAGED_AGENT`
        // is client-writable, so a worker can publish a head about itself
        // claiming `role_id: "chief-of-staff"` -- the same forgery the
        // `content.tier` path below has always been exposed to, and the same
        // check refuses it. A self-authored head never reaches this line.
        if let Some(role_id) = content
            .get("role_id")
            .and_then(|value| value.as_str())
            .map(normalize_role_id)
        {
            if is_valid_role_slug(&role_id) {
                // Fail closed: same reasoning as every other read here.
                let employee = state
                    .db
                    .find_active_employee_by_role(tenant.community(), &role_id)
                    .await
                    .map_err(|error| {
                        format!("error: internal error resolving an agent's role: {error}")
                    })?;
                if let Some(employee) = employee {
                    // Corrupt stored rank falls closed to the most
                    // restricted rank, exactly as the by-pubkey path does.
                    return Ok(Some(
                        AgentTier::parse(&employee.rank).unwrap_or(AgentTier::Worker),
                    ));
                }
                // A role nobody currently fills is not an error and not a
                // guess: it is a head naming a vacancy. Fall through to
                // `tier` rather than inventing a rank for an unstaffed role.
            }
        }

        return Ok(content
            .get("tier")
            .and_then(|value| value.as_str())
            .and_then(AgentTier::parse));
    }

    Ok(None)
}

/// Resolve `pubkey`'s reporting line: the agent it reports to, scoped to
/// `tenant`, or `None` when there is no manager. Mirrors [`agent_tier`]
/// step for step, because the two answers come from the same two sources:
///
/// 1. an `employees` row for this pubkey -> its `manager` column (a hired
///    employee; the column is relay-written, so it needs no author-trust
///    scan);
/// 2. else an owner-authored managed-agent head -> its `manager` TAG (the
///    legacy-free managed-agent path; the tag, not any content field, is
///    authoritative -- tags are indexed and this is also where an agent's
///    reports are found for delete protection).
///
/// The claimed manager is then VALIDATED against the tier ladder before it
/// is returned: its own resolved tier must equal the subject's escalation
/// target exactly (worker -> leader, leader -> executive), and a subject
/// with no resolvable tier, or an executive subject, has no manager at all.
/// An invalid edge resolves to NO manager -- never to a different agent --
/// so a stale or forged line can only ever route to nobody, not somewhere.
///
/// Like [`agent_tier`], fails closed on every database error: a lookup
/// failure must never invent a reporting line. There is deliberately no
/// cycle detection: the ladder is a strict total order and every edge climbs
/// exactly one rung, so a cycle is unrepresentable -- a check here would
/// mask a broken tier rule rather than surface it.
///
/// Returns `Ok(None)` when the pubkey has no employees row and no
/// owner-authored head carrying a `manager` tag, when the claimed manager
/// fails the one-rung-up rule, or when the subject sits nowhere on the
/// ladder. Callers treat `None` as "no default audience", never as
/// authorization.
pub async fn agent_manager(
    tenant: &TenantContext,
    state: &AppState,
    pubkey: &PublicKey,
) -> Result<Option<PublicKey>, String> {
    // Fail closed: a DB error resolving the reporting line must not be read
    // as "no manager" any more than a tier lookup failure may invent one.
    let employee = state
        .db
        .find_employee(tenant.community(), &pubkey.to_bytes())
        .await
        .map_err(|error| format!("error: internal error loading employee record: {error}"))?;

    let claimed = if let Some(employee) = &employee {
        // A corrupt manager column (not 32 bytes) cannot be a reporting
        // line; the CHECK constraint makes it unreachable anyway.
        employee
            .manager
            .as_deref()
            .and_then(|bytes| PublicKey::from_slice(bytes).ok())
    } else {
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
            .map_err(|error| {
                format!("error: internal error loading managed-agent head: {error}")
            })?;

        // Walk candidates newest-first and use the first one authored by a
        // CURRENT community owner, exactly as [`agent_tier`] does before it
        // reads anything off a head. `KIND_MANAGED_AGENT` is client-writable:
        // trusting whichever head happens to be newest would let any member
        // redirect another agent's reporting line -- upward, or sideways to a
        // colluding same-rank agent that passes every tier check.
        for stored in rows {
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

            // NIP-33 latest-wins among the OWNER'S OWN heads: this is the
            // authoritative head even if it carries no `manager` tag, in
            // which case the answer is "no manager" -- never an older,
            // already-superseded head's line.
            return Ok(event_single_tag(&stored.event, "manager")
                .and_then(|manager_hex| PublicKey::from_hex(&manager_hex).ok()));
        }
        None
    };

    let Some(claimed) = claimed else {
        return Ok(None);
    };

    // The edge must sit exactly one rung up the ladder. Resolve the
    // subject's own tier first: no tier means nothing to escalate from, and
    // an executive is the top of the ladder -- it reports to no agent.
    //
    // This check is also why a SELF-manager is unrepresentable here, without
    // any explicit self-comparison: an edge from an agent to itself would
    // need its own tier to equal its own escalation target, and every rung's
    // target is strictly higher (Executive maps to itself only for subjects
    // already excluded above). A forged head naming its own subject as
    // manager therefore resolves to None, not to a self-loop.
    let Some(subject_tier) = agent_tier(tenant, state, pubkey).await? else {
        return Ok(None);
    };
    if subject_tier == AgentTier::Executive {
        return Ok(None);
    }
    let manager_tier = agent_tier(tenant, state, &claimed).await?;
    if manager_tier != Some(subject_tier.escalation_target()) {
        return Ok(None);
    }

    Ok(Some(claimed))
}

/// Read a single-valued tag off an event. `None` when the tag is absent --
/// AND when it appears more than once.
///
/// Duplicate-rejection, not first-wins: `KIND_MANAGED_AGENT` is
/// client-writable, so a head can carry two conflicting `manager` tags.
/// Resolving to the first would let the relay enforce one reporting line
/// while a client walking tags naively drew another -- a divergence the
/// owner cannot see. Same convention as `buzz_core::event_tags::single_tag`,
/// which refuses duplicates for exactly this reason; here an ambiguous line
/// resolves to NO line (fail closed) rather than erroring, matching every
/// other resolver in this file.
pub(crate) fn event_single_tag(event: &Event, name: &str) -> Option<String> {
    let mut found: Option<String> = None;
    for tag in event.tags.iter() {
        if tag.kind().to_string() != name {
            continue;
        }
        if found.is_some() {
            return None;
        }
        found = tag.content().map(|value| value.to_string());
    }
    found
}

/// Bring a `role_id` read off event content into the form `employees.role_id`
/// is stored in.
///
/// `employee_broker` writes the role from an owner-signed hire request after
/// `buzz_core::employee::role_and_name` has trimmed and lowercased it, so a
/// role read from anywhere else has to be put through the same two steps or
/// an owner who typed `Chief-Of-Staff` into one surface and `chief-of-staff`
/// into the other would silently fail to join.
fn normalize_role_id(raw: &str) -> String {
    raw.trim().to_ascii_lowercase()
}

/// Reject writes where a `Worker` or `Leader` agent addresses a community
/// owner, per the interrupt hierarchy (spec: tiers). `Executive` agents and
/// pubkeys with no managed-agent head (humans, unmanaged clients) are
/// unrestricted.
///
/// Scope: kinds 9, 40002, 40003 (stream messages), 41010 (DM open), 41011
/// (DM add member) and 1059 (NIP-17 gift wrap). Any other kind, or an
/// in-scope event carrying no `p` tags, returns `Ok(())` before any database
/// read, so ordinary traffic pays nothing for this gate.
///
/// `auth_pubkey` is the AUTHENTICATED writer, which is not always the event's
/// own signer: a gift wrap is signed by a throwaway ephemeral key and
/// `handlers::ingest` deliberately allows that mismatch (NIP-17). Resolving
/// the tier of `event.pubkey` there would find no managed-agent head and
/// treat every wrap as unrestricted, so the acting identity this gate
/// resolves is always the authenticated one. For every other gated kind
/// ingest has already rejected the write unless the two are equal, so this
/// is the same pubkey either way.
///
/// For the direct-contact kinds (DM open, DM add member, gift wrap) an owner
/// among the `p` tags is always rejected; there is no thread to carry a
/// reply exemption. For message kinds, an owner among the `p` tags is
/// allowed only under the reply exemption: the event's `e` tags must name a
/// thread root that either the owner authored, or that the owner has posted
/// into while p-tagging the acting agent (see [`owner_thread_permits`]). The
/// exemption must hold for every owner p-tagged on the event, not just one
/// of them.
///
/// Note on 41011: the `p` tags of a DM add-member name the participants
/// being ADDED, which is exactly the escalation this refuses (a worker opens
/// a permitted DM with its leader, then adds the owner to it). It does not
/// restrict a DM that already contained the owner before the add, since that
/// DM was necessarily opened by someone this gate already let through.
///
/// Fails closed: a database error resolving tier, membership, or the
/// exemption rejects the write rather than allowing it.
pub async fn enforce_owner_contact(
    tenant: &TenantContext,
    state: &AppState,
    event: &Event,
    auth_pubkey: &PublicKey,
) -> Result<(), String> {
    let kind = event.kind.as_u16() as u32;
    if !is_gated_kind(kind) {
        return Ok(());
    }

    let targets = extract_p_tags(event);
    if targets.is_empty() {
        return Ok(());
    }

    let Some(tier) = agent_tier(tenant, state, auth_pubkey).await? else {
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

    if is_direct_contact_kind(kind) {
        return Err(direct_contact_denied(kind, tier));
    }

    let Some(thread_root) = extract_thread_root(event) else {
        return Err(owner_contact_denied(tier));
    };

    let agent_bytes = auth_pubkey.to_bytes().to_vec();
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
/// is signed by a `Leader` or `Executive` agent, that the grant it cites
/// resolves to a currently ACTIVE, owner-authored delegation grant head, that
/// the decision's category matches the category the grant delegates, and
/// that a capped grant's declared amount is present and does not exceed the
/// cap (spec: decision logs).
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

    let Some(grant) = active_grant(tenant, state, &parsed.grant_id)
        .await?
        .filter(|grant| grant.active)
    else {
        return Err(format!(
            "restricted: decision log cites a grant that is not currently active: {}",
            parsed.grant_id
        ));
    };

    // Scope: a grant delegates ONE category of decision. A decision log
    // claiming any other category is citing authority it does not hold, no
    // matter how real the grant is -- without this check, one active grant
    // authorizes every decision an agent cares to record.
    if parsed.category != grant.category {
        return Err(format!(
            "restricted: decision log claims category `{}` but grant `{}` delegates only `{}`",
            parsed.category, parsed.grant_id, grant.category
        ));
    }

    // Cap: a capped grant binds every decision under it to a declared,
    // machine-readable amount at or under the cap. A missing amount fails
    // closed: no declared amount means no way to check the cap.
    if let Some(cap) = grant.cap_nano_usd {
        match parsed.amount_nano_usd {
            None => {
                return Err(format!(
                    "restricted: grant `{}` carries a spending cap; the decision log \
                     must declare amount_nano_usd",
                    parsed.grant_id
                ))
            }
            Some(amount) if amount > cap => {
                return Err(format!(
                    "restricted: decision amount {amount} nanoUSD exceeds grant `{}` \
                     cap of {cap}",
                    parsed.grant_id
                ))
            }
            Some(_) => {}
        }
    }

    Ok(())
}
