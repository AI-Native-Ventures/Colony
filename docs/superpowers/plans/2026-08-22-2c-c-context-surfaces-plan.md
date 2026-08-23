# 2c-C: show reporting lines and ask routing where people already look

Scope: gaps 6 and 7 from the phase 2b review.

**Your files:** the profile panel, member sidebar, DM header, and the asks
feature. Do NOT touch `PeopleSection`, `OrgNodeCard`, `EmployeeRoleDialog`,
`orgMembers.ts`, navigation or the sidebar shell. Other agents are inside those
right now.

## Task 6: reporting lines everywhere rank already appears

`AgentRankBadge` already renders in the member sidebar, the profile panel and the
DM header (see the consumers of `employeeHeads.ts`). The **manager** appears
nowhere.

So the owner can see that an agent is a Worker and never learn whose Worker it is.
Half an answer, in three places.

Deliver: the reporting line alongside the rank on those same surfaces, reading
naturally, for example "Worker, reports to Rivet", with the manager's name
linking to that agent.

Read the manager the way the relay does: employee heads first, then **only**
owner-authored kind 30177 heads. Kind 30177 is client-writable, so a
self-published head must be ignored exactly as `agent_tier` ignores a self-claimed
rank. `managedAgentHeads.ts` already does this; reuse it rather than re-reading
events yourself.

An agent with no manager should say so plainly, not render a blank.

## Task 7: show ask routing

Phase 2a made `buzz asks raise` default to the filer's manager, so escalation stops
being a lottery. The asks UI shows none of this, so the improvement is invisible
to the owner.

Deliver, in `AskDetailCard` and wherever asks are summarized:

- Who the ask is addressed to.
- Whether that was the filer's manager (auto-routed) or an explicit choice.
- Where an ask was promoted up the ladder by the relay, that it moved, and from
  whom. The relay leaves the original row with `status = 'promoted'` and its
  `audience_pubkey` names whoever let the deadline pass, so this is real data, not
  a guess.

Do not invent a countdown or a deadline display. Ask deadlines live only in the
relay's `asks` table today and exposing them is phase 4's job.

## Tests

- An agent with a manager shows the reporting line; one without says so.
- A self-authored head never contributes a manager.
- An auto-routed ask is distinguishable from an explicitly addressed one.

## Gates

```
. ./bin/activate-hermit
cd desktop && node --import ./test-loader.mjs --experimental-strip-types \
  --test src/features/<your test files>
just desktop-check
```

**Never `just ci`**, and **never `just desktop-lint`** (no such recipe).

Two repo rules that already broke this work once:
- No hand-rolled pubkey truncation; use `truncatePubkey` from `shared/lib/pubkey`.
- Regenerate `native-inventory.json` if you shift lines in a file it references.

## Done means

- Both tasks complete, tests proven failing first, `desktop-check` green.
- Screenshots: a profile showing a reporting line, and an ask showing its routing.
  Distinct hashes verified with `shasum -a 256`.
- `git commit -s` after each task, not all at the end.
- No PR, no merge.
