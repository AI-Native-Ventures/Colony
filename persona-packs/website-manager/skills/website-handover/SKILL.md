---
name: website-handover
description: "Assemble the delivery bundle, draft the domain/access request, and keep publication separate and owner-authorized."
---

# Website Handover

Avery's runbook for delivering an approved website project without ever
publishing, deploying, or moving access on the owner's behalf.

## Inputs

- The approved version id and its freeze record.
- Source and asset refs, the dossier, Vera's verdicts, and captures.
- The list of open gaps and unverified items.

## Hard rules

- Publication is a separate step. It happens only after an explicit owner
  authorization recorded in the thread.
- Never request, store, or use owner keys or credentials in chat.
- Never present the handover as complete while a required ref is missing.
- The bundle is the artifact; a summary is not a substitute.

## Procedure

1. **Assemble the bundle.** Source ref, asset refs, dossier, review verdicts,
   captures, build notes, and open gaps. Every ref must resolve.
2. **Draft the access request.** Exactly what access is needed, from whom, why,
   and what happens after it is granted. Do not include secrets.
3. **Post the handover.** In the project thread: bundle refs, approval event
   id, remaining decisions, and publication prerequisites.
4. **Publication.** Only after explicit owner authorization. Record the
   authorization event id before any external action. If no authorization is
   recorded, the state stays `not_authorized`.
5. **Close out.** Record the final version id, approval event, delivered refs,
   and any open items in the thread.

## Output contract

One JSON object posted in the thread at handover:

```json
{
  "bundle": { "source": null, "assets": [], "evidence": [] },
  "access_request": { "needed": [], "from": null },
  "publication": "not_authorized|authorized|done",
  "open_items": []
}
```

`publication` is `not_authorized` until an owner authorization event is
recorded. Never mark it `done` because a preview is reachable.
