# Landing page v2: sell real work to a small business owner

**Status:** Design final 2026-08-08. Client (owner) delegated design authority;
decisions below are locked unless he overrides. Successor to
[2026-08-03-landing-page-gap-vs-buzz.md](2026-08-03-landing-page-gap-vs-buzz.md),
which closed with the question this spec answers: what the page says about
the paid primitives before they ship.

## Who the page sells to

A small business owner running a service or product business (recruitment
agency, web studio, local services, e-commerce). They want AI to do real
work: fill the pipeline, run outbound, update the website, produce content,
do client work. They have never heard of git and do not care.

## The three laws

1. **Outcome English only.** No "git", "workflow", "canvas", "relay",
   "repo", "PR", "agent harness" anywhere on the page. Every heading names
   a business outcome.
2. **Show, don't tell.** Every claim section carries a real screenshot of
   the real app with believable small-business content, captured by a
   seeded, regenerable spec — never hand-tuned pixels, never mockups
   passed off as product.
3. **Sell only what is true.** Chain of command is relay-enforced today,
   so it is sold hard. The "one inbox of everything that needs you" UI is
   not built (spec approved 2026-08-04, unimplemented), so the page never
   shows or promises an inbox.

## Page structure (8 sections, 3 new)

| # | Section | Change |
|---|---------|--------|
| 1 | Hero | **None.** Untouched in every respect — client is happy with it |
| 2 | Statement | Copy re-aimed at the owner |
| 3 | ProductShowcase | Kept, including the current capture (already a business story: growth channel, ranked targets, agents working, reactions) |
| 4 | Chain of command | **New centerpiece** |
| 5 | Three jobs | **New**, alternating rows |
| 6 | Capabilities strip | **New**, one compact row |
| 7 | Starter team cards | Copy rewrite only; layout and art stay |
| 8 | Download + Footer | None |

### 2 · Statement copy

> **Delegate real work, not prompts.**
> Colony gives you a team of AI agents that find customers, write the
> outreach, and do the work — while you stay in charge of what matters.

### 4 · Chain of command (new centerpiece)

> **A chain of command, not a chatbot.**
> Tell your chief of staff what you need. It briefs the team leaders,
> their teams do the work, and questions climb the ladder only when no
> one below can answer them. Only what truly needs you reaches you —
> not a promise, it's how the system is built.

Visual: a drawn org-chart illustration using the Colony starter characters,
NOT a screenshot. Structure: You → Chief of staff → three leaders, **each
leader with their own workers grouped under them** (teams are per-leader,
not a shared pool). Example teams (final roles picked at build): Sales lead
(researcher, writer) · Marketing lead (designer, copywriter) · Ops lead
(scheduler, bookkeeper).

Why illustration: the org structure is real (tiers + relay enforcement),
but the one-place issues queue UI is not built. An illustration sells the
structure without faking a product surface.

### 5 · Three jobs (new, alternating rows)

Layout: image/text alternating rows; every screenshot inside the same
near-black (#211f1f) rounded frame ProductShowcase uses. Static — no
tabs, no scroll-driven animation.

1. **Wake up to a full pipeline** — "Your agents search your market,
   qualify who fits, and score every lead — new customers found for
   you, every day." Shot: Discovery campaign detail with scored leads.
   (Copy claims scores, not notes: lead notes exist only on the detail
   drawer after a manual edit, so they are not honestly capturable.)
2. **Nothing goes out without your OK** — "Outreach waits in a queue
   until you approve it. Nothing reaches a customer without your OK."
   Shot: outreach drafts queue with the Awaiting-approval metric and a
   visible Approve button. (No edit/decline claim: the product ships
   Approve + Schedule only.)
3. **The work shows up done** — "Website updates, social posts, candidate
   shortlists, client deliverables — finished work arrives in the
   conversation, ready for you to review." Shot: agent delivering a
   finished homepage copy rewrite in a channel, owner reaction.

Order is the funnel arc: find customers → reach them safely → deliver
the work.

### 6 · Capabilities strip (new)

"And everything a workspace needs": Voice calls — agents included ·
Everything searchable · Files and images · Mac, Windows, Linux. All four
verified in-product (huddles with AddAgentDialog; search; media; Download
section already serves all three OS). No mobile claim — not publicly
released.

### 7 · Starter team copy rewrite

Section heading: **Meet your first three hires.** Cards keep art and
layout; copy shifts to first-day jobs, aligned with the persona pack
roles in `crates/buzz-persona` at build time (verify before shipping,
directional copy below):

- **Scout finds your customers** — Researches your market and fills your
  pipeline with people worth talking to.
- **Forager brings work home** — Drafts the outreach and follows up —
  always with your sign-off.
- **Tender keeps everything moving** — Tracks the team's work and makes
  sure nothing stalls or slips.

Kickoff display order in-product is Scout, Forager, Tender
(`STARTER_PERSONA_ORDER`); cards follow the same order.

## Screenshot production

Pattern: one Playwright spec per shot alongside the existing
"capture: the company channel hero shot" in
`desktop/tests/e2e/site-feature-screenshots.spec.ts` (or sibling file),
mock bridge seeded, `pnpm build:e2e` only. Rules that already cost time,
honored: seed before opening the channel, open/leave/reopen for read
state, `waitForAnimations` before capture, scoped crops, hash-distinct
gate (`shasum -a 256` — every PNG unique), images land in
`site/src/assets/` (content-hashed by Vite) never `site/public/`.

Discovery shots seed via the Discovery feature's mock/e2e path; if no
seeding path exists there yet, build the minimal one rather than
hand-cropping a live capture.

## Truth ledger

| Claim | Status | Basis |
|---|---|---|
| Workers cannot interrupt you | Built | Relay refuses worker/leader→owner at ingest; typed asks; grants with caps |
| Agents find + score leads | Built | Discovery UI: campaigns, scores, timeline |
| Outreach waits for approval | Built | Drafts queue with Approve action. Claim is phrased as behavior (nothing sends unapproved), which holds product-wide (channel drafts, workflow approvals, outreach queue). The Outreach tab itself is preview-phase for live-entitled plans — the page claims the behavior, never the tab |
| Voice calls with agents | Built | Huddle components incl. AddAgentDialog |
| One inbox of things needing you | **Not built** | Never shown or promised on the page |

## Out of scope

Hero changes of any kind. Pricing/credits (unsettled). Mobile claims.
Inbox UI. Animating the character PNGs (~3MB — revisit later).

## Deploy reminders

Site deploys to Cloudflare Pages project `colony-site` (production branch
`main`). Verify with a real browser load of the bare URL — the edge has
served stale files and cached 404s before; content-hashed asset imports
are the structural fix.
