---
name: website-team-workflow
description: "Run the six-stage website method as one durable project with mention handoffs and evidence gates."
---

# Website Team Workflow

Avery's runbook for coordinating research, direction, build, review, owner
review, and handover without a second tracker.

## Inputs

- The owner's request and the project channel.
- The pack instructions (method, handoff path, operating rules).

## Hard rules

- One canonical project thread. Post the brief, every handoff, and every status
  line there.
- Every handoff names the work, links the brief and inputs, and mentions the
  teammate.
- A stage is complete only when its output ref is in the thread and the
  evidence gate passed.
- Post a status line only on a meaningful factual change: a stage transition, a
  new output ref, or a new blocker. Do not post after every teammate reply, and
  never re-post a review card for the same version.
- Never call owner-side job lease commands from an agent identity.
- Never publish or promise publication.

## Procedure

1. **Intake.** Restate the request as a brief: goal, audience, must-keep,
   constraints, success criteria, non-goals, open questions. Post it in the
   thread. Ask the owner only about scope-changing ambiguity.
2. **Research handoff.** Mention Ren with the brief. Expected output: cited
   dossier, desktop and mobile before captures, explicit gaps.
3. **Direction handoff.** When the dossier lands, mention Jules with the dossier
   ref. Expected output: one direction statement and one immutable version.
4. **Review handoff.** Mention Vera with the version id. Expected output:
   evidence-backed findings and a verdict.
5. **Owner review.** Run the owner-review skill. One request per version.
6. **Handover.** Run the handover skill. Publication stays separate.

After a meaningful stage change, post one status line: stage, refs, next step.
Never post a step that has not happened, and do not narrate routine replies.

## Deduplication and restart limits

The mention handoff is best-effort. Searching the thread cannot guarantee
exactly-once intent under concurrent workers or a restart: two actors can each
miss the other's handoff and duplicate work. Never describe the fallback as
providing restart-safe exactly-once.

When the canonical Website Manager record and its durable platform command are
wired (see `docs/website-manager-protocol.md`), recover from that record first
and dispatch against its derived decision identity; that identity is the
once-only key. Until then, re-read the thread immediately before re-issuing a
handoff, treat an existing handoff as final, and say the check is best-effort
when it matters.

## Restart recovery

On restart, recover before acting. When a canonical record exists for the job,
read it first: it owns the revision, QA, decision, and handover state. Then read
the project thread newest-first and list the project's tasks
(`buzz tasks list --company <id>`). Reconstruct the stage from the record and
the refs. Resume at the first stage without a recorded output. Never repeat a
recorded stage.

## Gaps

If a teammate, capability, or artifact is missing, record the gap, stop the
affected stage, and continue with what is possible. Escalate with
`buzz asks raise` only when a decision is above the manager.

## Output contract

One bounded status object per meaningful update, posted in the thread. This is a
thread status, not a second tracker: the canonical job state is the Website
Manager review record (`colony.website-review/v1` in
`docs/website-manager-protocol.md`) once the platform integration is wired.

```json
{
  "project": "<id or thread event>",
  "stage": "research|direction|build|review|owner_review|handover",
  "version": null,
  "refs": [],
  "open_gaps": [],
  "next": "<who does what>"
}
```

Keep every field truthful. Use `null` for a version that does not exist yet.
