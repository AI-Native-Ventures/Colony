# Handover: Colony channel workspace (browser is tab kind one)

Date: 2026-08-07
For: the session working `codex/browser-engine-spike`
From: the session on `traycer/colony-sturdy-koala`

Read this before writing more code. The design the spike was built against
changed twice today, and the shell decision memo you already wrote now has a
requirement it was not sized for.

Nothing here invalidates `crates/buzz-browser`. The engine is sound and the
budget gate passes. What changed is the surface it plugs into.

---

## 1. Where things actually stand

**The spike is done.** Tasks 1 through 11 all have commits on
`codex/browser-engine-spike`:

| Proof | Result |
| --- | --- |
| Crate, contracts, host, CDP, snapshot, input, ledger, MCP | Committed, tests pass |
| Reference journey (Task 9) | **2 calls / 148 est. tokens**, against a cap of 25 calls / 40k |
| Naive DOM-dump baseline | 3 calls / 317 tokens (worse, as required) |
| README + shell decision memo (Task 11) | Committed at `7052aac26a` |
| **Live ACP agent gate (Task 10)** | **Not passed.** See below. |

`crates/buzz-browser` is 12 files, ~1,800 lines: `host`, `cdp`, `snapshot`,
`input`, `budget`, `journey`, `mcp`, `contracts`, `agent_proof`.

**Uncommitted in that worktree right now:**

```
crates/buzz-acp/src/acp.rs             +115
crates/buzz-browser/src/agent_proof.rs  +85
crates/buzz-browser/src/main.rs          +9
docs/superpowers/specs/2026-08-07-...-design.md   (spec sync, see §4)
```

Commit or stash the Rust changes before switching context. They look like a
continuation of the Task 10 proof.

### The one gate that did not pass

`docs/design/browser-engine-decision.md` says the live ACP agent gate failed
because "the available `goose` ACP session reports an internal error and
`codex-acp` / `claude-agent-acp` are not installed on this machine."

**Re-verify that before accepting it.** This repo has burned real time on
exactly this claim: an agent harness was declared missing while `opencode` and
`goose` were installed and eighteen agents had already done work. Check `which`,
`~/.local/bin`, `~/.bun/bin`, and
`~/Library/Application Support/xyz.block.buzz.app/global-agent-config.json`
before concluding anything is absent. If `goose` really does throw an internal
error, that is a finding worth a stack trace, not a shrug.

---

## 2. The decision that blocks everything downstream

Your memo recommends **moving Colony's desktop shell from Tauri to Electron**.

Its reasoning holds: live agent cursor and highlights on a real page are native
in Electron (`WebContentsView`), per-channel isolation is a first-class concept
(`persist:<channel-id>`), and the CDP path is identical either way. Tauri +
sidecar gives you a screencast stream instead of a real page.

Two things the memo did not have:

1. **The requirement it cites is stale.** It says the spec "requires a
   right-split pane inside a thread." That is no longer the design (see §3).
2. **The surface now hosts non-CDP tab kinds.** Whatever shell hosts a web tab
   also has to host a terminal (PTY) or file tab **in the same strip**. The memo
   compares shells on CDP cost only.

Both changes push the same direction. Codex is Electron plus a Rust backend, and
what Colony is now specifying is the Codex shape. But the migration cost is the
whole native surface: Colony's Tauri layer owns the relay client, media proxy,
keychain, agent runtime, mesh LLM, and worker hosts.

**This is Basheer's call, not the session's.** Do not start an Electron
migration. Update the memo with the two inputs above and put the revised
recommendation in front of him.

---

## 3. What changed in the design, and what it asks of you

Authoritative spec:
`docs/superpowers/specs/2026-08-07-colony-channel-browser-workspace-design.md`
on `traycer/colony-sturdy-koala`. Read its "Revision log" section first.

### Revision one: the browser is not a right split

The original draft said "conversation left, browser right, 50/50 draggable
divider." That slot is already occupied. `RightAuxiliaryPane.tsx` is a shared
right pane with four mutually-exclusive occupants (message thread, user profile,
agent session, channel management), arbitrated in `ChannelPane.tsx`, plus a
`FocusThreadDrawer` overlay mode. The draft never mentioned the thread panel, so
"open a thread, then click Browser" had no answer.

The workspace takes the **channel content column** instead, the column the
message timeline occupies. The right pane is untouched, so a thread stays open
and readable beside a live agent view. Agents never flip the surface; entering
workspace mode stays a human act.

