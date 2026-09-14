// One-off acceptance only. Never imported by the app or ordinary PR CI.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export const MODEL = "deepseek/deepseek-v4.1-flash";
const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const MAX_REQUESTS = 100;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_OUTPUT_TOKENS = 8192;

/** Host-only credential bridge; records usage metadata, never prompts or keys. */
export async function createLiveProofProvider({ apiKey, fetchImpl = fetch }) {
  assert.ok(apiKey?.startsWith("sk-or-v1-"), "Dedicated proof key required");
  const token = randomBytes(32).toString("hex");
  const receipts = [];
  const toolDiagnostics = new Set();
  const controllers = new Set();
  let calls = 0;
  let queue = Promise.resolve();
  let queued = 0;
  let closed = false;
  let failed = false;
  let upstreamStatus = null;
  const expires = Date.now() + 45 * 60_000;
  const server = createServer(async (request, response) => {
    const reply = (status, body) => {
      if (response.destroyed || response.writableEnded) return;
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      reply(404, { error: "Unsupported proof route" });
      return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      reply(401, { error: "Proof authorization required" });
      return;
    }
    if (closed || failed || calls >= MAX_REQUESTS || Date.now() >= expires) {
      reply(429, { error: "Proof budget exhausted or stopped" });
      return;
    }
    if (queued >= 8) {
      reply(429, { error: "Proof queue full" });
      return;
    }
    queued += 1;
    const previous = queue;
    let release;
    queue = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    if (closed || failed || calls >= MAX_REQUESTS || Date.now() >= expires) {
      queued -= 1;
      release();
      reply(429, { error: "Proof budget exhausted or stopped" });
      return;
    }
    const controller = new AbortController();
    controllers.add(controller);
    const timeout = setTimeout(() => {
      controller.abort();
      request.destroy();
    }, 120_000);
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        assert.ok(size <= MAX_BODY_BYTES, "Proof request too large");
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.ok(Array.isArray(body.messages), "Messages required");
      // Classify only tool results, retaining fixed categories rather than text.
      for (const message of body.messages) {
        if (message.role !== "tool") continue;
        const content = JSON.stringify(message.content ?? "");
        for (const [category, pattern] of [
          ["command-unavailable", /command not found|No such file or directory/i],
          ["cli-arguments", /unexpected argument|required arguments|unrecognized subcommand/i],
          ["authentication", /unauthorized|authentication failed|\b401\b/i],
          ["permission", /permission denied|forbidden|\b403\b/i],
          ["coordinator-authority", /coordinator.*(?:must|invalid|not|requires)|installed coordinator/i],
          ["block-instance", /(?:review|card) instance.*(?:not found|must|not authored)/i],
          ["task-reference", /missing reference|task.*not found|unknown task/i],
          ["generation-conflict", /generation.*(?:mismatch|conflict)|stale generation/i],
        ]) {
          if (pattern.test(content)) toolDiagnostics.add(category);
        }
      }
      let upstream;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        assert.ok(calls < MAX_REQUESTS && Date.now() < expires && !closed);
        calls += 1;
        upstream = await fetchImpl(ENDPOINT, {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: MODEL,
            messages: body.messages,
            ...(body.tools ? { tools: body.tools } : {}),
            ...(body.tool_choice ? { tool_choice: body.tool_choice } : {}),
            stream: false,
            max_tokens: MAX_OUTPUT_TOKENS,
            reasoning: { effort: "high" },
            provider: { allow_fallbacks: true },
          }),
        });
        upstreamStatus = upstream.status;
        if (upstream.status !== 429 || attempt === 2) break;
        const retryAfter = upstream.headers.get("retry-after");
        const seconds = retryAfter === null ? 10 : Number(retryAfter);
        assert.ok(
          Number.isFinite(seconds) && seconds >= 0 && seconds <= 30,
          "Rate limit exceeds bounded retry window",
        );
        await upstream.body?.cancel();
        await delay(Math.max(1, seconds) * 1000, undefined, {
          signal: controller.signal,
        });
      }
      assert.ok(upstream.ok, `Provider status ${upstream.status}`);
      const result = await upstream.json();
      assert.ok(Array.isArray(result.choices), "Provider completion missing");
      const usage = result.usage;
      assert.ok(Number.isFinite(usage?.cost), "Provider cost receipt required");
      receipts.push({
        call: calls,
        model: MODEL,
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        costUsd: usage.cost,
      });
      reply(200, result);
    } catch {
      failed = true;
      // Do not echo request data, provider errors, or credentials into logs.
      reply(502, { error: "Live proof provider failed; run stopped" });
    } finally {
      clearTimeout(timeout);
      controllers.delete(controller);
      queued -= 1;
      release();
    }
  });
  server.requestTimeout = 130_000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    httpUrl: `http://127.0.0.1:${server.address().port}`,
    token,
    receipts,
    diagnostics() {
      return { calls, failed, upstreamStatus, completedCalls: receipts.length, toolDiagnostics: [...toolDiagnostics].sort() };
    },
    assertHealthy() {
      assert.equal(failed, false, "Live provider run failed");
    },
    async close() {
      closed = true;
      for (const controller of controllers) controller.abort();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      apiKey = undefined;
    },
  };
}
