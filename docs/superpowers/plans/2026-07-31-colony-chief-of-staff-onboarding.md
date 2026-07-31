# Colony Chief of Staff Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn first-run Colony into a working conversation with the Chief of
Staff: scan the company's website, return a sourced brief, ask only the missing
questions, propose an editable Company Blueprint, and seed the approved roster,
teams, cost centres, and first three proposed Initiatives exactly once.

**Architecture:** Preserve the existing identity and community setup. Replace
the three-agent Buzz Welcome kickoff with one Chief of Staff in the private
Welcome channel. Give that agent a bounded, SSRF-safe `buzz company scan`
primitive and Core onboarding Blocks. A dedicated desktop broker validates the
signed Company Blueprint action and hands it to one idempotent Tauri transaction
that materializes trusted packaged role templates, multi-team membership, the
Company profile, and proposed Initiatives. The conversation and unresolved
Blocks are the durable onboarding state; there is no setup wizard or separate
onboarding database.

**Depends on:**

- `docs/superpowers/plans/2026-07-30-chat-native-blocks-foundation.md`
- `docs/superpowers/plans/2026-07-31-owned-relay-company-bootstrap.md`
- `docs/superpowers/plans/2026-07-31-colony-company-operating-kernel.md`

**Tech Stack:** Rust, reqwest, scraper, URL/DNS validation, Nostr, `buzz-cli`,
Tauri 2, React 19, TypeScript, Core Blocks, node:test, Playwright.

---

## Scope guardrails

- Identity, profile, relay connection, membership recovery, and owned-community
  setup remain in the existing onboarding curtain.
- Company onboarding begins only after the user enters the private Welcome
  conversation.
- Provision only Fizz/Chief of Staff before blueprint approval.
- Do not automatically activate, deploy, or start the other twelve employees
  before approval.
- Approval creates Persona definitions for the remaining roster. Managed
  instances are provisioned lazily when mentioned, using the existing flow.
- Do not create a generic Operations team. Generate service/production teams
  from evidence and answers.
- Do not create Client Success, Legal, HR, Analyst, Procurement, or other
  employees by default.
- Do not let an agent supply executable system prompts, commands, providers,
  credentials, or runtime configuration in a Blueprint.
- Do not send or spend anything during onboarding.
- Do not auto-start the first three proposed Initiatives.
- Do not store website extracts, answers, or blueprint data in localStorage.
- Do not add a Company setup page, roster wizard, or dashboard.
- A website scan is evidence collection, not truth. Every inferred field must
  carry source URLs and confidence; missing facts stay missing.

## Acceptance gates

### Gate A — Safe evidence collection

Pass only when the scanner:

- accepts public `https://` websites;
- rejects credentials, fragments, non-HTTP schemes, local/private/link-local/
  multicast/unspecified IPs, localhost names, raw private IPs, and DNS answers
  resolving to blocked ranges;
- manually validates every redirect;
- stays same-origin;
- respects page, byte, redirect, and time limits;
- returns normalized text plus exact source URLs;
- reports client-rendered/blocked sites without fabricating content.

### Gate B — Chat-native persistence

Pass only when Company Brief, Interview, and Company Blueprint are ordinary
persistent thread messages with pinned Core manifests; closing review or
restarting the desktop leaves unresolved attention intact; and an Interview
answer reaches the Chief of Staff as a signed Block action.

### Gate C — Idempotent company materialization

Pass only when approving one Blueprint under double-click, reconnect, app crash
after each checkpoint, and action replay produces:

- one approved Company profile;
- exactly the approved baseline Persona definitions;
- one copy of each team and membership;
- one lead per team who is also a member;
- no generic Operations team;
- the approved cost centres;
- exactly three proposed Initiatives;
- one authoritative success receipt;
- zero started non-Chief-of-Staff agents.

### Gate D — Real fresh-install experience

Pass only when a fresh packaged desktop connected to the owned relay completes:

1. identity/community setup;
2. private Welcome conversation;
3. website input;
4. scan;
5. sourced Company Brief;
6. missing-facts Interview;
7. Blueprint review;
8. approval;
9. roster/team references;
10. three proposed Initiatives;
11. close/restart with the same approved company.

---

## Approved baseline role templates

The broker recognizes these exact stable role IDs:

| Role ID | Role title | Default team | Lead/QA |
|---|---|---|---|
| `chief-of-staff` | Chief of Staff | Company Coordination | self |
| `website-agent` | Website Agent | Website | Chief of Staff |
| `cto` | CTO | Engineering | self |
| `frontend-engineer` | Frontend Engineer | Engineering | CTO |
| `backend-engineer` | Backend Engineer | Engineering | CTO |
| `security-engineer` | Security Engineer | Engineering | CTO |
| `devops-engineer` | DevOps Engineer | Engineering | CTO |
| `marketing-lead` | Marketing Lead | Marketing | self |
| `content-campaign-specialist` | Content & Campaign Specialist | Marketing | Marketing Lead |
| `lead-specialist` | Lead Specialist | Leads | Chief of Staff |
| `sales-lead` | Sales Lead | Sales | self |
| `outreach-closing-specialist` | Outreach & Closing Specialist | Sales | Sales Lead |
| `cfo` | CFO | Finance | Chief of Staff |

