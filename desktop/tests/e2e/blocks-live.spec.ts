import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installBridge, TEST_IDENTITIES } from "../helpers/bridge";

const execFile = promisify(execFileCallback);
const enabled = process.env.BUZZ_E2E_BLOCKS_LIVE === "1";

type CommandResult = Record<string, unknown>;

function required(name: string, value: string | undefined): string {
  if (!value)
    throw new Error(`${name} is required when BUZZ_E2E_BLOCKS_LIVE=1`);
  return value;
}

function json(output: string, command: string): CommandResult {
  try {
    return JSON.parse(output) as CommandResult;
  } catch (error) {
    throw new Error(
      `${command} returned non-JSON output: ${output}\n${String(error)}`,
    );
  }
}

async function runCli(
  binary: string,
  relayHttpUrl: string,
  args: string[],
  identity: keyof typeof TEST_IDENTITIES = "tyler",
): Promise<CommandResult> {
  const authTag =
    identity === "charlie"
      ? required("BUZZ_E2E_AGENT_AUTH_TAG", process.env.BUZZ_E2E_AGENT_AUTH_TAG)
      : "";
  const { stdout, stderr } = await execFile(binary, args, {
    env: {
      ...process.env,
      BUZZ_AUTH_TAG: authTag,
      BUZZ_PRIVATE_KEY: TEST_IDENTITIES[identity].privateKey,
      BUZZ_RELAY_URL: relayHttpUrl,
    },
  });
  if (stderr.trim())
    test
      .info()
      .annotations.push({ type: "cli-stderr", description: stderr.trim() });
  return json(stdout, `${binary} ${args.join(" ")}`);
}

async function eventually<T>(fn: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError ?? new Error("live gate did not converge before timeout");
}

async function writeEvidence(directory: string, name: string, value: unknown) {
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, name),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}

async function readRelaySelf(relayHttpUrl: string): Promise<string> {
  const response = await fetch(relayHttpUrl, {
    headers: { Accept: "application/nostr+json" },
  });
  if (!response.ok) {
    throw new Error(`NIP-11 request failed with HTTP ${response.status}`);
  }
  const document = (await response.json()) as { self?: unknown };
  if (
    typeof document.self !== "string" ||
    !/^[0-9a-f]{64}$/i.test(document.self)
  ) {
    throw new Error("relay did not advertise a valid NIP-11 self pubkey");
  }
  return document.self.toLowerCase();
}

async function screenshot(
  page: import("@playwright/test").Page,
  directory: string,
  name: string,
) {
  await mkdir(directory, { recursive: true });
  await waitForAnimations(page);
  await page.screenshot({ path: path.join(directory, name), fullPage: true });
}

/**
 * Gate C intentionally owns neither relay nor ACP lifecycle.  The invoking
 * harness provides a running relay, an ACP fixture configured with
 * BUZZ_E2E_ACP_PROMPT_LOG, and memberships for the test identities.
 */
