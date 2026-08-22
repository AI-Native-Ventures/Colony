# Phase 2a: reporting lines and rank changes (relay + core + CLI)

Spec: `docs/superpowers/specs/2026-08-21-agent-org-and-visibility-design.html` section 3.

Scope of this plan: **backend only**. No desktop files. The People and Roles UI
is phase 2b and depends on this landing first.

## Read this before you design anything

`KIND_MANAGED_AGENT` (30177) is **client-writable**. Any agent can publish a head
about itself. The relay does not refuse those writes; trust comes from the READ
side, where `agent_tier` walks candidate heads and skips every one whose author is
not a current community owner (`crates/buzz-relay/src/interrupt_gate.rs:180-191`).
The doc comment at `crates/buzz-relay/src/interrupt_runtime.rs:1635` spells out the
same rule for persona claims.

This splits the work in two, and getting it backwards is the main way this task
fails:

- **Managed agents (30177): manager is validated at READ time.** You cannot reject
  a worker's self-published `manager` tag at ingest, because the write itself is
  legitimate. It must be ignored on read, exactly like a self-claimed `tier`.
- **Employees (30190): manager is validated at WRITE time.** The head is signed by
  a relay-held key and only ever published by `employee_broker`, so the broker
  validates before it signs.

## Task 1: the `manager` tag

Manager is a **tag**, not a content field, on both kinds. Tags are indexed and the
delete-protection rule in Task 5 has to query for an agent's reports. A content
mirror on 30177 is acceptable for client convenience but the tag is authoritative.

- Value: 64 lowercase hex characters, the manager's pubkey.
- Absent means no manager. Executives must never carry one.
- Parse it in `crates/buzz-core/src/employee.rs` beside the existing `rank`
  parsing, reusing `single_tag` and the `hex64` helper already there.

## Task 2: `manager_of` resolution, read side

Add to `crates/buzz-relay/src/interrupt_gate.rs`, next to `agent_tier` and
following its structure exactly:

```rust
pub async fn agent_manager(
    tenant: &TenantContext,
    state: &AppState,
    pubkey: &PublicKey,
) -> Result<Option<PublicKey>, String>
```

Rules, in order:

1. Employee row first, same precedence `agent_tier` uses. Read the new column from
   Task 4.
2. Otherwise the latest **owner-authored** 30177 head, using the same
   owner-authorship walk `agent_tier` performs. A head authored by anyone else is
   skipped, not trusted.
3. Resolve the claimed manager's tier via `agent_tier`. Return `None` unless it
   equals `subject_tier.escalation_target()` and the subject is not an executive.
   An invalid edge resolves to no manager; it never resolves to a different agent.
4. Fail closed on every DB error, exactly as `agent_tier` does. A lookup failure
   must never invent a reporting line.

Do not add cycle detection. The tier ladder is a strict total order and every edge
climbs exactly one rung, so a cycle is unrepresentable. A cycle check here would
mask a broken tier rule rather than surface it.

## Task 3: kind 9046, employee update

Register `KIND_EMPLOYEE_UPDATE` in `crates/buzz-core/src/kind.rs` (9046 is
provisional; confirm it is unused and take the next free value in that range if
not). Add it to the same kind lists 9045 appears in.

Owner-signed request carrying: the employee pubkey, and at least one of a new
`rank` or a new `manager`. Parsed in `crates/buzz-core/src/employee.rs` beside
`ParsedHireRequest`, with the same error type.

Handled in `crates/buzz-relay/src/employee_broker.rs`:

1. Refuse a signer who is not a current community owner, the same way
   `handle_hire_request` does.
2. Refuse an unknown or retired employee pubkey.
3. Validate the new manager: exists in this community, tier is exactly one rung
   above the employee's NEW rank, not the employee itself, and absent when the new
   rank is executive.
4. Refuse a demotion that would leave any current report's edge invalid. The error
   names those reports.
5. **Update the `employees` row and republish the 30190 head in the same
   transaction.** `agent_tier` reads `employees.rank` before it looks at any event,
   so a promotion that only republishes the head is invisible to the interrupt
   gate.
