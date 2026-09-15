# Website Manager: from preview foundation to the approved experience

## Acceptance gate

An existing worker can attach a complete saved website (HTML, local images, CSS and script assets) to the current conversation. The owner can view desktop/mobile layouts, request changes in the same thread, reopen either saved revision, and approve an exact version for handover without publishing it. The UI must retain the approved channel/side-thread arrangement and preview space. The tiny `preview_html` renderer is not this deliverable.

## Evidence already established

- Static preview, two revisions and reopen: GitHub 34885141052.
- Actual source upload and signed CLI/relay persistence, browser reload: 34874123766. Deterministic agent identity, no model; native bridge mocked.
- Electron packaging and general startup/signup/isolation checks: 34885136083. Does not test preview in the package.
- Existing agents now receive website-review instructions via nest skill version 6. Live adoption and model use remain unproven.

## Next implementation sequence

1. Define an optional immutable website bundle reference on the existing artifact contract. Keep large source/assets outside event bodies; pin the manifest and each local asset by digest. Preserve older artifact compatibility. Do not use unverified mutable URLs as version identities.
2. Selectively reuse the isolated preview host from the closed recovery worktree after reviewing its trust boundary. Avoid importing its website job broker or team installer. A preview gets no Colony bridge, account cookies or permission grants. Resolve only assets declared in its verified bundle; block external navigation and network by default. Fail visibly on missing or mismatched assets rather than showing a successful empty preview.
3. Connect that host to the existing artifact row and side thread, keeping the small static renderer as a compatibility fallback. Supply complete desktop/mobile previews and expansion. Do not globally weaken the app's CSP.
4. Present the approved review controls using existing signed actions and ordinary thread feedback. Approval binds to an artifact version and means design approval only. Request changes routes to the existing worker through the current leader; never create a replacement Chief of Staff.
5. Prepare handover from the approved immutable version with real source/assets and explicit limitations. No publication, DNS or outreach side effects.

## Proof strategy

Use a tiny two-page bundle with one image, stylesheet and local script to verify preview transport and isolation. Assert revision identity, missing-asset failure, denied external requests, no privileged bridge and no shared account session. Run these deterministic checks on GitHub. Then exercise that preview in the packaged Electron app. A real business website redesign remains a separate hours-long pilot and is never a recurring paid CI requirement.

Do not report this phase complete based on a skill paragraph, mockup, fixture screenshot, or successful general app startup. Those are separate proof stages. PR 812 remains the draft foundation; do not enable auto-merge while review is incomplete.
