// Deterministic model responses only. Every tool, signature, Task and reply is real.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFixtureShellResult } from "./tool-result.mjs";

export const WORKER_OUTPUT =
  "ONBOARDING_WORKER_OUTPUT: Three proposed improvements for Horizon Labs";
export const SCOUT_REVIEW =
  "ONBOARDING_SCOUT_REVIEW: Reviewed the three improvements; ready for your decision.";
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

/** Serve the OpenAI-compatible upstream consumed by the real local credits gateway. */
export async function createOnboardingFixtureProvider() {
  let context;
  let error;
  let calls = 0;
  const requests = [];
  const steps = new Map();
  const tools = [];
  const toolResults = [];
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(
        request.headers.authorization,
        "Bearer synthetic-onboarding-provider",
      );
      assert.ok(++calls <= 40, "Fixture model call budget exceeded");
      let raw = "";
      for await (const chunk of request) {
        raw += chunk;
        assert.ok(Buffer.byteLength(raw) <= 4 * 1024 * 1024);
      }
      const body = JSON.parse(raw);
      assert.ok(
        context,
        "No model calls are allowed before explicit staffing and Start",
      );
      const all = JSON.stringify(body.messages);
      const actor = all.includes(context.workerMarker)
        ? "worker"
        : all.includes(context.scoutMarker)
          ? "scout"
          : null;
      assert.ok(actor, "The real runtime carries the fixture persona marker");
      const last = body.messages.at(-1)?.content;
      const completion =
        typeof last === "string" && last.startsWith("You have stopped.");
      const stage =
        actor === "worker"
          ? "worker"
          : all.includes(WORKER_OUTPUT)
            ? "review"
            : "delegate";
      const index = steps.get(stage) ?? 0;
      const previousTool = tools.findLast(
        (tool) => tool.actor === actor && tool.stage === stage,
      );
      if (previousTool && !completion) {
        const result = readFixtureShellResult(
          body.messages,
          previousTool.toolCallId,
        );
        if (
          !toolResults.some((entry) => entry.toolCallId === result.toolCallId)
        )
          toolResults.push({ actor, stage, ...result });
        assert.equal(
          result.exitCode,
          0,
          "Actual shell command must exit successfully",
        );
        assert.equal(
          result.timedOut,
          false,
          "Actual shell command must finish within its bound",
        );
        assert.equal(
          result.accepted,
          true,
          "Exact issued CLI command must report relay acceptance",
        );
      }
      const command = async () => {
        const task = await context.readTask();
        assert.equal(task.threadRoot, context.rootId);
        assert.equal(task.sourceChannelId, context.channelId);
        const thread = `--channel ${context.channelId} --reply-to ${context.rootId} --task ${quote(task.id)} --team ${quote(task.owningTeamId)}`;
        if (stage === "delegate") {
          return `buzz messages send ${thread} --mention ${context.workerPubkey} --content ${quote("Review Horizon Labs and draft three practical branding improvements, each with a reason and next step. Return your output in this thread and mention the Chief of Staff for review.")}`;
        }
        if (stage === "worker") {
          return `buzz messages send ${thread} --mention ${context.scoutPubkey} --content ${quote(`${WORKER_OUTPUT}\n\n1. Lead with the monthly branding offer. Reason: visitors can understand the service immediately. Next step: review a clearer headline.\n2. Use one consistent visual system. Reason: the website and social posts should feel related. Next step: approve a colour and typography guide.\n3. Show a clear enquiry action. Reason: prospects need an obvious next step. Next step: review a short enquiry form.`)}`;
        }
        if (index === 0)
          return `buzz messages send ${thread} --content ${quote(SCOUT_REVIEW)}`;
        return `buzz tasks report-complete --task ${quote(task.id)} --note ${quote("Reviewed the worker's three proposed improvements in the original onboarding thread.")}`;
      };
      let message;
      if (completion)
        message = { role: "assistant", content: '{"complete":true}' };
      else if (index < (stage === "review" ? 2 : 1)) {
        const name = body.tools?.find((tool) =>
          tool.function.name.endsWith("__shell"),
        )?.function.name;
        assert.ok(name, "The actual managed agent exposes the shell tool");
        const shell = await command();
        const toolCallId = `onboarding-call-${calls}`;
        tools.push({ actor, stage, command: shell, toolCallId });
        steps.set(stage, index + 1);
        message = {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: toolCallId,
              type: "function",
              function: {
                name,
                arguments: JSON.stringify({
                  command: shell,
                  timeout_ms: 15000,
                }),
              },
            },
          ],
        };
      } else {
        message = {
          role: "assistant",
          content:
            stage === "delegate"
              ? "The worker is preparing the draft in this thread."
              : stage === "worker"
                ? "The draft is ready for the Chief of Staff to review."
                : SCOUT_REVIEW,
        };
      }
      requests.push({ actor, stage, completion, model: body.model });
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          id: `onboarding-${calls}`,
          object: "chat.completion",
          model: body.model,
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          choices: [
            {
              index: 0,
              message,
              finish_reason: message.tool_calls ? "tool_calls" : "stop",
            },
          ],
        }),
      );
    } catch (cause) {
      error = cause;
      response.writeHead(500).end(
        JSON.stringify({
          error: { message: "Onboarding model fixture failed" },
        }),
      );
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    httpUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
    tools,
    toolResults,
    assertHealthy() {
      if (error) throw error;
    },
    configure(value) {
      assert.equal(
        context,
        undefined,
        "One approved team per fixture provider",
      );
      for (const key of ["rootId", "workerPubkey", "scoutPubkey"])
        assert.match(value[key], /^[a-f0-9]{64}$/);
      assert.match(value.channelId, /^[a-f0-9-]{36}$/);
      context = Object.freeze({ ...value });
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
