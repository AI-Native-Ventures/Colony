# Website Manager proof contract

The approved visual and product contract is [the design specification](2026-09-10-website-manager-design.md). Implementation is delegated to DeepSeek V4.1 Flash through OpenRouter at `max` reasoning. The orchestrator reviews and integrates the work. Automated checks, builds and tests run in GitHub CI, not on the owner's Mac.

## Proof stages

Keep implementation, automated checks, rendered acceptance, real agent work, merge, deployment and installed-app adoption separate. None of the cases below currently has a passing result recorded.

| Case | Required observation | Evidence to retain |
| --- | --- | --- |
| Brief | A supplied URL and ordinary-language request produce one job in the current community/channel/thread. The large inline block and adjacent thread follow the approved design. | Root event, job/task identity, screenshot at reference width |
| Work | The manager delegates factual research, a fused design/build and independent review. Stage changes correspond to recorded worker work. | Job filings, outcomes/checkpoints and thread replies |
| Review | Before and redesign use real captured/generated artifacts. Desktop/mobile switch and expansion work. The displayed version identifies saved source and preview artifacts. | Screenshot of each view, immutable artifact references and digests |
| Revision | Owner feedback starts actual delegated revision work once. The old version remains inspectable; a new revision returns to review. | Signed request, job outcome, both versions and rendered difference |
| Approval | The owner's decision identifies the exact reviewed revision. An old, duplicate or racing action cannot approve newer work. An agent cannot impersonate owner approval. | Accepted and rejected action/receipt cases |
| Handover | Approved source/assets, review record and a domain/access request draft are available in the same thread. No production publish or message to a third party occurs. | Handover artifact and action history |
| Recovery | Reload during work and after review recovers the same job, version and action state without another dispatch. Lease recovery does not duplicate a completed stage. | Before/after IDs, job history and restart evidence |
| Isolation | Switching communities does not carry preview state, approval authority, pending actions or artifacts into another community. | Two-community test with matching scope assertions |
| Preview failure | Missing/invalid artifacts, blocked embedding or interrupted loads display recoverable errors without fabricated content or successful-review claims. | Failure screenshot and diagnostic code |
| Visual parity | Brief, Working, Review, Revision and Handover match the approved spacing, typography, tinted panels, role identity and substantial inline preview. | Five distinct rendered states at matching widths |

## Reviewer rules

- A test fixture may render sample website content, but production code must never fall back to the concept's website, copy, stage status, reply counts or approval state.
- A mutable public URL alone does not establish the reviewed bytes. Preserve captured original material, versioned redesign artifacts and the source/content identity used for approval.
- Website content is untrusted input. A preview must not inherit Colony's authenticated browser session, privileged preload, filesystem access, popups or navigation authority.
- Reuse the existing task/job broker, signed Blocks actions and immutable manifests wherever they meet the contract. Do not introduce a separate workflow engine or generic agent-authored HTML renderer.
- Consume the shared Blocks work from PR #682 after it lands; coordinate any necessary extension at that boundary.
- Report a failed or unproven row explicitly. Do not replace the approved experience with a smaller implementation and mark the phase complete.

## Additional acceptance findings from source review

- Switching immutable revisions must never display the preceding capture under the new version label, including the first render before effects run.
- The native host must receive full element bounds and the independent visible clip rectangle. Clipping must not resize the website CSS viewport or paint over channel headers, composers, menus or dialogs.
- Both desktop and mobile previews must fit available width and height while retaining the real 1440x900 or390x844 CSS viewport. A portrait preview that remains partly hidden at every scroll position fails acceptance.
- The expanded preview must hide the inline native view and remain usable with app zoom and a small window. Faked view bounds are source-level test evidence only; actual Electron rendering is required.
- QA rows must come from the actual verified reviewer report. Reference presence, matching-shaped hashes, a boolean pass flag and a screenshot alone do not establish content, navigation, layout or functional checks.
- Team setup must install actual editable runtime skills, persist community-scoped identities and hierarchy, inherit existing Power defaults, preserve customizations, and recover partial installation without duplicate agents. A pack in the repository or local team card alone is not installation proof.

## Current checkpoint

DeepSeek V4.1 Flash via OpenRouter, reasoning max, is writing the implementation. Root is reviewing and orchestrating. Native artifact loader and pure review-contract source have been drafted and received source review; remaining corrections are included in subsequent worker tasks. UI source currently includes preview controls/surface and work-stage presentation, with remaining review/handover/starter components in progress. Backend persistence and actual Electron hosting are in progress.

No feature commit, PR, GitHub test result, rendered five-state acceptance, installed runtime adoption or real website-job proof has passed at this checkpoint. Shared Blocks PR682 remains a separate dependency; its source will be consumed after it lands. No local CI has been run.
