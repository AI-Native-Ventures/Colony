// Explicit fixture owner approval and real ACP work in the UI-created thread.
import assert from "node:assert/strict";
import path from "node:path";
import { expect } from "@playwright/test";
import { waitForAnimations } from "../../tests/helpers/animations.ts";
import { approveFixtureTeam } from "./approved-team.mjs";
import { readPendingAttempt, readRenderedCompany } from "./diagnostics.mjs";
import {
  FIRST_JOB_BRIEF,
  INSTAGRAM_DRAFTS,
  WORKER_OUTPUT,
  SCOUT_REVIEW,
} from "./provider.mjs";
import { checkFixtureUnstaffed } from "./unstaffed.mjs";

/** Caller owns the real package and services; only model responses and ledger funds are fixtures. */
export async function completeFixtureWork({
  page,
  account,
  proxy,
  relay,
  provider,
  directory,
  bundle,
  proofDirectory,
  repositoryModuleUrls = [],
  onProgress = () => {},
  onEvidence = () => {},
}) {
  const invoke = (command, args = {}) =>
    page.evaluate(
      ({ command, args }) =>
        window.colonyDesktop.request("invoke", { command, args }),
      { command, args },
    );
  const welcomeUrl = page.url();
  assert.equal(
    new URL(
      welcomeUrl.split("#")[1],
      "https://fixture.invalid",
    ).searchParams.get("thread"),
    account.rootEventId,
  );
  const reloadWelcome = async () => {
    await page.reload();
    await page.waitForFunction(() => !!window.colonyDesktop);
    assert.equal((await invoke("get_identity")).pubkey, account.ownerPubkey);
    assert.equal(await invoke("get_relay_ws_url"), account.relayUrl);
    const current = new URL(
      page.url().split("#")[1],
      "https://fixture.invalid",
    );
    if (
      current.pathname !== `/channels/${account.channelId}` ||
      current.searchParams.get("thread") !== account.rootEventId
    ) {
      await page.evaluate((target) => {
        location.hash = new URL(target).hash;
      }, welcomeUrl);
    }
  };
  const brief = FIRST_JOB_BRIEF;
  const cards = page
    .getByTestId("first-job-suggestion")
    .filter({ visible: true });
  assert.equal(
    account.suggestion.brief,
    brief,
    "The actual owner-signed setup root contains the intended default first job",
  );
  await expect(cards.first().getByRole("textbox")).toHaveValue(brief);
  await expect(cards.last().getByRole("textbox")).toHaveValue(brief);
  const defaultBrief = {
    rootBrief: account.suggestion.brief,
    paneBriefs: await cards
      .getByRole("textbox")
      .evaluateAll((inputs) => inputs.map((input) => input.value)),
    edited: false,
  };
  onEvidence({ defaultBrief });
  let unstaffed;
  const approved = await approveFixtureTeam({
    page,
    account,
    proxy,
    directory,
    buzzBinary: path.join(bundle, "Contents/Resources/native/buzz"),
    onProgress,
    onTaskCandidates: (taskHeadCandidates) =>
      onEvidence({ taskHeadCandidates }),
    beforeTeamApproval: async () => {
      unstaffed = await checkFixtureUnstaffed({
        page,
        account,
        relay,
        provider,
        invoke,
        reloadWelcome,
        brief,
        proofDirectory,
        onProgress,
      });
      onEvidence({ unstaffed });
      onProgress("funded-no-worker-blocked");
    },
  });
  onProgress("business-and-team-approved");
  assert.equal(
    (await invoke("get_colony_credits_account")).available_balance_nanousd,
    "5000000000",
  );
  assert.equal(
    provider.requests.length,
    0,
    "Approving setup does not start a model",
  );
  provider.configure({
    scoutMarker: approved.scoutMarker,
    workerMarker: approved.workerMarker,
    scoutPubkey: approved.scout.pubkey,
    workerPubkey: approved.worker.pubkey,
    channelId: account.channelId,
    rootId: account.rootEventId,
    brief,
    readTask: approved.readTask,
  });
  // Reload also proves that the original owner-authored root survives setup/funding.
  await reloadWelcome();
  onEvidence({ ...(await approved.readApprovalEvidence()), unstaffed });
  await expect(cards.first()).toBeVisible();
  await expect(cards.first().getByRole("textbox")).toHaveValue(brief);
  await expect(cards.last().getByRole("textbox")).toHaveValue(brief);
  assert.equal((await readPendingAttempt(page, account)).exists, false);
  // Fixture approval and readback are much faster than human setup. Let the
  // real 300/minute owner HTTP admission window expire before creating work.
  onProgress("waiting-for-admission-window-before-start");
  await new Promise((resolve) => setTimeout(resolve, 60_000));
  assert.equal(provider.requests.length, 0);
  assert.equal((await readPendingAttempt(page, account)).exists, false);
  const retry = cards
    .first()
    .getByRole("button", { name: "Try again", exact: true });
  if (await retry.isVisible()) await retry.click();
  else
    await cards
      .first()
      .getByRole("button", { name: "Start this job", exact: true })
      .click();
  onProgress("explicit-start");
  const quotaRetries = [];
  await expect
    .poll(
      async () => {
        provider.assertHealthy();
        const alert = cards.first().getByRole("alert");
        if (await alert.isVisible()) {
          const message = await alert.innerText();
          const quota = /^rate-limited: quota exceeded; retry in (\d+)s$/.exec(
            message,
          );
          if (!quota || quotaRetries.length) throw new Error(message);
          const seconds = Number(quota[1]);
          assert.ok(
            seconds > 0 && seconds <= 30,
            "Only a bounded server-specified cooldown is retryable",
          );
          const instructions = await relay.query(
            `SELECT count(*) FROM events WHERE kind=9 AND tags @> '[["h","${account.channelId}"],["client","colony:first-job-start:v1"]]'::jsonb;`,
          );
          assert.equal(
            instructions,
            "0",
            "Do not retry after an instruction reached the relay",
          );
          assert.equal(
            provider.requests.length,
            0,
            "Do not retry after model work began",
          );
          const pendingAttempt = await readPendingAttempt(page, account);
          quotaRetries.push({
            seconds,
            instructions,
            modelCalls: 0,
            pendingAttempt,
          });
          if (pendingAttempt.messageId) {
            assert.ok(
              Number.isInteger(pendingAttempt.messageCreatedAt) &&
                Math.floor(Date.now() / 1000) +
                  seconds -
                  pendingAttempt.messageCreatedAt <=
                  5,
              "An aged signed instruction requires review, never an automatic retry",
            );
          }
          onProgress("respecting-relay-cooldown-before-explicit-retry");
          await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
          const phase = await cards.first().getAttribute("data-phase");
          assert.ok(phase === "uncertain" || phase === "error");
          const retryButton =
            phase === "uncertain" ? "Check request" : "Try again";
          Object.assign(quotaRetries.at(-1), { phase, retryButton });
          await cards
            .first()
            .getByRole("button", {
              name: retryButton,
              exact: true,
            })
            .click();
          return null;
        }
        // Observe real persisted state without spending the owner's HTTP quota.
        // Commands and final assertions still read and verify the signed head.
        return relay.query(
          `SELECT content::jsonb->>'status' FROM events WHERE community_id=(SELECT id FROM communities WHERE host='${proxy.businessHost}') AND kind=30181 AND pubkey=decode('${approved.profileHead.pubkey}','hex') AND deleted_at IS NULL AND content::jsonb->>'threadRoot'='${account.rootEventId}' AND content::jsonb->>'sourceChannelId'='${account.channelId}' ORDER BY created_at DESC,id ASC LIMIT 1;`,
        );
      },
      {
        timeout: 120_000,
        intervals: [2_000],
        message:
          "Real worker output and Chief report complete the canonical Task",
      },
    )
    .toBe("completed")
    .catch(async (error) => {
      onEvidence({
        ...(await approved.readApprovalEvidence()),
        failedStartCompanyRead: await readRenderedCompany(
          page,
          repositoryModuleUrls,
        ),
        pendingAttempt: await readPendingAttempt(page, account),
        quotaRetries,
        unstaffed,
      });
      throw error;
    });
  const task = await approved.readTask();
  assert.equal(task.status, "completed");
  const actualAgents = await invoke("list_managed_agents");
  const isolatedRuntimes = [approved.scout, approved.worker].map((ref) => {
    const agent = actualAgents.find(
      (candidate) => candidate.pubkey === ref.pubkey,
    );
    assert.ok(
      agent?.isolated && agent.pid > 0,
      "Both real managed runtimes execute inside isolation",
    );
    return { pubkey: agent.pubkey, pid: agent.pid, isolated: agent.isolated };
  });
  assert.equal(task.threadRoot, account.rootEventId);
  assert.equal(task.sourceChannelId, account.channelId);
  assert.ok(task.assigneePersonaIds.includes(approved.scout.personaId));
  assert.ok(provider.requests.some((request) => request.actor === "worker"));
  assert.ok(provider.requests.some((request) => request.stage === "review"));
  await expect
    .poll(
      () => {
        provider.assertHealthy();
        return provider.requests.some(
          (request) => request.stage === "review" && request.completion,
        );
      },
      {
        timeout: 15_000,
        message: "Chief of Staff finishes its actual review turn",
      },
    )
    .toBe(true);
  provider.assertHealthy();
  await Promise.all([
    expect(cards.first().getByTestId("first-job-status")).toHaveText(
      "Completed",
      { timeout: 30_000 },
    ),
    expect(cards.last().getByTestId("first-job-status")).toHaveText(
      "Completed",
      { timeout: 30_000 },
    ),
  ]);
  await expect(
    page.getByText(WORKER_OUTPUT, { exact: false }).first(),
  ).toBeVisible();
  const workerRow = page
    .getByTestId("message-thread-replies")
    .getByTestId("message-row")
    .filter({ hasText: WORKER_OUTPUT })
    .first();
  const expandOutput = workerRow.getByRole("button", {
    name: "Read full message",
    exact: true,
  });
  if (await expandOutput.isVisible()) await expandOutput.click();
  assert.equal(INSTAGRAM_DRAFTS.length, 5);
  assert.equal(new Set(INSTAGRAM_DRAFTS.map((draft) => draft.caption)).size, 5);
  assert.equal(
    new Set(INSTAGRAM_DRAFTS.map((draft) => draft.visualBrief)).size,
    5,
  );
  for (const draft of INSTAGRAM_DRAFTS) {
    await expect(workerRow).toContainText(draft.caption);
    await expect(workerRow).toContainText(draft.visualBrief);
  }
  await expect(workerRow).toContainText(
    "no images have been created and no posts have been published",
  );
  const deliveredDrafts = {
    captions: INSTAGRAM_DRAFTS.length,
    matchingVisualBriefs: INSTAGRAM_DRAFTS.length,
    days: INSTAGRAM_DRAFTS.map((draft) => draft.day),
    renderedFieldsVerified: 10,
    generatedImages: 0,
    publishedPosts: 0,
  };
  const presentation = await page
    .getByText(WORKER_OUTPUT, { exact: false })
    .first()
    .evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        regularInterLoaded: Array.from(document.fonts).some(
          (face) =>
            face.family.includes("Inter Variable") && face.status === "loaded",
        ),
      };
    });
  assert.match(presentation.fontFamily, /Inter Variable/);
  assert.doesNotMatch(presentation.fontFamily, /Inter Tight/);
  assert.equal(presentation.regularInterLoaded, true);
  await expect(page.getByTestId("community-rail")).toBeVisible();
  presentation.communityRailVisible = true;
  onEvidence({
    liveCompletion: {
      taskId: task.id,
      paneStatuses: ["Completed", "Completed"],
    },
    presentation,
    deliveredDrafts,
  });
  onProgress("live-completed-font-and-rail-verified");
  await expect(
    page.getByText(SCOUT_REVIEW, { exact: false }).first(),
  ).toBeVisible();
  await page
    .getByText(SCOUT_REVIEW, { exact: false })
    .filter({ visible: true })
    .last()
    .scrollIntoViewIfNeeded();
  await waitForAnimations(page);
  const outputScreenshot = await page.screenshot({
    path: path.join(proofDirectory, "joined-worker-reviewed.png"),
  });
  const callsBeforeReload = provider.requests.length;
  const reloadStartedAt = performance.now();
  const reloadCompletion = { progression: [] };
  await reloadWelcome();
  await expect(cards.first().getByRole("textbox")).toHaveValue(brief);
  await expect
    .poll(
      async () => {
        const statuses = await cards
          .getByTestId("first-job-status")
          .allTextContents();
        const previous = reloadCompletion.progression.at(-1)?.paneStatuses;
        if (JSON.stringify(previous) !== JSON.stringify(statuses)) {
          reloadCompletion.progression.push({
            elapsedMs: Math.round(performance.now() - reloadStartedAt),
            paneStatuses: statuses,
          });
          onEvidence({ reloadCompletion });
        }
        return statuses;
      },
      { timeout: 30_000, message: "Both panes restore canonical completion" },
    )
    .toEqual(["Completed", "Completed"]);
  reloadCompletion.completedAfterMs = Math.round(
    performance.now() - reloadStartedAt,
  );
  onEvidence({ reloadCompletion });
  assert.equal((await approved.readTask()).id, task.id);
  await cards.last().scrollIntoViewIfNeeded();
  await waitForAnimations(page);
  const completedScreenshot = await page.screenshot({
    path: path.join(proofDirectory, "joined-canonical-completed.png"),
  });
  assert.notDeepEqual(
    outputScreenshot,
    completedScreenshot,
    "Returned work and canonical status are distinct screenshot states",
  );
  assert.equal(
    provider.requests.length,
    callsBeforeReload,
    "Reload does not create another paid turn",
  );
  assert.match(account.channelId, /^[a-f0-9-]{36}$/);
  const instructionCount = await relay.query(
    `SELECT count(*) FROM events WHERE kind=9 AND tags @> '[["h","${account.channelId}"],["client","colony:first-job-start:v1"]]'::jsonb;`,
  );
  assert.equal(instructionCount, "1");
  const taskCount = await relay.query(
    `SELECT count(DISTINCT content::jsonb->>'id') FROM events WHERE kind=30181 AND content::jsonb->>'sourceChannelId'='${account.channelId}' AND content::jsonb->>'threadRoot'='${account.rootEventId}';`,
  );
  assert.equal(taskCount, "1");
  const gatewayCalls = proxy.requests.filter(
    (request) =>
      request.host === proxy.businessHost &&
      request.method === "POST" &&
      request.path === "/gateway/openai/v1/chat/completions" &&
      request.status === 200,
  );
  const mintedTokens = proxy.requests.filter(
    (request) =>
      request.host === proxy.businessHost &&
      request.method === "POST" &&
      request.path === "/api/gateway/tokens" &&
      request.status === 200,
  );
  assert.ok(
    mintedTokens.length >= 1,
    "Actual runtimes obtain the owner/relay-scoped provisioned gateway lease",
  );
  assert.ok(
    gatewayCalls.length > 0,
    "Actual model requests traverse the canonical credits gateway",
  );
  assert.equal(
    gatewayCalls.length,
    provider.requests.length,
    "Every fixture model response comes through the real gateway",
  );
  onProgress("worker-output-reviewed-canonical-task-completed");
  return {
    unstaffed,
    defaultBrief,
    deliveredDrafts,
    taskId: task.id,
    status: task.status,
    instructionCount,
    taskCount,
    modelResponses: "deterministic local fixture",
    execution:
      "real packaged ACP, shell, signed CLI, relay and credits gateway",
    funding:
      "real admin ledger seed in isolated database; no payment settlement tested",
    requests: provider.requests,
    tools: provider.tools,
    fixtureRuntimeBaseUrl: approved.runtimeBaseUrl,
    untouchedProviderDefault:
      "not tested; explicit fixture gateway base approved",
    gatewayModelCalls: gatewayCalls.length,
    mintedRuntimeTokens: mintedTokens.length,
    isolatedRuntimes,
    toolResults: provider.toolResults,
    quotaRetries,
    fixtureHttpRequests: { ...approved.fixtureHttpRequests },
    observer:
      "read-only SQL status every 2s; signed relay head checked for commands and final state",
    preStartAdmissionPauseSeconds: 60,
    presentation,
    reloadCompletion,
  };
}
