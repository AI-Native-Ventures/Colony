#!/usr/bin/env node
/** Deterministic ACP fixture for agents-everywhere live tests. */
import { execFile } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { createInterface } from "node:readline";

const exec = promisify(execFile);

const wakeDelayMs = Number.parseInt(
  process.env.BUZZ_E2E_FAKE_ACP_WAKE_MS ?? "0",
  10,
);
if (!Number.isFinite(wakeDelayMs) || wakeDelayMs < 0) {
  throw new Error("BUZZ_E2E_FAKE_ACP_WAKE_MS must be a non-negative integer");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const textFromPrompt = (params) =>
  (params?.prompt ?? [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");

const processApproval = async (prompt) => {
  const counterPath = process.env.BUZZ_E2E_APPROVAL_COUNTER;
  const cli = process.env.BUZZ_E2E_CLI_BIN;
  if (!counterPath || !cli || !prompt.includes("action=approval.approve"))
    return;

  const action = prompt.match(
    /^Block action: instance=([0-9a-f]{64}) action=approval\.approve idempotency=([0-9a-f-]{36})$/m,
  );
  const eventStarts = [...prompt.matchAll(/^Event ID: ([0-9a-f]{64})$/gm)];
  const owningEvent = eventStarts
    .filter((candidate) => (candidate.index ?? -1) < (action?.index ?? -1))
    .at(-1);
  const nextEvent = eventStarts.find(
    (candidate) => (candidate.index ?? -1) > (action?.index ?? -1),
  );
  const eventSection =
    owningEvent && action
      ? prompt.slice(owningEvent.index, nextEvent?.index ?? prompt.length)
      : "";
  const actionEventId = owningEvent?.[1];
  const channel = eventSection.match(/^Channel: .+ \(#([^)]+)\)$/m)?.[1];
  const parsed = eventSection.match(
    /^Block action: instance=([0-9a-f]{64}) action=approval\.approve idempotency=([0-9a-f-]{36})$/m,
  );
  if (!actionEventId || !channel || !parsed) {
    throw new Error(
      "approval Block prompt is missing its signed routing fields",
    );
  }
  const [, instanceEventId, idempotencyKey] = parsed;
  const existing = existsSync(counterPath)
    ? JSON.parse(readFileSync(counterPath, "utf8"))
    : { processed: {} };
  if (existing.processed[idempotencyKey]) return;

  const resultPath = join(
    dirname(counterPath),
    "approval-processor-result.json",
  );
  writeFileSync(
    resultPath,
    `${JSON.stringify({ summary: "Bounded Gate C processor completed once." })}\n`,
    "utf8",
  );
  await exec(
    cli,
    [
      "blocks",
      "receipt",
      "--channel",
      channel,
      "--action",
      actionEventId,
      "--instance",
      instanceEventId,
      "--status",
      "succeeded",
      "--result",
      resultPath,
    ],
    { env: process.env },
  );
  existing.processed[idempotencyKey] = {
    action_event_id: actionEventId,
    instance_event_id: instanceEventId,
  };
  existing.count = Object.keys(existing.processed).length;
  writeFileSync(counterPath, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
};

let sessionCounter = 0;
const input = createInterface({
  input: process.stdin,
  crlfDelay: Number.POSITIVE_INFINITY,
});
for await (const line of input) {
  if (!line.trim()) continue;
  const request = JSON.parse(line);
  if (request.id === undefined || typeof request.method !== "string") continue;

  switch (request.method) {
    case "initialize":
      if (wakeDelayMs > 0) await sleep(wakeDelayMs);
      write({
        jsonrpc: "2.0",
        id: request.id,
        result: { protocolVersion: 2, agentCapabilities: {} },
      });
      break;
    case "session/new":
      sessionCounter += 1;
      write({
        jsonrpc: "2.0",
        id: request.id,
        result: { sessionId: `fake-session-${sessionCounter}` },
      });
      break;
    case "session/prompt": {
      const prompt = textFromPrompt(request.params);
      const promptLog = process.env.BUZZ_E2E_ACP_PROMPT_LOG;
      if (promptLog) {
        appendFileSync(
          promptLog,
          `===== ${request.params?.sessionId ?? "unknown-session"} =====\n${prompt}\n`,
          "utf8",
        );
      }
      await processApproval(prompt);
      const ids = [...prompt.matchAll(/\bAE-ID:([A-Za-z0-9._:-]+)\b/g)].map(
        (match) => match[1],
      );
      const ack = `AE-ACK:${ids.join(",")}`;
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: request.params?.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: ack },
          },
        },
      });
      const channel = prompt.match(/^Channel: .+ \(#([^)]+)\)$/m)?.[1];
      const replyTo = prompt.match(/--reply-to ([0-9a-f]{64})/)?.[1];
      const cli = process.env.BUZZ_E2E_CLI_BIN;
      if (cli && channel) {
        const args = [
          "messages",
          "send",
          "--channel",
          channel,
          "--content",
          ack,
        ];
        if (replyTo) args.push("--reply-to", replyTo);
        await exec(cli, args, { env: process.env });
      }
      write({
        jsonrpc: "2.0",
        id: request.id,
        result: { stopReason: "end_turn" },
      });
      break;
    }
    case "session/cancel":
      write({ jsonrpc: "2.0", id: request.id, result: {} });
      break;
    default:
      write({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32601,
          message: `Unsupported fixture method: ${request.method}`,
        },
      });
  }
}
