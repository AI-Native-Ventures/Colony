import { expect, test, type Page } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import { seedActiveIdentity, seedFreshFounder } from "../helpers/onboarding";

// A blank username means the mock bridge reports no kind:0 profile event for
// the active identity, which is what keeps the app-level onboarding gate open.
const FIRST_RUN_IDENTITY = { ...TEST_IDENTITIES.tyler, username: "" };

// The canvas flow is the only flow, so nothing here opts into it. Storage
// seeding still has to be registered before installMockBridge: React reads it
// on mount and the bridge triggers that mount.
async function seedFreshFirstRun(
  page: Page,
  extraStorage: Record<string, string> = {},
  mock?: Parameters<typeof installMockBridge>[1],
) {
  await page.addInitScript((extra) => {
    for (const [key, value] of Object.entries(extra)) {
      window.localStorage.setItem(key, value);
    }
  }, extraStorage);
  // The flow mounts above the community boundary now, so the founder marker
  // and an empty community list are what open it, not the app-level gate.
  await seedFreshFounder(page, FIRST_RUN_IDENTITY.pubkey);
  await seedActiveIdentity(page, FIRST_RUN_IDENTITY);
  await installMockBridge(page, mock, {
    skipOnboardingSeed: true,
    skipCommunitySeed: true,
  });
}

/**
 * A computer with no tool the founder already pays for.
 *
 * The default mock catalog reports Oh My Pi and Claude Code ready, which is
 * the detected case. This is the other one: only the hosted agent, which is
 * on every computer and is never something detection found.
 */
function runtime(
  id: string,
  label: string,
  availability: string,
  authStatus: Record<string, unknown>,
) {
  return {
    id,
    label,
    avatar_url: "",
    availability,
    command: null,
    binary_path: null,
    default_args: [],
    mcp_command: null,
    install_hint: `Install ${label}`,
    install_instructions_url: "https://example.com",
    can_auto_install: false,
    underlying_cli_path: null,
    node_required: false,
    auth_status: authStatus,
    login_hint: `Sign in to ${label}`,
  };
}

const NOTHING_INSTALLED = [
  runtime("buzz-agent", "Colony Agent", "available", {
    status: "not_applicable",
  }),
  runtime("claude", "Claude Code", "not_installed", { status: "unknown" }),
  runtime("codex", "Codex", "available", { status: "logged_out" }),
];

/** Everything before the building screen, answered the same way every time. */
async function walkToCompany(page: Page) {
  await passMachineLanding(page);
  await page.getByLabel("Your name").fill("Aisha Bello");
  await page.getByLabel("Email").fill("aisha@rosebankauto.co.za");
  await page.getByLabel("Password").fill("colonyprototype");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("I have saved my code").click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(
    page.getByRole("heading", { name: "Now, your company." }),
  ).toBeVisible();
  await page.getByLabel("Company name").fill("Rosebank Auto Care");
  await page
    .getByRole("button", { name: "Not yet, we are still building" })
    .click();
}

/**
 * Machine onboarding stands in front of the flow on a machine with no
 * community: its completion is vouched by a matching community pubkey, and
 * these runs deliberately have none. One click is the whole step.
 */
async function passMachineLanding(page: Page) {
  await expect(page.getByTestId("machine-onboarding-gate")).toBeVisible();
  await page.getByRole("button", { name: "Start with Colony" }).click();
}

