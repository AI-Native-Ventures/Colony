# Community Power Completion Implementation Plan

**Goal:** Every new business reaches resumable Business and Power onboarding, with actionable subscription, Colony Credits and OpenRouter choices.

**Architecture:** Repair the existing transaction boundary and reuse current native provider, payments and isolation components. Keep provider evidence separate from rendering and from configuration persistence. Work is split between community lifecycle, native subscription integration, and the shared Power purchase/eligibility surface.

**Tech stack:** React, TypeScript, Rust, Electron/native host, Nostr relay; GitHub CI only.

## Community lifecycle — identity_names

- [ ] Change the App connecting gate and communityOnboarding transaction predicate so source=create-community cannot be skipped by an existing owner profile.
- [ ] Capture owner and transaction ID; fence restore, apply, finish and cancellation against those values. Preserve unfinished drafts when leaving, and avoid dropping finalization solely due to elapsed time.
- [ ] Pass the captured owner and isCurrentRun guard through AdditionalCommunityRun. Finalization must not recapture another owner or complete a replacement transaction.
- [ ] Add unit cases for both creation sources and owner/relay mismatch; add an E2E case starting from the real community creation entry, not a pre-seeded profile stage. Cover leaving/reopening and completion isolation.

## Subscription integration — power_runtime

- [ ] Audit native scanner, provider-supported account/usage interfaces, runtime catalog, and isolation launch guard; document the supported boundary.
- [ ] Implement supported account/usage refresh and isolated subscription launch through native capability facts, without copying shared user credentials into worker-visible storage.
- [ ] Add focused native fixture/fault checks for unavailable or expired authentication, missing quotas, depleted windows, and launch isolation. Wire provider plan and usage view models for the Power screen.

## Credits and OpenRouter — root

- [ ] Add a compact Credits purchase section in PowerScreen using the existing payment service and scoped durable checkout controller. Persist reference before browser handoff; guard all operations by captured owner/relay. Reopen/check a pending attempt instead of creating another charge. Display relay pack price/currency and refresh balance after confirmed payment.
- [ ] Wire FreeOpenRouterFields to a native quota result that distinguishes measured purchases, confirmed unpaid account, and unavailable purchase history. Correct the existing quota command's management-key rejection handling and permissive missing-field defaults. Never use remaining key allowance or any-paid flag as proof of the $10 threshold.
- [ ] Add provider-owned top-up and Check again actions, cancellation/error recovery, scope/key changes fencing, and explicit current rate-limit copy. Continue to reject paid model fallbacks in this lane.
- [ ] Add rendered regressions for all three choices, purchase pending/return/confirmed/error states, OpenRouter measured/unknown states, and model/credential preservation.

## Integration and acceptance — root

- [ ] Review independent edits against the accepted contract; update native inventory if command/capability surfaces change and agent contributor rules if persistence semantics change.
- [ ] Commit with sign-off and the user-approved local hook exception; open PR to develop and use GitHub CI. Correct failures from job evidence, not guesses.
- [ ] Review final-source screenshots and download the exact successful package. Prove the new-community path and feasible connected-provider actions on the actual package. Clearly record provider authorization or private-account proof gaps.
- [ ] Reconcile earlier requested capabilities in the scope audit. Keep production release agent independent; do not hold its current promotion for these unmerged changes.
