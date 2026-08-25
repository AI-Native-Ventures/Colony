# Onboarding Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the developer-facing first run with a ten-screen flow a non-technical founder can finish, branching on whether they already have an agent installed.

**Architecture:** A pure flow module owns step order, branching, back targets and resume. Screens are presentational and take props only, so every rule is unit-testable without rendering. External systems (auth, payments, website reading, invites) are consumed through one contracts module with hand-written fakes, so this plan ships and tests end to end before any of those exist.

**Tech Stack:** React 19, TypeScript, Tailwind (compiled), Tauri 2, `@tanstack/react-query`, `node:test` for unit tests, Playwright for E2E.

**Spec:** `docs/superpowers/specs/2026-08-21-onboarding-redesign-design.md`

**Reference prototype:** `prototypes/onboarding/` is a clickable build of all ten screens with the agreed copy, layout and motion. Read `src/app.jsx` when a screen's structure is unclear. It is not app code and must not be imported.

## Global Constraints

Every task inherits these. They come from the spec, `CLAUDE.md`, and `docs/BRAND.md`.

- **No developer-facing words on screen.** No CLI, terminal, runtime, harness, ACP, API key, nsec, or private key. An agent runtime is a "brain". A runtime name appears only if the user already had it installed.
- **No assumption about the user's hardware.** Never "your Mac". Use "your computer".
- **No em dashes anywhere.** Not in UI copy, not in source comments, not in docs. Use commas, colons, or separate sentences.
- **Text sizes are rem only.** Use stock Tailwind tokens or `text-2xs` / `text-3xs` / `text-badge` / `text-title`. Never `text-[13px]` or `text-[0.9rem]`. Enforced by `pnpm check:px-text`.
- **Every animation needs a `prefers-reduced-motion: reduce` fallback**, gated per mechanism. CSS animation is switched off in CSS; a JS timer must be gated in JS.
- **Animate wrapper elements, never SVG children.** WebKit paints SVG children on the main thread, so a transform on a `<path>` freezes exactly while a loading gate is on screen.
- **Never trap the user.** Every blocking step has a timeout and a way forward. Every disabled primary button has visible text saying what is missing.
- **Files stay under 1000 lines**, enforced by `pnpm check:file-sizes`.
- **A `label` wrapping a custom component, or a wrapper div carrying a key
  handler, trips Biome's a11y rules.** Biome cannot see through a custom
  component to the native control inside it. Suppress with a `biome-ignore`
  comment that states why, matching the convention already used in
  `ChannelActivityPopover.tsx` and `SidebarProfileCard.tsx`.
- **Never use `autoFocus`.** Biome's `lint/a11y/noAutofocus` is error-level in
  this repo, so the pre-commit hook rejects it. Focus an element with a `ref`
  in an effect instead.
- **Commit with `git commit -s`.** The DCO check fails any commit without a sign-off.
- **Run one test file directly** while iterating. Activate hermit first, from
  the repo root, or node will not be on PATH in a fresh shell:
  `. ./bin/activate-hermit && cd desktop && node --import ./test-loader.mjs --experimental-strip-types --test <path>`.
  Do not use `pnpm test -- --test-name-pattern=...`: node still imports every
  `.test.mjs` in the suite before filtering, so it takes minutes, and a pattern
  silently matches fewer tests than it looks like it does. Run the whole suite
  with `pnpm test` once before the final commit of a task.

---

## File Structure

Everything new lives under `desktop/src/features/onboarding/`.

| File | Responsibility |
|---|---|
| `flow/steps.ts` | Step ids, order, branch resolution, back targets, resume rule. Pure. |
| `flow/persistence.ts` | Read and write flow answers through `safeStorage`. Pure over an injected storage. |
| `flow/validation.ts` | Email, password strength, website and description rules. Pure. |
| `flow/track.ts` | Turns the runtime catalog into `byo` or `colony`, with the probe timeout. Pure. |
| `contracts.ts` | Types plus fakes for auth, payments, scrape and invites. |
| `ui/new/OnboardingCanvas.tsx` | Gradient canvas, grain, step marker, foot trail. Chrome only. |
| `ui/new/screens/*.tsx` | One file per screen. Props in, callbacks out, no data fetching. |
| `ui/new/NewOnboardingFlow.tsx` | Wires the flow module to the screens and the contracts. |
| `newOnboardingFlag.ts` | Single switch that decides which flow `App.tsx` mounts. |

Screens are deliberately separate files: each is independently reviewable, and the directory keeps every file well under the size guard.

---

## Task 1: Flow module

**Files:**
- Create: `desktop/src/features/onboarding/flow/steps.ts`
- Test: `desktop/src/features/onboarding/flow/steps.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `type OnboardingStep`, `ONBOARDING_STEPS: readonly OnboardingStep[]`, `nextStep(current, answers): OnboardingStep | "done"`, `backStep(current): OnboardingStep | null`, `resumeStep(answers): OnboardingStep`.

- [ ] **Step 1: Write the failing test**

```javascript
// desktop/src/features/onboarding/flow/steps.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import {
  ONBOARDING_STEPS,
  backStep,
  nextStep,
  resumeStep,
} from "./steps.ts";

const base = {
  account: null,
  recoveryAcknowledged: false,
  company: null,
  track: null,
  brain: null,
  stage: null,
  hasWebsite: null,
  website: null,
  description: null,
  paid: false,
};

test("steps_are_ten_in_spec_order", () => {
  assert.equal(ONBOARDING_STEPS.length, 10);
  assert.equal(ONBOARDING_STEPS[0], "account");
  assert.equal(ONBOARDING_STEPS[8], "credits");
});

test("business_with_no_website_skips_the_reading_step", () => {
  const answers = { ...base, hasWebsite: false };
  assert.equal(nextStep("business", answers), "description");
});

test("business_with_a_website_goes_to_reading", () => {
  const answers = { ...base, hasWebsite: true, website: "example.com" };
  assert.equal(nextStep("business", answers), "reading");
});

test("back_skips_steps_that_do_work_on_entry", () => {
  // Landing back on reading would re-run the scrape and spend money again.
  assert.equal(backStep("description"), "business");
  // Landing back on the probe would re-probe, and on install would reinstall.
  assert.equal(backStep("business"), "company");
});

test("back_is_absent_where_it_has_no_meaning", () => {
  assert.equal(backStep("account"), null);
  assert.equal(backStep("recovery"), null);
  assert.equal(backStep("probing"), null);
});

test("resume_lands_on_the_first_unanswered_step", () => {
  const answers = {
    ...base,
    account: { email: "a@b.com" },
    recoveryAcknowledged: true,
  };
  assert.equal(resumeStep(answers), "company");
});

