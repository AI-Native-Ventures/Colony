---
name: website-owner-review
description: "One review request per version, exact-version and manifest-bound approval, and feedback mapped to the protocol's requestChanges decision."
---

# Website Owner Review

Avery's runbook for presenting a version to the owner and turning feedback into
work without duplicates or ambiguity.

## Inputs

- The review packet: version id, revision number, preview manifest hash, before
  and redesign captures (desktop and mobile), Vera's QA record for that exact
  revision and manifest, known limitations.
- The project thread, and the canonical review record once it exists.

## Hard rules

- One review request per version id. Never re-ask on an unchanged version.
- Silence is not approval. Only an explicit owner decision counts.
- Approval binds to the exact version id and its manifest hash. A new version
  needs a new approval.
- The protocol's owner decisions are `approve` and `requestChanges` (see
  `docs/website-manager-protocol.md`). There is no `reject` decision: feedback
  that rejects the direction or the build maps to `requestChanges` with a note.
  Cancelling the project outright is an explicit cancellation capability that
  does not exist yet; record the request and escalate, and do not invent a
  command for it.
- One owner feedback event should yield one revision version. The mention path
  is best-effort and not atomic under a race or restart. Use the canonical
  record and the durable `buzz website request-changes` action for the state
  transition; when handing work to Jules by mention, include the feedback event
  id and exact version and treat the pre-record check as best-effort.
- Never call owner-side job lease commands from an agent identity.

## Procedure

1. **Verify the packet.** The packet must carry the version id, its preview
   manifest hash, the revision number, Vera's QA record for that exact revision
   and manifest, and before/after captures. If any required evidence is
   missing, stop and ask the responsible teammate for it. Do not present an
   incomplete packet.
2. **Post the request.** In the project thread: what changed, why, the
   before/after evidence refs, Vera's verdict, the decision needed (approve or
   request changes), and your recommended default.
3. **On feedback.** Re-read the thread for a revision handoff already bound to
   that feedback event id, and read the canonical record once one exists. If a
   handoff is recorded, stop; do not duplicate it. Otherwise mention Jules with
   the feedback event id, the exact version it applies to, and the change list.
   Say plainly that the pre-record check is best-effort.
4. **On approval.** Record the approval event id against the version id and
   its manifest hash in the thread. That version is now frozen.
5. **On feedback that rejects the direction.** Still a `requestChanges`
   decision: record the feedback and hand off a new direction or a new version.
   Do not reuse the rejected or approved version id, and do not describe this
   as a protocol `reject`.

## Output contract

One bounded object posted in the thread per review request:

```json
{
  "version": "<version id>",
  "revision": 1,
  "manifestSha256": "<64 lowercase hex>",
  "decision": "awaiting|approved|changes_requested",
  "feedback_event": null,
  "revision_version": null
}
```

Keep the decision truthful: `awaiting` until an explicit owner answer lands.
Record the canonical decision through the review record; the object above is
the thread summary, not a parallel protocol.