Company Coordination, Website, Leads, and Finance may include the Chief of Staff
as the accountable lead/QA member. This does not create a department hierarchy;
the same Persona may be in multiple teams.

Stable materialized IDs:

```text
persona: company:<company_id>:<role_id>
team:    company-team:<company_id>:<team_id>
```

Fizz remains `builtin:fizz` and receives role ID `chief-of-staff`. The
transaction reuses that Persona rather than creating another Chief of Staff.

---

## Blueprint no-secret contract

The inline `company-blueprint` data may contain only:

```ts
type CompanyBlueprintData = {
  schema: "colony.company-blueprint/v1";
  requestId: string;
  company: {
    id: string;
    tradingName: string;
    legalName?: string;
    website?: string;
    summary: string;
    businessType: string;
    services: Array<{ id: string; name: string; description: string }>;
    customerSegments: string[];
  };
  roster: Array<{
    roleId: BaselineRoleId;
    personalName: string;
    enabled: boolean;
  }>;
  teams: Array<{
    id: string;
    name: string;
    description: string;
    leadRoleId: BaselineRoleId;
    memberRoleIds: BaselineRoleId[];
    kind: "baseline" | "service";
    serviceId?: string;
  }>;
  costCentres: Array<{
    id: string;
    name: string;
    kind: "service" | "internal";
    serviceId?: string;
  }>;
  readinessGaps: Array<{
    id: string;
    area: "legal" | "security" | "payment" | "contract" | "privacy" | "other";
    summary: string;
    severity: "info" | "attention" | "blocking";
    sourceUrls: string[];
  }>;
  proposedInitiatives: Array<{
    id: string;
    title: string;
    summary: string;
    ownerRoleId: BaselineRoleId;
    costCentreId: string;
    commercialPurpose:
      | "sales"
      | "marketing"
      | "administration"
      | "internalProduct";
  }>;
};
```

It must not contain:

- system prompts;
- runtime, model, or provider choices;
- shell commands;
- environment variables;
- API keys or tokens;
- private keys;
- URLs other than company/source URLs;
- external side-effect instructions.

The approving action contains the complete edited Blueprint plus:

```json
{
  "requestId": "same UUID as Block instance",
  "blueprintHash": "sha256 of canonical edited blueprint"
}
```

The broker validates both against the persisted proposal and the trusted role
template catalog before execution.

---

## Task 1: Replace the Welcome Team with one Chief of Staff

**Files:**

- Modify: `desktop/src/features/onboarding/welcomeGuide.ts`
- Modify: `desktop/src/features/onboarding/welcomeGuide.test.mjs`
- Modify: `desktop/src/features/onboarding/welcomeKickoff.ts`
- Modify: `desktop/src/features/onboarding/welcomeKickoff.test.mjs`
- Modify: `desktop/src/features/onboarding/welcomeCanvas.ts`
- Modify: `desktop/src/features/onboarding/welcomeCanvas.test.mjs`
- Modify: `desktop/src/features/onboarding/hooks.ts`
- Modify: `desktop/src/features/onboarding/ui/CommunityOnboardingFlow.tsx`
- Create: `desktop/src/features/onboarding/ui/CommunityOnboardingFlow.test.mjs`
- Modify: `desktop/src/features/agents/lib/useBotRecents.ts`
- Modify: `desktop/tests/e2e/onboarding.spec.ts`

### Step 1: Write the red behavior tests

- [ ] Assert the onboarding starter set contains only:

```ts
{ name: "Fizz", personaId: "builtin:fizz", roleId: "chief-of-staff" }
```

- [ ] Assert no Honey/Bumble activation, creation, start, or channel membership
  call occurs.
- [ ] Assert the Welcome opener says Colony, introduces Fizz as Chief of Staff,
  and asks for the company website or a short interview.
- [ ] Assert provider-not-configured fallback still works.
- [ ] Assert existing Honey/Bumble user customizations are untouched; they are
  merely no longer auto-provisioned.

### Step 2: Run red

- [ ] Run:

```bash
cd desktop
pnpm exec tsx --test \
  src/features/onboarding/welcomeGuide.test.mjs \
  src/features/onboarding/welcomeKickoff.test.mjs \
  src/features/onboarding/welcomeCanvas.test.mjs
```

Expected: tests still observe the three-agent Buzz kickoff.

### Step 3: Simplify provisioning

- [ ] Replace `WELCOME_TEAM_STARTERS`, tuple types, teammate readiness waits,
  intro coordination, and closer timers with `ensureChiefOfStaff`.
- [ ] Reuse an existing relay-scoped Fizz instance when present.
- [ ] Activate and provision only `builtin:fizz`.
- [ ] Keep `respondTo="owner-only"`, `spawnAfterCreate=false`, and
  `startOnAppLaunch=false`.
- [ ] Add Fizz to Welcome as a bot and start only when the kickoff is ready.

### Step 4: Replace visible copy

- [ ] Use:

```text
Hi @<owner>, I'm Fizz, your Chief of Staff.

Colony is where we'll run the company together. I’ll learn how the business
works, propose the smallest useful team, coordinate work, and bring decisions
back here.

Send me the company website. If there isn't one yet, say so and I'll ask a few
focused questions instead. I won't create the company or start work until you
approve the blueprint.
```

