# Channel Workspace Phase B1 Implementation Plan: ownership protocol

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the relay-side contract for workspace tab ownership, so a tab has
an owner and one driver at a time, the human or the owning agent can hand a tab
to an agent, and any driver change is an auditable event, provable end to end
with the `buzz` CLI against a live relay.

**Architecture:** A tab gets a parameterized-replaceable **head** event carrying
its identity, owner and current driver (last write wins, mirroring
`KIND_MANAGED_AGENT` and `KIND_JOB_HEAD`). Every driver change is additionally
recorded as an append-only **grant** or **takeover** event, giving the audit
trail the spec asks for ("a takeover is recorded in the thread"). Grants are
p-gated, so an agent can only read grants addressed to it. Tab **payloads never
leave the device** — the relay learns that a tab exists, who owns it and who is
driving it, never what is in it.

**Tech Stack:** Rust (`buzz-core` for parse/validate, `buzz-relay` for ingest
enforcement, `buzz-cli` for the agent-facing surface, `buzz-test-client` for the
end-to-end proof). No desktop or TypeScript work in this plan.

## Global Constraints

- Spec of record: `docs/superpowers/specs/2026-08-07-colony-channel-browser-workspace-design.md`, section **Ownership and concurrency**.
- Phase A shipped in PR #200 and is on `develop`. The tab store it added
  (`desktop/src/features/workspace/lib/workspaceTabs.ts`) is device-local and
  **this plan does not change it**. Desktop wiring is Phase B2.
- **Payloads never cross the relay.** A tab head carries id, channel, kind,
  title, owner and driver. It never carries scratchpad text, a file path, or
  image bytes. A task that finds itself serialising a payload has gone wrong.
- **One driver at a time.** The head's `driver` is the single source of truth.
  Grant and takeover events are the audit trail, not the state.
- **An agent may never grant itself a tab.** This is enforced at relay ingest,
  not in the CLI and not by prompt. Same principle as the interrupt gate in
  `crates/buzz-relay/src/interrupt_gate.rs`: the relay refuses rather than
  trusting the caller.
- All event kind integers live in `crates/buzz-core/src/kind.rs`. Add them there
  first, then implement handling.
- Channels are scoped with `h` tags (NIP-29 group tag), never `e` tags.
- No `unsafe`. No new `unwrap()`/`expect()` in production paths, use `?` and
  real error types. `#[cfg(test)]` may use them freely.
- New public API needs doc comments.
- 1000-line ceiling per file, enforced by `pnpm check:file-sizes` (it covers
  `src-tauri/src` too) and `just mobile-check`.
- Commit with `git commit -s` every time. The DCO check fails otherwise.
- `just ci` before the PR. `just test` as well, because this touches
  `buzz-relay` and needs Postgres and Redis running.

## Known gap, accepted for B1

The spec says agents "cannot see or touch tabs they do not own or have not been
granted, **including tabs created by other agents**". B1 delivers the *touch*
half completely and the *see* half partially:

- Grants are p-gated, so an agent reads only grants addressed to it.
- Tab payloads are device-local, so an agent cannot read another tab's contents
  no matter what it queries.
- **Tab heads remain visible to every channel member, agents included.** An
  agent that queries heads learns that a tab named "Notes" exists in a channel
  it is already a member of. It learns nothing about the contents and can drive
  nothing.

Closing that last gap means per-kind read ACL on a channel-scoped replaceable
kind, which the relay does not have today and which would also hide agent-owned
tabs from the human's own tab list unless designed carefully. It is deliberately
out of scope here and belongs with the approvals work, where the same ACL
machinery is needed anyway. Do not half-build it in this plan.

## Out of scope for B1

| Deferred | Why | Lands in |
| --- | --- | --- |
| Desktop UI: ownership badges, Take over button, agent-working indicator | Needs this protocol to exist first | Phase B2 |
| Approval cards, thread mirror, allow-once/always | Its own security surface, needs read ACL | Phase B3 |
| Evidence posting and ledger wiring | Same | Phase B3 |
| Per-kind payload sync | Only `scratchpad` and `web` payloads are portable; a path or PTY handle is not | When a portable kind needs it |
| Pausing an agent turn on human input | Needs the desktop input surface | Phase B2 |
| `web`, `terminal`, `video` kinds | Unchanged from Phase A | Phases C and D |

## File structure

| File | Responsibility |
| --- | --- |
| `crates/buzz-core/src/kind.rs` | Three new kind constants, registry and p-gate entries |
| `crates/buzz-core/src/workspace_tab.rs` | Parse and validate head, grant and takeover events |
| `crates/buzz-relay/src/workspace_tab_gate.rs` | Ingest rule: who may change a driver |
| `crates/buzz-cli/src/commands/workspace.rs` | `buzz workspace tabs …` agent-facing surface |
| `crates/buzz-test-client/tests/e2e_workspace_tabs.rs` | End-to-end handover proof |
| `docs/nips/NIP-WS.md` | The protocol, written down |

Modified:

| File | Change |
| --- | --- |
| `crates/buzz-core/src/lib.rs` | `pub mod workspace_tab;` |
| `crates/buzz-relay/src/lib.rs` | `pub mod workspace_tab_gate;` |
| `crates/buzz-relay/src/handlers/ingest.rs` | Call the gate for the three kinds |
| `crates/buzz-cli/src/commands/mod.rs` | `pub mod workspace;` |
| `crates/buzz-cli/src/main.rs` | `WorkspaceCmd` subcommand and dispatch |

