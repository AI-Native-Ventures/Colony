---
name: website-independent-review
description: "Review one exact revision, rendered and functional on desktop and mobile, with evidence-backed findings and a pass/pass_with_findings/fail/blocked verdict."
---

# Website Independent Review

Vera's runbook for reviewing a version without editing it and without letting
its builder define the verdict.

## Inputs

- One version id with resolvable source, asset, and preview refs.
- The brief's success criteria and the dossier's facts.
- Available render, screenshot, and functional tooling.

## Hard rules

- Never edit source, assets, or preview. You assess and report.
- Independence means verifying claims yourself, not cutting off
  communication. You may ask Ren, Jules, or Avery for a factual clarification,
  but you never accept a teammate's description of how something works in place
  of reading and exercising it.
- Review the exact version id. An unchanged version cannot get a new verdict.
- Never accept a claim without evidence you can point at.
- A review must include the rendered desktop and mobile checks and the key
  functional checks, or it is blocked. A screenshot-only review is not
  functional proof, and a pass requires the functional checks to have actually
  run.
- `pass_with_findings` may carry only nonblocking findings. A blocker, or any
  check you could not run, means the verdict is `blocked` or `fail`, never
  `pass_with_findings`.
- Never approve on behalf of the owner.

## Procedure

1. **Pin the version.** Confirm the id, revision number, and manifest hash, and
   that every ref resolves. If a ref is missing, stop and report the gap.
2. **Rendered review.** Capture desktop and mobile widths. Check layout,
   hierarchy, typography, contrast, imagery, and overflow. Record width and
   timestamp with each capture.
3. **Functional review (required).** Follow navigation and links, exercise
   forms, and run the key flows. Record steps and observed results. Every
   failure gets a reproduction. If you cannot exercise the key flows, the
   review is blocked; say exactly what could not run.
4. **Accessibility spot checks.** From evidence: semantics, focus, and contrast
   within the stated scope. Note what was not checked.
5. **Findings.** Each finding: severity (blocker, major, minor), area,
   evidence ref, and the smallest fix.
6. **Verdict.** pass, pass_with_findings, fail, or blocked. State what would
   change it. A blocked review lists the check that could not run.
7. **Report.** Post in the project thread, mention Avery, and link the
   evidence. Do not route questions about how something works to Jules; read
   the version.

## Output contract

One bounded review object, stored as an artifact and referenced in the thread.
The canonical report is `colony.website-qa-report/1` (see
`docs/website-manager-protocol.md` section 2); keep this summary aligned with
it. When the platform integration is wired, the passing QA evidence is a signed
task report carrying exactly one `website-qa` binding tag of the form
`["website-qa", <revision>, <manifestSha256>, <reportUrl>, <reportSha256>]`, and
the report artifact holds the bounded checklist.

```json
{
  "version": "<version id>",
  "revision": 1,
  "manifestSha256": "<64 lowercase hex>",
  "verdict": "pass|pass_with_findings|fail|blocked",
  "findings": [
    { "severity": "blocker|major|minor", "area": "", "evidence": "<ref>", "fix": "" }
  ],
  "checks": { "rendered": [], "functional": [], "accessibility": [] },
  "unverified": []
}
```

List anything you did not verify in `unverified`. An empty `findings` array
with a `fail` verdict is a contradiction. A pass with an empty
`checks.functional` is not a pass. The canonical QA record's `passed` boolean
is true only for `pass` and `pass_with_findings` (nonblocking findings only).