test("resume_reruns_probing_rather_than_restoring_a_partial_result", () => {
  const answers = {
    ...base,
    account: { email: "a@b.com" },
    recoveryAcknowledged: true,
    company: "Rosebank Auto Care",
  };
  assert.equal(resumeStep(answers), "probing");
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd desktop && node --import ./test-loader.mjs --experimental-strip-types --test src/features/onboarding/flow/steps.test.mjs`
Expected: FAIL, cannot find module `./steps.ts`.

- [ ] **Step 3: Write the implementation**

```typescript
// desktop/src/features/onboarding/flow/steps.ts

/** The ten screens, in the order the spec defines them. */
export const ONBOARDING_STEPS = [
  "account",
  "recovery",
  "company",
  "probing",
  "brain",
  "business",
  "reading",
  "description",
  "credits",
  "invite",
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export type OnboardingTrack = "byo" | "colony";

export type OnboardingAnswers = {
  account: { email: string } | null;
  recoveryAcknowledged: boolean;
  company: string | null;
  track: OnboardingTrack | null;
  brain: string | null;
  stage: "live" | "building" | null;
  hasWebsite: boolean | null;
  website: string | null;
  description: string | null;
  paid: boolean;
};

/**
 * Steps that do work the moment they are entered: probing reads the user's
 * computer, install writes to it, and reading spends Colony's own money on a
 * scrape. Back must never land on one of these, and resume must re-run them
 * rather than restore a half-finished result.
 */
const WORKING_STEPS: ReadonlySet<OnboardingStep> = new Set([
  "probing",
  "reading",
]);

export function nextStep(
  current: OnboardingStep,
  answers: OnboardingAnswers,
): OnboardingStep | "done" {
  if (current === "business" && answers.hasWebsite === false) {
    return "description";
  }
  const index = ONBOARDING_STEPS.indexOf(current);
  const next = ONBOARDING_STEPS[index + 1];
  return next ?? "done";
}

/**
 * Null means the screen shows no back control at all. Account and recovery
 * have nothing to go back to once the account exists, and the working steps
 * above must not be re-entered.
 */
const BACK_TARGETS: Partial<Record<OnboardingStep, OnboardingStep>> = {
  company: "account",
  business: "company",
  description: "business",
  credits: "description",
  invite: "credits",
};

export function backStep(current: OnboardingStep): OnboardingStep | null {
  return BACK_TARGETS[current] ?? null;
}

export function resumeStep(answers: OnboardingAnswers): OnboardingStep {
  if (!answers.account) return "account";
  if (!answers.recoveryAcknowledged) return "recovery";
  if (!answers.company) return "company";
  if (!answers.track) return "probing";
  if (!answers.brain) return "brain";
  if (answers.stage === null || answers.hasWebsite === null) return "business";
  if (answers.hasWebsite && !answers.description) return "reading";
  if (!answers.description) return "description";
  if (!answers.paid) return "credits";
  return "invite";
}

export function isWorkingStep(step: OnboardingStep): boolean {
  return WORKING_STEPS.has(step);
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd desktop && node --import ./test-loader.mjs --experimental-strip-types --test src/features/onboarding/flow/steps.test.mjs`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/features/onboarding/flow/steps.ts desktop/src/features/onboarding/flow/steps.test.mjs
git commit -s -m "feat(onboarding): flow module for step order, branching and resume"
```

---

## Task 2: Validation rules

**Files:**
- Create: `desktop/src/features/onboarding/flow/validation.ts`
- Test: `desktop/src/features/onboarding/flow/validation.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `isEmail(value: string): boolean`, `passwordShortfall(value: string): number`, `isWebsite(value: string): boolean`, `normaliseWebsite(value: string): string`, `descriptionShortfall(value: string): number`.

Shortfall functions return how many characters are still missing, so screens can render "6 more characters" rather than a dead button. The prototype audit found the silent minimum on both the password and the description fields, and that is the fix.

- [ ] **Step 1: Write the failing test**

```javascript
// desktop/src/features/onboarding/flow/validation.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import {
  descriptionShortfall,
  isEmail,
  isWebsite,
  normaliseWebsite,
  passwordShortfall,
} from "./validation.ts";

test("email_rejects_a_string_with_no_domain", () => {
  assert.equal(isEmail("not-an-email"), false);
  assert.equal(isEmail("a@b"), false);
  assert.equal(isEmail("aisha@rosebankauto.co.za"), true);
});

test("password_shortfall_counts_down_to_zero", () => {
  assert.equal(passwordShortfall(""), 10);
  assert.equal(passwordShortfall("abcd"), 6);
  assert.equal(passwordShortfall("colonyprototype"), 0);
});

test("website_rejects_a_bare_word_and_accepts_a_domain", () => {
  assert.equal(isWebsite("asdf"), false);
  assert.equal(isWebsite("rosebankautocare.co.za"), true);
  assert.equal(isWebsite("https://rosebankautocare.co.za/services"), true);
});

test("website_normalises_to_a_scheme_qualified_url", () => {
  assert.equal(
    normaliseWebsite("rosebankautocare.co.za"),
    "https://rosebankautocare.co.za",
  );
  assert.equal(
    normaliseWebsite("http://example.com/"),
    "http://example.com",
  );
});

test("description_shortfall_counts_trimmed_characters", () => {
  assert.equal(descriptionShortfall("   "), 20);
  assert.equal(descriptionShortfall("We fix cars in Joburg."), 0);
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd desktop && node --import ./test-loader.mjs --experimental-strip-types --test src/features/onboarding/flow/validation.test.mjs`
Expected: FAIL, cannot find module `./validation.ts`.

- [ ] **Step 3: Write the implementation**

```typescript
// desktop/src/features/onboarding/flow/validation.ts

/** Minimum password length. Mirrors the spec. */
export const PASSWORD_MIN = 10;
/** Minimum business description length. Mirrors the spec. */
export const DESCRIPTION_MIN = 20;

/**
 * Deliberately loose. These rules exist to catch a typo, not to argue with
 * anyone about what a valid address looks like.
 */
export function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test((value ?? "").trim());
}

export function passwordShortfall(value: string): number {
  return Math.max(0, PASSWORD_MIN - (value ?? "").length);
}

function stripScheme(value: string): string {
  return (value ?? "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
}

export function isWebsite(value: string): boolean {
  return /^([a-z0-9-]+\.)+[a-z]{2,}(\/.*)?$/i.test(stripScheme(value));
}

export function normaliseWebsite(value: string): string {
  const trimmed = (value ?? "").trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${stripScheme(trimmed)}`;
}

export function descriptionShortfall(value: string): number {
  return Math.max(0, DESCRIPTION_MIN - (value ?? "").trim().length);
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd desktop && node --import ./test-loader.mjs --experimental-strip-types --test src/features/onboarding/flow/validation.test.mjs`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/features/onboarding/flow/validation.ts desktop/src/features/onboarding/flow/validation.test.mjs
git commit -s -m "feat(onboarding): validation rules with shortfall counts"
```

---

## Task 3: Answer persistence

**Files:**
- Create: `desktop/src/features/onboarding/flow/persistence.ts`
- Test: `desktop/src/features/onboarding/flow/persistence.test.mjs`

**Interfaces:**
- Consumes: `OnboardingAnswers` from Task 1.
- Produces: `EMPTY_ANSWERS: OnboardingAnswers`, `loadAnswers(storage): OnboardingAnswers`, `saveAnswers(storage, answers): void`, `clearAnswers(storage): void`, `ONBOARDING_ANSWERS_KEY`.

Storage is injected rather than imported so tests need no browser. In the app, pass an adapter over `getStorageItem` / `setStorageItem` from `@/shared/lib/safeStorage`, which is already throw-safe on denied-storage origins.

- [ ] **Step 1: Write the failing test**

```javascript
// desktop/src/features/onboarding/flow/persistence.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_ANSWERS,
  clearAnswers,
  loadAnswers,
  saveAnswers,
} from "./persistence.ts";

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => void map.set(key, value),
    remove: (key) => void map.delete(key),
    _map: map,
  };
}

test("persistence_round_trips_answers", () => {
  const storage = fakeStorage();
  saveAnswers(storage, { ...EMPTY_ANSWERS, company: "Rosebank Auto Care" });
  assert.equal(loadAnswers(storage).company, "Rosebank Auto Care");
});

test("persistence_returns_empty_answers_when_nothing_is_stored", () => {
  assert.deepEqual(loadAnswers(fakeStorage()), EMPTY_ANSWERS);
});

test("persistence_survives_corrupt_json_rather_than_throwing", () => {
  // A half-written value must not brick first run for that profile.
  const storage = fakeStorage({ "colony.onboarding.answers": "{not json" });
  assert.deepEqual(loadAnswers(storage), EMPTY_ANSWERS);
});

test("persistence_ignores_unknown_keys_from_an_older_build", () => {
  const storage = fakeStorage({
    "colony.onboarding.answers": JSON.stringify({
      company: "Rosebank Auto Care",
      dinosaur: true,
    }),
  });
  const loaded = loadAnswers(storage);
  assert.equal(loaded.company, "Rosebank Auto Care");
  assert.equal("dinosaur" in loaded, false);
});

test("clear_removes_the_stored_answers", () => {
  const storage = fakeStorage();
  saveAnswers(storage, { ...EMPTY_ANSWERS, company: "X" });
  clearAnswers(storage);
  assert.deepEqual(loadAnswers(storage), EMPTY_ANSWERS);
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd desktop && node --import ./test-loader.mjs --experimental-strip-types --test src/features/onboarding/flow/persistence.test.mjs`
Expected: FAIL, cannot find module `./persistence.ts`.

- [ ] **Step 3: Write the implementation**

```typescript
// desktop/src/features/onboarding/flow/persistence.ts
import type { OnboardingAnswers } from "./steps";

export const ONBOARDING_ANSWERS_KEY = "colony.onboarding.answers";

export type AnswerStorage = {
  get: (key: string) => string | null;
  set: (key: string, value: string) => void;
  remove: (key: string) => void;
};

export const EMPTY_ANSWERS: OnboardingAnswers = {
  account: null,
  recoveryAcknowledged: false,
  company: null,
  track: null,
  brain: null,
  stage: null,
  hasWebsite: null,
  website: null,
  description: null,
  paid: false,
};

/**
 * Rebuilds a known-shaped object rather than trusting whatever is on disk.
 * A stored blob from an older build can carry keys this version has never
 * heard of, and passing those through would leak into the flow's branching.
 */
function coerce(raw: unknown): OnboardingAnswers {
  if (!raw || typeof raw !== "object") return { ...EMPTY_ANSWERS };
  const value = raw as Partial<OnboardingAnswers>;
  return {
    account: value.account ?? null,
    recoveryAcknowledged: value.recoveryAcknowledged === true,
    company: value.company ?? null,
    track: value.track ?? null,
    brain: value.brain ?? null,
    stage: value.stage ?? null,
    hasWebsite: value.hasWebsite ?? null,
    website: value.website ?? null,
    description: value.description ?? null,
    paid: value.paid === true,
  };
}

export function loadAnswers(storage: AnswerStorage): OnboardingAnswers {
  const stored = storage.get(ONBOARDING_ANSWERS_KEY);
  if (!stored) return { ...EMPTY_ANSWERS };
  try {
    return coerce(JSON.parse(stored));
  } catch {
    return { ...EMPTY_ANSWERS };
  }
}

export function saveAnswers(
  storage: AnswerStorage,
  answers: OnboardingAnswers,
): void {
  storage.set(ONBOARDING_ANSWERS_KEY, JSON.stringify(answers));
}

export function clearAnswers(storage: AnswerStorage): void {
  storage.remove(ONBOARDING_ANSWERS_KEY);
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd desktop && node --import ./test-loader.mjs --experimental-strip-types --test src/features/onboarding/flow/persistence.test.mjs`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/features/onboarding/flow/persistence.ts desktop/src/features/onboarding/flow/persistence.test.mjs
git commit -s -m "feat(onboarding): persist answers so a crash resumes mid-flow"
```

---

## Task 4: Track resolution and the probe budget

**Files:**
- Create: `desktop/src/features/onboarding/flow/track.ts`
- Test: `desktop/src/features/onboarding/flow/track.test.mjs`

**Interfaces:**
- Consumes: `resolveAgentReadiness` from `@/features/onboarding/ui/agentReadiness`, `AcpRuntimeCatalogEntry` and `GlobalAgentConfig` from `@/shared/api/types`, `OnboardingTrack` from Task 1.
- Produces: `resolveTrack(runtimes, config): { track: OnboardingTrack; installed: string[] }`, `withProbeBudget<T>(promise, ms, fallback): Promise<T>`, `PROBE_BUDGET_MS`.

Reuses the existing readiness logic rather than writing a second detector. The new part is the budget: a hung binary must cost the flow at most eight seconds.

- [ ] **Step 1: Write the failing test**

```javascript
// desktop/src/features/onboarding/flow/track.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { PROBE_BUDGET_MS, resolveTrack, withProbeBudget } from "./track.ts";

function runtime(overrides = {}) {
  return {
    id: "claude-code",
    label: "Claude Code",
    availability: "available",
    authStatus: { status: "logged_in" },
    avatarUrl: "",
    command: "claude",
    binaryPath: "/usr/local/bin/claude",
    defaultArgs: [],
    mcpCommand: null,
    installHint: "",
    installInstructionsUrl: "https://example.com",
    canAutoInstall: false,
    underlyingCliPath: null,
    nodeRequired: false,
    loginHint: null,
    ...overrides,
  };
}

const emptyConfig = { agents: {}, defaults: {} };

test("track_is_byo_when_a_logged_in_runtime_exists", () => {
  const result = resolveTrack([runtime()], emptyConfig);
  assert.equal(result.track, "byo");
  assert.deepEqual(result.installed, ["Claude Code"]);
});

test("track_is_colony_when_nothing_is_available", () => {
  const result = resolveTrack(
    [runtime({ availability: "missing" })],
    emptyConfig,
  );
  assert.equal(result.track, "colony");
  assert.deepEqual(result.installed, []);
});

test("track_ignores_a_runtime_that_is_present_but_not_logged_in", () => {
  // Installed but unusable is the same as absent for a non-technical user:
  // we must not offer a brain that cannot answer.
  const result = resolveTrack(
    [runtime({ authStatus: { status: "logged_out" } })],
    emptyConfig,
  );
  assert.equal(result.track, "colony");
});

test("probe_budget_falls_back_when_the_probe_hangs", async () => {
  const hang = new Promise(() => {});
  const result = await withProbeBudget(hang, 20, "fallback");
  assert.equal(result, "fallback");
});

test("probe_budget_returns_the_real_value_when_it_arrives_in_time", async () => {
  const result = await withProbeBudget(Promise.resolve("real"), 50, "fallback");
  assert.equal(result, "real");
});

test("probe_budget_is_eight_seconds", () => {
  assert.equal(PROBE_BUDGET_MS, 8000);
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd desktop && node --import ./test-loader.mjs --experimental-strip-types --test src/features/onboarding/flow/track.test.mjs`
Expected: FAIL, cannot find module `./track.ts`.

- [ ] **Step 3: Write the implementation**

```typescript
// desktop/src/features/onboarding/flow/track.ts
import { resolveAgentReadiness } from "@/features/onboarding/ui/agentReadiness";
import type {
  AcpRuntimeCatalogEntry,
  GlobalAgentConfig,
} from "@/shared/api/types";
import type { OnboardingTrack } from "./steps";

/**
 * Whole-screen budget for detection. A binary that never answers costs the
 * flow this much and no more; anything still silent is treated as absent.
 */
export const PROBE_BUDGET_MS = 8000;

export type TrackResult = {
  track: OnboardingTrack;
  /** Labels of runtimes the user can actually use, for screen 5a. */
  installed: string[];
};

export function resolveTrack(
  runtimes: readonly AcpRuntimeCatalogEntry[],
  config: GlobalAgentConfig,
): TrackResult {
  const installed = runtimes
    .filter(
      (runtime) =>
        runtime.id !== "buzz-agent" &&
        runtime.availability === "available" &&
        (runtime.authStatus.status === "logged_in" ||
          runtime.authStatus.status === "not_applicable"),
    )
    .map((runtime) => runtime.label);

  const readiness = resolveAgentReadiness(runtimes, config, "any");
  const track: OnboardingTrack =
    readiness.ready && readiness.reason === "cli" ? "byo" : "colony";

  return { track: installed.length ? track : "colony", installed };
}

export function withProbeBudget<T>(
  probe: Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    probe
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(fallback);
      });
  });
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd desktop && node --import ./test-loader.mjs --experimental-strip-types --test src/features/onboarding/flow/track.test.mjs`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/features/onboarding/flow/track.ts desktop/src/features/onboarding/flow/track.test.mjs
git commit -s -m "feat(onboarding): resolve the branch from installed agents, with a probe budget"
```

---

## Task 5: External contracts and fakes

**Files:**
- Create: `desktop/src/features/onboarding/contracts.ts`
- Create: `desktop/src/features/onboarding/contracts.fake.ts`
- Test: `desktop/src/features/onboarding/contracts.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `type OnboardingServices` with members `auth`, `payments`, `scrape`, `invites`; `createFakeServices(overrides?): OnboardingServices`; `type ScrapeResult`.

Every screen takes services as a prop. That is what lets this plan ship before auth, payments, scraping or invites exist, and it is what makes the failure paths testable without a network.

- [ ] **Step 1: Write the failing test**

```javascript
// desktop/src/features/onboarding/contracts.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { createFakeServices } from "./contracts.fake.ts";

test("fake_auth_returns_a_recovery_code", async () => {
  const services = createFakeServices();
  const result = await services.auth.signUp("a@b.com", "colonyprototype");
  assert.match(result.recoveryCode, /^[A-Z0-9-]{8,}$/);
});

test("fake_scrape_can_be_told_to_fail_with_a_typed_reason", async () => {
  const services = createFakeServices({ scrapeOutcome: "unreachable" });
  const result = await services.scrape.describeBusiness("https://example.com");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unreachable");
});

test("fake_payments_reports_an_abandoned_checkout", async () => {
  const services = createFakeServices({ paymentOutcome: "abandoned" });
  const started = await services.payments.createTransaction(500, "a@b.com");
  const verified = await services.payments.verify(started.reference);
  assert.equal(verified.paid, false);
});

test("fake_payments_credits_the_balance_on_success", async () => {
  const services = createFakeServices();
  const started = await services.payments.createTransaction(500, "a@b.com");
  await services.payments.verify(started.reference);
  const balance = await services.payments.balance("pubkey");
  assert.equal(balance.usdCents, 500);
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd desktop && node --import ./test-loader.mjs --experimental-strip-types --test src/features/onboarding/contracts.test.mjs`
Expected: FAIL, cannot find module `./contracts.fake.ts`.

- [ ] **Step 3: Write the implementation**

```typescript
// desktop/src/features/onboarding/contracts.ts

export type SignUpResult = {
  pubkey: string;
  recoveryCode: string;
};

/** Typed failures, so a screen never has to parse an error string. */
export type ScrapeFailureReason =
  | "unreachable"
  | "blocked"
  | "empty"
  | "timeout";

export type ScrapeResult =
  | { ok: true; description: string; sourcePages: string[] }
  | { ok: false; reason: ScrapeFailureReason };

export type OnboardingServices = {
  auth: {
    signUp: (email: string, password: string) => Promise<SignUpResult>;
  };
  payments: {
    /** Amount is USD cents. $5.00 is 500. Everything is USD, nothing converts. */
    createTransaction: (
      usdCents: number,
      email: string,
    ) => Promise<{ authorizationUrl: string; reference: string }>;
    verify: (reference: string) => Promise<{ paid: boolean; usdCents: number }>;
    balance: (pubkey: string) => Promise<{ usdCents: number }>;
  };
  scrape: {
    describeBusiness: (url: string) => Promise<ScrapeResult>;
  };
  invites: {
    invite: (emails: string[]) => Promise<{ sent: number }>;
  };
};
```

```typescript
// desktop/src/features/onboarding/contracts.fake.ts
import type { OnboardingServices, ScrapeFailureReason } from "./contracts";

export type FakeOptions = {
  scrapeOutcome?: "ok" | ScrapeFailureReason;
  paymentOutcome?: "paid" | "abandoned";
  delayMs?: number;
};

const SAMPLE_DESCRIPTION =
  "Rosebank Auto Care is an independent vehicle workshop in Johannesburg. " +
  "You handle servicing, diagnostics and repairs for private owners and " +
  "small fleets, with a 48 hour turnaround on most jobs.";

/**
 * Hand-written fakes, not mocks: the flow is built and tested against these
 * until the real auth, payments, scrape and invite services exist.
 */
export function createFakeServices(
  options: FakeOptions = {},
): OnboardingServices {
  const {
    scrapeOutcome = "ok",
    paymentOutcome = "paid",
    delayMs = 0,
  } = options;
  const wait = () =>
    delayMs ? new Promise((resolve) => setTimeout(resolve, delayMs)) : null;

  let balanceCents = 0;
  const pending = new Map<string, number>();

  return {
    auth: {
      signUp: async (email) => {
        await wait();
        return {
          pubkey: `fake-${email}`,
          recoveryCode: "TRAIL-9F2K-4QD8-MZ71",
        };
      },
    },
    payments: {
      createTransaction: async (usdCents) => {
        await wait();
        const reference = `ref_${pending.size + 1}`;
        pending.set(reference, usdCents);
        return {
          authorizationUrl: `https://checkout.example/${reference}`,
          reference,
        };
      },
      verify: async (reference) => {
        await wait();
        const amount = pending.get(reference) ?? 0;
        if (paymentOutcome === "abandoned") return { paid: false, usdCents: 0 };
        balanceCents += amount;
        return { paid: true, usdCents: amount };
      },
      balance: async () => {
        await wait();
        return { usdCents: balanceCents };
      },
    },
    scrape: {
      describeBusiness: async () => {
        await wait();
        if (scrapeOutcome === "ok") {
          return {
            ok: true,
            description: SAMPLE_DESCRIPTION,
            sourcePages: ["/", "/services"],
          };
        }
        return { ok: false, reason: scrapeOutcome };
      },
    },
    invites: {
      invite: async (emails) => {
        await wait();
        return { sent: emails.length };
      },
    },
  };
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd desktop && node --import ./test-loader.mjs --experimental-strip-types --test src/features/onboarding/contracts.test.mjs`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/features/onboarding/contracts.ts desktop/src/features/onboarding/contracts.fake.ts desktop/src/features/onboarding/contracts.test.mjs
git commit -s -m "feat(onboarding): service contracts with hand-written fakes"
```

---

## Task 6: Canvas chrome

**Files:**
- Create: `desktop/src/features/onboarding/ui/new/canvasTheme.ts`
- Create: `desktop/src/features/onboarding/ui/new/OnboardingCanvas.tsx`
- Create: `desktop/src/features/onboarding/ui/new/onboarding-canvas.css`
- Test: `desktop/src/features/onboarding/ui/new/canvasTheme.test.mjs`

**Interfaces:**
- Consumes: `OnboardingStep` from Task 1.
- Produces: `canvasFor(step, track): CanvasTheme`, `<OnboardingCanvas step track children>`.

The gradient shifts per screen and is the progress indicator. Port the values from `prototypes/onboarding/src/app.jsx` (the `CANVAS` map) and the styles from `prototypes/onboarding/app.css`.

- [ ] **Step 1: Write the failing test**

```javascript
// desktop/src/features/onboarding/ui/new/canvasTheme.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { canvasFor } from "./canvasTheme.ts";
import { ONBOARDING_STEPS } from "../../flow/steps.ts";

test("canvas_covers_every_step", () => {
  for (const step of ONBOARDING_STEPS) {
    const theme = canvasFor(step, "colony");
    assert.ok(theme.base, `no base colour for ${step}`);
    assert.ok(theme.mesh.length >= 2, `thin mesh for ${step}`);
  }
});

test("canvas_credits_is_the_only_dark_screen", () => {
  const dark = ONBOARDING_STEPS.filter(
    (step) => canvasFor(step, "colony").ink === "light",
  );
  assert.deepEqual(dark, ["credits"]);
});

test("canvas_brain_differs_by_track", () => {
  const byo = canvasFor("brain", "byo");
  const colony = canvasFor("brain", "colony");
  assert.notEqual(byo.base, colony.base);
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd desktop && node --import ./test-loader.mjs --experimental-strip-types --test src/features/onboarding/ui/new/canvasTheme.test.mjs`
Expected: FAIL, cannot find module `./canvasTheme.ts`.

- [ ] **Step 3: Write the implementation**

```typescript
// desktop/src/features/onboarding/ui/new/canvasTheme.ts
import type { OnboardingStep, OnboardingTrack } from "../../flow/steps";

/** Brand hues. Values verified against docs/BRAND.md. */
const HUE = {
  violet: "#8b5cf6",
  violetDeep: "#4c1d95",
  blue: "#3b82f6",
  pink: "#ec4899",
  pinkSoft: "#f9a8d4",
  amber: "#f59e0b",
  green: "#10b981",
  plum: "#6b1746",
  white: "#ffffff",
} as const;

export type MeshBlob = {
  color: string;
  x: string;
  y: string;
  radius: string;
};

export type CanvasTheme = {
  base: string;
  /** "dark" means dark ink on a light field. */
  ink: "dark" | "light";
  mesh: MeshBlob[];
};

const blob = (color: string, x: string, y: string, radius: string): MeshBlob => ({
  color,
  x,
  y,
  radius,
});

/**
 * One gradient per screen. The canvas shifting as the flow advances is the
 * progress indicator, which is why no step counter appears in the flow.
 * Credits is the only dark screen: it is the ask, and the dark field is what
 * makes it land.
 */
const THEMES: Record<string, CanvasTheme> = {
  account: {
    base: "#e9d9fb",
    ink: "dark",
    mesh: [
      blob(HUE.violet, "18%", "22%", "58%"),
      blob(HUE.pinkSoft, "78%", "72%", "62%"),
      blob(HUE.white, "50%", "45%", "40%"),
    ],
  },
  recovery: {
    base: "#c4b0f5",
    ink: "dark",
    mesh: [
      blob(HUE.violet, "30%", "70%", "66%"),
      blob(HUE.violetDeep, "82%", "24%", "48%"),
      blob(HUE.white, "44%", "40%", "30%"),
    ],
  },
  company: {
    base: "#f7d9c4",
    ink: "dark",
    mesh: [
      blob(HUE.pink, "22%", "18%", "56%"),
      blob(HUE.amber, "76%", "76%", "64%"),
      blob(HUE.white, "52%", "42%", "36%"),
    ],
  },
  probing: {
    base: "#cfe4f7",
    ink: "dark",
    mesh: [
      blob(HUE.blue, "24%", "26%", "62%"),
      blob(HUE.green, "80%", "74%", "58%"),
      blob(HUE.white, "48%", "46%", "38%"),
    ],
  },
  "brain:byo": {
    base: "#c9edda",
    ink: "dark",
    mesh: [
      blob(HUE.green, "26%", "30%", "62%"),
      blob(HUE.blue, "82%", "80%", "46%"),
      blob(HUE.white, "52%", "44%", "40%"),
    ],
  },
  "brain:colony": {
    base: "#cbdcfa",
    ink: "dark",
    mesh: [
      blob(HUE.blue, "20%", "24%", "60%"),
      blob(HUE.violet, "80%", "76%", "58%"),
      blob(HUE.white, "50%", "46%", "36%"),
    ],
  },
  business: {
    base: "#f8dfb4",
    ink: "dark",
    mesh: [
      blob(HUE.amber, "24%", "72%", "62%"),
      blob(HUE.pinkSoft, "78%", "22%", "54%"),
      blob(HUE.white, "48%", "44%", "38%"),
    ],
  },
  reading: {
    base: "#c7e9e2",
    ink: "dark",
    mesh: [
      blob(HUE.green, "22%", "24%", "60%"),
      blob(HUE.blue, "78%", "72%", "60%"),
      blob(HUE.white, "50%", "48%", "36%"),
    ],
  },
  description: {
    base: "#f6e2ee",
    ink: "dark",
    mesh: [
      blob(HUE.white, "40%", "34%", "52%"),
      blob(HUE.pink, "80%", "76%", "56%"),
      blob(HUE.violet, "16%", "78%", "44%"),
    ],
  },
  credits: {
    base: "#3d0a2a",
    ink: "light",
    mesh: [
      blob(HUE.plum, "28%", "30%", "66%"),
      blob(HUE.violetDeep, "78%", "74%", "62%"),
      blob(HUE.pink, "62%", "18%", "34%"),
    ],
  },
  invite: {
    base: "#e6dafb",
    ink: "dark",
    mesh: [
      blob(HUE.violet, "22%", "26%", "58%"),
      blob(HUE.pink, "80%", "74%", "56%"),
      blob(HUE.white, "50%", "50%", "40%"),
    ],
  },
};

export function canvasFor(
  step: OnboardingStep,
  track: OnboardingTrack,
): CanvasTheme {
  if (step === "brain") return THEMES[`brain:${track}`];
  return THEMES[step];
}
```

Then the component. Copy `.ob-canvas`, `.ob-mesh`, `.ob-streak`, `.ob-grain`, `.ob-step`, `.ob-foot`, `.ob-trail` and the ant gait rules from `prototypes/onboarding/app.css` into `onboarding-canvas.css`, renaming the `ob-` prefix to `onb-`. Wrap the file in `@layer components`, per `docs/BRAND.md`: unlayered CSS beats Tailwind's utilities regardless of specificity and would silently defeat call-site overrides.

```tsx
// desktop/src/features/onboarding/ui/new/OnboardingCanvas.tsx
import type { ReactNode } from "react";
import type { OnboardingStep, OnboardingTrack } from "../../flow/steps";
import { ONBOARDING_STEPS } from "../../flow/steps";
import { canvasFor } from "./canvasTheme";
import "./onboarding-canvas.css";

type Props = {
  step: OnboardingStep;
  track: OnboardingTrack;
  children: ReactNode;
};

export function OnboardingCanvas({ step, track, children }: Props) {
  const theme = canvasFor(step, track);
  const index = ONBOARDING_STEPS.indexOf(step);
  const mesh = theme.mesh
    .map(
      (b) =>
        `radial-gradient(circle at ${b.x} ${b.y}, ${b.color} 0%, transparent ${b.radius})`,
    )
    .join(",");

  return (
    <div
      className={`onb-canvas ${theme.ink === "light" ? "dark" : ""}`}
      data-ink={theme.ink}
      style={{ background: theme.base }}
    >
      <div className="onb-mesh" style={{ background: mesh }} />
      <div className="onb-streak" />
      <div className="onb-grain" />
      <p className="onb-step">
        {String(index + 1).padStart(2, "0")} / {ONBOARDING_STEPS.length}
      </p>
      <div className="onb-stage">{children}</div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd desktop && node --import ./test-loader.mjs --experimental-strip-types --test src/features/onboarding/ui/new/canvasTheme.test.mjs`
Expected: PASS, 3 tests.

- [ ] **Step 5: Check the guards**

Run: `cd desktop && pnpm check:px-text && pnpm check:file-sizes`
Expected: both pass. If `check:px-text` fails, a px or arbitrary rem literal came across from the prototype. Replace it with a stock token.

- [ ] **Step 6: Commit**

```bash
git add desktop/src/features/onboarding/ui/new/
git commit -s -m "feat(onboarding): gradient canvas chrome with per-step hues"
```

---

## Task 7: Account and recovery screens

**Files:**
- Create: `desktop/src/features/onboarding/ui/new/screens/AccountScreen.tsx`
- Create: `desktop/src/features/onboarding/ui/new/screens/RecoveryScreen.tsx`
- Test: `desktop/src/features/onboarding/ui/new/screens/accountGate.test.mjs`

**Interfaces:**
- Consumes: `isEmail`, `passwordShortfall` (Task 2), `OnboardingServices` (Task 5).
- Produces: `accountReady(values): boolean`, `<AccountScreen values onChange onSubmit />`, `<RecoveryScreen code acknowledged onAcknowledge onContinue />`.

Screens take values and callbacks. The gate itself is a pure exported function so it can be tested without rendering.

- [ ] **Step 1: Write the failing test**

```javascript
// desktop/src/features/onboarding/ui/new/screens/accountGate.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { accountReady } from "./AccountScreen.tsx";

const valid = {
  name: "Aisha Bello",
  email: "aisha@rosebankauto.co.za",
  password: "colonyprototype",
  city: "Johannesburg",
};

test("account_gate_requires_a_real_email", () => {
  assert.equal(accountReady(valid), true);
  assert.equal(accountReady({ ...valid, email: "not-an-email" }), false);
});

test("account_gate_requires_a_long_enough_password", () => {
  assert.equal(accountReady({ ...valid, password: "short" }), false);
});

test("account_gate_does_not_require_a_city", () => {
  // City is prefilled from IP and is optional. Nothing blocks on it.
  assert.equal(accountReady({ ...valid, city: "" }), true);
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd desktop && node --import ./test-loader.mjs --experimental-strip-types --test src/features/onboarding/ui/new/screens/accountGate.test.mjs`
Expected: FAIL, cannot find module `./AccountScreen.tsx`.

- [ ] **Step 3: Write the implementation**

```tsx
// desktop/src/features/onboarding/ui/new/screens/AccountScreen.tsx
import { useState } from "react";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Progress } from "@/shared/ui/progress";
import {
  PASSWORD_MIN,
  isEmail,
  passwordShortfall,
} from "../../../flow/validation";

export type AccountValues = {
  name: string;
  email: string;
  password: string;
  city: string;
};

export function accountReady(values: AccountValues): boolean {
  return (
    values.name.trim().length > 0 &&
    isEmail(values.email) &&
    passwordShortfall(values.password) === 0
  );
}

type Props = {
  values: AccountValues;
  onChange: (patch: Partial<AccountValues>) => void;
  onSubmit: () => void;
  isSubmitting: boolean;
};

export function AccountScreen({
  values,
  onChange,
  onSubmit,
  isSubmitting,
}: Props) {
  const [emailTouched, setEmailTouched] = useState(false);
  const ready = accountReady(values);
  const shortfall = passwordShortfall(values.password);

  return (
    <div className="onb-screen">
      <div className="onb-col-head">
        <h1 className="onb-headline">Welcome to the colony.</h1>
        <p className="onb-sub">
          A few quick questions and your workspace is ready.
        </p>
      </div>
      <div
        className="onb-panel"
        onKeyDown={(event) => {
          if (event.key === "Enter" && ready && !isSubmitting) onSubmit();
        }}
      >
        <label className="onb-field">
          <span className="onb-label">Your name</span>
          <Input
            value={values.name}
            placeholder="Aisha Bello"
            onChange={(e) => onChange({ name: e.target.value })}
          />
        </label>
        <label className="onb-field">
          <span className="onb-label">Email</span>
          <Input
            type="email"
            value={values.email}
            placeholder="you@company.com"
            onBlur={() => setEmailTouched(true)}
            onChange={(e) => onChange({ email: e.target.value })}
          />
          {emailTouched && values.email && !isEmail(values.email) ? (
            <p className="onb-note onb-note-warn">
              That does not look like an email address.
            </p>
          ) : null}
        </label>
        <label className="onb-field">
          <span className="onb-label">Password</span>
          <Input
            type="password"
            value={values.password}
            placeholder={`At least ${PASSWORD_MIN} characters`}
            onChange={(e) => onChange({ password: e.target.value })}
          />
          <Progress
            value={Math.min(100, (values.password.length / PASSWORD_MIN) * 100)}
          />
          <p className="onb-note">
            {shortfall === 0
              ? "Strong enough."
              : `${shortfall} more characters`}
          </p>
        </label>
        <label className="onb-field">
          <span className="onb-label">City</span>
          <Input
            value={values.city}
            onChange={(e) => onChange({ city: e.target.value })}
          />
          <p className="onb-note">Change it if we got it wrong.</p>
        </label>
      </div>
      <div className="onb-actions">
        <Button size="lg" disabled={!ready || isSubmitting} onClick={onSubmit}>
          {isSubmitting ? "Creating your account" : "Continue"}
        </Button>
      </div>
    </div>
  );
}
```

```tsx
// desktop/src/features/onboarding/ui/new/screens/RecoveryScreen.tsx
import { useState } from "react";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";

type Props = {
  code: string;
  acknowledged: boolean;
  onAcknowledge: (value: boolean) => void;
  onContinue: () => void;
};

export function RecoveryScreen({
  code,
  acknowledged,
  onAcknowledge,
  onContinue,
}: Props) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // Clipboard access can be denied. Selecting the text still works, so
      // the label change is the only feedback that matters here.
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2200);
  };

  const save = () => {
    const blob = new Blob(
      [`Colony recovery code\n\n${code}\n\nKeep this somewhere safe.\n`],
      { type: "text/plain" },
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "colony-recovery-code.txt";
    anchor.click();
    URL.revokeObjectURL(url);
    setSaved(true);
  };

  return (
    <div className="onb-screen">
      <div className="onb-col-head">
        <h1 className="onb-headline">Keep this code somewhere safe.</h1>
        <p className="onb-sub">
          If you ever forget your password, this code is the only way back into
          your account. We cannot reset it for you.
        </p>
      </div>
      <div className="onb-panel">
        <p className="onb-code">{code}</p>
        <div className="onb-row">
          <Button variant="outline" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button variant="outline" onClick={save}>
            {saved ? "Saved" : "Save as file"}
          </Button>
        </div>
        <label className="onb-check">
          <Checkbox
            checked={acknowledged}
            onCheckedChange={(value) => onAcknowledge(value === true)}
          />
          <span className="onb-label">I have saved my code</span>
        </label>
      </div>
      <div className="onb-actions">
        <Button size="lg" disabled={!acknowledged} onClick={onContinue}>
          Continue
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd desktop && node --import ./test-loader.mjs --experimental-strip-types --test src/features/onboarding/ui/new/screens/accountGate.test.mjs`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/features/onboarding/ui/new/screens/
git commit -s -m "feat(onboarding): account and recovery screens"
```

---

## Task 8: Company, probing and brain screens

**Files:**
- Create: `desktop/src/features/onboarding/ui/new/screens/CompanyScreen.tsx`
- Create: `desktop/src/features/onboarding/ui/new/screens/ProbingScreen.tsx`
- Create: `desktop/src/features/onboarding/ui/new/screens/BrainScreen.tsx`
- Create: `desktop/src/features/onboarding/ui/new/WalkingAnt.tsx`
- Test: `desktop/src/features/onboarding/ui/new/screens/probingCopy.test.mjs`

**Interfaces:**
- Consumes: `resolveTrack`, `withProbeBudget`, `PROBE_BUDGET_MS` (Task 4).
- Produces: `PROBE_LINES: string[]`, `<CompanyScreen />`, `<ProbingScreen onResolved />`, `<BrainScreen installed selected onSelect onContinue />`.

`WalkingAnt` is a straight port of `site/src/brand/WalkingAnt.tsx`: leg tripods as HTML wrappers, geometry from `docs/BRAND.md`. Do not re-derive the path data.

- [ ] **Step 1: Write the failing test**

```javascript
// desktop/src/features/onboarding/ui/new/screens/probingCopy.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { PROBE_LINES } from "./ProbingScreen.tsx";

test("probing_copy_says_what_it_actually_does", () => {
  // This screen reads the user's filesystem. Copy says so, because the
  // cheerful alternative is a lie the product would have to keep.
  assert.ok(
    PROBE_LINES.some((line) => /already on your computer/i.test(line)),
    "no line tells the user their computer is being checked",
  );
});

test("probing_copy_never_names_a_developer_concept", () => {
  const banned = /\b(CLI|terminal|runtime|harness|ACP|binary|PATH)\b/i;
  for (const line of PROBE_LINES) {
    assert.ok(!banned.test(line), `developer word in: ${line}`);
  }
});

test("probing_copy_never_assumes_the_users_hardware", () => {
  for (const line of PROBE_LINES) {
    assert.ok(!/\bmac\b/i.test(line), `hardware assumption in: ${line}`);
  }
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd desktop && node --import ./test-loader.mjs --experimental-strip-types --test src/features/onboarding/ui/new/screens/probingCopy.test.mjs`
Expected: FAIL, cannot find module `./ProbingScreen.tsx`.

- [ ] **Step 3: Write the implementation**

```tsx
// desktop/src/features/onboarding/ui/new/screens/ProbingScreen.tsx
import { useEffect, useState } from "react";
import { useAcpRuntimesQuery } from "@/features/agents/hooks";
import { WalkingAnt } from "../WalkingAnt";
import { PROBE_BUDGET_MS, resolveTrack } from "../../../flow/track";
import type { TrackResult } from "../../../flow/track";
import type { GlobalAgentConfig } from "@/shared/api/types";

export const PROBE_LINES = [
  "Building your workspace",
  "Checking what is already on your computer",
  "Getting your agents ready",
];

/** Minimum time on screen, so a fast probe reads as a step and not a flash. */
const MIN_VISIBLE_MS = 2000;

type Props = {
  globalConfig: GlobalAgentConfig;
  reducedMotion: boolean;
  onResolved: (result: TrackResult) => void;
};

export function ProbingScreen({
  globalConfig,
  reducedMotion,
  onResolved,
}: Props) {
  const runtimes = useAcpRuntimesQuery();
  const [line, setLine] = useState(0);

  useEffect(() => {
    if (reducedMotion) return undefined;
    const id = setInterval(
      () => setLine((current) => Math.min(current + 1, PROBE_LINES.length - 1)),
      1150,
    );
    return () => clearInterval(id);
  }, [reducedMotion]);

  useEffect(() => {
    const started = Date.now();
    let cancelled = false;

    const settle = (result: TrackResult) => {
      if (cancelled) return;
      const elapsed = Date.now() - started;
      const hold = Math.max(0, MIN_VISIBLE_MS - elapsed);
      setTimeout(() => {
        if (!cancelled) onResolved(result);
      }, hold);
    };

    // The whole screen is capped. A binary that never answers is treated as
    // absent rather than being allowed to end onboarding.
    const budget = setTimeout(
      () => settle({ track: "colony", installed: [] }),
      PROBE_BUDGET_MS,
    );

    if (runtimes.data) {
      clearTimeout(budget);
      settle(resolveTrack(runtimes.data, globalConfig));
    }

    return () => {
      cancelled = true;
      clearTimeout(budget);
    };
  }, [runtimes.data, globalConfig, onResolved]);

  return (
    <div className="onb-screen" data-solo="true">
      <div className="onb-col-head">
        <h1 className="onb-headline">Getting things ready.</h1>
      </div>
      <div className="onb-search" aria-hidden="true">
        <WalkingAnt className="onb-search-ant" />
      </div>
      <p className="onb-status" aria-live="polite">
        {PROBE_LINES[line]}
      </p>
    </div>
  );
}
```

`CompanyScreen` mirrors `AccountScreen`: one `Input`, Enter submits, `Back` present, primary disabled until the name is non-empty, headline "Now, your company." and button "Create workspace".

`BrainScreen` renders `installed` as selectable rows with a liveness dot, headline "You are already set up.", sub "We found these on your computer. Pick the one your agents should think with. You can change it any time." No runtime is named unless it came back from the probe.

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd desktop && node --import ./test-loader.mjs --experimental-strip-types --test src/features/onboarding/ui/new/screens/probingCopy.test.mjs`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/features/onboarding/ui/new/
git commit -s -m "feat(onboarding): company, probing and brain screens"
```

---

## Task 9: Colony agent install screen

**Files:**
- Create: `desktop/src/features/onboarding/ui/new/screens/InstallScreen.tsx`
- Test: `desktop/src/features/onboarding/ui/new/screens/installState.test.mjs`

**Interfaces:**
- Consumes: `WalkingAnt` (Task 8).
- Produces: `type InstallState`, `nextInstallState(current, event): InstallState`, `<InstallScreen state onRetry onContinueAnyway />`.

- [ ] **Step 1: Write the failing test**

```javascript
// desktop/src/features/onboarding/ui/new/screens/installState.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { nextInstallState } from "./InstallScreen.tsx";

test("install_failure_offers_a_way_forward", () => {
  const failed = nextInstallState("running", { type: "failed" });
  assert.equal(failed, "failed");
  // Never a dead end: retry, or continue into a degraded workspace.
  assert.equal(nextInstallState("failed", { type: "retry" }), "running");
  assert.equal(nextInstallState("failed", { type: "skip" }), "degraded");
});

test("install_success_moves_on", () => {
  assert.equal(nextInstallState("running", { type: "succeeded" }), "done");
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd desktop && node --import ./test-loader.mjs --experimental-strip-types --test src/features/onboarding/ui/new/screens/installState.test.mjs`
Expected: FAIL, cannot find module `./InstallScreen.tsx`.

- [ ] **Step 3: Write the implementation**

```tsx
// desktop/src/features/onboarding/ui/new/screens/InstallScreen.tsx
import { Button } from "@/shared/ui/button";
import { Progress } from "@/shared/ui/progress";
import { WalkingAnt } from "../WalkingAnt";

export type InstallState = "running" | "failed" | "degraded" | "done";

export type InstallEvent =
  | { type: "succeeded" }
  | { type: "failed" }
  | { type: "retry" }
  | { type: "skip" };

export function nextInstallState(
  current: InstallState,
  event: InstallEvent,
): InstallState {
  switch (event.type) {
    case "succeeded":
      return "done";
    case "failed":
      return "failed";
    case "retry":
      return "running";
    case "skip":
      return "degraded";
    default:
      return current;
  }
}

type Props = {
  state: InstallState;
  onRetry: () => void;
  onContinueAnyway: () => void;
};

export function InstallScreen({ state, onRetry, onContinueAnyway }: Props) {
  if (state === "failed") {
    return (
      <div className="onb-screen" data-solo="true">
        <div className="onb-col-head">
          <h1 className="onb-headline">That did not work.</h1>
          <p className="onb-sub">
            We could not finish setting up your agent. Check your internet
            connection and try again.
          </p>
        </div>
        <div className="onb-actions">
          <Button size="lg" onClick={onRetry}>
            Try again
          </Button>
          <button
            type="button"
            className="onb-quiet-action"
            onClick={onContinueAnyway}
          >
            Continue without it for now
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="onb-screen" data-solo="true">
      <div className="onb-col-head">
        <h1 className="onb-headline">Setting up your agent.</h1>
        <p className="onb-sub">
          Colony is putting an agent to work for you. Nothing for you to do.
        </p>
      </div>
      <div className="onb-install">
        <WalkingAnt className="onb-install-ant" />
        <Progress value={null} />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd desktop && node --import ./test-loader.mjs --experimental-strip-types --test src/features/onboarding/ui/new/screens/installState.test.mjs`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/features/onboarding/ui/new/screens/InstallScreen.tsx desktop/src/features/onboarding/ui/new/screens/installState.test.mjs
git commit -s -m "feat(onboarding): Colony agent install screen with a retry path"
```

---

## Task 10: Business, reading and description screens

**Files:**
- Create: `desktop/src/features/onboarding/ui/new/screens/BusinessScreen.tsx`
- Create: `desktop/src/features/onboarding/ui/new/screens/ReadingScreen.tsx`
- Create: `desktop/src/features/onboarding/ui/new/screens/DescriptionScreen.tsx`
- Test: `desktop/src/features/onboarding/ui/new/screens/descriptionCopy.test.mjs`

**Interfaces:**
- Consumes: `isWebsite`, `normaliseWebsite`, `descriptionShortfall` (Task 2), `ScrapeResult` (Task 5).
- Produces: `descriptionCopy(input): { title: string; sub: string }`, `SCRAPE_FAILURE_COPY: Record<ScrapeFailureReason, string>`.

The prototype audit caught the sharpest bug in the whole flow here: with no website given, screen 8 still read "Here is what we found." and printed an invented description. `descriptionCopy` exists so that can never regress silently.

- [ ] **Step 1: Write the failing test**

```javascript
// desktop/src/features/onboarding/ui/new/screens/descriptionCopy.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { SCRAPE_FAILURE_COPY, descriptionCopy } from "./DescriptionScreen.tsx";

test("description_never_claims_a_finding_when_there_was_no_website", () => {
  const copy = descriptionCopy({ hasWebsite: false, scrapeFailed: false });
  assert.equal(copy.title, "Tell us what you do.");
});

test("description_never_claims_a_finding_when_the_scrape_failed", () => {
  const copy = descriptionCopy({ hasWebsite: true, scrapeFailed: true });
  assert.equal(copy.title, "Tell us what you do.");
});

test("description_reports_a_finding_only_when_there_was_one", () => {
  const copy = descriptionCopy({ hasWebsite: true, scrapeFailed: false });
  assert.equal(copy.title, "Here is what we found.");
});

test("scrape_failures_never_explain_bot_protection_to_the_user", () => {
  const blocked = SCRAPE_FAILURE_COPY.blocked;
  assert.equal(blocked, SCRAPE_FAILURE_COPY.unreachable);
  assert.ok(!/cloudflare|bot|403/i.test(blocked));
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd desktop && node --import ./test-loader.mjs --experimental-strip-types --test src/features/onboarding/ui/new/screens/descriptionCopy.test.mjs`
Expected: FAIL, cannot find module `./DescriptionScreen.tsx`.

- [ ] **Step 3: Write the implementation**

```tsx
// desktop/src/features/onboarding/ui/new/screens/DescriptionScreen.tsx
import { Button } from "@/shared/ui/button";
import { Textarea } from "@/shared/ui/textarea";
import { DESCRIPTION_MIN, descriptionShortfall } from "../../../flow/validation";
import type { ScrapeFailureReason } from "../../../contracts";

/**
 * Every failure gets the same plain sentence. A user whose site sits behind a
 * bot wall does not need to be taught what a bot wall is.
 */
const UNREACHABLE = "We could not reach that website.";

export const SCRAPE_FAILURE_COPY: Record<ScrapeFailureReason, string> = {
  unreachable: UNREACHABLE,
  blocked: UNREACHABLE,
  empty: UNREACHABLE,
  timeout: UNREACHABLE,
};

export function descriptionCopy(input: {
  hasWebsite: boolean;
  scrapeFailed: boolean;
}): { title: string; sub: string } {
  // Two separate reasons the generated text is absent: nothing was read, or
  // reading failed. Either way the app must not claim it found something.
  if (!input.hasWebsite) {
    return {
      title: "Tell us what you do.",
      sub: "A line or two is enough. Your agents work from this.",
    };
  }
  if (input.scrapeFailed) {
    return {
      title: "Tell us what you do.",
      sub: `${UNREACHABLE} Write a line or two about your business instead.`,
    };
  }
  return {
    title: "Here is what we found.",
    sub: "Change anything we got wrong. Your agents work from this.",
  };
}

type Props = {
  hasWebsite: boolean;
  scrapeFailed: boolean;
  value: string;
  onChange: (value: string) => void;
  onContinue: () => void;
  onBack: () => void;
};

export function DescriptionScreen({
  hasWebsite,
  scrapeFailed,
  value,
  onChange,
  onContinue,
  onBack,
}: Props) {
  const copy = descriptionCopy({ hasWebsite, scrapeFailed });
  const shortfall = descriptionShortfall(value);

  return (
    <div className="onb-screen">
      <div className="onb-col-head">
        <h1 className="onb-headline">{copy.title}</h1>
        <p className="onb-sub">{copy.sub}</p>
      </div>
      <div className="onb-panel">
        <Textarea
          rows={5}
          value={value}
          placeholder="We repair and service cars in Johannesburg."
          onChange={(event) => onChange(event.target.value)}
        />
        <p className="onb-note">
          {shortfall === 0
            ? `${value.trim().length} characters`
            : `${shortfall} more characters`}
        </p>
      </div>
      <div className="onb-actions">
        <Button size="lg" disabled={shortfall > 0} onClick={onContinue}>
          Looks right
        </Button>
        <button type="button" className="onb-quiet-action" onClick={onBack}>
          Back
        </button>
      </div>
    </div>
  );
}
```

`BusinessScreen` asks the two questions from the spec, validates the website with `isWebsite`, shows the example in the error message, and normalises with `normaliseWebsite` before handing it up.

`ReadingScreen` calls `services.scrape.describeBusiness`, caps the whole step at 30 seconds, and always calls `onDone` with either the description or a typed failure. It hides the back control while running, because there is nothing useful to say about it.

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd desktop && node --import ./test-loader.mjs --experimental-strip-types --test src/features/onboarding/ui/new/screens/descriptionCopy.test.mjs`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/features/onboarding/ui/new/screens/
git commit -s -m "feat(onboarding): business, reading and description screens"
```

---

## Task 11: Credits screen

**Files:**
- Create: `desktop/src/features/onboarding/ui/new/screens/CreditsScreen.tsx`
- Test: `desktop/src/features/onboarding/ui/new/screens/creditsState.test.mjs`

**Interfaces:**
- Consumes: `OnboardingServices` (Task 5).
- Produces: `AMOUNTS_USD`, `MIN_USD`, `amountValid(usd)`, `type CheckoutState`, `<CreditsScreen track services onPaid onSkip onBack />`.

- [ ] **Step 1: Write the failing test**

```javascript
// desktop/src/features/onboarding/ui/new/screens/creditsState.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { AMOUNTS_USD, MIN_USD, amountValid } from "./CreditsScreen.tsx";

test("credits_minimum_is_five_dollars", () => {
  assert.equal(MIN_USD, 5);
  assert.equal(amountValid(5), true);
  assert.equal(amountValid(4), false);
  assert.equal(amountValid(Number.NaN), false);
});

test("credits_presets_all_clear_the_minimum", () => {
  for (const amount of AMOUNTS_USD) {
    assert.equal(amountValid(amount), true);
  }
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd desktop && node --import ./test-loader.mjs --experimental-strip-types --test src/features/onboarding/ui/new/screens/creditsState.test.mjs`
Expected: FAIL, cannot find module `./CreditsScreen.tsx`.

- [ ] **Step 3: Write the implementation**

```tsx
// desktop/src/features/onboarding/ui/new/screens/CreditsScreen.tsx
import { useState } from "react";
import { Button } from "@/shared/ui/button";
import { openUrl } from "@/shared/api/nativeBridge";
import type { OnboardingServices } from "../../../contracts";
import type { OnboardingTrack } from "../../../flow/steps";

export const AMOUNTS_USD = [5, 10, 25] as const;
export const MIN_USD = 5;

export function amountValid(usd: number): boolean {
  return Number.isFinite(usd) && usd >= MIN_USD;
}

export type CheckoutState = "idle" | "leaving" | "abandoned";

type Props = {
  track: OnboardingTrack;
  email: string;
  pubkey: string;
  services: OnboardingServices;
  onPaid: () => void;
  onSkip: () => void;
  onBack: () => void;
};

export function CreditsScreen({
  track,
  email,
  pubkey,
  services,
  onPaid,
  onSkip,
  onBack,
}: Props) {
  const [state, setState] = useState<CheckoutState>("idle");
  const [amount, setAmount] = useState<number>(MIN_USD);
  const [custom, setCustom] = useState("");
  const [usingCustom, setUsingCustom] = useState(false);

  const chosen = usingCustom ? Number(custom || 0) : amount;
  const valid = amountValid(chosen);

  const pay = async () => {
    setState("leaving");
    const started = await services.payments.createTransaction(
      Math.round(chosen * 100),
      email,
    );
    await openUrl(started.authorizationUrl);

    // The webhook is the source of truth, not the browser coming back. Poll
    // the balance so a paid customer is never stranded on the payment screen
    // because a callback went missing.
    const verified = await services.payments.verify(started.reference);
    if (verified.paid) {
      onPaid();
      return;
    }
    const balance = await services.payments.balance(pubkey);
    if (balance.usdCents > 0) {
      onPaid();
      return;
    }
    setState("abandoned");
  };

  return (
    <div className="onb-screen">
      <div className="onb-col-head">
        <h1 className="onb-headline">Put your colony to work.</h1>
        <p className="onb-sub">
          {track === "colony"
            ? "Credits are what your agents run on: finding customers, reaching out, research, and work that carries on while you sleep. Your agent runs on Colony, so credits keep it working."
            : "Credits pay for the work your agents do out in the world: finding customers, reaching out, and research."}
        </p>
      </div>
      <div className="onb-amounts">
        {AMOUNTS_USD.map((value) => (
          <button
            type="button"
            key={value}
            className="onb-amount"
            data-selected={!usingCustom && amount === value}
            onClick={() => {
              setUsingCustom(false);
              setAmount(value);
            }}
          >
            ${value}
          </button>
        ))}
        {usingCustom ? (
          <span className="onb-amount" data-selected="true">
            $
            <input
              ref={customRef}
              inputMode="numeric"
              aria-label="Custom amount in dollars"
              value={custom}
              style={{ width: `${Math.max(2, custom.length || 2)}ch` }}
              onChange={(event) =>
                setCustom(event.target.value.replace(/\D/g, "").slice(0, 5))
              }
            />
          </span>
        ) : (
          <button
            type="button"
            className="onb-amount"
            onClick={() => setUsingCustom(true)}
          >
            Other
          </button>
        )}
      </div>
      <div className="onb-panel">
        <div className="onb-handoff">
          <p className="onb-handoff-title">
            You will pay with Paystack, then come straight back here.
          </p>
          <p className="onb-handoff-methods">
            Colony never sees your card details.
          </p>
        </div>
        <p className={`onb-note${state === "abandoned" ? " onb-note-warn" : ""}`}>
          {state === "abandoned"
            ? "That payment was not completed. Nothing has been charged."
            : usingCustom && custom && !valid
              ? `The minimum is $${MIN_USD}.`
              : `$${MIN_USD} minimum. Reading your website cost 4 cents, and that comes off this first payment.`}
        </p>
      </div>
      <div className="onb-actions">
        <Button
          size="lg"
          disabled={!valid || state === "leaving"}
          onClick={pay}
        >
          {state === "leaving"
            ? "Taking you to Paystack"
            : state === "abandoned"
              ? "Try again"
              : `Pay $${valid ? chosen : MIN_USD}`}
        </Button>
        {track === "byo" ? (
          <button type="button" className="onb-quiet-action" onClick={onSkip}>
            I will use my own agent for now
          </button>
        ) : null}
        <button type="button" className="onb-quiet-action" onClick={onBack}>
          Back
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd desktop && node --import ./test-loader.mjs --experimental-strip-types --test src/features/onboarding/ui/new/screens/creditsState.test.mjs`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/features/onboarding/ui/new/screens/CreditsScreen.tsx desktop/src/features/onboarding/ui/new/screens/creditsState.test.mjs
git commit -s -m "feat(onboarding): credits screen with the Paystack handoff"
```

---

## Task 12: Invite screen

**Files:**
- Create: `desktop/src/features/onboarding/ui/new/screens/InviteScreen.tsx`
- Test: `desktop/src/features/onboarding/ui/new/screens/inviteEntry.test.mjs`

**Interfaces:**
- Consumes: `isEmail` (Task 2).
- Produces: `parseInviteEntry(raw, existing): { added: string[]; rejected: string[] }`.

Both bugs the prototype audit found here are covered by the test: a pasted list produced nothing, and a bad address was rejected in total silence.

- [ ] **Step 1: Write the failing test**

```javascript
// desktop/src/features/onboarding/ui/new/screens/inviteEntry.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { parseInviteEntry } from "./InviteScreen.tsx";

test("invite_splits_a_pasted_list", () => {
  const result = parseInviteEntry("a@b.com, c@d.com e@f.com", []);
  assert.deepEqual(result.added, ["a@b.com", "c@d.com", "e@f.com"]);
  assert.deepEqual(result.rejected, []);
});

test("invite_reports_entries_it_could_not_read", () => {
  const result = parseInviteEntry("a@b.com nonsense", []);
  assert.deepEqual(result.added, ["a@b.com"]);
  assert.deepEqual(result.rejected, ["nonsense"]);
});

test("invite_drops_duplicates_case_insensitively", () => {
  const result = parseInviteEntry("A@B.com", ["a@b.com"]);
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.rejected, []);
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd desktop && node --import ./test-loader.mjs --experimental-strip-types --test src/features/onboarding/ui/new/screens/inviteEntry.test.mjs`
Expected: FAIL, cannot find module `./InviteScreen.tsx`.

- [ ] **Step 3: Write the implementation**

```tsx
// desktop/src/features/onboarding/ui/new/screens/InviteScreen.tsx
import { useState } from "react";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { isEmail } from "../../../flow/validation";

/**
 * Pasting a list is the normal way people do this, so split before judging.
 * Rejected entries come back so the screen can name them instead of silently
 * swallowing what the user typed.
 */
export function parseInviteEntry(
  raw: string,
  existing: readonly string[],
): { added: string[]; rejected: string[] } {
  const seen = new Set(existing.map((entry) => entry.toLowerCase()));
  const added: string[] = [];
  const rejected: string[] = [];

  for (const part of raw.split(/[\s,;]+/).filter(Boolean)) {
    if (!isEmail(part)) {
      rejected.push(part);
      continue;
    }
    if (seen.has(part.toLowerCase())) continue;
    seen.add(part.toLowerCase());
    added.push(part);
  }

  return { added, rejected };
}

type Props = {
  invites: string[];
  onChange: (invites: string[]) => void;
  onSend: () => void;
  onSkip: () => void;
  onBack: () => void;
};

export function InviteScreen({
  invites,
  onChange,
  onSend,
  onSkip,
  onBack,
}: Props) {
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState("");

  const commit = () => {
    if (!draft.trim()) return;
    const { added, rejected } = parseInviteEntry(draft, invites);
    if (added.length) onChange([...invites, ...added]);
    setDraft(rejected.join(" "));
    setProblem(
      rejected.length ? `Could not read: ${rejected.join(", ")}` : "",
    );
  };

  return (
    <div className="onb-screen">
      <div className="onb-col-head">
        <h1 className="onb-headline">Who else is coming?</h1>
        <p className="onb-sub">
          They get an email with a link that brings them straight into your
          workspace.
        </p>
      </div>
      <div className="onb-panel">
        {invites.length ? (
          <div className="onb-pills">
            {invites.map((entry) => (
              <span key={entry} className="onb-pill">
                {entry}
                <button
                  type="button"
                  aria-label={`Remove ${entry}`}
                  onClick={() =>
                    onChange(invites.filter((item) => item !== entry))
                  }
                >
                  x
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <Input
          value={draft}
          placeholder="name@company.com"
          onChange={(event) => {
            setDraft(event.target.value);
            if (problem) setProblem("");
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              commit();
            }
          }}
          onBlur={commit}
        />
        <p className={`onb-note${problem ? " onb-note-warn" : ""}`}>
          {problem || "Press enter after each address."}
        </p>
      </div>
      <div className="onb-actions">
        <Button size="lg" disabled={!invites.length} onClick={onSend}>
          Send invites
        </Button>
        <button type="button" className="onb-quiet-action" onClick={onSkip}>
          It is just me for now
        </button>
        <button type="button" className="onb-quiet-action" onClick={onBack}>
          Back
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd desktop && node --import ./test-loader.mjs --experimental-strip-types --test src/features/onboarding/ui/new/screens/inviteEntry.test.mjs`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/features/onboarding/ui/new/screens/InviteScreen.tsx desktop/src/features/onboarding/ui/new/screens/inviteEntry.test.mjs
git commit -s -m "feat(onboarding): invite screen with list paste and rejection feedback"
```

---

## Task 12b: Screen styles

**Files:**
- Create: `desktop/src/features/onboarding/ui/new/onboarding-screens.css`
- Modify: `desktop/src/features/onboarding/ui/new/OnboardingCanvas.tsx` (import the new stylesheet)
- Test: `desktop/src/features/onboarding/ui/new/screenStyles.test.mjs`

**Interfaces:**
- Consumes: the class names the screens already render.
- Produces: a stylesheet covering every `onb-` class outside the canvas chrome.

This task exists because the plan omitted it. Task 6 styled only the canvas
(mesh, streak, grain, step marker, foot trail, ant gait). Every screen-level
class the screens render has no rule at all, so the flow currently renders as
unstyled markup on a gradient.

Port the remaining rules from `prototypes/onboarding/app.css`, renaming the
`ob-` prefix to `onb-`, and wrap the file in `@layer components`. Do not
invent new styles: the prototype is the agreed design and it has been reviewed.

Classes that must be covered, taken from what the merged screens render:
`onb-screen` (including `data-wide` and `data-solo`), `onb-col-head`,
`onb-headline`, `onb-sub`, `onb-panel`, `onb-field`, `onb-label`, `onb-note`,
`onb-note-warn`, `onb-row`, `onb-actions`, `onb-quiet-action`, `onb-card`,
`onb-code`, `onb-check`, `onb-options`, `onb-option`, `onb-option-title`,
`onb-option-meta`, `onb-pulse`, `onb-stack`, `onb-amounts`, `onb-amount`,
`onb-handoff`, `onb-handoff-title`, `onb-handoff-methods`, `onb-pills`,
`onb-pill`, `onb-window`, `onb-pages`, `onb-page`, `onb-skel`, `onb-search`,
`onb-search-ant`, `onb-install`, `onb-install-ant`, `onb-status`.

Two things the prototype does not have to handle and this file does:

1. `BusinessScreen` renders `fieldset` elements, which carry a default browser
   border, padding and margin. Reset them.
2. The screens use the real Colony `Input` and `Textarea`, whose own classes
   ship inside `@layer`. The call-site restyle to underline fields therefore
   works from an unlayered rule, exactly as the prototype does it.

- [ ] **Step 1: Write the failing test**

```javascript
// desktop/src/features/onboarding/ui/new/screenStyles.test.mjs
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "onboarding-screens.css"), "utf8");

function renderedClasses() {
  const dirs = [here, join(here, "screens")];
  const found = new Set();
  for (const dir of dirs) {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".tsx")) continue;
      const source = readFileSync(join(dir, file), "utf8");
      for (const match of source.matchAll(/onb-[a-z0-9-]+/g)) {
        found.add(match[0]);
      }
    }
  }
  return [...found];
}

test("every_rendered_screen_class_has_a_style_rule", () => {
  const canvas = readFileSync(join(here, "onboarding-canvas.css"), "utf8");
  const missing = renderedClasses().filter(
    (name) => !css.includes(`.${name}`) && !canvas.includes(`.${name}`),
  );
  assert.deepEqual(missing, [], `classes with no CSS rule: ${missing.join(", ")}`);
});

test("screen_styles_are_layered", () => {
  // Unlayered CSS beats Tailwind's utilities regardless of specificity, which
  // silently defeats call-site overrides. See docs/BRAND.md.
  assert.ok(css.includes("@layer components"));
});

test("fieldset_defaults_are_reset", () => {
  // BusinessScreen groups its questions in fieldsets, which arrive with a
  // browser border, padding and margin.
  assert.match(css, /fieldset[^{]*\{[^}]*border:\s*0/);
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `. ./bin/activate-hermit && cd desktop && node --import ./test-loader.mjs --experimental-strip-types --test src/features/onboarding/ui/new/screenStyles.test.mjs`
Expected: FAIL, cannot read `onboarding-screens.css`.

- [ ] **Step 3: Write the stylesheet**

Port from `prototypes/onboarding/app.css`. Rename every `ob-` prefix to `onb-`,
wrap the whole file in `@layer components`, and add the fieldset reset. Import
it from `OnboardingCanvas.tsx` beside the existing canvas stylesheet import.

- [ ] **Step 4: Run the test and watch it pass**

Run: `. ./bin/activate-hermit && cd desktop && node --import ./test-loader.mjs --experimental-strip-types --test src/features/onboarding/ui/new/screenStyles.test.mjs`
Expected: PASS, 3 tests.

- [ ] **Step 5: Check the guards**

Run: `cd desktop && pnpm check:px-text && pnpm check:file-sizes`
Expected: both pass. The prototype uses stock rem tokens, so any failure here
means an arbitrary literal came across in the port.

- [ ] **Step 6: Commit**

```bash
git add desktop/src/features/onboarding/ui/new/onboarding-screens.css desktop/src/features/onboarding/ui/new/screenStyles.test.mjs desktop/src/features/onboarding/ui/new/OnboardingCanvas.tsx
git commit -s -m "feat(onboarding): screen styles ported from the reviewed prototype"
```

---

## Task 13: Wire the flow together behind a flag

**Files:**
- Create: `desktop/src/features/onboarding/newOnboardingFlag.ts`
- Create: `desktop/src/features/onboarding/ui/new/NewOnboardingFlow.tsx`
- Modify: `desktop/src/app/App.tsx:263`
- Test: `desktop/src/features/onboarding/newOnboardingFlag.test.mjs`

**Interfaces:**
- Consumes: everything above.
- Produces: `isNewOnboardingEnabled(env): boolean`, `<NewOnboardingFlow services onComplete />`.

Screen 10 ships hidden. Invite links have no destination while the download button is off the marketing site, and sending someone a dead link is worse than not inviting them.

- [ ] **Step 1: Write the failing test**

```javascript
// desktop/src/features/onboarding/newOnboardingFlag.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { invitesEnabled, isNewOnboardingEnabled } from "./newOnboardingFlag.ts";

test("flag_defaults_to_the_existing_flow", () => {
  assert.equal(isNewOnboardingEnabled({}), false);
});

test("flag_turns_on_explicitly", () => {
  assert.equal(isNewOnboardingEnabled({ VITE_NEW_ONBOARDING: "1" }), true);
});

test("invites_stay_off_until_the_download_button_is_back", () => {
  // An invite link with no app to download is a dead end for the recipient.
  assert.equal(invitesEnabled({ VITE_NEW_ONBOARDING: "1" }), false);
  assert.equal(
    invitesEnabled({ VITE_NEW_ONBOARDING: "1", VITE_ONBOARDING_INVITES: "1" }),
    true,
  );
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd desktop && node --import ./test-loader.mjs --experimental-strip-types --test src/features/onboarding/newOnboardingFlag.test.mjs`
Expected: FAIL, cannot find module `./newOnboardingFlag.ts`.

- [ ] **Step 3: Write the implementation**

```typescript
// desktop/src/features/onboarding/newOnboardingFlag.ts

type Env = Record<string, string | undefined>;

/**
 * The redesigned flow ships dark until it is signed off. Both switches are
 * read from the build environment so a release can enable them without a code
 * change.
 */
export function isNewOnboardingEnabled(env: Env): boolean {
  return env.VITE_NEW_ONBOARDING === "1";
}

export function invitesEnabled(env: Env): boolean {
  return isNewOnboardingEnabled(env) && env.VITE_ONBOARDING_INVITES === "1";
}
```

Then `NewOnboardingFlow.tsx` holds the state: current step, answers, track. It loads answers on mount via `loadAnswers`, routes with `resumeStep`, saves after each screen's continue, and renders the screen for the current step inside `OnboardingCanvas`. Reduced motion comes from `window.matchMedia("(prefers-reduced-motion: reduce)")` and is passed to every screen that runs a timer, because CSS cannot reach a JS interval.

In `App.tsx`, guard the existing mount:

```tsx
{isNewOnboardingEnabled(import.meta.env) ? (
  <NewOnboardingFlow services={onboardingServices} onComplete={handleComplete} />
) : (
  <OnboardingFlow /* existing props unchanged */ />
)}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd desktop && node --import ./test-loader.mjs --experimental-strip-types --test src/features/onboarding/newOnboardingFlag.test.mjs`
Expected: PASS, 3 tests.

- [ ] **Step 5: Verify the whole suite and the guards**

Run: `cd desktop && pnpm test && pnpm typecheck && pnpm check`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add desktop/src/features/onboarding/ desktop/src/app/App.tsx
git commit -s -m "feat(onboarding): wire the redesigned flow behind a build flag"
```

---

## Task 14: End-to-end smoke test

**Files:**
- Create: `desktop/tests/e2e/onboarding-redesign.spec.ts`
- Modify: `desktop/playwright.config.ts` (add the spec to the `smoke` project's `testMatch`)

**Interfaces:**
- Consumes: `installMockBridge` from the existing E2E helpers, the flag from Task 13.

- [ ] **Step 1: Write the failing test**

```typescript
// desktop/tests/e2e/onboarding-redesign.spec.ts
import { expect, test } from "@playwright/test";
import { installMockBridge } from "../helpers/e2eBridge";
import { waitForAnimations } from "../helpers/animations";

test("a non-technical user can finish onboarding", async ({ page }) => {
  await installMockBridge(page);
  await page.goto("/");

  await page.getByLabel("Your name").fill("Aisha Bello");
  await page.getByLabel("Email").fill("aisha@rosebankauto.co.za");
  await page.getByLabel("Password").fill("colonyprototype");
  await page.getByRole("button", { name: "Continue" }).click();

  await page.getByLabel("I have saved my code").check();
  await page.getByRole("button", { name: "Continue" }).click();

  await page.getByLabel("Company name").fill("Rosebank Auto Care");
  await page.getByRole("button", { name: "Create workspace" }).click();

  // The probe screen resolves on its own budget; no interaction here.
  await expect(page.getByText("Getting things ready.")).toBeVisible();
  await expect(page.getByText("Tell us about the work.")).toBeVisible({
    timeout: 15000,
  });

  await waitForAnimations(page);
  await expect(page.getByRole("heading")).toBeVisible();
});

test("a disabled primary action always says what is missing", async ({
  page,
}) => {
  await installMockBridge(page);
  await page.goto("/");

  await page.getByLabel("Password").fill("short");
  // The rule the flow exists to honour: never a dead button with no reason.
  await expect(page.getByText("5 more characters")).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd desktop && pnpm test:e2e:smoke`
Expected: FAIL, the new flow is not mounted because the flag is off.

- [ ] **Step 3: Enable the flag for E2E builds**

Add `VITE_NEW_ONBOARDING=1` to the `e2e` mode env in `desktop/vite.config.ts` (or a `.env.e2e` file, matching whatever the repo already does for mode-specific values). Build with `pnpm build:e2e`, never `pnpm run build`: a plain build strips the mock bridge and every mock-mode spec fails with `Cannot read properties of undefined (reading 'invoke')`, which looks exactly like a product bug.

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd desktop && pnpm test:e2e:smoke`
Expected: PASS. If a previous build's server is still up, kill port 4173 first, since `reuseExistingServer` will otherwise serve stale code.

- [ ] **Step 5: Commit**

```bash
git add desktop/tests/e2e/onboarding-redesign.spec.ts desktop/playwright.config.ts desktop/vite.config.ts
git commit -s -m "test(onboarding): end-to-end smoke test for the redesigned flow"
```

---

## Self-review notes

**Spec coverage.** Screens 1 to 10 map to Tasks 7 to 12. Branch logic is Task 4, persistence and resume are Tasks 1 and 3, the canvas and the trail are Task 6, contracts are Task 5, and the flag plus the App mount are Task 13.

**Deliberately out of scope**, matching the spec's own boundaries: the auth service and key escrow, the Paystack integration in the relay, the scraper, and invite email delivery. Each is consumed here through `contracts.ts` and faked, so this plan produces a flow that runs and is tested end to end before any of them lands.

**Three spec questions are still open** and none of them blocks this plan:

1. Whether an existing key-only account can attach an email and password.
2. Whether an invited teammate runs this flow or a shortened join flow.
3. Refund handling for the recouped description cost.
