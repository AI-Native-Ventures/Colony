# Desktop request audit

This audit separates source coverage from release and live-account evidence.
It covers the concrete desktop requests, not the earlier business-agent roadmap.

## Implemented in the reviewed source

- PR #666: creating a community starts that community's Business and Power
  onboarding, with resume state scoped to the owner and community.
- The Power step offers subscriptions, Colony Credits and free OpenRouter models.
  It includes subscription detection, connection, model selection and available
  usage evidence; a Credits checkout and balance recheck; and OpenRouter
  connection, allowance evidence, top-up and recheck.
- Browser import has select-all and distinguishes newly copied sessions from
  preserved existing data, unsupported data and failures.
- Name restoration, the production message font and the community rail are
  present. The approved branded channel and right-side thread layout is retained.
- PR #669 adds canonical business-context handoff and explicit approval of a
  coordinator/worker pair for the first job. Its verification is independent of
  the earlier Power changes; see the first-job report beside this file.

## Remaining capability limits

1. **Browser import is not universal.** `browser-import/stores.mjs` supports
   Firefox and macOS Chrome/Chromium. Safari, Edge, Brave, Arc and Dia can be
   discovered but their import choices are disabled. Detecting a profile and
   copying cookies also do not prove an active website login.
2. **Claude usage is version-dependent.** The native Claude account adapter
   reports unavailable usage when the installed version lacks structured
   `get_usage`; it points to the provider's usage interface. It must not invent
   quota percentages.
3. **OpenRouter purchase history may be inaccessible.** The ordinary OAuth key
   is not a management key. The provider's
   [credits endpoint](https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits)
   requires a management key. Ordinary key metadata can prove an unpaid account
   but cannot prove that a previously paid account bought at least $10. The UI
   distinguishes unknown history from unpaid and verified totals; unknown
   history must not become an instruction to pay again. Free usage below the
   increased-limit threshold remains available subject to provider limits.

## Proof still required

- Authenticated Claude/Codex execution with the selected subscription and
  provider-reported usage.
- A real Credits checkout through settlement, accepted receipt and reflected
  available balance.
- OpenRouter purchase evidence and allowance recheck using a real account.
- PR #669's native fresh-worker preparation followed by a worker reply and Scout
  review in the original thread. Browser mocks and the older manually staffed
  native fixture do not establish this.
- Installed-user upgrade and public updater verification for the production
  package; the release agent owns these independently.

Apple Developer signing and notarization are explicitly out of scope at the
owner's request. Release hashes and updater integrity remain required.