test.describe("Blocks live Gate C", () => {
  // This spec intentionally mutates a harness-owned relay. A Playwright retry
  // would reuse that state and stop proving the clean Core -> custom transition;
  // rerun the harness instead so every attempt starts from a reset schema.
  test.describe.configure({ retries: 0 });
  test.skip(
    !enabled,
    "set BUZZ_E2E_BLOCKS_LIVE=1 to run the harness-owned live gate",
  );

  test("persists the chat-native Blocks loop with signed relay evidence", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const relayHttpUrl = required(
      "BUZZ_E2E_RELAY_HTTP_URL",
      process.env.BUZZ_E2E_RELAY_HTTP_URL,
    );
    const relayWsUrl = required(
      "BUZZ_E2E_RELAY_WS_URL",
      process.env.BUZZ_E2E_RELAY_WS_URL,
    );
    const relaySelf = await readRelaySelf(relayHttpUrl);
    const cli = required("BUZZ_E2E_CLI_BIN", process.env.BUZZ_E2E_CLI_BIN);
    const databaseUrl = required(
      "BUZZ_E2E_DATABASE_URL",
      process.env.BUZZ_E2E_DATABASE_URL,
    );
    const evidenceRoot = required(
      "BUZZ_E2E_EVIDENCE_DIR",
      process.env.BUZZ_E2E_EVIDENCE_DIR,
    );
    const approvalCounter = required(
      "BUZZ_E2E_APPROVAL_COUNTER",
      process.env.BUZZ_E2E_APPROVAL_COUNTER,
    );
    const harnessProject = required(
      "BUZZ_E2E_HARNESS_PROJECT",
      process.env.BUZZ_E2E_HARNESS_PROJECT,
    );
    const evidence = evidenceRoot;
    const name = `blocks-live-${process.pid}`;

    // This channel is created through the public signed CLI path.  It is the
    // only test-owned relay state; no TwoRelayHarness or raw event SQL is used.
    const created = await runCli(cli, relayHttpUrl, [
      "channels",
      "create",
      "--name",
      name,
      "--type",
      "stream",
      "--visibility",
      "open",
    ]);
    const channelId = String(created.channel_id ?? "");
    if (!channelId)
      throw new Error("channels create did not return channel_id");
    await runCli(cli, relayHttpUrl, [
      "channels",
      "add-member",
      "--channel",
      channelId,
      "--pubkey",
      TEST_IDENTITIES.charlie.pubkey,
      "--role",
      "member",
    ]);

    const leadManifest = path.resolve(
      "../crates/buzz-relay/src/core_blocks/composites/lead-card.json",
    );
    const approvalManifest = path.resolve(
      "../crates/buzz-relay/src/core_blocks/composites/approval.json",
    );
    const brainstormManifest = path.resolve(
      "../crates/buzz-relay/src/core_blocks/composites/brainstorm.json",
    );
    const oldLeadData = path.join(evidence, "lead-old.json");
    const newLeadData = path.join(evidence, "lead-new.json");
    const nextLeadManifest = path.join(evidence, "lead-card-1.1.0.json");
    const approvalData = path.join(evidence, "approval.json");
    const approvalInput = path.join(evidence, "approval-input.json");
    const brainstormData = path.join(evidence, "brainstorm.json");
    const brainstormInput = path.join(evidence, "brainstorm-input.json");
    await writeEvidence(evidence, "lead-old.json", {
      company_id: `gate-c-${process.pid}`,
      name: "Gate C Lead",
      website: "https://example.com/gate-c",
      fit_summary: "Persisted through the signed relay path.",
      status: "qualified",
      score: 91,
      evidence: ["Live relay signature", "Browser-visible card"],
    });
    await writeEvidence(evidence, "lead-new.json", {
      company_id: `gate-c-${process.pid}-active`,
      name: "Gate C Lead",
      website: "https://example.com/gate-c-active",
      fit_summary: "Rendered through the newly activated presentation.",
      status: "qualified",
      score: 94,
      evidence: ["Active catalog version", "Old instance remains pinned"],
    });
    await writeEvidence(evidence, "approval.json", {
      action: "Send Gate C evidence",
      destination: "gate-c@example.com",
      content: "Deliberate retry proof.",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      status: "pending",
    });
    await writeEvidence(evidence, "brainstorm.json", {
      title: "Gate C direction",
      prompt: "Choose the two directions to execute.",
      choices: [
        { id: "editorial", label: "Editorial", description: "Typography-led." },
        { id: "conversion", label: "Conversion", description: "Proof-led." },
      ],
    });
    await writeEvidence(evidence, "brainstorm-input.json", {
      selected: ["editorial", "conversion"],
      custom_input: "Keep the experience conversational and restrained.",
    });

    const nextManifest = JSON.parse(
      await readFile(leadManifest, "utf8"),
    ) as Record<string, unknown> & {
      tree: Record<string, unknown>;
    };
    nextManifest.version = "1.1.0";
    nextManifest.created_at = Math.floor(Date.now() / 1000);
    nextManifest.origin = "workspace-custom";
    nextManifest.description =
      "A Gate C presentation update authored through the workshop conversation.";
    nextManifest.tree = {
      ...nextManifest.tree,
      title: "Qualified lead: {{name}}",
    };
    await writeEvidence(evidence, "lead-card-1.1.0.json", nextManifest);

    // Scout posts the old active Lead Card before any catalog change.
    const oldLead = await runCli(cli, relayHttpUrl, [
      "blocks",
      "invoke",
      "--channel",
      channelId,
      "--handle",
      "lead-card",
      "--data",
      oldLeadData,
      "--processor",
      TEST_IDENTITIES.charlie.pubkey,
    ]);
    const oldLeadEventId = String(oldLead.event_id ?? "");
    if (!oldLeadEventId)
      throw new Error("old Lead Card invoke did not return event_id");
    const userRequest = await runCli(cli, relayHttpUrl, [
      "messages",
      "send",
      "--channel",
      channelId,
      "--content",
      "@Developer update this Lead Card presentation without changing the old instance.",
      "--mention",
      TEST_IDENTITIES.charlie.pubkey,
      "--reply-to",
      oldLeadEventId,
    ]);
    const userRequestEventId = String(userRequest.event_id ?? "");
    if (!userRequestEventId)
      throw new Error("workshop request did not return event_id");

    // Developer validates, publishes, and previews a new immutable manifest in
    // the same conversation. Only the human owner activates it.
    const leadTest = await runCli(
      cli,
      relayHttpUrl,
      ["blocks", "test", "--manifest", nextLeadManifest],
      "charlie",
    );
    const approvalTest = await runCli(cli, relayHttpUrl, [
      "blocks",
      "test",
      "--manifest",
      approvalManifest,
    ]);
    const brainstormTest = await runCli(cli, relayHttpUrl, [
      "blocks",
      "test",
      "--manifest",
      brainstormManifest,
    ]);
    const draft = await runCli(
      cli,
      relayHttpUrl,
      ["blocks", "draft", "--manifest", nextLeadManifest],
      "charlie",
    );
    const draftId = String(draft.event_id ?? "");
    if (!draftId) throw new Error("blocks draft did not return event_id");
    const preview = await runCli(
      cli,
      relayHttpUrl,
      [
        "blocks",
        "invoke",
        "--channel",
        channelId,
        "--handle",
        "lead-card",
        "--data",
        newLeadData,
        "--manifest",
        draftId,
        "--processor",
        TEST_IDENTITIES.charlie.pubkey,
        "--reply-to",
        oldLeadEventId,
      ],
      "charlie",
    );
    const activation = await runCli(cli, relayHttpUrl, [
      "blocks",
      "activate",
      "--handle",
      "lead-card",
      "--manifest",
      draftId,
    ]);
    const newLead = await runCli(cli, relayHttpUrl, [
      "blocks",
      "invoke",
      "--channel",
      channelId,
      "--handle",
      "lead-card",
      "--data",
      newLeadData,
      "--processor",
      TEST_IDENTITIES.charlie.pubkey,
    ]);
    const newLeadEventId = String(newLead.event_id ?? "");
    if (!newLeadEventId)
      throw new Error("new Lead Card invoke did not return event_id");
    const approval = await runCli(cli, relayHttpUrl, [
      "blocks",
      "invoke",
      "--channel",
      channelId,
      "--handle",
      "approval",
      "--data",
      approvalData,
      "--processor",
      TEST_IDENTITIES.charlie.pubkey,
    ]);
    const approvalEventId = String(approval.event_id ?? "");
    if (!approvalEventId)
      throw new Error("blocks invoke approval did not return event_id");
    const brainstorm = await runCli(cli, relayHttpUrl, [
      "blocks",
      "invoke",
      "--channel",
      channelId,
      "--handle",
      "brainstorm",
      "--data",
      brainstormData,
      "--processor",
      TEST_IDENTITIES.charlie.pubkey,
    ]);
    const brainstormEventId = String(brainstorm.event_id ?? "");
    if (!brainstormEventId)
      throw new Error("blocks invoke brainstorm did not return event_id");
    const firstProposal = await runCli(
      cli,
      relayHttpUrl,
      [
        "agents",
        "draft-create",
        "--channel",
        channelId,
        "--display-name",
        "Gate C Researcher",
        "--system-prompt",
        "Research target companies and preserve evidence.",
      ],
      "charlie",
    );
    const secondProposal = await runCli(
      cli,
      relayHttpUrl,
      [
        "agents",
        "draft-create",
        "--channel",
        channelId,
        "--display-name",
        "Gate C QA",
        "--system-prompt",
        "Review deliverables and report concrete defects.",
      ],
      "charlie",
    );
    const proposalIds = [firstProposal, secondProposal].map((proposal) =>
      String(proposal.instance_event_id ?? ""),
    );
    if (proposalIds.some((id) => !id))
      throw new Error("agent draft-create did not return both instance IDs");
    await writeEvidence(evidence, "cli.json", {
      created,
      databaseUrl,
      oldLead,
      userRequest,
      userRequestEventId,
      leadTest,
      approvalTest,
      brainstormTest,
      draft,
      preview,
      activation,
      newLead,
      approval,
      brainstorm,
      firstProposal,
      secondProposal,
    });

    // The real relay backs message/catalog reads. Agent execution itself is a
    // browser Tauri seam: native creation's exactly-once contract is covered by
    // `agent_proposals_tests.rs`, not falsely claimed by Chromium.
    await installBridge(page, {
      mode: "relay",
      user: "tyler",
      relayHttpUrl,
      relayWsUrl,
      mock: {
        // The browser E2E bridge stands in for Tauri only. Mirror the value the
        // real native command reads from this same relay's NIP-11 document so
        // manifest trust is still rooted in the live relay identity.
        relaySelf,
        agentProposalExecutionOutcomes: [
          {
            status: "applied",
            definition_id: "gate-c-native-seam",
            agent_pubkey: TEST_IDENTITIES.charlie.pubkey,
            recovered: false,
          },
        ],
        globalAgentConfig: {
          env_vars: { OPENAI_COMPAT_API_KEY: "gate-c-placeholder" },
          model: "gpt-5",
          preferred_runtime: "buzz-agent",
          provider: "openai",
        },
        // The native store is the only mocked boundary in this relay-backed
        // run. Mirror the locally managed Charlie process that the real ACP
        // harness started above so the desktop can enforce proposal ownership.
        managedAgents: [
          {
            pubkey: TEST_IDENTITIES.charlie.pubkey,
            name: "Charlie",
            status: "running",
          },
        ],
      },
    });
    await page.goto("/");
    await expect(page.getByTestId("app-sidebar")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(name, { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await page.getByText(name, { exact: true }).click();
    const oldLeadRow = page.locator(`[data-message-id="${oldLeadEventId}"]`);
    const newLeadRow = page.locator(`[data-message-id="${newLeadEventId}"]`);
    await expect(
      oldLeadRow.getByText("Gate C Lead", { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      newLeadRow.getByText("Qualified lead: Gate C Lead", { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByText("Approval required", { exact: true }),
    ).toBeVisible();
    await screenshot(page, evidence, "01-pinned-and-active-leads.png");

    // A full page/runtime reload must resolve each instance by its own pinned
    // manifest ID, not silently re-render the old event through the new head.
    await page.reload();
    await expect(page.getByTestId("app-sidebar")).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      oldLeadRow.getByText("Gate C Lead", { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      newLeadRow.getByText("Qualified lead: Gate C Lead", { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await screenshot(page, evidence, "02-after-desktop-restart.png");

    const proposalRows = proposalIds.map((id) =>
      page.locator(`[data-message-id="${id}"]`),
    );
    // Every assertion below chains off these two locators, so a timeline that
    // renders one proposal twice does not report a duplicate row: the chained
    // locator matches in both copies and Playwright fails somewhere else with
    // "element(s) not found" or a strict-mode violation, minutes away from the
    // real cause. Pin uniqueness here so the gate names the duplicate itself.
    for (const [index, row] of proposalRows.entries()) {
      await expect(
        row,
        `proposal row ${index} must render exactly once`,
      ).toHaveCount(1);
    }
    await expect(
      proposalRows[0].getByRole("button", { name: "Review agent" }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      proposalRows[1].getByRole("button", { name: "Review agent" }),
    ).toBeVisible({ timeout: 30_000 });
    await proposalRows[0].getByRole("button", { name: "Review agent" }).click();
    const proposalDialog = page.getByTestId("persona-dialog");
    await expect(proposalDialog.getByLabel("Agent name")).toHaveValue(
      "Gate C Researcher",
    );
    await page.keyboard.press("Escape");
    await page.reload();
    await expect(
      proposalRows[0].getByRole("button", { name: "Review agent" }),
    ).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Inbox" }).click();
    await expect(page.getByTestId("home-inbox")).toBeVisible();
    await page.getByTestId("inbox-filter-trigger").click();
    await page.getByRole("menuitemradio", { name: "Needs action" }).click();
    await expect(
      page.getByTestId(`home-inbox-item-${proposalIds[0]}`),
    ).toBeVisible();
    await expect(
      page.getByTestId(`home-inbox-item-${proposalIds[1]}`),
    ).toBeVisible();
    await screenshot(page, evidence, "03-proposals-survive-close-restart.png");
    await page.getByText(name, { exact: true }).click();

    const multiSelectAction = await runCli(cli, relayHttpUrl, [
      "blocks",
      "act",
      "--channel",
      channelId,
      "--instance",
      brainstormEventId,
      "--action",
      "brainstorm.submit",
      "--input",
      brainstormInput,
    ]);

    // A retry keeps one idempotency key. The relay durable claim is verified
    // below; issuing two CLI writes makes that property observable outside UI.
    await writeEvidence(evidence, "approval-input.json", {
      approval_hash: "a".repeat(64),
    });
    const idempotencyKey = "10000000-0000-4000-8000-000000000701";
    const firstAction = await runCli(cli, relayHttpUrl, [
      "blocks",
      "act",
      "--channel",
      channelId,
      "--instance",
      approvalEventId,
      "--action",
      "approval.approve",
      "--input",
      approvalInput,
      "--idempotency-key",
      idempotencyKey,
    ]);
    const retryAction = await runCli(cli, relayHttpUrl, [
      "blocks",
      "act",
      "--channel",
      channelId,
      "--instance",
      approvalEventId,
      "--action",
      "approval.approve",
      "--input",
      approvalInput,
      "--idempotency-key",
      idempotencyKey,
    ]);
    const counter = await eventually(async () => {
      const value = JSON.parse(
        await readFile(approvalCounter, "utf8").catch(() => "{}"),
      ) as { count?: number };
      return value.count === 1 ? value : undefined;
    });
    const { stdout: claimCount } = await execFile(
      "docker",
      [
        "compose",
        "-p",
        harnessProject,
        "-f",
        "docker-compose.harness.yml",
        "exec",
        "-T",
        "postgres",
        "psql",
        "-U",
        "buzz",
        "-d",
        "buzz",
        "-tAc",
        `SELECT count(*) FROM block_action_claims WHERE instance_event_id = decode('${approvalEventId}', 'hex') AND idempotency_key = '${idempotencyKey}'::uuid`,
      ],
      { cwd: path.resolve("..") },
    );
    expect(Number(claimCount.trim())).toBe(1);
    await writeEvidence(evidence, "approval-retry.json", {
      firstAction,
      retryAction,
      idempotencyKey,
      claimCount: Number(claimCount.trim()),
      processorCounter: counter,
    });

    // The ACP fixture's log is harness-owned. We do not manufacture a prompt:
    // this assertion fails if the live agent did not observe the signed action.
    const promptLog = path.join(evidenceRoot, "acp-prompts.log");
    const prompts = await eventually(async () => {
      const text = await readFile(promptLog, "utf8").catch(() => "");
      return text.includes(idempotencyKey) && text.includes("editorial")
        ? text
        : undefined;
    });
    await writeFile(path.join(evidence, "acp-prompt.log"), prompts, "utf8");
    await writeEvidence(evidence, "multi-select.json", { multiSelectAction });
    const approvalCompleted = page.getByText("Completed.", { exact: true });
    await expect(approvalCompleted).toBeVisible({
      timeout: 30_000,
    });
    await approvalCompleted.scrollIntoViewIfNeeded();
    await screenshot(page, evidence, "04-approval-receipt.png");

    // Browser mode reaches the real relay but its native command boundary is
    // intentionally deterministic. Double invocation must still reserve one
    // browser command; the Rust tests run by prove-blocks cover the real store.
    await proposalRows[0].getByRole("button", { name: "Review agent" }).click();
    await expect(proposalDialog.getByLabel("Agent name")).toHaveValue(
      "Gate C Researcher",
    );
    await proposalDialog
      .getByLabel("Agent name")
      .fill("Gate C Researcher approved");
    const submit = proposalDialog.getByTestId("persona-dialog-submit");
    await expect(submit).toBeEnabled();
    await submit.evaluate((element) => {
      (element as HTMLElement).click();
      (element as HTMLElement).click();
    });
    // The dialog closes only after the signed Block action is published, and
    // the client gives that publish PUBLISH_TIMEOUT_MS (25s) before it gives
    // up. The integration project's default expect timeout is 15s, so the
    // assertion could fire while the publish was still inside its own budget
    // and report a hung dialog for a round trip that was merely slow. Wait
    // past the publish deadline, like the receipt assertions below already do.
    await expect(proposalDialog).toBeHidden({ timeout: 30_000 });
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window.__BUZZ_E2E_COMMAND_LOG__ ?? []).filter(
              (entry) => entry.command === "execute_agent_proposal",
            ).length,
        ),
      )
      .toBe(1);
    await expect(proposalRows[0].getByText("Completed.")).toBeVisible({
      timeout: 30_000,
    });
    await proposalRows[1].getByRole("button", { name: "Review agent" }).click();
    const decline = proposalDialog.getByRole("button", { name: "Decline" });
    await expect(decline).toBeEnabled();
    await decline.click();
    await expect(proposalDialog).toBeHidden({ timeout: 30_000 });
    await expect(proposalRows[1].getByText("Declined.")).toBeVisible({
      timeout: 30_000,
    });
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window.__BUZZ_E2E_COMMAND_LOG__ ?? []).filter(
              (entry) => entry.command === "execute_agent_proposal",
            ).length,
        ),
      )
      .toBe(1);
    await page.getByRole("button", { name: "Inbox" }).click();
    await page.getByTestId("inbox-filter-trigger").click();
    await page.getByRole("menuitemradio", { name: "Needs action" }).click();
    // The home feed refreshes from the real relay when a live feed update
    // lands (useLiveHomeFeedActions), and e2e mode exposes the same refetch
    // via the app's buzz:e2e-home-feed-updated hook. Wait for the feed to
    // converge on the relay's projection before asserting: the gate must
    // prove the loop, not race the client feed cache. The assertion below
    // still fails if the loop is broken (no receipt, or the projection keeps
    // the resolved instance) because the refetch hits the real relay.
    await page.evaluate(() => {
      window.dispatchEvent(new Event("buzz:e2e-home-feed-updated"));
    });
    await expect(
      page.getByTestId(`home-inbox-item-${proposalIds[0]}`),
    ).toHaveCount(0);
    await expect(
      page.getByTestId(`home-inbox-item-${proposalIds[1]}`),
    ).toHaveCount(0);
    await screenshot(page, evidence, "05-proposals-resolved.png");

    test.info().annotations.push(
      { type: "gate-c-evidence", description: evidence },
      {
        type: "native-seam",
        description:
          "Browser execute_agent_proposal is mocked; native exactly-once is separately cargo-tested.",
      },
      {
        type: "gate-b",
        description:
          "Invalid, timeout, and offline visual evidence remains in Gate B.",
      },
    );
  });
});