6. Keypair, `role_id`, `hire_event` and `hired_by` are never touched. This is the
   entire reason the kind exists: re-running `hire` would mint a second identity
   for the same role and lose its memory and history.

## Task 4: migration 0061

`migrations/0043_employees.sql` defines the table. Add:

```sql
ALTER TABLE employees ADD COLUMN IF NOT EXISTS manager BYTEA;
ALTER TABLE employees ADD CONSTRAINT employees_manager_len
    CHECK (manager IS NULL OR LENGTH(manager) = 32);
```

Confirm 0061 is the next free number before writing it. Update the `employees`
row struct and every query in `crates/buzz-db` that selects from it.

## Task 5: lifecycle rules

- **Retiring an employee that has reports is refused**, and the error names them.
  Reports are found by querying 30190 and owner-authored 30177 heads carrying a
  `manager` tag equal to that pubkey. Silent reparenting would move authority
  without the owner deciding it.
- **Open asks keep their original audience across a rank change.** Do not
  re-target live asks. Verify the ask path reads its audience from the ask event,
  not by re-resolving the filer's tier at answer time; if it re-resolves, say so in
  your report rather than changing it here.

## Task 6: ask routing default

`buzz asks raise` currently requires `--to`
(`crates/buzz-cli/src/commands/asks.rs`). Make it optional: when omitted, resolve
the filer's manager via the relay and address the ask there. An explicit `--to`
still wins and is still validated by the existing one-rung-up rule. When there is
no manager, the error tells the filer to pass `--to` and says why.

## Task 7: CLI surface

`crates/buzz-cli/src/commands/employees.rs`:

- `buzz employees hire` gains `--manager`.
- `buzz employees promote --pubkey --rank [--manager]` and
  `buzz employees reassign --pubkey --manager` publish kind 9046.
- `buzz employees list` includes rank and manager in both output formats.

Follow the existing conventions: writes return `{event_id, accepted, message}`,
exit codes 0/1/2/3/4/5 as documented in CLAUDE.md.

## Task 8: tests

Rust, following `crates/buzz-relay/tests/interrupt_gate.rs`:

1. A manager one rung up resolves. Two rungs up does not. Same rung does not.
2. A self-published 30177 head naming a manager is ignored; an owner-authored one
   is honoured. **This is the security test. Write it first and watch it fail.**
3. A regression test pinning that a self-published `tier` is ignored. This is
   already correct behaviour; the test stops a later change from breaking it.
4. An executive carrying a manager resolves to no manager.
5. A manager in another community does not resolve.
6. Kind 9046 from a non-owner is refused; from an owner it updates the row AND the
   head, keeping pubkey, role and hire event identical.
7. A promotion is immediately visible to `agent_tier` (this is the test that
   catches a head-only update).
8. Retiring an employee with reports is refused and the error names them.
9. A demotion that would invalidate a report's edge is refused.

Prove each fails before the fix. A test that passes against unmodified code is
testing nothing.

## Gates

```
. ./bin/activate-hermit
cargo test -p buzz-core employee
cargo test -p buzz-relay interrupt_gate
cargo clippy -p buzz-core -p buzz-relay -p buzz-cli
cargo fmt
```

**Do NOT run `just ci`.** It saturates the owner's machine for about ten minutes
and he is working on it. The full matrix runs on GitHub when the orchestrator
pushes.

`just test` (integration, needs Postgres and Redis) IS required here because this
changes the DB schema, but run only the suites covering employees and the
interrupt gate, not the whole thing.

## Definition of done

- Every test above passes, with the earlier failing output saved.
- `just ci` and `just test` both pass.
- No files under `desktop/` are touched. That is phase 2b.
- Every commit uses `git commit -s`.
- Do NOT open a PR and do NOT merge. Commit to the current branch and report back.

## Report back with

1. The failing output from before each fix, at least for tests 2, 6 and 7.
2. Final `just ci` and `just test` results.
3. The kind number you actually used for the employee update, and why.
4. Whether the ask answer path re-resolves the filer's tier, per Task 5.