test("a non-technical user can get from the first screen to the end", async ({
  page,
}) => {
  await seedFreshFirstRun(page);
  await page.goto("/");
  await passMachineLanding(page);

  // Screen 1: account. The primary button is dead until every field answers.
  await expect(
    page.getByRole("heading", { name: "Let's get your colony started." }),
  ).toBeVisible();
  await page.getByLabel("Your name").fill("Aisha Bello");
  await page.getByLabel("Email").fill("aisha@rosebankauto.co.za");
  await page.getByLabel("Password").fill("colonyprototype");
  await page.getByRole("button", { name: "Continue" }).click();

  // Screen 2: recovery code. Continue stays locked until the box is ticked.
  await expect(
    page.getByRole("heading", { name: "Your way back in." }),
  ).toBeVisible();
  await page.getByLabel("I have saved my code").click();
  await page.getByRole("button", { name: "Continue" }).click();

  // Screen 3: company. Name, stage and the website question are one screen:
  // answering "no website" here is what skips the paid reading step later.
  await expect(
    page.getByRole("heading", { name: "Now, your company." }),
  ).toBeVisible();
  await page.getByLabel("Company name").fill("Rosebank Auto Care");
  await page
    .getByRole("button", { name: "Not yet, we are still building" })
    .click();
  await page.getByRole("button", { name: "No", exact: true }).click();
  await page.getByRole("button", { name: "Create workspace" }).click();

  // Screen 4: building. It shows its work as a live list and ends on the
  // draft, with no interaction until it settles. No website means the flow
  // must not claim a finding.
  await expect(page.getByTestId("onboarding-building-list")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Tell us what you do." }),
  ).toBeVisible({ timeout: 15_000 });
  // The list is still there beside the draft: what was done stays on screen.
  await expect(page.getByTestId("onboarding-building-list")).toBeVisible();
  await page
    .getByPlaceholder("We repair and service cars in Johannesburg.")
    .fill("We service and repair cars for owners around Johannesburg.");
  await page.getByRole("button", { name: "Looks right" }).click();

  // Screen 5: the brain picker opens on Colony Agent whatever the mock
  // catalog reports ready, so the walk continues on the colony track. The
  // skip path off the credits screen exists on every track, so this no
  // longer depends on what the catalog says is installed.
  await expect(
    page.getByRole("heading", { name: "Pick who does the thinking." }),
  ).toBeVisible({ timeout: 15_000 });
  // Colony Agent is what the founder is defaulted into, not whichever tool
  // detection happened to find first.
  await expect(page.getByTestId("onboarding-brain-buzz-agent")).toHaveAttribute(
    "data-selected",
    "true",
  );
  await page.getByRole("button", { name: "Continue" }).click();

  // Screen 6: credits. Every track offers a way past it, so no payment
  // handoff is needed to finish.
  await expect(
    page.getByRole("heading", { name: "Put something in the tin." }),
  ).toBeVisible();

  // One pack, not the seven-tile ladder. Someone who has not started yet
  // cannot choose between seven amounts of a thing they have never spent.
  await expect(page.getByTestId("onboarding-credits-pack")).toHaveCount(1);

  // This walk answered "no website", so nothing was read and the screen must
  // not offer money back against a reading that never happened.
  await expect(page.getByText("reading your website")).toHaveCount(0);

  // The Pay button fell below the fold at 1280x720 while the pack grid was
  // there, and the canvas is fixed to the viewport and clips, so it could not
  // be scrolled to: a dead end rather than a layout nit.
  const pay = page.getByTestId("onboarding-credits-pay");
  await expect(pay).toBeVisible();
  const payBox = await pay.boundingBox();
  expect((payBox?.y ?? 0) + (payBox?.height ?? 0)).toBeLessThanOrEqual(660);

  await page.getByTestId("onboarding-credits-later").click();

  // The flow hands control back to the app: the canvas unmounts and the main
  // shell takes over. An invite screen must not appear in between, since
  // invites ship dark while the download button is off the marketing site.
  await expect(page.locator(".onb-canvas")).toHaveCount(0);
  await waitForAnimations(page);
  await expect(page.getByTestId("app-top-chrome")).toBeVisible();
});

test("a taken email address is explained inline and keeps the form intact", async ({
  page,
}) => {
  // Pin the signup failure the real service would produce for a duplicate
  // address (see the e2e-only override in NewOnboardingFlow), so screen 1's
  // failure states stay testable without pointing the flow at a live relay.
  await seedFreshFirstRun(page, {
    "colony.e2e.authFailure": JSON.stringify({ kind: "email-taken" }),
  });
  await page.goto("/");
  await passMachineLanding(page);

  await expect(
    page.getByRole("heading", { name: "Let's get your colony started." }),
  ).toBeVisible();
  await page.getByLabel("Your name").fill("Aisha Bello");
  await page.getByLabel("Email").fill("aisha@rosebankauto.co.za");
  await page.getByLabel("Password").fill("colonyprototype");
  await page.getByRole("button", { name: "Continue" }).click();

  // The error sits on the email field, not as a dead button or a silent
  // nothing. The flow stays here.
  const emailField = page
    .locator("label.onb-field")
    .filter({ has: page.locator("#onb-account-email") });
  await expect(
    emailField.getByText("That email already has an account."),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Let's get your colony started." }),
  ).toBeVisible();

  // A failed signup never clears what was typed.
  await expect(page.getByLabel("Your name")).toHaveValue("Aisha Bello");
  await expect(page.getByLabel("Email")).toHaveValue(
    "aisha@rosebankauto.co.za",
  );
  await expect(page.getByLabel("Password")).toHaveValue("colonyprototype");
});