- [ ] Update the Welcome canvas to explain name/role/team mentions and
  persistent Blocks without mentioning Buzz, Honey, or Bumble.
- [ ] Keep the consumer-facing rename scoped to copy and test expectations; do
  not rename technical identifiers.

### Step 5: Prove and commit

- [ ] Run the focused tests and:

```bash
cd desktop
pnpm test:e2e:integration -- --grep "first-run onboarding"
```

- [ ] Commit:

```bash
git add desktop/src/features/onboarding/welcomeGuide.ts \
  desktop/src/features/onboarding/welcomeGuide.test.mjs \
  desktop/src/features/onboarding/welcomeKickoff.ts \
  desktop/src/features/onboarding/welcomeKickoff.test.mjs \
  desktop/src/features/onboarding/welcomeCanvas.ts \
  desktop/src/features/onboarding/welcomeCanvas.test.mjs \
  desktop/src/features/onboarding/hooks.ts \
  desktop/src/features/onboarding/ui/CommunityOnboardingFlow.tsx \
  desktop/src/features/onboarding/ui/CommunityOnboardingFlow.test.mjs \
  desktop/src/features/agents/lib/useBotRecents.ts \
  desktop/tests/e2e/onboarding.spec.ts
git commit -s -m "feat(onboarding): begin with the Chief of Staff"
```

---

## Task 2: Add a bounded public website scan primitive

**Files:**

- Modify: `Cargo.toml`
- Modify: `crates/buzz-cli/Cargo.toml`
- Create: `crates/buzz-cli/src/company_scan.rs`
- Modify: `crates/buzz-cli/src/commands/company.rs`
- Modify: `crates/buzz-cli/src/lib.rs`
- Create: `crates/buzz-cli/tests/company_scan.rs`
- Modify: `crates/buzz-cli/TESTING.md`

### Step 1: Add a local test server and failing safety tests

- [ ] Add `buzz company scan --url <https-url>`.
- [ ] Use a local HTTP test server only through an injected test transport; the
  production parser must continue to require HTTPS.
- [ ] Assert rejection of:
  - `file:`, `data:`, `ftp:`, `ws:`, and `http:` production URLs;
  - username/password;
  - query credentials and fragments;
  - localhost and `.local`;
  - IPv4/IPv6 loopback, private, link-local, multicast, unspecified, and
    documentation ranges;
  - decimal/octal/hex IP disguises;
  - public hostname whose DNS answers include a blocked address;
  - redirect from a public origin to private or different origin.
- [ ] Assert five redirects maximum, ten pages maximum, 2 MiB per page,
  8 MiB total body bytes, ten seconds per request, and thirty seconds total.
- [ ] Assert binary/non-HTML content is skipped.
- [ ] Assert response bytes are capped while streaming, before buffering the
  entire body.

### Step 2: Run red

- [ ] Run:

```bash
. ./bin/activate-hermit
cargo test -p buzz-cli --test company_scan --no-fail-fast
```

Expected: scanner and command are missing.

### Step 3: Implement manual network validation

- [ ] Add `scraper` at the workspace level and to `buzz-cli`.
- [ ] Parse with `url::Url`.
- [ ] Disable reqwest automatic redirects.
- [ ] Resolve every hostname with `tokio::net::lookup_host` before each request.
- [ ] Reject the whole target if any resolved address is blocked.
- [ ] Re-parse, re-resolve, revalidate, and enforce same-origin for every
  redirect.
- [ ] Set a clear user agent:

```text
ColonyCompanyScanner/1 (+https://colony.ainative.ventures)
```

### Step 4: Extract evidence, not conclusions

- [ ] Return:

```rust
pub struct CompanyScanResult {
    pub requested_url: String,
    pub canonical_url: String,
    pub pages: Vec<ScannedPage>,
    pub discovered_links: Vec<String>,
    pub warnings: Vec<ScanWarning>,
    pub limits: ScanLimits,
}

pub struct ScannedPage {
    pub url: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub headings: Vec<String>,
    pub text: String,
    pub fetched_at: String,
}
```

- [ ] Strip script, style, noscript, SVG, navigation boilerplate, repeated
  whitespace, and duplicate text blocks.
- [ ] Prefer same-origin About, Services, Work/Portfolio, Customers/Case Studies,
  Pricing, Contact, and homepage links.
- [ ] Do not infer services, customers, or legal facts inside the scanner.
- [ ] Add warnings for client-rendered shells, access denial, truncation,
  and partial fetches.

### Step 5: Print canonical JSON

- [ ] `buzz company scan` prints the exact result as JSON and returns:
  - `0` for usable evidence;
  - `1` for invalid input;
  - `2` for network/relay-style failure;
  - `4` for a valid but unusable/blocked site.

### Step 6: Prove and commit

- [ ] Run:

```bash
. ./bin/activate-hermit
cargo fmt --all -- --check
cargo test -p buzz-cli --test company_scan --no-fail-fast
cargo test -p buzz-cli --lib --no-fail-fast
```

- [ ] Commit:

