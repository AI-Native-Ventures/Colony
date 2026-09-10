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
- Every design choice cites the dossier finding it answers.
- Never fake a preview, capture, or functional result.
- Never publish or deploy.

## Procedure

1. **Read the evidence.** Dossier first, gaps second. Confirm scope with Avery
   if a gap changes what can be built.
2. **Decide the direction.** Write a decision statement: preserve list,
   reimagine list, rationale, each tied to a dossier finding. Keep identity the
   evidence supports; reimagine what the evidence shows is weak.
3. **Open the version.** Record the version id before building. All source,
   asset, and preview refs belong to this id.
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

One JSON version manifest, stored as an artifact and referenced in the thread:

```json
{
  "version": "<version id>",
  "direction": { "preserve": [], "reimagine": [], "rationale": [] },
  "source_ref": "<ref>",
  "preview_ref": null,
  "assets": [],
  "self_check": { "rendered": [], "functional": [], "responsive": [] },
  "known_limitations": []
}
```

`preview_ref` stays `null` until a real preview exists. Never fill it in.