---

## Task 1: Kind constants

Three kinds. The head is parameterized-replaceable so a driver change is a
last-write-wins update keyed by tab id, exactly like `KIND_MANAGED_AGENT`. The
grant and takeover events are stored and non-replaceable, because an audit trail
that can be overwritten is not an audit trail.

30174 through 30191 are taken, so the head takes **30192**. 44300 through 44303
belong to the interrupt protocol, so the audit events take **44400** and
**44401**.

**Files:**
- Modify: `crates/buzz-core/src/kind.rs`

**Interfaces:**
- Consumes: nothing.
- Produces: `KIND_WORKSPACE_TAB_HEAD: u32 = 30192`,
  `KIND_WORKSPACE_TAB_GRANT: u32 = 44400`,
  `KIND_WORKSPACE_TAB_TAKEOVER: u32 = 44401`.

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)] mod tests` block at the bottom of
`crates/buzz-core/src/kind.rs`:

```rust
#[test]
fn workspace_tab_kinds_are_registered_and_correctly_classified() {
    // The head is addressable so a driver change replaces it by tab id.
    assert!(is_parameterized_replaceable(KIND_WORKSPACE_TAB_HEAD));
    assert!(ALL_KINDS.contains(&KIND_WORKSPACE_TAB_HEAD));

    // The audit events must NOT be replaceable: an overwritable trail is not a
    // trail. 44400-44401 sit in the stored range.
    assert!(!is_parameterized_replaceable(KIND_WORKSPACE_TAB_GRANT));
    assert!(!is_parameterized_replaceable(KIND_WORKSPACE_TAB_TAKEOVER));
    assert!(ALL_KINDS.contains(&KIND_WORKSPACE_TAB_GRANT));
    assert!(ALL_KINDS.contains(&KIND_WORKSPACE_TAB_TAKEOVER));

    // A grant names the agent it addresses, so an agent must only be able to
    // read grants pointed at itself.
    assert!(P_GATED_KINDS.contains(&KIND_WORKSPACE_TAB_GRANT));

    // The head is the channel's tab list and every member reads it, so it must
    // NOT be p-gated. See "Known gap, accepted for B1" in the plan.
    assert!(!P_GATED_KINDS.contains(&KIND_WORKSPACE_TAB_HEAD));
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p buzz-core workspace_tab_kinds`

Expected: FAIL, `cannot find value KIND_WORKSPACE_TAB_HEAD in this scope`.

- [ ] **Step 3: Write the implementation**

Add after `pub const KIND_JOB_HEAD: u32 = 30191;`:

```rust
/// Channel workspace tab head (parameterized replaceable, human- or agent-authored).
/// One per tab. `d` is the tab id, `h` is the channel. Tags: one `tab-kind`
/// (the registry kind string, e.g. `scratchpad`), one `title`, one `owner`
/// (pubkey hex), one `driver` (pubkey hex, the single active driver).
///
/// Deliberately carries no payload. Tab contents stay on the device that holds
/// them; the relay learns that a tab exists and who is driving it, never what
/// is in it. See docs/nips/NIP-WS.md.
pub const KIND_WORKSPACE_TAB_HEAD: u32 = 30192;
```

Add after `pub const KIND_DECISION_LOG: u32 = 44303;`:

```rust
// Channel workspace ownership (44400–44401)
/// Workspace tab grant (stored, non-replaceable). A human or the tab's owning
/// agent handing the driver seat to an agent. Tags: one `p` (the grantee), one
/// `tab` (tab id), one `h` (channel). p-gated: an agent reads only the grants
/// addressed to it.
pub const KIND_WORKSPACE_TAB_GRANT: u32 = 44400;

/// Workspace tab takeover (stored, non-replaceable). The driver seat changing
/// hands other than by grant: a human taking a tab back, or a driver releasing
/// it. Tags: one `tab`, one `h`, one `reason` (`human-takeover` | `release`).
pub const KIND_WORKSPACE_TAB_TAKEOVER: u32 = 44401;
```

Add all three to `ALL_KINDS`, and add `KIND_WORKSPACE_TAB_GRANT` to
`P_GATED_KINDS` (the list starting at line 159).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p buzz-core workspace_tab_kinds`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/buzz-core/src/kind.rs
git commit -s -m "feat(workspace): tab ownership event kinds"
```

---

## Task 2: Tab head parsing

**Files:**
- Create: `crates/buzz-core/src/workspace_tab.rs`
- Modify: `crates/buzz-core/src/lib.rs`

**Interfaces:**
- Consumes: `KIND_WORKSPACE_TAB_HEAD` (Task 1).
- Produces: `struct WorkspaceTabHead { tab_id, channel_id, tab_kind, title, owner, driver }` (all `String`),
  `enum WorkspaceTabError`, `fn parse_tab_head(event: &nostr::Event) -> Result<WorkspaceTabHead, WorkspaceTabError>`.

- [ ] **Step 1: Write the failing test**

Create `crates/buzz-core/src/workspace_tab.rs` with only this test module and a
`//!` doc comment:

```rust
//! Parse and validate channel workspace ownership events.

#[cfg(test)]
mod tests {
    use super::*;

    fn head_event(tags: Vec<Vec<&str>>) -> nostr::Event {
        crate::test_support::signed_event(KIND_WORKSPACE_TAB_HEAD, "", tags)
    }

    #[test]
    fn a_well_formed_head_parses_every_field() {
        let event = head_event(vec![
            vec!["d", "tab-7"],
            vec!["h", "chan-a"],
            vec!["tab-kind", "scratchpad"],
            vec!["title", "Notes"],
            vec!["owner", &"a".repeat(64)],
            vec!["driver", &"b".repeat(64)],
        ]);
        let head = parse_tab_head(&event).unwrap();
        assert_eq!(head.tab_id, "tab-7");
        assert_eq!(head.channel_id, "chan-a");
        assert_eq!(head.tab_kind, "scratchpad");
        assert_eq!(head.title, "Notes");
        assert_eq!(head.owner, "a".repeat(64));
        assert_eq!(head.driver, "b".repeat(64));
    }

    #[test]
    fn a_head_without_a_channel_is_refused() {
        let event = head_event(vec![
            vec!["d", "tab-7"],
            vec!["tab-kind", "scratchpad"],
            vec!["title", "Notes"],
            vec!["owner", &"a".repeat(64)],
            vec!["driver", &"a".repeat(64)],
        ]);
        assert!(matches!(
            parse_tab_head(&event),
            Err(WorkspaceTabError::MissingTag("h"))
        ));
    }

    #[test]
    fn the_workspace_layer_never_learns_the_payload() {
        // A head that smuggles content must still parse to metadata only. This
        // is the plan's central rule expressed as a test: nothing in
        // WorkspaceTabHead can carry tab contents.
        let mut event = head_event(vec![
            vec!["d", "tab-7"],
            vec!["h", "chan-a"],
            vec!["tab-kind", "scratchpad"],
            vec!["title", "Notes"],
            vec!["owner", &"a".repeat(64)],
            vec!["driver", &"a".repeat(64)],
        ]);
        event.content = "secret scratchpad text".into();
        let head = parse_tab_head(&event).unwrap();
        let serialized = serde_json::to_string(&head).unwrap();
        assert!(
            !serialized.contains("secret scratchpad text"),
            "a tab head must never carry payload: {serialized}"
        );
    }

    #[test]
    fn a_non_hex_pubkey_is_refused() {
        let event = head_event(vec![
            vec!["d", "tab-7"],
            vec!["h", "chan-a"],
            vec!["tab-kind", "scratchpad"],
            vec!["title", "Notes"],
            vec!["owner", "not-a-pubkey"],
            vec!["driver", &"a".repeat(64)],
        ]);
        assert!(matches!(
            parse_tab_head(&event),
            Err(WorkspaceTabError::InvalidPubkey("owner"))
        ));
    }

    #[test]
    fn a_blank_title_is_refused() {
        let event = head_event(vec![
            vec!["d", "tab-7"],
            vec!["h", "chan-a"],
            vec!["tab-kind", "scratchpad"],
            vec!["title", "   "],
            vec!["owner", &"a".repeat(64)],
            vec!["driver", &"a".repeat(64)],
        ]);
        assert!(matches!(
            parse_tab_head(&event),
            Err(WorkspaceTabError::BlankTag("title"))
        ));
    }
}
```

Before running, check whether `crate::test_support::signed_event` exists with
that signature. Run `grep -rn "mod test_support" crates/buzz-core/src` and read
it. If the helper does not exist or takes different arguments, **use the
repo's actual helper** and say in your report which one you used; do not add a
second event-building helper.

- [ ] **Step 2: Run the test to verify it fails**

Add `pub mod workspace_tab;` to `crates/buzz-core/src/lib.rs`, then run:
`cargo test -p buzz-core workspace_tab`

Expected: FAIL, `cannot find function parse_tab_head`.

- [ ] **Step 3: Write the implementation**

Prepend to `workspace_tab.rs`:

```rust
use serde::Serialize;

use crate::kind::KIND_WORKSPACE_TAB_HEAD;

/// Why a workspace ownership event was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkspaceTabError {
    /// The event kind is not the one this parser handles.
    WrongKind(u32),
    /// A required tag is absent.
    MissingTag(&'static str),
    /// A required tag is present but empty or whitespace.
    BlankTag(&'static str),
    /// A pubkey tag is not 64 lowercase hex characters.
    InvalidPubkey(&'static str),
}

impl std::fmt::Display for WorkspaceTabError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::WrongKind(kind) => write!(f, "unexpected kind {kind}"),
            Self::MissingTag(tag) => write!(f, "missing `{tag}` tag"),
            Self::BlankTag(tag) => write!(f, "`{tag}` tag is empty"),
            Self::InvalidPubkey(tag) => {
                write!(f, "`{tag}` is not a 64-character hex pubkey")
            }
        }
    }
}

impl std::error::Error for WorkspaceTabError {}

/// One workspace tab, as the relay knows it.
///
/// Metadata only, by design. The tab's `payload` stays on the device that owns
/// it, so this struct has no field that could carry scratchpad text, a file
/// path, or image bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorkspaceTabHead {
    pub tab_id: String,
    pub channel_id: String,
    /// The registry kind string, e.g. `scratchpad`. Opaque to the relay.
    pub tab_kind: String,
    pub title: String,
    /// Pubkey hex of the tab's owner.
    pub owner: String,
    /// Pubkey hex of the single active driver.
    pub driver: String,
}

fn first_tag(event: &nostr::Event, name: &'static str) -> Result<String, WorkspaceTabError> {
    let value = event
        .tags
        .iter()
        .filter_map(|tag| {
            let slice = tag.as_slice();
            (slice.first().map(String::as_str) == Some(name)).then(|| slice.get(1).cloned())
        })
        .next()
        .flatten()
        .ok_or(WorkspaceTabError::MissingTag(name))?;
    if value.trim().is_empty() {
        return Err(WorkspaceTabError::BlankTag(name));
    }
    Ok(value.trim().to_string())
}

fn pubkey_tag(event: &nostr::Event, name: &'static str) -> Result<String, WorkspaceTabError> {
    let value = first_tag(event, name)?;
    let valid = value.len() == 64 && value.chars().all(|c| c.is_ascii_hexdigit());
    if !valid {
        return Err(WorkspaceTabError::InvalidPubkey(name));
    }
    Ok(value.to_ascii_lowercase())
}

/// Parse a tab head event. Rejects anything missing identity or ownership.
pub fn parse_tab_head(event: &nostr::Event) -> Result<WorkspaceTabHead, WorkspaceTabError> {
    let kind = event.kind.as_u16() as u32;
    if kind != KIND_WORKSPACE_TAB_HEAD {
        return Err(WorkspaceTabError::WrongKind(kind));
    }
    Ok(WorkspaceTabHead {
        tab_id: first_tag(event, "d")?,
        channel_id: first_tag(event, "h")?,
        tab_kind: first_tag(event, "tab-kind")?,
        title: first_tag(event, "title")?,
        owner: pubkey_tag(event, "owner")?,
        driver: pubkey_tag(event, "driver")?,
    })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p buzz-core workspace_tab`

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/buzz-core/src/workspace_tab.rs crates/buzz-core/src/lib.rs
git commit -s -m "feat(workspace): parse workspace tab head events"
```

---

## Task 3: Grant and takeover parsing

**Files:**
- Modify: `crates/buzz-core/src/workspace_tab.rs`

**Interfaces:**
- Consumes: `WorkspaceTabError`, `first_tag`, `pubkey_tag` (Task 2).
- Produces: `struct WorkspaceTabGrant { tab_id, channel_id, grantee, granter }`,
  `struct WorkspaceTabTakeover { tab_id, channel_id, new_driver, reason }`,
  `enum TakeoverReason { HumanTakeover, Release }`,
  `fn parse_tab_grant(&nostr::Event) -> Result<WorkspaceTabGrant, WorkspaceTabError>`,
  `fn parse_tab_takeover(&nostr::Event) -> Result<WorkspaceTabTakeover, WorkspaceTabError>`.

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `workspace_tab.rs`:

```rust
fn grant_event(author: &str, tags: Vec<Vec<&str>>) -> nostr::Event {
    let mut event = crate::test_support::signed_event(KIND_WORKSPACE_TAB_GRANT, "", tags);
    event.pubkey = nostr::PublicKey::from_hex(author).unwrap();
    event
}

#[test]
fn a_grant_names_the_agent_and_the_tab() {
    let granter = "a".repeat(64);
    let grantee = "b".repeat(64);
    let event = grant_event(
        &granter,
        vec![
            vec!["tab", "tab-7"],
            vec!["h", "chan-a"],
            vec!["p", &grantee],
        ],
    );
    let grant = parse_tab_grant(&event).unwrap();
    assert_eq!(grant.tab_id, "tab-7");
    assert_eq!(grant.channel_id, "chan-a");
    assert_eq!(grant.grantee, grantee);
    assert_eq!(grant.granter, granter, "the granter is the event author");
}

#[test]
fn a_grant_to_yourself_is_refused_at_parse_time() {
    let same = "a".repeat(64);
    let event = grant_event(
        &same,
        vec![vec!["tab", "tab-7"], vec!["h", "chan-a"], vec!["p", &same]],
    );
    assert!(
        matches!(parse_tab_grant(&event), Err(WorkspaceTabError::SelfGrant)),
        "an agent must never be able to hand itself a tab"
    );
}

#[test]
fn a_grant_without_a_grantee_is_refused() {
    let event = grant_event(
        &"a".repeat(64),
        vec![vec!["tab", "tab-7"], vec!["h", "chan-a"]],
    );
    assert!(matches!(
        parse_tab_grant(&event),
        Err(WorkspaceTabError::MissingTag("p"))
    ));
}

#[test]
fn takeover_reasons_are_a_closed_set() {
    for (raw, expected) in [
        ("human-takeover", TakeoverReason::HumanTakeover),
        ("release", TakeoverReason::Release),
    ] {
        let event = crate::test_support::signed_event(
            KIND_WORKSPACE_TAB_TAKEOVER,
            "",
            vec![
                vec!["tab", "tab-7"],
                vec!["h", "chan-a"],
                vec!["reason", raw],
                vec!["driver", &"a".repeat(64)],
            ],
        );
        assert_eq!(parse_tab_takeover(&event).unwrap().reason, expected);
    }

    let bogus = crate::test_support::signed_event(
        KIND_WORKSPACE_TAB_TAKEOVER,
        "",
        vec![
            vec!["tab", "tab-7"],
            vec!["h", "chan-a"],
            vec!["reason", "because-i-said-so"],
            vec!["driver", &"a".repeat(64)],
        ],
    );
    assert!(matches!(
        parse_tab_takeover(&bogus),
        Err(WorkspaceTabError::UnknownReason)
    ));
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p buzz-core workspace_tab`

Expected: FAIL, `cannot find function parse_tab_grant` and
`no variant named SelfGrant`.

- [ ] **Step 3: Write the implementation**

Add two variants to `WorkspaceTabError`, with their `Display` arms:

```rust
    /// The event author granted the tab to itself.
    SelfGrant,
    /// The `reason` tag is not one of the known takeover reasons.
    UnknownReason,
```

```rust
            Self::SelfGrant => write!(f, "an agent cannot grant itself a tab"),
            Self::UnknownReason => write!(f, "unknown takeover reason"),
```

Then append:

```rust
use crate::kind::{KIND_WORKSPACE_TAB_GRANT, KIND_WORKSPACE_TAB_TAKEOVER};

/// A tab handed from its current driver to an agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorkspaceTabGrant {
    pub tab_id: String,
    pub channel_id: String,
    /// Pubkey hex of the agent receiving the driver seat.
    pub grantee: String,
    /// Pubkey hex of the event author handing it over.
    pub granter: String,
}

/// Why the driver seat changed hands other than by grant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum TakeoverReason {
    /// A human took the tab back from an agent.
    HumanTakeover,
    /// The current driver gave the tab up voluntarily.
    Release,
}