```bash
git add Cargo.toml crates/buzz-cli/Cargo.toml \
  crates/buzz-cli/src/company_scan.rs \
  crates/buzz-cli/src/commands/company.rs crates/buzz-cli/src/lib.rs \
  crates/buzz-cli/tests/company_scan.rs crates/buzz-cli/TESTING.md
git commit -s -m "feat(cli): scan company websites safely"
```

---

## Task 3: Add Core Company Brief, Interview, and Blueprint Blocks

**Files:**

- Create: `crates/buzz-relay/src/core_blocks/composites/company-brief.json`
- Create: `crates/buzz-relay/src/core_blocks/composites/interview.json`
- Create: `crates/buzz-relay/src/core_blocks/composites/company-blueprint.json`
- Modify: `crates/buzz-relay/src/core_blocks.rs`
- Modify: `crates/buzz-core/src/block.rs`
- Modify: `desktop/src/features/blocks/contracts.ts`
- Modify: `desktop/src/features/blocks/coreBlockVectors.test.mjs`
- Modify: `desktop/tests/e2e/blocks.spec.ts`

### Step 1: Write red manifest tests

- [ ] Assert all three manifests parse, validate every example, render readable
  fallbacks, and use only the approved native primitive grammar.
- [ ] Assert `company-brief` requires:
  - trading name;
  - summary;
  - sourced findings;
  - explicit gaps;
  - scan timestamp;
  - exact source URLs.
- [ ] Assert `interview` contains one focused question per Block with:
  - question ID;
  - prompt;
  - why it matters;
  - zero to twelve options;
  - custom input;
  - `interview.answer` as a resolving signed action.
- [ ] Assert `company-blueprint` uses `company.review` as a presentation action
  and retains attention until an authoritative approve/reject/request-changes
  receipt.

### Step 2: Run red

- [ ] Run:

```bash
. ./bin/activate-hermit
cargo test -p buzz-relay core_blocks --no-fail-fast
cd desktop && pnpm exec tsx --test src/features/blocks/coreBlockVectors.test.mjs
```

### Step 3: Implement Company Brief

- [ ] Use section, details, card-list, status, and table primitives.
- [ ] Show confidence as `confirmed`, `inferred`, or `unknown`.
- [ ] Never hide gaps because sources are absent.
- [ ] Keep full source URLs in data and fallback.

### Step 4: Implement one-question Interview

- [ ] Render one question at a time rather than a new multi-page wizard.
- [ ] Support single-select or multi-select plus free-form input.
- [ ] Send the signed answer to the Chief of Staff processor.
- [ ] A receipt resolves that question only; the agent may publish the next
  Interview Block when another high-value gap remains.

### Step 5: Implement Blueprint preview

- [ ] Render:
  - Company summary;
  - enabled roster;
  - teams and leads;
  - shared memberships;
  - cost centres;
  - readiness gaps;
  - first three proposed Initiatives.
- [ ] The inline card exposes `Review blueprint`; the detailed review remains
  persistent and is reopened from the same Block.
- [ ] Include text fallback naming every proposed employee/team.

### Step 6: Prove and commit

- [ ] Run the focused Core/desktop tests and:

```bash
cd desktop
pnpm test:e2e:smoke -- --grep "company onboarding blocks"
```

- [ ] Commit:

```bash
git add crates/buzz-relay/src/core_blocks/composites/company-brief.json \
  crates/buzz-relay/src/core_blocks/composites/interview.json \
  crates/buzz-relay/src/core_blocks/composites/company-blueprint.json \
  crates/buzz-relay/src/core_blocks.rs crates/buzz-core/src/block.rs \
  desktop/src/features/blocks/contracts.ts \
  desktop/src/features/blocks/coreBlockVectors.test.mjs \
  desktop/tests/e2e/blocks.spec.ts
git commit -s -m "feat(blocks): add company onboarding primitives"
```

---

## Task 4: Give the Chief of Staff a bounded onboarding protocol

**Files:**

- Modify: `desktop/src-tauri/src/managed_agents/personas.rs`
- Create: `crates/buzz-acp/src/company_onboarding_prompt.md`
- Modify: `crates/buzz-acp/src/base_prompt.md`
- Modify: `crates/buzz-acp/src/setup_mode.rs`
- Modify: `crates/buzz-acp/src/lib.rs`

### Step 1: Pin the behavior with prompt-contract tests

- [ ] Assert the Chief of Staff:
  - asks for the website once;
  - calls `buzz company scan --url`;
  - never claims scan output is verified beyond its sources;
  - emits a `company-brief` before questions;
  - asks only missing high-value facts;
  - uses one `interview` Block per question;
  - proposes the trusted baseline roster plus evidence-derived service teams;
  - never invents a generic Operations team;
  - never embeds prompts/runtime/credentials in the Blueprint;
  - proposes exactly three Initiatives;
  - does not invoke work or external effects.

### Step 2: Run red

- [ ] Run:

```bash
. ./bin/activate-hermit
cargo test -p buzz-acp company_onboarding --no-fail-fast
```

### Step 3: Add the machine-readable protocol section

- [ ] Include:

```text
<colony-company-onboarding>
State is read from persistent thread Blocks and receipts.
1. Website evidence before conclusions.
2. Brief before interview.
3. Questions only for explicit gaps.
4. Blueprint references trusted role IDs only.
5. No work begins before an approval receipt.
</colony-company-onboarding>
```

