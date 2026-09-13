---
name: website-handover
description: "Jules assembles the delivery bundle and access-request draft for an approved version; Avery verifies, records, and presents it; publication stays separate and owner-authorized."
---

# Website Handover

Jules's runbook for assembling the delivery bundle for an approved version and
drafting the domain/access request. Avery verifies the bundle against this
contract, records it as the pinned coordinator, and presents it to the owner.
Nothing here publishes, deploys, or moves access.

## Inputs

- The approved version id, its revision number, and its manifest hash, with the
  approval bound to exactly that revision and hash.
- The source archive and asset refs, the dossier, Vera's QA record, and
  captures.
- The list of open gaps and unverified items.

## Hard rules

- Publication is a separate step. It happens only after an explicit owner
  authorization recorded in the thread.
- Never request, store, or use owner keys or credentials in chat.
- Never present the handover as complete while a required ref is missing. No
  handover with a null source archive, a missing preview manifest hash, or a
  missing QA record for the approved revision.
- Every artifact ref is the protocol pair `{url, sha256}`; the hash covers the
  exact bytes behind the URL.
- The bundle is the artifact; a summary is not a substitute.
- Do not invent a publish or cutover command. The canonical handover contract is
  in `docs/website-manager-protocol.md` (there is deliberately no publish,
  deploy, or cutover field). Jules prepares `handover.json` and sends it to
  Avery. Only Avery, acting as the pinned coordinator, or the pinned owner may
  record it with `buzz website handover --channel <uuid> --task <id> --thread
  <hex> --file <handover.json>` after checking the exact approved revision and
  manifest.

## Procedure

1. **Confirm the approval.** The approved revision and manifest hash must match
   the version being handed over. If they do not, stop and ask Avery.
2. **Assemble the bundle.** Source archive ref, asset refs, dossier, Vera's QA
   record for the approved revision and manifest, before/after captures, build
   notes, and open gaps. Every ref must resolve and every hash must be the hash
   of the exact bytes.
3. **Draft the access request.** Exactly what access is needed, from whom, why,
   and what happens after it is granted. Do not include secrets.
4. **Submit for verification.** Mention Avery with the bundle refs, the
   approved revision and manifest hash, the QA record, the access-request
   draft, and the remaining decisions. Avery verifies and records the handover
   as the pinned coordinator, then presents it; do not run the recording command
   or present it as delivered yourself.
5. **Publication.** Only after explicit owner authorization. Record the
   authorization event id before any external action, and let the owner-side
   path perform it. If no authorization is recorded, the state stays
   `not_authorized`.
6. **Close out.** Record the final version id, revision, manifest hash,
   approval event, delivered refs, and any open items in the thread.

## Output contract

One bounded handover object, stored as an artifact and referenced in the
thread. Field names mirror the handover record in
`docs/website-manager-protocol.md`; do not invent a parallel protocol.

```json
{
  "approvedRevision": 1,
  "approvedManifestSha256": "<64 lowercase hex>",
  "sourceUrl": "<public https source reference>",
  "sourceArchive": { "url": "<https url>", "sha256": "<64 lowercase hex>" },
  "assets": [{ "path": "", "url": "<https url>", "sha256": "<64 lowercase hex>" }],
  "qaReport": { "url": "<https url>", "sha256": "<64 lowercase hex>" },
  "evidence": [],
  "accessRequest": { "needed": [], "from": null },
  "publication": "not_authorized|authorized|done",
  "openItems": []
}
```

Field names follow the handover record in `docs/website-manager-protocol.md`
(`approvedRevision`, `approvedManifestSha256`, `sourceUrl`, `sourceArchive`,
`assets`). `jobId`, `taskId`, and `acceptedBy` are set by the platform when the
handover is recorded; do not invent them in the thread draft. `qaReport` is the
artifact ref for the QA report attached to the approved revision.
`publication` is `not_authorized` until an owner authorization event is
recorded. Never mark it `done` because a preview is reachable.