/// The driver seat changing hands other than by grant.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorkspaceTabTakeover {
    pub tab_id: String,
    pub channel_id: String,
    /// Pubkey hex of the driver after the change.
    pub new_driver: String,
    pub reason: TakeoverReason,
}

/// Parse a grant. Refuses a self-grant regardless of who signed it.
pub fn parse_tab_grant(event: &nostr::Event) -> Result<WorkspaceTabGrant, WorkspaceTabError> {
    let kind = event.kind.as_u16() as u32;
    if kind != KIND_WORKSPACE_TAB_GRANT {
        return Err(WorkspaceTabError::WrongKind(kind));
    }
    let grantee = pubkey_tag(event, "p")?;
    let granter = event.pubkey.to_hex().to_ascii_lowercase();
    if grantee == granter {
        return Err(WorkspaceTabError::SelfGrant);
    }
    Ok(WorkspaceTabGrant {
        tab_id: first_tag(event, "tab")?,
        channel_id: first_tag(event, "h")?,
        grantee,
        granter,
    })
}

/// Parse a takeover. The reason is a closed set so the audit trail stays
/// queryable rather than becoming free text.
pub fn parse_tab_takeover(
    event: &nostr::Event,
) -> Result<WorkspaceTabTakeover, WorkspaceTabError> {
    let kind = event.kind.as_u16() as u32;
    if kind != KIND_WORKSPACE_TAB_TAKEOVER {
        return Err(WorkspaceTabError::WrongKind(kind));
    }
    let reason = match first_tag(event, "reason")?.as_str() {
        "human-takeover" => TakeoverReason::HumanTakeover,
        "release" => TakeoverReason::Release,
        _ => return Err(WorkspaceTabError::UnknownReason),
    };
    Ok(WorkspaceTabTakeover {
        tab_id: first_tag(event, "tab")?,
        channel_id: first_tag(event, "h")?,
        new_driver: pubkey_tag(event, "driver")?,
        reason,
    })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p buzz-core workspace_tab`

Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/buzz-core/src/workspace_tab.rs
git commit -s -m "feat(workspace): parse tab grant and takeover events"
```

---

## Task 4: Relay ingest gate

Parse-time validation stops a malformed grant. This task stops a *well-formed*
one from the wrong author. The rule: only the tab's current driver or its owner
may hand it on. Anyone else is refused at ingest, the same way
`interrupt_gate.rs` refuses an agent messaging an owner rather than trusting a
prompt not to.

**Files:**
- Create: `crates/buzz-relay/src/workspace_tab_gate.rs`
- Modify: `crates/buzz-relay/src/lib.rs`, `crates/buzz-relay/src/handlers/ingest.rs`

**Interfaces:**
- Consumes: `parse_tab_grant`, `WorkspaceTabHead` (Tasks 2 and 3).
- Produces: `fn grant_authorized(head: &WorkspaceTabHead, granter: &str) -> Result<(), String>`.

- [ ] **Step 1: Write the failing test**

Create `crates/buzz-relay/src/workspace_tab_gate.rs` with the test module only:

```rust
//! Who may change a workspace tab's driver.

#[cfg(test)]
mod tests {
    use super::*;

    fn head(owner: &str, driver: &str) -> WorkspaceTabHead {
        WorkspaceTabHead {
            tab_id: "tab-7".into(),
            channel_id: "chan-a".into(),
            tab_kind: "scratchpad".into(),
            title: "Notes".into(),
            owner: owner.into(),
            driver: driver.into(),
        }
    }

    #[test]
    fn the_current_driver_may_hand_the_tab_on() {
        let agent = "b".repeat(64);
        assert!(grant_authorized(&head(&"a".repeat(64), &agent), &agent).is_ok());
    }

    #[test]
    fn the_owner_may_hand_the_tab_on_even_while_an_agent_drives() {
        let owner = "a".repeat(64);
        assert!(grant_authorized(&head(&owner, &"b".repeat(64)), &owner).is_ok());
    }

    #[test]
    fn a_bystander_agent_cannot_hand_on_someone_elses_tab() {
        let error = grant_authorized(&head(&"a".repeat(64), &"b".repeat(64)), &"c".repeat(64))
            .unwrap_err();
        assert!(
            error.contains("not the driver"),
            "unexpected refusal: {error}"
        );
    }

    #[test]
    fn the_refusal_never_leaks_the_other_pubkeys() {
        // A bystander learning who owns or drives a tab it cannot touch is a
        // disclosure. The message says no, not who.
        let owner = "a".repeat(64);
        let driver = "b".repeat(64);
        let error =
            grant_authorized(&head(&owner, &driver), &"c".repeat(64)).unwrap_err();
        assert!(!error.contains(&owner), "leaked the owner: {error}");
        assert!(!error.contains(&driver), "leaked the driver: {error}");
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Add `pub mod workspace_tab_gate;` to `crates/buzz-relay/src/lib.rs`, then run:
`cargo test -p buzz-relay workspace_tab_gate`

Expected: FAIL, `cannot find function grant_authorized`.

- [ ] **Step 3: Write the implementation**

Prepend to `workspace_tab_gate.rs`:

```rust
use buzz_core::workspace_tab::WorkspaceTabHead;

/// Whether `granter` may change this tab's driver.
///
/// Only the current driver or the tab's owner may. A refusal deliberately does
/// not name the owner or the driver: an agent that cannot touch a tab should
/// not learn who can.
pub fn grant_authorized(head: &WorkspaceTabHead, granter: &str) -> Result<(), String> {
    let granter = granter.to_ascii_lowercase();
    if granter == head.driver.to_ascii_lowercase()
        || granter == head.owner.to_ascii_lowercase()
    {
        return Ok(());
    }
    Err(format!(
        "restricted: you are not the driver or owner of tab {}",
        head.tab_id
    ))
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p buzz-relay workspace_tab_gate`

Expected: PASS (4 tests).

- [ ] **Step 5: Wire it into ingest**

Read `crates/buzz-relay/src/handlers/ingest.rs` and find where a kind-specific
check runs before an event is stored. `KIND_DISCOVERY_WORKSPACE_ACTION` appears
at lines 454, 677 and 741 and shows the shape. Add a branch for
`KIND_WORKSPACE_TAB_GRANT` that:

1. parses the event with `parse_tab_grant`, refusing with the parse error text
   on `Err`;
2. loads the current head for `(channel_id, tab_id)` from the store;
3. calls `grant_authorized(&head, &grant.granter)` and refuses with that error
   text on `Err`.

If no head exists for that tab, refuse with
`"restricted: unknown tab {tab_id}"`. A grant for a tab the relay has never seen
is either a race or a probe, and neither should be stored.

Follow the existing refusal mechanism in that file exactly. Do not invent a new
error channel, and report which one you used.

- [ ] **Step 6: Verify the wiring with an integration test**

Run: `just test`

This needs Postgres and Redis. Expected: PASS, no regressions.

- [ ] **Step 7: Commit**

```bash
git add crates/buzz-relay/src/workspace_tab_gate.rs crates/buzz-relay/src/lib.rs \
        crates/buzz-relay/src/handlers/ingest.rs
git commit -s -m "feat(workspace): refuse tab grants from non-drivers at ingest"
```

---

## Task 5: `buzz workspace tabs` CLI

The agent-facing surface. Per AGENTS.md, agent-facing features belong in
`buzz-cli` first: add the subcommand here, then wire the call in `client.rs`.

**Files:**
- Create: `crates/buzz-cli/src/commands/workspace.rs`
- Modify: `crates/buzz-cli/src/commands/mod.rs`, `crates/buzz-cli/src/main.rs`

**Interfaces:**
- Consumes: everything from Tasks 1 to 3.
- Produces: `buzz workspace tabs list --channel <id>`,
  `buzz workspace tabs grant --channel <id> --tab <id> --to <pubkey>`,
  `buzz workspace tabs take --channel <id> --tab <id>`,
  `buzz workspace tabs release --channel <id> --tab <id>`.

- [ ] **Step 1: Read the pattern first**

Read `crates/buzz-cli/src/commands/grants.rs`. It is the closest existing
command: it builds a signed event, submits it, and maps relay refusals to exit
codes. Copy its shape, including how it reports a write conflict. Note the exit
code contract from AGENTS.md: 0 ok, 1 input error, 2 network/relay, 3 auth,
4 other, 5 write conflict.

- [ ] **Step 2: Write the failing test**

Add to `crates/buzz-cli/src/commands/workspace.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn granting_to_yourself_is_refused_before_any_network_call() {
        // The relay refuses this too, but a CLI that needs the network to
        // discover an obvious input error wastes a round trip and is untestable
        // offline. Same guard grants.rs applies to hard-list categories.
        let me = "a".repeat(64);
        let error = validate_grant_input(&me, &me).unwrap_err();
        assert!(
            matches!(error, CliError::Input(_)),
            "expected an input error, got {error:?}"
        );
    }

    #[tokio::test]
    async fn granting_to_a_malformed_pubkey_is_refused_before_any_network_call() {
        let error = validate_grant_input(&"a".repeat(64), "nope").unwrap_err();
        assert!(matches!(error, CliError::Input(_)));
    }

    #[tokio::test]
    async fn granting_to_a_different_valid_pubkey_is_accepted() {
        assert!(validate_grant_input(&"a".repeat(64), &"b".repeat(64)).is_ok());
    }
}
```

- [ ] **Step 3: Run the test to verify it fails**

Add `pub mod workspace;` to `crates/buzz-cli/src/commands/mod.rs`, then run:
`cargo test -p buzz-cli workspace`

Expected: FAIL, `cannot find function validate_grant_input`.

- [ ] **Step 4: Write the implementation**

```rust
use crate::error::CliError;

/// Reject a grant the relay would reject anyway, without a round trip.
pub fn validate_grant_input(granter: &str, grantee: &str) -> Result<(), CliError> {
    let valid = grantee.len() == 64 && grantee.chars().all(|c| c.is_ascii_hexdigit());
    if !valid {
        return Err(CliError::Input(format!(
            "`--to` must be a 64-character hex pubkey, got `{grantee}`"
        )));
    }
    if granter.eq_ignore_ascii_case(grantee) {
        return Err(CliError::Input(
            "an agent cannot grant itself a tab; ask the owner".into(),
        ));
    }
    Ok(())
}
```

Then the four subcommands, each building and submitting its event:

- `list`: query `KIND_WORKSPACE_TAB_HEAD` filtered by `#h` = channel, print the
  sig-stripped JSON array of heads (reads return arrays, per AGENTS.md).
- `grant`: `validate_grant_input`, then publish `KIND_WORKSPACE_TAB_GRANT` with
  tags `tab`, `h`, `p`, then republish the head with `driver` set to the
  grantee. Print `{event_id, accepted, message}`.
- `take`: publish `KIND_WORKSPACE_TAB_TAKEOVER` with `reason` `human-takeover`
  and `driver` set to your own pubkey, then republish the head.
- `release`: same with `reason` `release` and `driver` set to the head's owner.

Match `CliError` to the exit codes from Step 1. Use the existing error type,
do not add a new one.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cargo test -p buzz-cli workspace`

Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add crates/buzz-cli/src/commands/workspace.rs \
        crates/buzz-cli/src/commands/mod.rs crates/buzz-cli/src/main.rs
git commit -s -m "feat(workspace): buzz workspace tabs list, grant, take, release"
```

---

## Task 6: End-to-end handover proof

Everything above can pass while the handover still does not work against a real
relay. This task proves it does.

**Files:**
- Create: `crates/buzz-test-client/tests/e2e_workspace_tabs.rs`

**Interfaces:**
- Consumes: every task above.
- Produces: nothing.

- [ ] **Step 1: Read an existing E2E test first**

Read `crates/buzz-test-client/tests/e2e_relay.rs` for the harness: how it starts
a relay, creates identities, publishes and queries. Copy that setup rather than
building your own.

- [ ] **Step 2: Write the failing test**

```rust
//! A tab changes hands, end to end, against a real relay.

#[tokio::test]
async fn a_tab_hands_over_from_human_to_agent_and_back() {
    let ctx = TestContext::new().await;
    let human = ctx.identity("human").await;
    let agent = ctx.identity("agent").await;
    let bystander = ctx.identity("bystander").await;
    let channel = ctx.channel(&human, "workspace-handover").await;
    ctx.join(&agent, &channel).await;
    ctx.join(&bystander, &channel).await;

    // The human opens a tab. Driver is the human.
    ctx.publish_tab_head(&human, &channel, "tab-1", "scratchpad", "Notes", &human, &human)
        .await;

    // A bystander agent cannot hand it on.
    let refused = ctx
        .try_publish_grant(&bystander, &channel, "tab-1", &agent)
        .await;
    assert!(
        refused.is_err(),
        "a bystander must not be able to grant someone else's tab"
    );

    // The human grants it to the agent.
    ctx.publish_grant(&human, &channel, "tab-1", &agent).await;
    ctx.publish_tab_head(&human, &channel, "tab-1", "scratchpad", "Notes", &human, &agent)
        .await;
    assert_eq!(ctx.current_driver(&channel, "tab-1").await, agent.pubkey_hex());

    // The agent cannot grant it back to itself.
    let self_grant = ctx.try_publish_grant(&agent, &channel, "tab-1", &agent).await;
    assert!(self_grant.is_err(), "self-grant must be refused");

    // The human takes it back.
    ctx.publish_takeover(&human, &channel, "tab-1", &human, "human-takeover")
        .await;
    ctx.publish_tab_head(&human, &channel, "tab-1", "scratchpad", "Notes", &human, &human)
        .await;
    assert_eq!(ctx.current_driver(&channel, "tab-1").await, human.pubkey_hex());

    // The whole handover is on the record, in order.
    let trail = ctx.ownership_trail(&channel, "tab-1").await;
    assert_eq!(trail.len(), 2, "one grant and one takeover: {trail:?}");
}

#[tokio::test]
async fn an_agent_reads_only_grants_addressed_to_it() {
    let ctx = TestContext::new().await;
    let human = ctx.identity("human").await;
    let agent_a = ctx.identity("agent-a").await;
    let agent_b = ctx.identity("agent-b").await;
    let channel = ctx.channel(&human, "grant-visibility").await;
    ctx.join(&agent_a, &channel).await;
    ctx.join(&agent_b, &channel).await;

    ctx.publish_tab_head(&human, &channel, "tab-1", "scratchpad", "A", &human, &human)
        .await;
    ctx.publish_grant(&human, &channel, "tab-1", &agent_a).await;

    // agent_b asking for grants addressed to agent_a is refused by the p-gate.
    let refused = ctx.try_query_grants_for(&agent_b, &agent_a).await;
    assert!(refused.is_err(), "p-gated kinds must refuse a cross-pubkey query");

    // agent_a sees its own.
    assert_eq!(ctx.query_grants_for(&agent_a, &agent_a).await.len(), 1);
}
```

Helper names above (`publish_tab_head`, `try_publish_grant`, `current_driver`,
`ownership_trail`, `try_query_grants_for`) are new. Add them to the test file
itself unless `TestContext` already has an equivalent; if it does, use the
existing one and say which.

- [ ] **Step 3: Run the test to verify it fails**

Run: `just test`

Expected: FAIL. Before the CLI and gate exist, the bystander grant is stored
instead of refused.

- [ ] **Step 4: Make it pass**

Fix whatever the test exposes. If it passes with no changes at all, the test is
not exercising the gate: check that the bystander really is a channel member and
really is neither owner nor driver, and say so in your report.

- [ ] **Step 5: Commit**

```bash
git add crates/buzz-test-client/tests/e2e_workspace_tabs.rs
git commit -s -m "test(workspace): end-to-end tab handover against a live relay"
```

---

## Task 7: Write the protocol down

**Files:**
- Create: `docs/nips/NIP-WS.md`
- Modify: `CLAUDE.md` is a symlink to `AGENTS.md`; **stage `AGENTS.md`**

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Write the NIP**

Read `docs/nips/NIP-IQ.md` first and match its structure. Document:

- the three kinds, their tags, and which are replaceable;
- the single-driver rule and who may change a driver;
- that grants are p-gated and what that means for an agent's queries;
- that payloads never cross the relay, and why (a file path or PTY handle is
  meaningless on another machine);
- the accepted B1 gap: tab heads are visible to every channel member.

- [ ] **Step 2: Add the CLI to the agent guide**

In `AGENTS.md`, next to the existing "Agent asks" paragraph, add a short
paragraph on tab ownership: an agent drives a tab only while it is the head's
`driver`, it obtains that by grant and never by self-grant, and
`buzz workspace tabs list` shows what it holds.

Stage `AGENTS.md`, not `CLAUDE.md`. `CLAUDE.md` is a symlink (mode 120000) and
staging it is a no-op that silently drops the change.

- [ ] **Step 3: Commit**

```bash
git add docs/nips/NIP-WS.md AGENTS.md
git commit -s -m "docs(workspace): NIP-WS tab ownership protocol"
```

---

## Task 8: Full gate and PR

- [ ] **Step 1: Run the whole local gate**

```bash
just ci
just test
```

`just test` needs Postgres and Redis. Both must pass.

- [ ] **Step 2: Open the PR and arm auto-merge**

```bash
gh pr create --repo AI-Native-Ventures/Colony --base develop \
  --title "feat(workspace): tab ownership protocol (phase B1)" --body-file <body>
gh pr merge <number> --repo AI-Native-Ventures/Colony --merge --auto
```

`--auto` is required; plain `gh pr merge` is refused on `develop` because the
merge queue owns the strategy. Every `gh` command needs `--repo`, since a bare
`gh` resolves to the upstream `block/buzz`.

CI runs on develop PRs here (`.github/workflows/ci.yml`, `pull_request:
branches: [main, develop, release]`), including the Rust and relay suites. A PR
showing "no checks reported" is conflicted, not ungated.

---

## Self-review

**Spec coverage.** One driver at a time: the head's `driver` field, Task 2.
Drivers are the human and one agent: Tasks 2 and 3. An agent sees and drives
tabs granted to it: p-gated grants, Task 1, proven in Task 6. Granting hands
control over and is recorded: Tasks 3 and 5, proven in Task 6. Agents cannot
touch tabs they were not granted: Task 4, proven in Task 6. Multiple agents
never drive the same tab: single `driver` field plus the ingest gate.

**Deliberately not covered, and listed in "Out of scope":** the desktop surface,
approvals, evidence, ledger, pausing a turn on human input, and payload sync.
The one spec requirement only partially met is agent-invisibility of tab heads,
documented under "Known gap, accepted for B1" rather than silently skipped.

**Type consistency.** `WorkspaceTabHead`'s six fields are identical in Tasks 2,
4 and 6. `WorkspaceTabError` gains `SelfGrant` and `UnknownReason` in Task 3 and
is used unchanged in Tasks 4 and 5. `parse_tab_grant` returns
`WorkspaceTabGrant` whose `granter` field is what Task 4's `grant_authorized`
takes as its second argument. The tag names (`d`, `h`, `tab-kind`, `title`,
`owner`, `driver`, `tab`, `p`, `reason`) are identical across Tasks 1, 2, 3, 5
and 6.
