// Explicit fixture owner approval and real ACP work in the UI-created thread.
import assert from "node:assert/strict";
import path from "node:path";
import { expect } from "@playwright/test";
import { waitForAnimations } from "../../tests/helpers/animations.ts";
import { nativeProofReader, verifySigned } from "./native-team.mjs";
import {
  readPendingAttempt,
  readRenderedCompany,
  waitForTeamPreview,
} from "./diagnostics.mjs";
import {
  FIRST_JOB_BRIEF,
  INSTAGRAM_DRAFTS,
  WORKER_OUTPUT,
  SCOUT_REVIEW,
} from "./provider.mjs";

import { readFixtureInstruction } from "./instruction.mjs";
import { readApprovalAttempt } from "./approval-diagnostics.mjs";
import { assertCreditsProof, creditsProofQuery } from "./credits-proof.mjs";
import {
  loseSyncedFixtureTeam,
  proveFixtureTeamRecovery,
  readFixtureTeamReadiness,
} from "./team-recovery.mjs";
import {
  installNativePublishObserver,
  readNativePublishObservations,
} from "./native-publish-diagnostics.mjs";

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
  const preJobCalls = account.preLegacyModelCalls;
  assert.ok(
    Number.isInteger(preJobCalls) &&
      preJobCalls >= account.connectionProbe.calls,
    "Account proof records the paid Scout setup baseline before the legacy job",
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
  const relayPubkey = await invoke("get_relay_self");
  const originalAgents = await invoke("list_managed_agents");
  assert.equal(
    originalAgents.length,
    1,
    "Actual onboarding supplies Scout only",
  );
  assert.equal(originalAgents[0].persona_id, "builtin:fizz");
  assert.ok(
    Number(originalAgents[0].pid) > 0,
    "Approved setup leaves the starter Scout runtime available",
  );
  assert.equal(originalAgents[0].relay_url, account.relayUrl);
  assert.equal(originalAgents[0].owner_identified, true);
  const starterPersona = (await invoke("list_personas")).find(
    (persona) => persona.id === "builtin:fizz",
  );
  assert.ok(starterPersona);
  assert.equal(starterPersona.is_builtin, true);
  assert.equal(starterPersona.role_id, "chief-of-staff");
  assert.equal(starterPersona.role_title, "Chief of Staff");
  assert.equal(starterPersona.is_active, true);
  assert.ok(starterPersona.system_prompt.length > 0);
  const starterScout = {
    pubkey: originalAgents[0].pubkey,
    persona: starterPersona,
  };
  const reader = nativeProofReader({
    relay,
    account,
    invoke,
    relayPubkey,
    starterScout,
  });
  const profileHead = await reader.business();
  assert.equal(
    (await reader.events(30175)).filter(
      (event) => event.pubkey === account.ownerPubkey,
    ).length,
    0,
    "The packaged builtin is local; no custom worker definition exists before approval",
  );
  assert.equal((await reader.events(30181)).length, 0);
  assert.equal(provider.receivedCallCount, preJobCalls);
  const teamPreviews = {};
  const waitForProposal = async (phase, startedAt = Date.now()) => {
    await waitForTeamPreview({
      startedAt,
      readState: () =>
        cards.first().evaluate((card) => {
          const panel = card.querySelector(
            '[data-testid="first-job-team-proposal"]',
          );
          const pending =
            panel?.querySelector('[role="status"]')?.textContent ===
            "Checking your team…";
          const retryAvailable = Array.from(
            panel?.querySelectorAll("button") ?? [],
          ).some((button) => button.textContent === "Check team");
          return {
            pending,
            ready: !!panel && !panel.querySelector('[role="status"]'),
            retryAvailable,
            error: card.querySelector('[role="alert"]')?.textContent ?? null,
          };
        }),
      onObservation: (observation) => {
        teamPreviews[phase] = observation;
        onEvidence({ teamPreviews: { ...teamPreviews } });
      },
    });
    await expect(
      cards.first().getByTestId("first-job-team-proposal"),
    ).toContainText("Sarah");
    await expect(
      cards.first().getByTestId("first-job-team-proposal"),
    ).toContainText("Content & Campaign Specialist");
  };
  await waitForProposal("beforeWorkApproval");
  // The connection probe already seeded this isolated ledger through the operator CLI.
  const initialCredits = await invoke("get_colony_credits_account");
  assert.equal(
    initialCredits.available_balance_nanousd,
    initialCredits.total_balance_nanousd,
  );
  assert.ok(BigInt(initialCredits.total_balance_nanousd) < 5000000000n);
  const config = await invoke("get_global_agent_config");
  assert.equal(config.credential_mode, "colony_credits");
  assert.equal(config.preferred_runtime, "buzz-agent");
  const runtimeBaseUrl = `https://${proxy.businessHost}/gateway/openai/v1`;
  // Explicit fixture-only global base; newly prepared workers must still inherit it.
  const saved = await invoke("set_global_agent_config", {
    config: {
      ...config,
      env_vars: { ...config.env_vars, OPENAI_COMPAT_BASE_URL: runtimeBaseUrl },
    },
    expectedOwnerPubkey: account.ownerPubkey,
    expectedRelayUrl: account.relayUrl,
  });
  assert.equal(saved.failed_restart_count, 0);
  assert.equal(saved.restarted_count, 0);
  const proposalReloadStartedAt = Date.now();
  await reloadWelcome();
  assert.equal(provider.receivedCallCount, preJobCalls);
  assert.equal((await readPendingAttempt(page, account)).exists, false);
  await expect(cards.first().getByRole("textbox")).toHaveValue(brief);
  await waitForProposal("afterReload", proposalReloadStartedAt);
  const unstaffed = {
    modelCalls: 0,
    tasks: 0,
    workers: 0,
    result:
      "Concrete new worker shown; approval creates it through native preparation",
  };
  onEvidence({
    unstaffed,
    profile: { eventId: profileHead.id, signatureVerified: true },
  });
  await waitForAnimations(page);
  await page.screenshot({
    path: path.join(proofDirectory, "joined-team-before-approval.png"),
  });
  let prepared;
  let preparationRead;
  const readTeam = () =>
    (preparationRead ??= (async () => {
      const deadline = Date.now() + 30_000;
      let lastError;
      do {
        try {
          prepared = await reader.readTeam();
          return prepared;
        } catch (error) {
          lastError = error;
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      } while (Date.now() < deadline);
      throw lastError;
    })());
  provider.configure({
    rootId: account.rootEventId,
    channelId: account.channelId,
    brief,
    readTeam,
    readTask: reader.readTask,
  });
  // Normal explicit product action. No direct create/persona/rank/membership calls.
  const start = cards
    .first()
    .getByRole("button", { name: "Approve team and start", exact: true });
  await expect(start).toBeEnabled();
  const teamLoss = await loseSyncedFixtureTeam({
    directory,
    account,
    reader,
    relay,
  });
  onEvidence({ teamLoss });
  assert.equal(provider.receivedCallCount, preJobCalls);
  assert.equal((await reader.events(30181)).length, 0);
  onProgress("genuine-synced-team-projection-loss-injected");
  await page.evaluate(installNativePublishObserver, {
    ownerPubkey: account.ownerPubkey,
    relayUrl: account.relayUrl,
    channelId: account.channelId,
    rootEventId: account.rootEventId,
    requestId: account.suggestion.requestId,
  });
  await start.click();
  await readTeam().catch(async (error) => {
    onEvidence({
      retainedApproval: await readApprovalAttempt(page, account).catch(() => ({
        unavailable: true,
      })),
      nativePublishResponses: await readNativePublishObservations(page),
      relayApprovalEvents: await reader
        .events(9)
        .then((events) =>
          events
            .filter(
              (event) =>
                event.pubkey === account.ownerPubkey &&
                event.tags.some(
                  (tag) =>
                    tag[0] === "client" &&
                    tag[1] === "colony:first-job-team-approval:v1" &&
                    tag[2] === account.suggestion.requestId,
                ),
            )
            .map((event) => event.id),
        )
        .catch(() => ({ unavailable: true })),
    });
    throw error;
  });
  const publicTeam = () =>
    Object.fromEntries(
      ["scout", "worker"].map((actor) => {
        const { prompt: _prompt, ...ref } = prepared[actor];
        return [actor, ref];
      }),
    );
  const approved = {
    ...prepared,
    profileHead,
    runtimeBaseUrl,
    readTask: reader.readTask,
    fixtureHttpRequests: {
      observer: "read-only SQL; native frontend retains real relay reads",
    },
    readApprovalEvidence: async () => {
      const fresh = await reader.readTeam();
      assert.equal(fresh.worker.pubkey, prepared.worker.pubkey);
      return {
        ...publicTeam(),
        approvalId: fresh.approvalId,
        receiptId: fresh.receiptId,
        membershipId: fresh.membershipId,
      };
    },
  };
  onEvidence(await approved.readApprovalEvidence());
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
            provider.receivedCallCount,
            preJobCalls,
            "Do not retry after legacy model work began",
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
        nativePublishResponses: await readNativePublishObservations(page),
        teamReadiness: await readFixtureTeamReadiness(directory, account).catch(
          () => ({ unavailable: true }),
        ),
      });
      const taskFailure = await reader
        .failureEvidence()
        .catch(() => ({ unavailable: true }));
      onEvidence({
        taskFailure,
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
  onEvidence({
    nativePublishResponses: await readNativePublishObservations(page),
  });
  const task = await approved.readTask();
  assert.equal(task.status, "completed");
  onEvidence({
    teamReadiness: await readFixtureTeamReadiness(directory, account).catch(
      () => ({ unavailable: true }),
    ),
  });
  const teamRecovery = await proveFixtureTeamRecovery({
    directory,
    account,
    reader,
    loss: teamLoss,
    task,
  });
  onEvidence({ teamRecovery });
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
  const signedReplies = [];
  for (const [actor, marker] of [
    ["worker", WORKER_OUTPUT],
    ["scout", SCOUT_REVIEW],
  ]) {
    const replies = (await reader.events(9)).filter((event) =>
      event.content.startsWith(marker),
    );
    assert.ok(
      replies.length > 0,
      `Actual signed ${actor} output reached the relay`,
    );
    for (const event of replies) {
      verifySigned(event, 9, approved[actor].pubkey);
      for (const [name, value] of [
        ["h", account.channelId],
        ["e", account.rootEventId],
        ["task", task.id],
        ["team", task.owningTeamId],
      ]) {
        assert.ok(
          event.tags.some((tag) => tag[0] === name && tag[1] === value),
          `Signed ${actor} reply keeps ${name} scope`,
        );
      }
      signedReplies.push({
        actor,
        eventId: event.id,
        pubkey: event.pubkey,
        signatureVerified: true,
      });
    }
  }
  onEvidence({ signedReplies });
  const instruction = await readFixtureInstruction({
    relay,
    invoke,
    account,
    scout: approved.scout,
    worker: actualAgents.find(
      (agent) => agent.pubkey === approved.worker.pubkey,
    ),
    brief,
  });
  const instructionRow = page
    .getByTestId("message-thread-replies")
    .getByTestId("message-row")
    .filter({ hasText: "Coordinate this job in this thread." })
    .first();
  await expect(instructionRow).toContainText(/Ask\s+@?Sarah\s+to do the work/);
  await expect(instructionRow).not.toContainText(/nostr:npub/);
  await instructionRow.scrollIntoViewIfNeeded();
  await waitForAnimations(page);
  await page.screenshot({
    path: path.join(proofDirectory, "joined-friendly-instruction.png"),
  });
  onEvidence({ instruction });
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
  const callsBeforeReload = provider.receivedCallCount;
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
    provider.receivedCallCount,
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
    provider.receivedCallCount,
    "Every received fixture model call comes through the real gateway",
  );
  provider.assertHealthy();
  assert.equal(provider.requests.length, provider.receivedCallCount);
  const chargedResponses = provider.requests.map((request) => ({
    responseId: request.responseId,
    model: request.model,
    usage: { ...request.usage },
  }));
  const callsBeforeStop = provider.receivedCallCount;
  const stoppedRuntimes = [];
  for (const agent of [approved.scout, approved.worker]) {
    assert.equal((await invoke("get_identity")).pubkey, account.ownerPubkey);
    assert.equal(await invoke("get_relay_ws_url"), account.relayUrl);
    const stopped = await invoke("stop_managed_agent", {
      pubkey: agent.pubkey,
    });
    assert.ok(
      stopped.pid == null,
      "The actual model producer has stopped before final accounting",
    );
    stoppedRuntimes.push({ pubkey: agent.pubkey, pid: stopped.pid ?? null });
  }
  assert.equal(
    provider.receivedCallCount,
    callsBeforeStop,
    "No late model call escapes final reconciliation",
  );
  let accounting;
  let debits;
  await expect
    .poll(
      async () => {
        accounting = JSON.parse(
          await relay.query(creditsProofQuery(account.ownerPubkey)),
        );
        onEvidence({
          finalAccounting: {
            chargedResponses,
            stoppedRuntimes,
            snapshot: accounting,
          },
        });
        try {
          debits = assertCreditsProof(
            accounting,
            chargedResponses,
            account.connectionProbe.fundingNanousd,
          );
          return true;
        } catch {
          return false;
        }
      },
      {
        timeout: 30_000,
        intervals: [1000],
        message:
          "Every exact provider response has one terminal intent and distinct debit",
      },
    )
    .toBe(true);
  // Retain the precise assertion even if a future poll implementation changes.
  debits = assertCreditsProof(
    accounting,
    chargedResponses,
    account.connectionProbe.fundingNanousd,
  );
  const finalCredits = await invoke("get_colony_credits_account");
  assert.equal(finalCredits.total_balance_nanousd, accounting.balance);
  assert.equal(finalCredits.available_balance_nanousd, accounting.balance);
  assert.equal(finalCredits.gateway_reserved_nanousd, "0");
  assert.equal(finalCredits.discovery_reserved_nanousd, "0");
  assert.equal(provider.receivedCallCount, callsBeforeStop);
  provider.assertHealthy();
  const creditsSettlement = {
    initial: initialCredits,
    totalSyntheticFundingNanousd: account.connectionProbe.fundingNanousd,
    final: finalCredits,
    debits,
    chargedResponses,
    stoppedRuntimes,
    intents: accounting.intents,
    ledgerRows: accounting.debits,
    funding: "Synthetic isolated admin seed; no checkout or vendor payment",
  };
  onEvidence({ creditsSettlement });
  onProgress("worker-output-reviewed-canonical-task-completed");
  return {
    unstaffed,
    defaultBrief,
    instruction,
    deliveredDrafts,
    taskId: task.id,
    status: task.status,
    teamRecovery,
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
    creditsSettlement,
    isolatedRuntimes,
    signedReplies,
    approval: await approved.readApprovalEvidence(),
    actorAuthority:
      "Exact own System persona against unchanged native builtin Scout and owner-signed30175 worker; signed30177 tier and manager; signed reply pubkeys",
    rankContextLimitation:
      "ACP rank lines read employee30190, so managed-agent30177 ranks may be absent from model work context",
    toolResults: provider.toolResults,
    quotaRetries,
    fixtureHttpRequests: { ...approved.fixtureHttpRequests },
    observer:
      "read-only SQL status every 2s; signed relay head checked for commands and final state",
    preStartAdmissionPauseSeconds: 0,
    presentation,
    reloadCompletion,
  };
}
