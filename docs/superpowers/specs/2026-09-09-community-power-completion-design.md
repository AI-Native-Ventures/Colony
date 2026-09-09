# Complete community onboarding and Power

The owner has already approved the three Power choices and the branded onboarding layout. This phase finishes that behavior rather than proposing another design. Keep the account step for a first identity; a returning owner creating a business gets Business and Power using that identity. Creating a community must not skip those steps because the owner already has a profile.

## Acceptance contract

1. Create a community from the community rail or picker. Business and Power appear. Returning, switching away, restarting, or retrying resumes only that owner and community's unfinished setup. Going back does not mark it complete. Completing one community does not complete another.
2. Subscriptions displays detected Claude and Codex accounts, plan names, measured usage windows and reset times when available. Missing or stale measurements are explicitly labelled. A selectable supported subscription must actually launch an isolated teammate; finding a CLI or a cookie is not sufficient proof.
3. Colony Credits displays available balance and live credit packs, opens the existing checkout, keeps its reference across interruptions, and verifies payment without duplicate purchases. Returning from the browser alone is not payment confirmation. No purchase or work starts on mount.
4. OpenRouter connects through the existing PKCE flow, offers only free models, checks eligibility from authoritative account evidence, provides OpenRouter's credit-purchase link, and rechecks after return. Lifetime purchases of at least $10 currently unlock 1,000 requests/day; remaining balance does not determine that threshold. The 20/minute cap still applies. Unknown eligibility must never become a false low-tier or upgrade-required claim.
5. Existing provider/model/payment choices survive unless the owner changes them. Provider metadata and launch capability facts remain native-catalog owned. No extra technical fields in the primary user flow.

## Architecture

Repair the existing community transaction and app gate, including captured owner and transaction ID fencing. Reuse the new founder layout and existing Business/Power screens. Use the current native subscription scanner and provider integrations as the authority for subscription facts, with isolated launch adapters where missing. Use the existing payment service and scoped checkout controller; do not introduce a second payment API. Add an explicit OpenRouter measurement state rather than inferring a historical $10 purchase from a normal API key's paid/free flag.

## External provider boundary

Verified September 9, 2026: OpenRouter's GET /api/v1/credits is documented as management-key-only. GET /api/v1/key exposes whether any credits have been purchased, not an exact $10 purchase total. PKCE produces a user-controlled inference key and documents no purchase-history scope. Implement honest partial evidence and a provider-owned verification path; do not store a broad management key as an inference credential or invent successful verification.

Sources: https://openrouter.ai/docs/api_reference/limits ; https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits ; https://openrouter.ai/docs/guides/overview/auth/oauth .

## Proof and delivery

Use GitHub CI for all tests and builds; no local CI, tests, builds or hooks. Cover real entry-point transitions, remount/restart and cross-owner/relay races, purchase pending/retry states, insufficient/unknown/eligible OpenRouter states, unavailable/exhausted subscription limits, and actual supported isolated launches. Render screenshots from the final source in GitHub and inspect the packaged app before claiming usability. Production promotion/release is assigned independently and must not mislabel the ad-hoc Electron beta as a production release.