test("a disabled primary action always says what is missing", async ({
  page,
}) => {
  await seedFreshFirstRun(page);
  await page.goto("/");
  await passMachineLanding(page);

  // The rule the redesign exists to honour: never a dead Continue with no
  // reason. A short password shows the exact count still missing.
  // 12 is PASSWORD_MIN, which tracks MIN_PASSPHRASE_LEN in key_backup.rs: the
  // identity backup runs before signup posts, so a shorter password fails
  // locally and reads as a network error.
  await page.getByLabel("Password").fill("short");
  await expect(page.getByText("7 more characters")).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();

  // The same rule on the company screen: unanswered questions are named,
  // and the name on its own is not enough to claim a workspace.
  await page.getByLabel("Your name").fill("Aisha Bello");
  await page.getByLabel("Email").fill("aisha@rosebankauto.co.za");
  await page.getByLabel("Password").fill("colonyprototype");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("I have saved my code").click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(
    page.getByRole("heading", { name: "Now, your company." }),
  ).toBeVisible();
  await expect(
    page.getByText("Enter your company name to continue."),
  ).toBeVisible();
  await page.getByLabel("Company name").fill("Rosebank Auto Care");
  await expect(
    page.getByText("Answer both questions to continue."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create workspace" }),
  ).toBeDisabled();
});

test("a founder with a website is shown what was read and can change it", async ({
  page,
}) => {
  // The other walk that matters. Every other spec here answers "no website",
  // so the reading line, the finding copy and the credits refund line were
  // never walked end to end by anything.
  await seedFreshFirstRun(page);
  await page.goto("/");
  await walkToCompany(page);
  await page.getByRole("button", { name: "Yes", exact: true }).click();
  await page
    .getByPlaceholder("rosebankautocare.co.za")
    .fill("rosebankautocare.co.za");
  await page.getByRole("button", { name: "Create workspace" }).click();

  // Building: the list runs, the site is read, and the screen ends on the
  // draft it produced rather than on a blank box.
  await expect(page.getByTestId("onboarding-building-list")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Here is what we found." }),
  ).toBeVisible({ timeout: 20_000 });
  const draft = page.getByPlaceholder(
    "We repair and service cars in Johannesburg.",
  );
  await expect(draft).toHaveValue(/independent vehicle workshop/);

  // A read that came back leaves nothing to offer as an opener.
  await expect(page.getByText("Tap one and change it")).toHaveCount(0);

  await draft.fill("We service and repair cars for owners around Rosebank.");
  await page.getByRole("button", { name: "Looks right" }).click();

  await expect(
    page.getByRole("heading", { name: "Pick who does the thinking." }),
  ).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Continue" }).click();

  // Something was read, so the refund against it may be promised. The
  // no-website walk above asserts the opposite.
  await expect(
    page.getByRole("heading", { name: "Put something in the tin." }),
  ).toBeVisible();
  await expect(page.getByText("reading your website")).toBeVisible();
});

test("a blank box is never the whole offer when there is no website", async ({
  page,
}) => {
  await seedFreshFirstRun(page);
  await page.goto("/");
  await walkToCompany(page);
  await page.getByRole("button", { name: "No", exact: true }).click();
  await page.getByRole("button", { name: "Create workspace" }).click();

  await expect(
    page.getByRole("heading", { name: "Tell us what you do." }),
  ).toBeVisible({ timeout: 20_000 });

  // Nothing was read, so there is nothing to show. Three openers stand in
  // for the blank box and "20 more characters", and tapping one fills it.
  const opener = page.getByRole("button", { name: /^We .+ for .+\.$/ });
  await expect(opener).toHaveCount(3);
  const first = opener.first();
  const text = (await first.textContent())?.trim() ?? "";
  await first.click();
  const draft = page.getByPlaceholder(
    "We repair and service cars in Johannesburg.",
  );
  await expect(draft).toHaveValue(text);

  // Filled, so the openers give way to the count and the action is live.
  await expect(opener).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Looks right" })).toBeEnabled();
});

test("nothing detected means no brain screen and no dead Back behind it", async ({
  page,
}) => {
  await seedFreshFirstRun(page, {}, { acpRuntimesCatalog: NOTHING_INSTALLED });
  await page.goto("/");
  await walkToCompany(page);
  await page.getByRole("button", { name: "No", exact: true }).click();
  await page.getByRole("button", { name: "Create workspace" }).click();

  await expect(
    page.getByRole("heading", { name: "Tell us what you do." }),
  ).toBeVisible({ timeout: 20_000 });
  // Five screens, not six: the picker is not counted when it will not run.
  await expect(page.getByTestId("onboarding-step-counter")).toHaveText(
    "04 / 05",
  );
  await page
    .getByPlaceholder("We repair and service cars in Johannesburg.")
    .fill("We service and repair cars for owners around Johannesburg.");
  await page.getByRole("button", { name: "Looks right" }).click();

  // Straight to credits: a picker with one already-selected row is a screen,
  // not a choice, so the same choice is applied without asking.
  await expect(
    page.getByRole("heading", { name: "Put something in the tin." }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByRole("heading", { name: "Pick who does the thinking." }),
  ).toHaveCount(0);
  // And no Back control offering the screen the flow just decided against.
  await expect(page.getByRole("button", { name: "Back" })).toHaveCount(0);
});
