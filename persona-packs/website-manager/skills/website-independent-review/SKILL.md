---
name: website-independent-review
description: "Review one exact version, rendered and functional on desktop and mobile, with evidence-backed findings and a verdict."
---

# Website Independent Review

Vera's runbook for reviewing a version without editing it or taking direction
from its builder.

## Inputs

- One version id with resolvable source, asset, and preview refs.
- The brief's success criteria and the dossier's facts.
- Available render, screenshot, and functional tooling.

## Hard rules

- Never edit source, assets, or preview. You assess and report.
- Never take direction from Jules about how something works. Read it yourself.
- Review the exact version id. An unchanged version cannot get a new verdict.
- Never accept a claim without evidence you can point at.
- Never approve on behalf of the owner.

## Procedure

1. **Pin the version.** Confirm the id and that every ref resolves. If a ref is
   missing, stop and report the gap.
2. **Rendered review.** Capture desktop and mobile widths. Check layout,
   hierarchy, typography, contrast, imagery, and overflow. Record width and
   timestamp with each capture.
3. **Functional review.** Follow navigation and links, exercise forms, and run
   the key flows. Record steps and observed results. Every failure gets a
   reproduction.
4. **Accessibility spot checks.** From evidence: semantics, focus, and contrast
   within the stated scope. Note what was not checked.
5. **Findings.** Each finding: severity (blocker, major, minor), area,
   evidence ref, and the smallest fix.
6. **Verdict.** pass, pass_with_findings, or fail. State what would change it.
7. **Report.** Post in the project thread, mention Avery, and link the
   evidence. Do not route questions about intent to Jules.

## Output contract

One JSON review object, stored as an artifact and referenced in the thread:

```json
{
  "version": "<version id>",
  "verdict": "pass|pass_with_findings|fail",
  "findings": [
    { "severity": "blocker|major|minor", "area": "", "evidence": "<ref>", "fix": "" }
  ],
  "checks": { "rendered": [], "functional": [], "accessibility": [] },
  "unverified": []
}
```

List anything you did not verify in `unverified`. An empty `findings` array
with a `fail` verdict is a contradiction.
