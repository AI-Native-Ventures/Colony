// Deterministic model responses only. Every tool, signature, Task and reply is real.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFixtureShellResult } from "./tool-result.mjs";
import { nativeRequestActor } from "./native-team.mjs";

// An independent acceptance literal: the fixture must use the actual default,
// not replace a different suggestion and claim to have tested the first job.
export const FIRST_JOB_BRIEF =
  'Draft five Instagram captions and five matching visual briefs for "Horizon Labs". Use the business context shared in this thread. Keep them ready for my review; do not create images or publish posts.';
export const INSTAGRAM_DRAFTS = Object.freeze(
  [
    {
      day: "Monday",
      title: "One recognisable business",
      caption:
        "Your website and social posts should feel like they belong to the same business. Horizon Labs brings your branding, website and social content together so your next customer gets a clearer picture of what you do. Which part of your brand needs attention first?",
      visualBrief:
        "Create a portrait layout with three aligned panels labelled Brand, Website and Social. Use the existing Horizon Labs palette and logo, with one consistent type style across all panels. Put the headline One recognisable business above the panels; keep the footer clear for the logo.",
    },
    {
      day: "Tuesday",
      title: "Make the next step clear",
      caption:
        "When someone lands on your website, can they quickly see what you offer and how to contact you? Start with one clear headline, a short explanation and an obvious enquiry button. Horizon Labs builds websites around those everyday customer questions. Save this as a quick homepage check.",
      visualBrief:
        "Show a simple homepage wireframe on a plain brand-colour background. Highlight three areas with numbered callouts: headline, service explanation and enquiry button. Use schematic text blocks rather than a fabricated client website. Add the heading Three things your homepage should make clear.",
    },
    {
      day: "Wednesday",
      title: "Consistency beyond the logo",
      caption:
        "A recognisable brand is more than a logo. Repeating your colours, type and tone helps your website and social posts feel connected. If your business has outgrown its current look, Horizon Labs can help bring those pieces together. Send us a message to tell us what has changed.",
      visualBrief:
        "Arrange a small brand toolkit: a logo placeholder, colour swatches, a type sample and a social-post frame. Apply the existing Horizon Labs visual identity throughout. Use the headline More than a logo and label the four elements clearly. Do not imply this is a completed client rebrand.",
    },
    {
      day: "Thursday",
      title: "Give each post a purpose",
      caption:
        "Not every post needs to sell. Explain a useful idea, answer a customer question or show how your service works. A small plan makes it easier to keep your business visible with content that belongs to your brand. Horizon Labs helps create and manage that content with you.",
      visualBrief:
        "Build a three-card editorial graphic labelled Explain, Answer and Show. Pair each label with a simple line icon and a short supporting phrase. Use generous spacing and the existing brand palette. Place the heading Give each post a purpose above the cards, with no invented performance metrics.",
    },
    {
      day: "Friday",
      title: "Start with your business",
      caption:
        "Thinking about a clearer brand, a refreshed website or more consistent social content? Tell Horizon Labs what your business does, who you serve and what you want to improve. We can start from that conversation and shape the next step together. Message us when you are ready to talk.",
      visualBrief:
        "Design a simple invitation graphic headed Tell us about your business. Below it, show three prompts: What you do, Who you serve and What needs to improve. Finish with Message Horizon Labs and the existing logo. Keep the design focused on an enquiry, without adding an unverified price or guarantee.",
    },
  ].map((draft) => Object.freeze(draft)),
);
export const WORKER_OUTPUT =
  "ONBOARDING_WORKER_OUTPUT: Five Instagram caption and visual-brief pairs for Horizon Labs";
export const WORKER_DRAFT = [
  WORKER_OUTPUT,
  "Drafts for your review. These are written visual briefs; no images have been created and no posts have been published.",
  ...INSTAGRAM_DRAFTS.map(
    (draft, index) =>
      `### ${index + 1}. ${draft.day} — ${draft.title}\n\n**Caption:** ${draft.caption}\n\n**Visual brief:** ${draft.visualBrief}`,
  ),
].join("\n\n");
export const SCOUT_REVIEW =
  "ONBOARDING_SCOUT_REVIEW: Reviewed all five captions and five matching visual briefs. They follow the shared website, branding and social-content offer, with a different purpose for each weekday. No invented customer results, prices or guarantees. Ready for your review; no images created and no posts published.";
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
      const requestNumber = ++calls;
      assert.ok(requestNumber <= 40, "Fixture model call budget exceeded");
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(
        request.headers.authorization,
        "Bearer synthetic-onboarding-provider",
      );
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
      const team = await context.readTeam();
      const currentTask = await context.readTask();
      const actor = nativeRequestActor(body.messages, team, currentTask);
      assert.equal(currentTask.threadRoot, context.rootId);
      assert.equal(currentTask.sourceChannelId, context.channelId);
      const last = body.messages.at(-1)?.content;
      const completion =
        typeof last === "string" && last.startsWith("You have stopped.");
      const stage =
        actor === "worker"
          ? "worker"
          : all.includes(WORKER_OUTPUT)
            ? "review"
            : "delegate";
      if (stage === "delegate")
        assert.ok(
          all.includes(JSON.stringify(context.brief).slice(1, -1)),
          "The real Chief of Staff receives the unchanged default brief",
        );
      if (stage === "worker")
        assert.ok(
          all.includes(JSON.stringify(context.brief).slice(1, -1)),
          "The real worker receives the default five-pair brief through delegation",
        );
      if (stage === "review")
        for (const draft of INSTAGRAM_DRAFTS)
          for (const field of [draft.caption, draft.visualBrief])
            assert.ok(
              all.includes(JSON.stringify(field).slice(1, -1)),
              "The Chief of Staff receives every caption and visual brief for review",
            );
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
          return `buzz messages send ${thread} --mention ${team.worker.pubkey} --content ${quote(`${context.brief}\n\nPrepare one distinct caption and matching visual brief for each weekday. Return all five pairs in this thread and mention the Chief of Staff for review.`)}`;
        }
        if (stage === "worker") {
          return `buzz messages send ${thread} --mention ${team.scout.pubkey} --content ${quote(WORKER_DRAFT)}`;
        }
        if (index === 0)
          return `buzz messages send ${thread} --content ${quote(SCOUT_REVIEW)}`;
        return `buzz tasks report-complete --task ${quote(task.id)} --note ${quote("Reviewed the worker's five Instagram captions and five matching visual briefs in the original onboarding thread. Drafts await owner review; no images created or posts published.")}`;
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
        const toolCallId = `onboarding-call-${requestNumber}`;
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
      const responseId = `onboarding-${requestNumber}`;
      const usage = {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      };
      requests.push({
        actor,
        stage,
        completion,
        model: body.model,
        responseId,
        usage,
      });
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          id: responseId,
          object: "chat.completion",
          model: body.model,
          usage,
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
    get receivedCallCount() {
      return calls;
    },
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
      for (const key of ["rootId"]) assert.match(value[key], /^[a-f0-9]{64}$/);
      assert.match(value.channelId, /^[a-f0-9-]{36}$/);
      assert.equal(value.brief, FIRST_JOB_BRIEF);
      assert.equal(typeof value.readTeam, "function");
      assert.equal(typeof value.readTask, "function");
      context = Object.freeze({ ...value });
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
