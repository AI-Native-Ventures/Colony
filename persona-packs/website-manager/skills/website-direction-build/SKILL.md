---
name: website-direction-build
description: "Choose one evidence-grounded direction and implement it as an immutable, self-checked version."
---

# Website Direction and Build

Jules's runbook for turning the dossier into one direction and one version of
built source, assets, and preview refs.

## Inputs

- Ren's dossier ref, captures, and gaps.
- The brief's scope and constraints.
- Available build, preview, and media tooling.

## Hard rules

- One direction per version. No grab bag of styles.
- Versions are immutable once handed to review. Feedback creates a new version.
- Business and content decisions are grounded in the dossier and cite the
  finding they answer. Aesthetic choices are your creative call: give a short
  rationale for each major choice rather than forcing an evidence citation.
- Preserve and elevate identity the evidence supports; meaningfully redesign
  identity the evidence shows is weak. Do not force every client into one look.
- Never fake a preview, capture, or functional result.
- Never publish or deploy.

## Procedure

1. **Read the evidence.** Dossier first, gaps second. Confirm scope with Avery
   if a gap changes what can be built.
2. **Decide the direction.** Write a decision statement: preserve list,
   reimagine list, and a short rationale for the major choices. Business and
   content claims cite the dossier finding they answer; aesthetic choices carry
   a rationale, not a forced citation. Keep identity the evidence supports;
   reimagine what the evidence shows is weak.
3. **Open the version.** Record the version id and revision number before
   building. All source, asset, and preview refs belong to this id.
4. **Build.** Implement responsive, accessible pages: semantic structure,
   readable contrast, keyboard reachability, and sensible loading. Keep assets
   with the version; no hotlinks to mutable third-party files.
5. **Self-check.** Render the pages, follow every link, exercise every form,
   and check desktop and mobile widths. Record what you actually did.
6. **Hand off.** Mention Vera and Avery in the project thread with the version
   id, source and preview refs, self-check results, and known limitations.
7. **On feedback.** Open a new version id and change only the bound feedback
   items. Never touch the reviewed version.

## Gaps

If preview hosting, screenshots, or artifact storage are not wired, record the
concrete gap in the handoff. A description of a preview is not a preview.

## Output contract

One bounded version object, stored as an artifact and referenced in the thread.
The canonical fields are the revision record in
`docs/website-manager-protocol.md`; keep this object aligned with them rather
than inventing a parallel shape.

```json
{
  "version": "<version id>",
  "revision": 1,
  "direction": { "preserve": [], "reimagine": [], "rationale": [] },
  "sourceUrl": "<public https source reference>",
  "sourceArchive": null,
  "preview": null,
  "assets": [],
  "self_check": { "rendered": [], "functional": [], "responsive": [] },
  "known_limitations": []
}
```

Field names follow the revision record in `docs/website-manager-protocol.md`:
`preview` is the artifact ref `{url, sha256}` whose hash is the SHA-256 of the
published manifest bytes. `preview` is null only until a verified immutable
artifact for this exact version exists. Never fabricate it: populate it with
the verified ref as soon as it is produced. `sourceUrl` and every asset ref
must resolve; do not report a built version with a null source.