- [ ] Tell the agent how to invoke the three Core Blocks with `buzz blocks
  invoke`.
- [ ] Tell it to reuse the thread and reference prior Block event IDs.
- [ ] Keep the prompt concise enough not to crowd ordinary work after
  onboarding; inject it only when no approved Company exists.

### Step 4: Stop injecting after approval

- [ ] Before session setup, query Company `30179` for an approved profile.
- [ ] Inject onboarding protocol only when absent/draft.
- [ ] Once approved, inject the normal compact Company context instead.

### Step 5: Prove and commit

- [ ] Run:

```bash
. ./bin/activate-hermit
cargo fmt --all -- --check
cargo test -p buzz-acp company_onboarding --no-fail-fast
```

- [ ] Commit:

```bash
git add desktop/src-tauri/src/managed_agents/personas.rs \
  crates/buzz-acp/src/company_onboarding_prompt.md \
  crates/buzz-acp/src/base_prompt.md crates/buzz-acp/src/setup_mode.rs \
  crates/buzz-acp/src/lib.rs
git commit -s -m "feat(chief-of-staff): guide company onboarding"
```

---

## Task 5: Define the trusted roster and Blueprint parser

**Files:**

- Create: `desktop/src-tauri/src/company/mod.rs`
- Create: `desktop/src-tauri/src/company/roster.rs`
- Create: `desktop/src-tauri/src/company/blueprint.rs`
- Modify: `desktop/src-tauri/src/lib.rs`
- Create: `desktop/src-tauri/src/company/roster_tests.rs`
- Create: `desktop/src/features/company/companyBlueprint.ts`
- Create: `desktop/src/features/company/companyBlueprint.test.mjs`

### Step 1: Write red Rust roster tests

- [ ] Pin the exact thirteen role IDs/titles from this plan.
- [ ] Assert every packaged template has:
  - role ID/title;
  - trusted system prompt;
  - no provider/model/runtime pin unless explicitly product-approved later;
  - owner-only response behavior by default;
  - no credentials or environment variables.
- [ ] Assert Fizz maps to `builtin:fizz`.
- [ ] Assert every baseline team lead is a member.
- [ ] Assert Company Coordination, Website, Leads, and Finance include the Chief
  of Staff where it is the QA lead.

### Step 2: Write red TypeScript parser tests

- [ ] Reject unknown keys recursively.
- [ ] Reject unknown/duplicate role IDs, duplicate personal names, duplicate
  team IDs, missing leads, leads outside membership, missing cost centres,
  service team without service ID, and any field matching secret-bearing names.
- [ ] Require exactly three proposed Initiatives.
- [ ] Require all Initiative owners/cost centres to exist.
- [ ] Allow disabling a baseline role except Chief of Staff only when no enabled
  team references it.
- [ ] Require personal names to be unique case-insensitively.

### Step 3: Run red

- [ ] Run:

```bash
. ./bin/activate-hermit
cargo test --manifest-path desktop/src-tauri/Cargo.toml company::roster --no-fail-fast
cd desktop && pnpm exec tsx --test src/features/company/companyBlueprint.test.mjs
```

### Step 4: Implement catalog and parser

- [ ] Keep prompts only in Rust packaged templates.
- [ ] The frontend parser accepts display-safe Blueprint data only.
- [ ] Compute the canonical Blueprint hash with the existing
  `canonicalBlockJson` + SHA-256 utilities.
- [ ] Export the same role ID list to the E2E bridge without copying prompts.

### Step 5: Prove and commit

- [ ] Run focused tests and commit:

```bash
git add desktop/src-tauri/src/company \
  desktop/src-tauri/src/lib.rs \
  desktop/src/features/company/companyBlueprint.ts \
  desktop/src/features/company/companyBlueprint.test.mjs
git commit -s -m "feat(company): define trusted baseline roster"
```

---

## Task 6: Build the persistent Blueprint review experience

**Files:**

- Create: `desktop/src/features/company/companyBlueprintReview.ts`
- Create: `desktop/src/features/company/useCompanyBlueprintReview.ts`
- Create: `desktop/src/features/company/ui/CompanyBlueprintDialog.tsx`
- Create: `desktop/src/features/company/ui/CompanyBlueprintRoster.tsx`
- Create: `desktop/src/features/company/ui/CompanyBlueprintTeams.tsx`
- Create: `desktop/src/features/company/ui/CompanyBlueprintReadiness.tsx`
- Create: `desktop/src/features/company/ui/CompanyBlueprintInitiatives.tsx`
- Modify: `desktop/src/features/blocks/ui/BlockMessage.tsx`
- Modify: `desktop/src/app/AppShell.tsx`
- Create: `desktop/src/features/company/companyBlueprintReview.test.mjs`
- Create: `desktop/tests/e2e/company-blueprint-review.spec.ts`
- Modify: `desktop/playwright.config.ts`

### Step 1: Write red review-state tests

- [ ] Assert selecting Review opens the Blueprint referenced by that Block.
- [ ] Assert closing the dialog does not resolve attention.
- [ ] Assert reopening restores the persisted proposal, not an unsaved stale
  singleton.
