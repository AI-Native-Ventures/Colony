import assert from "node:assert/strict";
import path from "node:path";
import { expect } from "@playwright/test";
import { waitForAnimations } from "../../tests/helpers/animations.ts";
import { readPendingAttempt } from "./diagnostics.mjs";

/** Prove the actual funded, approved business cannot start without its worker. */
export async function checkFixtureUnstaffed({
  page,
  account,
  relay,
  provider,
  invoke,
  reloadWelcome,
  brief,
  proofDirectory,
  onProgress = () => {},
}) {
  await relay.seedCredits(account.ownerPubkey);
  assert.equal(
    (await invoke("get_colony_credits_account")).available_balance_nanousd,
    "5000000000",
  );
  const personas = await invoke("list_personas");
  const activePersonas = personas
    .filter((persona) => persona.is_active ?? true)
    .map((persona) => persona.id);
  assert.deepEqual(activePersonas, ["builtin:fizz"]);
  const agents = await invoke("list_managed_agents");
  assert.ok(agents.every((agent) => agent.persona_id === "builtin:fizz"));
  assert.ok(agents.every((agent) => !agent.pid));
  await reloadWelcome();
  const cards = page
    .getByTestId("first-job-suggestion")
    .filter({ visible: true });
  await expect(cards.first()).toBeVisible();
  await cards.first().getByRole("textbox").fill(brief);
  await expect(cards.last().getByRole("textbox")).toHaveValue(brief);
  const assertNoWork = async () => {
    assert.equal((await readPendingAttempt(page, account)).exists, false);
    assert.equal(
      await relay.query(
        `SELECT count(*) FROM events WHERE kind=30181 AND content::jsonb->>'sourceChannelId'='${account.channelId}';`,
      ),
      "0",
    );
    assert.equal(
      await relay.query(
        `SELECT count(*) FROM events WHERE kind=9 AND tags @> '[["h","${account.channelId}"],["client","colony:first-job-start:v1"]]'::jsonb;`,
      ),
      "0",
    );
    assert.equal(provider.requests.length, 0);
    provider.assertHealthy();
  };
  await assertNoWork();
  onProgress("waiting-for-admission-window-before-unstaffed-check");
  await new Promise((resolve) => setTimeout(resolve, 60_000));
  await assertNoWork();
  await cards
    .first()
    .getByRole("button", { name: "Start this job", exact: true })
    .click();
  await expect(cards.first()).toHaveAttribute("data-phase", "blocked", {
    timeout: 30_000,
  });
  await expect(cards.first().getByRole("alert")).toHaveText(
    "An approved worker is not available for this job yet. Review your team, then try again.",
    { timeout: 30_000 },
  );
  await expect(
    cards.first().getByRole("button", { name: "Review team", exact: true }),
  ).toBeVisible();
  await expect(
    cards.first().getByRole("button", { name: "Try again", exact: true }),
  ).toBeEnabled();
  await expect(cards.last().getByRole("textbox")).toHaveValue(brief);
  await assertNoWork();
  assert.ok((await invoke("list_managed_agents")).every((agent) => !agent.pid));
  await waitForAnimations(page);
  await page.screenshot({
    path: path.join(proofDirectory, "joined-funded-no-worker.png"),
  });
  return {
    availableBalanceNanousd: "5000000000",
    activePersonas,
    tasks: 0,
    instructions: 0,
    modelCalls: 0,
    admissionPauseSeconds: 60,
    result:
      "worker unavailable; shared brief retained and actual retry available",
  };
}
