# Landing Page v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Colony landing page middle around a small-business-owner story: chain of command, three job sections with real seeded screenshots, capabilities strip, and outcome-English copy — per `docs/superpowers/specs/2026-08-08-landing-page-v2-design.md`.

**Architecture:** Three new React sections in `site/src/sections/` slotted into `App.tsx`; three new marketing screenshots produced by seeded Playwright capture tests appended to `desktop/tests/e2e/site-feature-screenshots.spec.ts` and copied into `site/src/assets/` (content-hashed by Vite). No product code changes.

**Tech Stack:** React 19 + Vite + Tailwind (site), Playwright + e2e mock bridge (desktop captures), wrangler (Cloudflare Pages deploy).

## Global Constraints

- Worktree: `/Users/mac/Desktop/Billion/AI-Native-Ventures-App-worktrees/landing-page-v2`, branch `feat/landing-page-v2`, PR targets `develop`.
- Activate hermit before git/hooks: `. ./bin/activate-hermit` from the worktree root.
- Commit with `git commit -s` every time.
- Copy law: no "git", "workflow", "canvas", "relay", "repo", "PR" in any user-facing site string.
- Hero (`site/src/sections/Hero.tsx`), `Download.tsx`, `Footer.tsx`, `ProductShowcase.tsx`: DO NOT MODIFY.
- New site images go to `site/src/assets/` (imported, content-hashed), NEVER `site/public/`.
- Desktop e2e: build with `pnpm build:e2e` only; `page.addInitScript`/seeding before `installMockBridge`; `waitForAnimations(page)` before every screenshot; every shipped PNG hash-distinct (`shasum -a 256`).
- Screenshot frame color when embedding on the site: `#211f1f` (matches ProductShowcase).
- `pnpm` from `desktop/` and `site/` respectively; hermit provides node/pnpm.

---

### Task 1: Capture specs — three marketing screenshots

**Files:**
- Modify: `desktop/tests/e2e/site-feature-screenshots.spec.ts` (append three tests)
- Output: `desktop/test-results/site-features/{discovery-pipeline,outreach-approval,work-delivered}.png` → copied to `site/src/assets/`

**Interfaces:**
- Produces: `site/src/assets/discovery-pipeline.png`, `site/src/assets/outreach-approval.png`, `site/src/assets/work-delivered.png` (Task 5 imports these exact filenames)

- [ ] **Step 1: Append imports + three capture tests**

Add to the imports in `site-feature-screenshots.spec.ts`:

```ts
import { seedActiveIdentity } from "../helpers/onboarding";
```

(`TEST_IDENTITIES` is already imported from `../helpers/bridge`.)

Append these tests at the end of the file:

```ts
// The Discovery pipeline and outreach-approval shots ride the e2e fixture
// data source (FixtureDiscoveryDataSource) — MODE === "e2e" swaps it in at
// DiscoveryRouteScreen, so the campaigns below are pre-seeded product
// fixtures, not bridge mocks. Deep links are the seeding mechanism.
test("capture: discovery pipeline", async ({ page }) => {
  await seedActiveIdentity(page, TEST_IDENTITIES.tyler);
  await installMockBridge(page);
  // Taller than 720 so the lead table shows a full run of scored rows.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(
    "/#/discovery?surface=campaign&industryId=automotive" +
      "&verticalId=auto-repair&campaignId=auto-repair-johannesburg&tab=leads",
    { waitUntil: "domcontentloaded" },
  );
  await expect(page.getByTestId("campaign-lead-table")).toBeVisible();
  await expect(page.getByText("Rosebank Auto Care")).toBeVisible();
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOTS}/discovery-pipeline.png` });
});

