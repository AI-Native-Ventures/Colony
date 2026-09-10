---
name: website-owner-review
description: "One review request per version, exact-version approval, and one bound revision handoff per feedback event."
---

# Website Owner Review

Avery's runbook for presenting a version to the owner and turning feedback into
work without duplicates or ambiguity.

## Inputs

- The review packet: version id, before and redesign captures (desktop and
  mobile), Vera's verdict, known limitations.
- The project thread.

## Hard rules

- One review request per version id. Never re-ask on an unchanged version.
- Silence is not approval. Only an explicit owner decision counts.
- Approval binds to the exact version id. A new version needs a new approval.
- One owner feedback event yields exactly one revision version.
- Never call owner-side job lease commands from an agent identity.

## Procedure

1. **Verify the packet.** If any required evidence is missing, stop and ask the
   responsible teammate for it. Do not present an incomplete packet.
2. **Post the request.** In the project thread: what changed, why, the
   before/after evidence refs, Vera's verdict, the decision needed
   (approve, revise, reject), and your recommended default.
3. **On feedback.** Search the thread for a revision handoff already bound to
   that feedback event id. If one exists, stop; do not duplicate it. Otherwise
   mention Jules with the feedback event id, the exact version it applies to,
   and the change list.
4. **On approval.** Record the approval event id against the version id in the
   thread. That version is now frozen.
5. **On rejection.** Record it as feedback for a new direction or version. Do
   not reuse the rejected or approved version id.

## Output contract

One JSON object posted in the thread per review request:

```json
{
  "version": "<version id>",
  "decision": "awaiting|approved|revision_requested|rejected",
  "feedback_event": null,
  "revision_version": null
}
```

Keep the decision truthful: `awaiting` until an explicit owner answer lands.