### Revision two: tabs are typed, browser is one kind

The content column hosts a **tabbed workspace**. Each tab has a kind. Codex-style.

| Kind | v1 | Approval keyed on |
| --- | --- | --- |
| `web` | **Ships** | host + action class |
| `terminal` | Later | command + working directory |
| `file` | Later | path, write vs read |
| `scratchpad` | Later | none |

**v1 ships exactly one kind: `web`. Do not build a terminal.** The owner was
explicit: the surface should be ready for one, the terminal itself is not being
worked on.

Two structural rules:

- **One tab strip, one level of tabs.** A web tab *is* a workspace tab. Two
  pages are two workspace tabs. Do not give the browser its own nested strip.
- **Tab kind is fixed at creation.** A web tab never becomes a terminal tab.

### The four concrete asks

All in the shared desktop layer, none in the engine:

1. **Approvals take the permission key as a parameter.** Do not hardcode
   "host". The card, thread mirror, Allow once / Allow always / Block, and the
   per-channel scoping rule are shared. What the permission is remembered under
   is the kind's answer.
2. **Evidence accepts an output excerpt, not only a screenshot.** Same message
   path, either payload.
3. **The tab model is not the browser model.** Tab identity, title, order,
   creator, driver, and lifecycle live on the tab. URL and navigation history go
   under a kind-scoped payload the workspace layer never reads.
4. **Ownership is per tab, not per kind.** One driver at a time, grants,
   takeover, human-interaction pause. It must apply unchanged to a tab that is
   not a web page.

### How "ready for a terminal" gets proven

A **stub kind exercised in tests**. It can be registered, opened in the same
strip, owned and granted, raise an approval keyed on something other than a
host, and post evidence that is not a screenshot. No second engine, no shipped
UI. That is success criterion 9.

If the stub needs a change to the shared layer to work, the shared layer was
still browser-shaped. That is the whole point of the criterion.

---

## 4. Branch situation, read before committing

Two branches hold two halves of one design:

| Branch | Has |
| --- | --- |
| `codex/browser-engine-spike` | The spike plan, `crates/buzz-browser`, the shell memo |
| `traycer/colony-sturdy-koala` | The revised spec |

Neither is complete. The spike plan
(`docs/superpowers/plans/2026-08-07-colony-browser-engine-spike.md`) exists only
on the spike branch; it was added in `15342e2b19` alongside the spec, but only
the spec landed on the other branch (`679570f67`).

I synced the revised spec into the spike worktree as an **uncommitted** change.
Your copy was byte-identical to the original draft (blob `fb727da9`), so nothing
of yours was overwritten. Diff before committing:

```
git diff docs/superpowers/specs/2026-08-07-colony-channel-browser-workspace-design.md
```

This repo has a standing rule of one agent per branch, and there are now two
agents holding halves. Raise the merge rather than resolving it unilaterally.

Also corrected in the revised spec: it previously cited "Task 7 (shell decision
memo)". Task 7 is the budget ledger. The memo is **Task 11**.

---

## 5. Suggested next moves, in order

1. Commit or stash the three uncommitted `.rs` files.
2. Re-verify the ACP harness claim before accepting that Task 10 is blocked.
3. Update `docs/design/browser-engine-decision.md`: fix the stale "right-split
   pane" requirement, and add the cost of hosting a non-CDP tab kind in the same
   strip to both shell options.
4. Put the revised memo in front of Basheer. Do not start a shell migration.
5. Only after the shell decision: plan the desktop integration phase against the
   revised spec.

---

## 6. Gotchas worth knowing before you touch desktop code

- Colony desktop is **Tauri 2 + React 19**, and the desktop crate is excluded
  from the root cargo workspace. `cargo test` at the repo root does not run it.
- `just desktop-tauri-fmt` fails inside git worktrees and blocks commits. Run it
  from the main checkout.
- Any new module-level cache, Map, or class instance holding community-scoped
  data must be reset in `resetCommunityState()`
  (`desktop/src/features/communities/useCommunityInit.ts`). Workspace sessions
  and surface mode both qualify.
- Commit with `git commit -s`. The DCO check fails any PR with a commit missing
  `Signed-off-by`.
- Day-to-day PRs target `develop`, not `main`. PRs into develop run no CI, so
  `just ci` locally is the only gate.