- [ ] Assert the user can:
  - change personal names;
  - enable/disable optional roles subject to invariant validation;
  - change team memberships and leads;
  - add/remove service teams using existing roles;
  - edit cost centres;
  - edit proposed Initiative titles/summaries;
  - approve, request changes with a note, or reject.
- [ ] Assert no runtime/provider/prompt controls appear.

### Step 2: Run red

- [ ] Run:

```bash
cd desktop
pnpm exec tsx --test src/features/company/companyBlueprintReview.test.mjs
```

### Step 3: Implement a focused review dialog

- [ ] Use one dialog opened from the inline persistent Block.
- [ ] Keep sections on one scroll surface; do not create wizard pages or route
  tabs.
- [ ] Show invariant errors beside the affected roster/team.
- [ ] `Request changes` submits a signed `company.request-changes` action with
  the note and edited Blueprint but does not materialize company state.
- [ ] `Reject` submits `company.reject`.
- [ ] `Approve` submits `company.approve` with canonical edited data and hash.

### Step 4: Add visual proof

- [ ] Capture locator-scoped screenshots for:
  - inline Blueprint card;
  - review dialog roster/teams;
  - readiness/initiatives;
  - validation error;
  - approved receipt.
- [ ] Call `waitForAnimations(page)` before every screenshot.
- [ ] Verify unique hashes:

```bash
shasum -a 256 test-results/company-blueprint/*.png
```

### Step 5: Prove and commit

- [ ] Run:

```bash
cd desktop
pnpm test:e2e:smoke -- --grep "company blueprint review"
pnpm lint
```

- [ ] Commit the implementation and specs, not generated PNGs:

```bash
git add desktop/src/features/company/companyBlueprintReview.ts \
  desktop/src/features/company/useCompanyBlueprintReview.ts \
  desktop/src/features/company/ui \
  desktop/src/features/blocks/ui/BlockMessage.tsx \
  desktop/src/app/AppShell.tsx \
  desktop/src/features/company/companyBlueprintReview.test.mjs \
  desktop/tests/e2e/company-blueprint-review.spec.ts \
  desktop/playwright.config.ts
git commit -s -m "feat(company): review blueprints from chat"
```

---

## Task 7: Add the idempotent Blueprint materialization command

**Files:**

- Create: `desktop/src-tauri/src/commands/company_blueprint.rs`
- Create: `desktop/src-tauri/src/commands/company_blueprint_tests.rs`
- Modify: `desktop/src-tauri/src/commands/mod.rs`
- Modify: `desktop/src-tauri/src/lib.rs`
- Create: `desktop/src-tauri/src/company/transaction.rs`
- Modify: `desktop/src-tauri/src/managed_agents/personas.rs`
- Modify: `desktop/src-tauri/src/managed_agents/teams.rs`
- Modify: `desktop/src-tauri/src/managed_agents/persona_events.rs`
- Modify: `desktop/src-tauri/src/managed_agents/team_events.rs`
- Create: `desktop/src/shared/api/companyBlueprint.ts`

### Step 1: Pin transaction checkpoints

- [ ] Use a mode-`600` journal keyed by
  `(owner_pubkey, community_scope, request_id)`:

```rust
pub enum BlueprintCheckpoint {
    Validated,
    CompanyPublished,
    PersonasSeeded,
    TeamsSeeded,
    InitiativesPublished,
    Completed,
}
```

- [ ] Persist after every completed side effect with atomic-write-file.
- [ ] Store only IDs, event IDs, hashes, and checkpoint state—never private
  keys or prompts copied from runtime memory.

### Step 2: Write fault-injection tests

- [ ] Interrupt after each checkpoint and rerun.
- [ ] Assert stable IDs prevent duplicates.
- [ ] Assert a request ID with a different Blueprint hash is rejected.
- [ ] Assert two concurrent calls join one transaction.
- [ ] Assert source Block/action signer, instance, manifest, channel, owner,
  request ID, and hash are revalidated.
- [ ] Assert Company approval is owner-signed.
- [ ] Assert no managed instance except existing Chief of Staff is created or
  started.
- [ ] Assert exactly three Initiative events are published as `proposed`.

### Step 3: Run red

- [ ] Run:

```bash
. ./bin/activate-hermit
cargo test --manifest-path desktop/src-tauri/Cargo.toml company_blueprint --no-fail-fast
```

### Step 4: Implement deterministic materialization

- [ ] Validate against packaged role templates.
- [ ] Publish the approved Company profile using the kernel SDK builder.
- [ ] Materialize each enabled Persona:
  - reuse `builtin:fizz` for Chief of Staff;
  - otherwise use `company:<company_id>:<role_id>`;
  - personal name from approved Blueprint;
  - role title/ID and trusted packaged prompt from roster catalog;
  - active, owner-only, no runtime/model/provider pin.
- [ ] Materialize teams with
  `company-team:<company_id>:<team_id>`, approved memberships, and lead.
- [ ] Publish three proposed Initiatives with stable approved IDs.
- [ ] Use existing persona/team event sync rather than parallel storage.

### Step 5: Return a safe result

- [ ] Return:

```ts
type CompanyBlueprintExecutionResult = {
  outcome: "created" | "recovered";
  companyId: string;
  companyEventId: string;
  personaIds: string[];
  teamIds: string[];
  initiativeIds: string[];
  checkpoint: "completed";
};
```

- [ ] Never return prompts, private keys, env vars, or auth tags.

### Step 6: Prove and commit

- [ ] Run:

```bash
. ./bin/activate-hermit
cargo fmt --all -- --check
cargo test --manifest-path desktop/src-tauri/Cargo.toml company_blueprint --no-fail-fast
```

- [ ] Commit:

```bash
git add desktop/src-tauri/src/commands/company_blueprint.rs \
  desktop/src-tauri/src/commands/company_blueprint_tests.rs \
  desktop/src-tauri/src/commands/mod.rs desktop/src-tauri/src/lib.rs \
  desktop/src-tauri/src/company/transaction.rs \
  desktop/src-tauri/src/managed_agents/personas.rs \
  desktop/src-tauri/src/managed_agents/teams.rs \
  desktop/src-tauri/src/managed_agents/persona_events.rs \
  desktop/src-tauri/src/managed_agents/team_events.rs \
  desktop/src/shared/api/companyBlueprint.ts
git commit -s -m "feat(company): materialize approved blueprints once"
```

---

## Task 8: Broker signed Blueprint actions and receipts

**Files:**

- Create: `desktop/src/features/company/useCompanyBlueprintBroker.ts`
- Create: `desktop/src/features/company/companyBlueprintBroker.ts`
- Create: `desktop/src/features/company/companyBlueprintBroker.test.mjs`
- Modify: `desktop/src/app/AppShell.tsx`
- Modify: `desktop/src/features/communities/useCommunityInit.ts`
- Modify: `desktop/src/features/home/lib/inbox.test.mjs`
- Create: `desktop/tests/e2e/company-blueprint-broker.spec.ts`
- Modify: `desktop/playwright.config.ts`

### Step 1: Write red authority tests

- [ ] Mirror the hardened Agent Proposal broker checks:
  - action and instance signatures verify;
  - instance is a kind-9 `company-blueprint`;
  - exact channel, manifest, instance, processor, decision maker, and action
    references match;
  - signer is current owner;
  - proposal signer is an owned managed Chief of Staff in the channel;
  - proposal data and edited action pass strict parsing;
  - hash matches;
  - receipt signer is owner;
  - one resolving receipt wins.
- [ ] Reject foreign agents, stale community leases, replay with changed content,
  duplicate actions, and cross-channel references.

### Step 2: Run red

- [ ] Run:

```bash
cd desktop
pnpm exec tsx --test src/features/company/companyBlueprintBroker.test.mjs
```

### Step 3: Implement process-lifetime execution queues

- [ ] Key by owner pubkey, opaque community execution scope, and instance event
  ID.
- [ ] Serialize actions per Blueprint.
- [ ] Join duplicate action work.
- [ ] Resume unreceipted accepted actions after remount/restart by querying the
  relay.
- [ ] Clear community-scoped leases in `resetCommunityState()`.

### Step 4: Publish receipts

- [ ] For approval success, publish one owner-signed resolving receipt naming
  Company, persona, team, and Initiative IDs.
- [ ] For request changes, publish a non-final receipt/action result that reaches
  the Chief of Staff and leaves the onboarding conversation active.
- [ ] For rejection, publish a resolving denied receipt.
- [ ] For recoverable local failure, leave attention unresolved and show a safe
  retry state; do not falsely publish failure as final if recovery may complete.

### Step 5: Prove and commit

- [ ] Run unit and focused E2E tests.
- [ ] Commit:

```bash
git add desktop/src/features/company/useCompanyBlueprintBroker.ts \
  desktop/src/features/company/companyBlueprintBroker.ts \
  desktop/src/features/company/companyBlueprintBroker.test.mjs \
  desktop/src/app/AppShell.tsx \
  desktop/src/features/communities/useCommunityInit.ts \
  desktop/src/features/home/lib/inbox.test.mjs \
  desktop/tests/e2e/company-blueprint-broker.spec.ts \
  desktop/playwright.config.ts
git commit -s -m "feat(company): broker persistent blueprint approvals"
```

---

## Task 9: Return the approved company and first Initiatives to chat

**Files:**

- Create: `crates/buzz-relay/src/core_blocks/composites/company-roster.json`
- Create: `crates/buzz-relay/src/core_blocks/composites/initiative-proposal.json`
- Modify: `crates/buzz-relay/src/core_blocks.rs`
- Modify: `crates/buzz-core/src/block.rs`
- Modify: `crates/buzz-acp/src/company_onboarding_prompt.md`
- Modify: `desktop/tests/e2e/blocks.spec.ts`

### Step 1: Pin final report contracts

- [ ] `company-roster` shows personal name, role title, teams, lead/QA, and
  active/provisioned status.
- [ ] `initiative-proposal` shows title, owning role/team, cost centre,
  commercial purpose, expected cost when known, and approval needed.
- [ ] Initiative proposal has no Start action in this phase.

### Step 2: Run red

- [ ] Run Core Block tests.

### Step 3: Implement post-approval behavior