test("capture: outreach approval queue", async ({ page }) => {
  await seedActiveIdentity(page, TEST_IDENTITIES.tyler);
  await installMockBridge(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(
    "/#/discovery?surface=campaign&entity=people&fieldId=marketing" +
      "&roleId=marketing-director&campaignId=marketing-directors-united-states" +
      "&tab=outreach",
    { waitUntil: "domcontentloaded" },
  );
  await expect(
    page.getByRole("heading", { name: "Outreach", exact: true }),
  ).toBeVisible();
  // First card whose status is still Draft — the one with a visible
  // Approve button; the metric strip above reads "Drafts Ready /
  // Awaiting approval", which is the sentence the landing copy makes.
  const draftCard = page
    .locator('[data-testid^="outreach-draft-"]')
    .filter({ has: page.getByRole("button", { name: "Approve" }) })
    .first();
  await expect(draftCard).toBeVisible();
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOTS}/outreach-approval.png` });
});

// The delivered-work shot reuses the hero-shot channel machinery: build a
// brand channel, seed the finished-work exchange as history, read it once,
// come back, capture the message cluster.
const TENDER = {
  pubkey: "7e19c4a8d2f6503b1e87ac40d5b92f634a01c8e7f52d3b96e0847ad1c5f29b60",
  name: "Tender",
  avatarUrl: "/onboarding/starter-team/tender.png",
};
const ID_DELIVERED = "5e".repeat(32);

test("capture: work delivered in a channel", async ({ page }) => {
  await installMockBridge(page, {
    searchProfiles: [
      { pubkey: MAYA.pubkey, displayName: MAYA.name },
      { pubkey: AISHA.pubkey, displayName: AISHA.name },
      {
        pubkey: TENDER.pubkey,
        displayName: TENDER.name,
        avatarUrl: TENDER.avatarUrl,
        isAgent: true,
        ownerPubkey: MAYA.pubkey,
      },
    ],
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () =>
      typeof (
        window as unknown as { __BUZZ_E2E_INVOKE_MOCK_COMMAND__?: unknown }
      ).__BUZZ_E2E_INVOKE_MOCK_COMMAND__ === "function",
  );

  await page.evaluate(
    async ({ members }) => {
      const w = window as unknown as {
        __BUZZ_E2E_INVOKE_MOCK_COMMAND__: (
          command: string,
          payload: Record<string, unknown>,
        ) => Promise<unknown>;
        __BUZZ_E2E_INVALIDATE_CHANNELS__: () => void;
      };
      const channel = (await w.__BUZZ_E2E_INVOKE_MOCK_COMMAND__(
        "create_channel",
        {
          name: "website",
          channelType: "stream",
          visibility: "open",
          description: "The studio site and everything on it",
        },
      )) as { id: string };
      await w.__BUZZ_E2E_INVOKE_MOCK_COMMAND__("add_channel_members", {
        channelId: channel.id,
        pubkeys: members,
      });
      w.__BUZZ_E2E_INVALIDATE_CHANNELS__();
    },
    { members: [AISHA.pubkey, TENDER.pubkey] },
  );

  await page.evaluate(
    ({ maya, aisha, tender, idDelivered, t0 }) => {
      const emit = (
        window as unknown as {
          __BUZZ_E2E_EMIT_MOCK_MESSAGE__: (
            input: Record<string, unknown>,
          ) => void;
        }
      ).__BUZZ_E2E_EMIT_MOCK_MESSAGE__;
      emit({
        channelName: "website",
        pubkey: maya,
        createdAt: t0 - 700,
        content:
          "The services page still says we do consultations on Saturdays. We stopped that in June — can we get the whole page brought up to date?",
      });
      emit({
        channelName: "website",
        pubkey: tender,
        id: idDelivered,
        createdAt: t0,
        content: [
          "Done. Every page is current again:",
          "",
          "- Services page: Saturday consultations removed, the three packages match the new price list",
          "- Homepage: headline now leads with the 48-hour turnaround, new photo of the workshop floor",
          "- Contact page: the old landline is gone, the booking link goes straight to your calendar",
          "",
          "Preview is live — one look from you and it publishes.",
        ].join("\n"),
      });
      emit({
        channelName: "website",
        pubkey: aisha,
        createdAt: t0 + 240,
        parentEventId: idDelivered,
        content: "Checked all three. Publish it.",
      });
      for (const [reactor, emoji, offset] of [
        [maya, "🎉", 300],
        [aisha, "👍", 320],
      ] as const) {
        emit({
          channelName: "website",
          pubkey: reactor,
          kind: 7,
          createdAt: t0 + offset,
          content: emoji,
          extraTags: [
            ["e", idDelivered],
            ["p", tender],
          ],
        });
      }
    },
    {
      maya: MAYA.pubkey,
      aisha: AISHA.pubkey,
      tender: TENDER.pubkey,
      idDelivered: ID_DELIVERED,
      t0: T0,
    },
  );

  // First visit marks history read; return trip captures without the NEW rule.
  await page.getByTestId("channel-website").click();
  await expect(page.getByTestId("chat-title")).toHaveText("website");
  await expect(page.getByText("Publish it.")).toBeVisible();
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");
  await page.getByTestId("channel-website").click();
  await expect(page.getByTestId("chat-title")).toHaveText("website");
  await expect(page.getByText("Preview is live")).toBeVisible();
  await expect(
    page.locator(`img[src="${TENDER.avatarUrl}"]`).first(),
  ).toBeVisible();
  await waitForAnimations(page);

  // The delivered-work message cluster with the composer floor, minus the
  // sidebar: the story is the delivery, not the channel list.
  const row = page.getByTestId("message-row").filter({
    hasText: "Every page is current again",
  });
  const box = await row.boundingBox();
  if (!box) throw new Error("could not measure the delivered-work message");
  await page.screenshot({
    path: `${SHOTS}/work-delivered.png`,
    clip: { x: 290, y: Math.max(0, box.y - 90), width: 990, height: 560 },
  });
});
```

- [ ] **Step 2: Build e2e bundle and run only the new captures**

```bash
cd /Users/mac/Desktop/Billion/AI-Native-Ventures-App-worktrees/landing-page-v2/desktop
pnpm install --frozen-lockfile 2>&1 | tail -2   # worktree has no node_modules yet
pnpm build:e2e
pnpm exec playwright test tests/e2e/site-feature-screenshots.spec.ts --project=smoke \
  -g "discovery pipeline|outreach approval|work delivered"
```

Expected: 3 passed. If `channel-website` testid misses, check the sidebar naming convention in an existing spec (`channel-growth` works in the hero-shot test, so `channel-<name>` is the pattern).

- [ ] **Step 3: Judge the shots like a designer, not a test runner**

Read all three PNGs with the Read tool. Reject and reshoot if: NEW divider or jump pill visible, empty avatar discs, fixture slugs in frame, clipped text, or a shot that fails to make its section's claim at a glance. Iterate crops until each PNG earns its place on a marketing page.

- [ ] **Step 4: Hash-distinct gate + copy into the site**

```bash
shasum -a 256 test-results/site-features/{discovery-pipeline,outreach-approval,work-delivered}.png
cp test-results/site-features/discovery-pipeline.png ../site/src/assets/
cp test-results/site-features/outreach-approval.png ../site/src/assets/
cp test-results/site-features/work-delivered.png ../site/src/assets/
```

All three hashes unique.

- [ ] **Step 5: Commit**

```bash
cd /Users/mac/Desktop/Billion/AI-Native-Ventures-App-worktrees/landing-page-v2
. ./bin/activate-hermit
git add desktop/tests/e2e/site-feature-screenshots.spec.ts site/src/assets/*.png
git commit -s -m "feat(site): capture pipeline, approval, and delivered-work marketing shots"
```

---

### Task 2: Statement copy re-aim

**Files:**
- Modify: `site/src/sections/Statement.tsx`

**Interfaces:**
- Consumes: nothing. Produces: no exports change (JSX copy only).

- [ ] **Step 1: Replace heading + paragraph**

In `Statement.tsx`, replace the `<h2>` text with `Delegate real work, not prompts.` and the `<p>` text with:

```
Colony gives you a team of AI agents that find customers, write the
outreach, and do the work — while you stay in charge of what matters.
```

Keep every className as is.

- [ ] **Step 2: Commit**

```bash
git add site/src/sections/Statement.tsx
git commit -s -m "feat(site): re-aim the statement at the business owner"
```

---

### Task 3: ChainOfCommand section (new centerpiece)

**Files:**
- Create: `site/src/sections/ChainOfCommand.tsx`
- Modify: `site/src/App.tsx` (add import + slot after `ProductShowcase`)

**Interfaces:**
- Produces: `export function ChainOfCommand()` — App.tsx renders `<ChainOfCommand />` between `<ProductShowcase />` and the Task 5 `<Jobs />`.

- [ ] **Step 1: Create the component**

```tsx
// site/src/sections/ChainOfCommand.tsx
// The page's differentiator section: Colony is an org chart, not a chatbot.
// Drawn with typographic chips and connector strokes rather than characters —
// the starter trio stays in the Cards section, and repeating three renders
// across eleven org nodes would read as a copy-paste team.
//
// The claim in the closing line is load-bearing and true: the relay refuses
// worker→owner contact at ingest, so "can't interrupt you" is enforcement,
// not etiquette. Keep the wording aligned with that fact.

const TEAMS = [
  { lead: "Sales lead", workers: ["Researcher", "Writer"] },
  { lead: "Marketing lead", workers: ["Designer", "Copywriter"] },
  { lead: "Ops lead", workers: ["Scheduler", "Bookkeeper"] },
];

function Connector({ height = 24 }: { height?: number }) {
  return (
    <div
      aria-hidden
      className="w-px bg-colony-ink/30"
      style={{ height }}
    />
  );
}

export function ChainOfCommand() {
  return (
    <section className="bg-colony-canvasMid px-6 py-20 sm:py-28">
      <div className="mx-auto max-w-4xl text-center">
        <h2 className="mx-auto max-w-3xl text-3xl font-semibold leading-tight tracking-tight text-colony-ink [text-wrap:balance] sm:text-4xl lg:text-5xl">
          A chain of command, not a chatbot.
        </h2>
        <p className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-colony-ink/70 sm:text-lg">
          Tell your chief of staff what you need. It briefs the team leaders,
          their teams do the work, and questions climb the ladder only when no
          one below can answer them.
        </p>

        <div className="mt-14 flex flex-col items-center">
          <div className="rounded-full bg-colony-ink px-7 py-2.5 text-sm font-semibold text-colony-canvas">
            You
          </div>
          <Connector />
          <div className="rounded-full border-2 border-colony-ink bg-white px-6 py-2.5 text-sm font-semibold text-colony-ink">
            Chief of staff
          </div>
          <Connector />
          {/* Rail that fans out to the three teams. */}
          <div
            aria-hidden
            className="hidden h-px w-full max-w-2xl bg-colony-ink/30 sm:block"
          />
          <div className="mt-0 grid w-full max-w-3xl gap-6 sm:grid-cols-3">
            {TEAMS.map((team) => (
              <div key={team.lead} className="flex flex-col items-center">
                <Connector height={20} />
                <div className="rounded-full border border-colony-ink/60 bg-white px-5 py-2 text-sm font-medium text-colony-ink">
                  {team.lead}
                </div>
                <Connector height={16} />
                <div className="flex gap-2">
                  {team.workers.map((worker) => (
                    <div
                      key={worker}
                      className="rounded-full bg-white/70 px-3.5 py-1.5 text-xs text-colony-ink/70"
                    >
                      {worker}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        <p className="mx-auto mt-12 max-w-xl text-sm leading-relaxed text-colony-ink/60 sm:text-base">
          Only what truly needs you reaches you. That's not a promise the
          agents try to keep — it's how the system is built.
        </p>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Wire into App.tsx**

```tsx
import { ChainOfCommand } from "@/sections/ChainOfCommand";
// ...
<Hero />
<Statement />
<ProductShowcase />
<ChainOfCommand />
<Cards />       {/* Jobs + CapabilitiesStrip slot in before Cards in Tasks 5–6 */}
```

- [ ] **Step 3: Visual check**

```bash
cd site && pnpm install 2>&1 | tail -1 && pnpm build && pnpm preview --port 4180
```

Screenshot the section (Playwright one-liner from `desktop/` per the repo note that scripts must live there), Read the PNG, fix connector alignment issues (the horizontal rail + vertical stubs must meet; adjust with negative margins if the grid gap floats them apart). Mobile (390px wide): teams stack — verify no rail orphan.

- [ ] **Step 4: Commit**

```bash
git add site/src/sections/ChainOfCommand.tsx site/src/App.tsx
git commit -s -m "feat(site): add the chain-of-command centerpiece section"
```

---

### Task 4: Jobs section — three alternating rows

**Files:**
- Create: `site/src/sections/Jobs.tsx`
- Modify: `site/src/App.tsx`

**Interfaces:**
- Consumes: Task 1 assets (`discovery-pipeline.png`, `outreach-approval.png`, `work-delivered.png` in `site/src/assets/`).
- Produces: `export function Jobs()`; App renders it after `<ChainOfCommand />`.

- [ ] **Step 1: Create the component**

```tsx
// site/src/sections/Jobs.tsx
// Three jobs, three real screenshots — the funnel arc: find customers,
// reach them safely, deliver the work. Every image is a seeded, regenerable
// capture (see desktop/tests/e2e/site-feature-screenshots.spec.ts) inside
// the same near-black frame the hero product shot established.
import deliveredShot from "@/assets/work-delivered.png";
import outreachShot from "@/assets/outreach-approval.png";
import pipelineShot from "@/assets/discovery-pipeline.png";

const FRAME = "#211f1f";

const JOBS = [
  {
    heading: "Wake up to a full pipeline",
    body: "Your agents search your market, qualify who fits, and score every lead — new customers found for you, every day.",
    image: pipelineShot,
    alt: "A Colony campaign for auto repair shops: a table of scored leads with owners, statuses, and contact details.",
  },
  {
    heading: "Nothing goes out without your OK",
    body: "Outreach waits in a queue until you approve it. Nothing reaches a customer without your OK.",
    image: outreachShot,
    alt: "Colony's outreach queue: drafts awaiting approval, each with an Approve button, and a metric card counting drafts ready.",
  },
  {
    heading: "The work shows up done",
    body: "Website updates, social posts, candidate shortlists, client deliverables — finished work arrives in the conversation, ready for you to review.",
    image: deliveredShot,
    alt: "An agent reports a finished website update in a Colony channel; a teammate replies 'Publish it' and reactions land on the message.",
  },
];

export function Jobs() {
  return (
    <section className="bg-colony-canvasLight px-6 py-20 sm:py-28">
      <div className="mx-auto flex max-w-6xl flex-col gap-20 sm:gap-28">
        {JOBS.map((job, index) => (
          <div
            key={job.heading}
            className="grid items-center gap-8 lg:grid-cols-2 lg:gap-14"
          >
            <div
              className={index % 2 === 1 ? "lg:order-2" : undefined}
            >
              <h3 className="text-2xl font-semibold leading-tight tracking-tight text-colony-ink sm:text-3xl">
                {job.heading}
              </h3>
              <p className="mt-4 max-w-md text-base leading-relaxed text-colony-ink/70 sm:text-lg">
                {job.body}
              </p>
            </div>
            <div
              className="rounded-3xl p-3 shadow-xl shadow-colony-ink/15 sm:p-6"
              style={{ backgroundColor: FRAME }}
            >
              <img
                src={job.image}
                alt={job.alt}
                className="w-full rounded-xl"
                loading="lazy"
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Wire into App.tsx after ChainOfCommand**

- [ ] **Step 3: Build + visual check** — rows alternate on desktop, stack image-below-text on mobile; screenshots legible at rendered width (they are 2x captures).

- [ ] **Step 4: Commit**

```bash
git add site/src/sections/Jobs.tsx site/src/App.tsx
git commit -s -m "feat(site): add the three-jobs section with seeded product shots"
```

---

### Task 5: CapabilitiesStrip section

**Files:**
- Create: `site/src/sections/CapabilitiesStrip.tsx`
- Modify: `site/src/App.tsx`

**Interfaces:**
- Produces: `export function CapabilitiesStrip()`; App renders it after `<Jobs />`, before `<Cards />`.

- [ ] **Step 1: Create the component**

```tsx
// site/src/sections/CapabilitiesStrip.tsx
// Breadth reassurance in one calm row. Four claims, all verified in-product:
// huddles (with add-agent-to-call), search, media sharing, and the three
// desktop platforms the Download section already serves. No mobile claim —
// the mobile app is not publicly released.
const CAPABILITIES = [
  "Voice calls — agents included",
  "Everything searchable",
  "Files and images",
  "Mac, Windows, and Linux",
];

export function CapabilitiesStrip() {
  return (
    <section className="bg-colony-canvasMid px-6 py-14 sm:py-16">
      <div className="mx-auto max-w-4xl text-center">
        <p className="text-sm font-medium uppercase tracking-wide text-colony-ink/60">
          And everything a workspace needs
        </p>
        <ul className="mt-6 flex flex-wrap items-center justify-center gap-3">
          {CAPABILITIES.map((capability) => (
            <li
              key={capability}
              className="rounded-full bg-white px-5 py-2.5 text-sm font-medium text-colony-ink shadow-sm shadow-colony-ink/5"
            >
              {capability}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Wire into App.tsx; final order**

```tsx
<Hero />
<Statement />
<ProductShowcase />
<ChainOfCommand />
<Jobs />
<CapabilitiesStrip />
<Cards />
<Download />
<Footer />
```

- [ ] **Step 3: Commit**

```bash
git add site/src/sections/CapabilitiesStrip.tsx site/src/App.tsx
git commit -s -m "feat(site): add the capabilities strip"
```

---

### Task 6: Cards copy rewrite (starter team)

**Files:**
- Modify: `site/src/sections/Cards.tsx` (CARDS array + section `<h2>` only; layout, trails, art untouched)

- [ ] **Step 1: Replace the heading and CARDS entries**

`<h2>`: `Meet your first three hires.`

```tsx
const CARDS = [
  {
    art: scoutArt,
    title: "Scout finds your customers",
    body: "Researches your market and fills your pipeline with people worth talking to.",
  },
  {
    art: foragerArt,
    title: "Forager brings the work home",
    body: "Drafts the outreach and follows up — always with your sign-off.",
  },
  {
    art: tenderArt,
    title: "Tender keeps everything moving",
    body: "Tracks the team's work and makes sure nothing stalls or slips.",
  },
];
```

Order = in-app kickoff order (Scout, Forager, Tender per `STARTER_PERSONA_ORDER`). Keep art imports; reorder array entries only.

- [ ] **Step 2: Commit**

```bash
git add site/src/sections/Cards.tsx
git commit -s -m "feat(site): recast the starter-team cards as first hires"
```

---

### Task 7: Full-page verification

**Files:**
- Create (throwaway, not committed): `desktop/scripts/site-scroll-shots.mjs` or inline Playwright via `node -e` from `desktop/` (Playwright resolves from desktop/)

- [ ] **Step 1: Build + preview**

```bash
cd site && pnpm build && (pnpm preview --port 4180 &) && sleep 2
```

- [ ] **Step 2: Scroll-capture the full page at 1280px and 390px**

From `desktop/` (module resolution), Playwright script: viewport 1280x800, goto `http://localhost:4173 (or 4180)`, capture at scroll offsets 0, 800, 1600, … to page bottom; repeat at 390x844. Read every PNG.

- [ ] **Step 3: Designer pass**

Check: section color rhythm (no two identical adjacent tints), heading scale consistency (section h2s match Statement's ramp), dark frames aligned across ProductShowcase/Jobs, org chart connectors meet their chips, copy-law sweep (`grep -rn -iE "\bgit\b|workflow|canvas|relay" site/src/sections/` returns only code identifiers/comments, no user-facing strings), no layout overflow at 390px.

- [ ] **Step 4: Kill preview server**

---

### Task 8: Gates, PR, merge

- [ ] **Step 1: Local gates**

```bash
cd /Users/mac/Desktop/Billion/AI-Native-Ventures-App-worktrees/landing-page-v2
. ./bin/activate-hermit
pnpm -C site build            # site type/build gate
pnpm -C desktop exec biome check tests/e2e/site-feature-screenshots.spec.ts
cd desktop && pnpm build:e2e && pnpm exec playwright test tests/e2e/site-feature-screenshots.spec.ts --project=smoke
```

All existing captures in the file must still pass (regression on the hero shot machinery).

- [ ] **Step 2: Push + PR to develop**

```bash
git push -u origin feat/landing-page-v2
gh pr create --repo AI-Native-Ventures/Colony --base develop \
  --title "feat(site): landing page v2 — sell real work to a business owner" \
  --body "<summary + spec link>"
```

(`gh` defaults to upstream block/buzz — always pass `--repo AI-Native-Ventures/Colony`.)

- [ ] **Step 3: PR screenshots**

`./scripts/post-screenshots.sh <pr> <dir-with-page-shots> <body.md>` with `{{filename}}` placeholders. Never relay-hosted URLs.

- [ ] **Step 4: Merge** (develop PRs run no CI; local gates above are the contract)

```bash
gh pr merge <pr> --repo AI-Native-Ventures/Colony --squash
```

---

### Task 9: Deploy + live proof

- [ ] **Step 1: Deploy from the merged develop state**

```bash
cd /Users/mac/Desktop/Billion/AI-Native-Ventures-App-worktrees/landing-page-v2
git checkout develop && git pull
pnpm -C site build
npx wrangler pages deploy site/dist --project-name colony-site --branch main
```

- [ ] **Step 2: Live verify with a real browser, bare URL**

Restart the gstack browse daemon first (it has served stale renders after deploys). Load `https://colony.ainative.ventures` with no query string, scroll-capture all sections, Read the PNGs. Confirm the three new screenshots render (content-hashed filenames — check the HTML references new hashes). curl alone is not verification.

- [ ] **Step 3: Client report**

Before/after full-page captures, live URL, what shipped, capture-regeneration one-liner, worktree/branch cleanup status.

---

## Self-Review

- Spec coverage: statement ✓ (T2), chain of command ✓ (T3), jobs+shots ✓ (T1,T4), strip ✓ (T5), cards ✓ (T6), hero/download untouched ✓ (constraint), deploy ✓ (T9). Gap: none.
- Placeholders: none — all copy and code literal.
- Type consistency: section exports are zero-prop `export function X()`; asset filenames in T1 Step 4 match T4 imports exactly.
