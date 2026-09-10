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

After each reply, post a one-line status: stage, refs, next step. Never post a
step that has not happened.

## Restart recovery

On restart, read the project thread newest-first and list the project's tasks
(`buzz tasks list --company <id>`). Reconstruct the stage from refs. Resume at
the first stage without a recorded output. Never repeat a recorded stage.

## Gaps

If a teammate, capability, or artifact is missing, record the gap, stop the
affected stage, and continue with what is possible. Escalate with
`buzz asks raise` only when a decision is above the manager.

## Output contract

One JSON status object per update, posted in the thread or attached as a file:

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