- [ ] The success receipt tells the Chief of Staff to:
  - query the approved Company/personas/teams/Initiatives from durable state;
  - publish one Company Roster report;
  - publish exactly three Initiative Proposal Blocks;
  - explain that nothing has started.
- [ ] Do not trust the pre-approval Blueprint as final state; read the
  materialized records.

### Step 4: Prove and commit

- [ ] Run Core and Block E2E tests.
- [ ] Commit:

```bash
git add crates/buzz-relay/src/core_blocks/composites/company-roster.json \
  crates/buzz-relay/src/core_blocks/composites/initiative-proposal.json \
  crates/buzz-relay/src/core_blocks.rs crates/buzz-core/src/block.rs \
  crates/buzz-acp/src/company_onboarding_prompt.md \
  desktop/tests/e2e/blocks.spec.ts
git commit -s -m "feat(company): report approved roster and initiatives"
```

---

## Task 10: Run the fresh-company acceptance gate

**Files:**

- Create: `desktop/tests/e2e/company-onboarding.spec.ts`
- Create: `desktop/tests/e2e/company-onboarding-faults.spec.ts`
- Modify: `desktop/playwright.config.ts`
- Modify: `TESTING.md`

### Step 1: Prove the no-website path

- [ ] Fresh identity enters Welcome.
- [ ] User says there is no website.
- [ ] Chief of Staff asks one focused Interview question at a time.
- [ ] Answers persist as signed actions.
- [ ] Blueprint contains explicit unknowns rather than invented evidence.

### Step 2: Prove the website path

- [ ] Use a deterministic public test fixture site with homepage, services,
  case study, and contact pages.
- [ ] Assert the scanner sources all four exact URLs.
- [ ] Assert Company Brief separates confirmed/inferred/unknown.
- [ ] Assert Interview asks only a fixture fact omitted from the site.

### Step 3: Prove approval and restart

- [ ] Edit one personal name and one service-team membership.
- [ ] Close the review; assert attention remains.
- [ ] Restart; reopen and approve.
- [ ] Assert:
  - thirteen enabled baseline roles unless the test explicitly disables one;
  - one Chief of Staff (`builtin:fizz`);
  - no Honey/Bumble auto-provision;
  - no generic Operations team;
  - expected service team;
  - three proposed Initiatives;
  - zero started non-Chief-of-Staff agents.

### Step 4: Fault-inject every checkpoint

- [ ] Repeat approval with injected interruption after Validated,
  CompanyPublished, PersonasSeeded, TeamsSeeded, and InitiativesPublished.
- [ ] Restart/replay and assert one final state and one receipt.
- [ ] Double-click Approve and disconnect/reconnect during execution.

### Step 5: Capture visual proof

- [ ] Capture unique, locator-scoped PNGs:
  - Chief of Staff opener;
  - sourced Company Brief;
  - Interview;
  - inline Blueprint;
  - review dialog;
  - approved roster;
  - three Initiative proposals.
- [ ] Call `waitForAnimations(page)` before every screenshot.
- [ ] Gate on unique hashes.

### Step 6: Run repository quality

- [ ] Run:

```bash
. ./bin/activate-hermit
cargo test -p buzz-cli --test company_scan --no-fail-fast
cargo test -p buzz-acp company_onboarding --no-fail-fast
cargo test --manifest-path desktop/src-tauri/Cargo.toml company_blueprint --no-fail-fast
cd desktop && pnpm test:e2e:integration -- --grep "company onboarding"
cd .. && just ci
```

Expected: all local gates pass.

### Step 7: Run real packaged proof

- [ ] Build using the owned-distribution wrapper.
- [ ] Install as a fresh app with clean app data.
- [ ] Connect to the approved owned relay.
- [ ] Use a real AI provider and real Chief of Staff turn.
- [ ] Complete the ten-step Gate D path.
- [ ] Relaunch and verify Company/roster/Initiatives remain.
- [ ] Report packaged, deployed, and live-proven separately.

### Step 8: Commit proof specifications

- [ ] Commit:

```bash
git add desktop/tests/e2e/company-onboarding.spec.ts \
  desktop/tests/e2e/company-onboarding-faults.spec.ts \
  desktop/playwright.config.ts TESTING.md
git commit -s -m "test: prove Colony company onboarding"
```

---

## Plan self-review checklist

- [ ] Community/identity onboarding remains intact.
- [ ] Company onboarding happens in chat.
- [ ] Only Chief of Staff exists before approval.
- [ ] Website content is source-backed and bounded.
- [ ] Missing evidence remains visible as missing.
- [ ] Interview asks one high-value gap at a time.
- [ ] Blueprint cannot carry executable or secret configuration.
- [ ] Roster templates are trusted packaged code, not agent-authored prompts.
- [ ] Team leads are members and agents may belong to multiple teams.
- [ ] No generic Operations team exists.
- [ ] Other default omissions remain omitted.
- [ ] Approval is idempotent and crash-recoverable.
- [ ] Exactly three Initiatives are proposed and none auto-starts.
- [ ] Closing UI does not resolve persistent attention.
- [ ] No new setup page or dashboard exists.
- [ ] All commits use `-s`.
- [ ] Mock, local relay, packaged, deployed, and live proof are reported as
  separate states.
