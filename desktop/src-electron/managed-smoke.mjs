// Actual packaged Electron + native managed launcher + ACP workers + local relay.
// All identities, provider responses and browser pages are synthetic.
import { _electron as electron, expect } from "@playwright/test";
import { waitForAnimations } from "../tests/helpers/animations.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { grantFilename } from "./browser/managed-workers.mjs";
const exec = promisify(execFile);
const bundle = process.env.COLONY_SMOKE_APP;
assert.ok(bundle, "COLONY_SMOKE_APP must identify the built app");
const relay = process.env.COLONY_SMOKE_RELAY || "ws://127.0.0.1:3157";
assert.ok(
  new URL(relay).hostname === "127.0.0.1",
  "Use only the isolated local relay",
);
const data = await realpath(
  await mkdtemp(path.join(os.tmpdir(), "colony-managed-proof-")),
);
const cli = path.join(bundle, "Contents/Resources/native/buzz");
const owner = `${"0".repeat(63)}1`;
const cliEnv = {
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  HOME: data,
  BUZZ_PRIVATE_KEY: owner,
  BUZZ_RELAY_URL: relay,
};
const runCli = async (...args) => {
  const { stdout } = await exec(cli, args, {
    env: cliEnv,
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout);
};
const queues = new Map();
const requests = [];
let modelError;
const server = createServer(async (request, response) => {
  try {
    if (request.url === "/page") {
      response.end(
        "<!doctype html><title>Isolation proof</title><h1>PRIVATE_BRAND_BRIEF</h1><label>Draft<textarea></textarea></label>",
      );
      return;
    }
    if (request.method === "GET" && request.url === "/inference/key") {
      assert.equal(request.headers.authorization, "Bearer synthetic-assigned");
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          data: { is_management_key: false, is_free_tier: true },
        }),
      );
      return;
    }
    if (request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          data: [
            {
              id: "fixture",
              object: "model",
              owned_by: "test",
              supported_parameters: ["tools"],
            },
          ],
        }),
      );
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const key = request.headers.authorization?.replace(/^Bearer /, "");
    assert.equal(
      request.url,
      key === "synthetic-assigned"
        ? "/inference/chat/completions"
        : "/v1/chat/completions",
      "Metering must preserve each provider's exact configured base path",
    );
    requests.push({ key, body });
    const completionCheck = body.messages
      .at(-1)
      ?.content?.startsWith("You have stopped.");
    const next = completionCheck
      ? () => ({ role: "assistant", content: '{"complete":true}' })
      : queues.get(key)?.shift();
    const message = next
      ? next(body)
      : { role: "assistant", content: "Test turn complete." };
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        id: "fixture",
        object: "chat.completion",
        model: "fixture",
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
        choices: [
          {
            index: 0,
            message,
            finish_reason: message.tool_calls ? "tool_calls" : "stop",
          },
        ],
      }),
    );
  } catch (error) {
    modelError = error;
    response.statusCode = 500;
    response.end("Fixture failed");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const waitFor = async (label, check, timeout = 45000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (modelError) throw modelError;
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw Error(`Timed out: ${label}`);
};
let app;
let page;
const workers = [];
const invoke = (command, args = {}) =>
  page.evaluate(
    ({ command, args }) =>
      window.colonyDesktop.request("invoke", { command, args }),
    { command, args },
  );
const launch = async () => {
  app = await electron.launch({
    executablePath: path.join(bundle, "Contents/MacOS/Colony Electron Beta"),
    args: [],
    cwd: data,
    timeout: 30000,
    env: {
      ...cliEnv,
      TMPDIR: os.tmpdir(),
      COLONY_ELECTRON_USER_DATA: data,
      BUZZ_SHARE_IDENTITY: "1",
    },
  });
  page = await app.firstWindow();
  await page.waitForFunction(() => !!window.colonyDesktop);
  await page
    .getByText("Inbox", { exact: true })
    .filter({ visible: true })
    .first()
    .waitFor({ timeout: 30000 });
  // Let the initial community route replacement finish before an async invoke.
  await page.waitForTimeout(1500);
};
try {
  await launch();
  const identity = await invoke("get_identity");
  assert.ok(identity, "The native host supplies the test identity");
  const config = await invoke("get_global_agent_config");
  await invoke("set_global_agent_config", {
    config: { ...config, credential_mode: "byok" },
  });
  const channel = await runCli(
    "channels",
    "create",
    "--name",
    "isolation-proof",
    "--type",
    "stream",
    "--visibility",
    "open",
  );
  assert.equal(channel.accepted, true);
  for (const name of ["Assigned", "Unassigned"]) {
    const key = `synthetic-${name.toLowerCase()}`;
    const provider = name === "Assigned" ? "openrouter" : "deepseek";
    const created = await invoke("create_managed_agent", {
      input: {
        name,
        agentCommand: "buzz-agent",
        provider,
        model: "fixture",
        relayUrl: relay,
        startOnAppLaunch: false,
        spawnAfterCreate: false,
        respondTo: "owner-only",
        backend: { type: "local" },
        parallelism: 1,
        envVars: {
          BUZZ_AGENT_PROVIDER: provider,
          ...(provider === "openrouter"
            ? {
                OPENROUTER_API_KEY: key,
                OPENROUTER_BASE_URL: `${origin}/inference`,
              }
            : {
                DEEPSEEK_API_KEY: key,
                OPENAI_COMPAT_BASE_URL: `${origin}/v1`,
              }),
          BUZZ_AGENT_LLM_TIMEOUT_SECS: "10",
          BUZZ_AGENT_TOOL_TIMEOUT_SECS: "10",
        },
      },
    });
    console.log("Created worker:", name, created.agent?.pubkey);
    assert.equal(created.spawn_error, null);
    workers.push(created.agent);
    await runCli(
      "channels",
      "add-member",
      "--channel",
      channel.channel_id,
      "--pubkey",
      created.agent.pubkey,
      "--role",
      "bot",
    );
    const worker = await invoke("start_managed_agent", {
      pubkey: created.agent.pubkey,
    });
    assert.equal(worker.isolated, true);
    assert.equal(worker.status, "running");
    workers[workers.length - 1] = worker;
  }
  await writeFile(
    path.join(data, "launch-proof.json"),
    JSON.stringify(
      {
        workers: workers.map(({ pubkey, name, pid, isolated, log_path }) => ({
          pubkey,
          name,
          pid,
          isolated,
          log_path,
        })),
        channel,
        origin,
      },
      null,
      2,
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 3000));
  for (const worker of workers) {
    const rows = await invoke("list_managed_agents");
    const current = rows.find((row) => row.pubkey === worker.pubkey);
    assert.equal(current?.status, "running", JSON.stringify(current));
    console.log(
      `${worker.name} remained running after sandbox initialization: PASS`,
    );
  }
  const request = (type, payload) =>
    page.evaluate(
      ({ type, payload }) => window.colonyDesktop.request(type, payload),
      { type, payload },
    );
  const business = "managed-proof";
  const tabId = "proof-tab";
  await request("business", { id: business, relay });
  await request("browser:open", { id: tabId, business, url: `${origin}/page` });
  await waitFor("fixture page load", () =>
    app.evaluate(
      ({ webContents }, url) =>
        webContents
          .getAllWebContents()
          .some((wc) => wc.getURL() === url && !wc.isLoading()),
      `${origin}/page`,
    ),
  );
  await request("browser:share", {
    id: tabId,
    pubkey: workers[0].pubkey,
    mode: "interact",
  });
  const toolText = (body) =>
    JSON.stringify(body.messages.filter((message) => message.role === "tool"));
  const textboxRef = (body) => {
    const snapshot = [...body.messages]
      .reverse()
      .find(
        (message) =>
          message.role === "tool" && message.content?.includes('"outline"'),
      );
    const ref = JSON.parse(snapshot.content).outline.match(
      /([a-f0-9]{12}-[0-9]+) textbox Draft/,
    )?.[1];
    assert.ok(ref, "Latest snapshot exposes the fixture textbox");
    return ref;
  };
  const call = (suffix, args) => (body) => {
    const name = body.tools.find((tool) =>
      tool.function.name.endsWith(`__${suffix}`),
    )?.function.name;
    assert.ok(name, `The real worker must have ${suffix}`);
    return {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: `call-${requests.length}`,
          type: "function",
          function: {
            name,
            arguments: JSON.stringify(
              typeof args === "function" ? args(body) : args,
            ),
          },
        },
      ],
    };
  };
  let turn = 0;
  const runTurn = async (worker, steps) => {
    const key = `synthetic-${worker.name.toLowerCase()}`;
    const marker = `FIXTURE_TURN_DONE_${++turn}`;
    const start = requests.length;
    queues.set(key, [
      ...steps,
      call("shell", (body) => {
        const context = [...body.messages]
          .reverse()
          .find(
            (message) =>
              message.role === "user" && message.content?.includes("Event ID:"),
          )?.content;
        const root = context?.match(/Event ID: ([a-f0-9]{64})/)?.[1];
        assert.ok(root, "Real relay context supplies the reply thread");
        return {
          command: `buzz messages send --channel ${channel.channel_id} --reply-to ${root} --content ${marker}`,
          timeout_ms: 10000,
        };
      }),
      () => ({ role: "assistant", content: marker }),
    ]);
    await runCli(
      "messages",
      "send",
      "--channel",
      channel.channel_id,
      "--mention",
      worker.pubkey,
      "--content",
      `Exercise the isolation boundary, test turn ${turn}.`,
    );
    await waitFor(
      `model completes ${marker}`,
      () => queues.get(key).length === 0,
      60000,
    );
    await waitFor(`relay publishes ${marker}`, async () =>
      JSON.stringify(
        await runCli(
          "messages",
          "get",
          "--channel",
          channel.channel_id,
          "--limit",
          "20",
        ),
      ).includes(marker),
    );
    return requests.slice(start).filter((request) => request.key === key);
  };
  const assigned = await runTurn(workers[0], [
    call("browser_snapshot", { tabId }),
    call("browser_type", (body) => {
      const ref = textboxRef(body);
      assert.ok(ref, "Snapshot exposes the real fixture textbox");
      return { tabId, ref, text: "APPROVED_TEST_DRAFT" };
    }),
  ]);
  assert.ok(toolText(assigned.at(-1).body).includes("PRIVATE_BRAND_BRIEF"));
  assert.equal(
    await app.evaluate(
      ({ webContents }, url) =>
        webContents
          .getAllWebContents()
          .find((wc) => wc.getURL() === url)
          .executeJavaScript("document.querySelector('textarea').value"),
      `${origin}/page`,
    ),
    "APPROVED_TEST_DRAFT",
  );
  console.log(
    "Native-launched agent read and typed in the actual browser: PASS",
  );
  let victimGrant;
  const grantName = grantFilename(workers[0]);
  for (const entry of await readdir(os.tmpdir())) {
    if (!entry.startsWith("colony-browser-")) continue;
    const candidate = path.join(os.tmpdir(), entry, grantName);
    try {
      await access(candidate);
      victimGrant = candidate;
      break;
    } catch {}
  }
  assert.ok(
    victimGrant,
    "Locate only the grant for our uniquely generated test worker",
  );
  const victimToken = JSON.parse(await readFile(victimGrant, "utf8")).token;
  const profile = path.join(data, "synthetic-browser-profile-secret");
  await writeFile(profile, "SYNTHETIC_BROWSER_PROFILE_SECRET");
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const unassigned = await runTurn(workers[1], [
    call("browser_snapshot", { tabId }),
    call("shell", {
      command: `cat ${quote(victimGrant)}; cat ${quote(profile)}`,
      timeout_ms: 5000,
    }),
  ]);
  const stolen = toolText(unassigned.at(-1).body);
  assert.ok(stolen.includes("No browser tab is shared"));
  assert.ok(
    stolen.includes("Operation not permitted") ||
      stolen.includes("Permission denied"),
  );
  assert.ok(!stolen.includes(victimToken));
  assert.ok(!stolen.includes("SYNTHETIC_BROWSER_PROFILE_SECRET"));
  console.log(
    "Unassigned native worker cannot read the page, steal its grant, or read protected profile files: PASS",
  );
  await request("browser:action", { id: tabId, action: "takeover" });
  const revoked = await runTurn(workers[0], [
    call("browser_snapshot", { tabId }),
  ]);
  assert.ok(toolText(revoked.at(-1).body).includes("revoked"));
  console.log("Owner takeover revokes the running agent: PASS");
  await request("browser:share", {
    id: tabId,
    pubkey: workers[0].pubkey,
    mode: "read",
  });
  await invoke("stop_managed_agent", { pubkey: workers[0].pubkey });
  workers[0] = await invoke("start_managed_agent", {
    pubkey: workers[0].pubkey,
  });
  const restarted = await runTurn(workers[0], [
    call("browser_snapshot", { tabId }),
  ]);
  assert.ok(
    toolText(restarted.at(-1).body).includes("No browser tab is shared"),
  );
  await request("browser:share", {
    id: tabId,
    pubkey: workers[0].pubkey,
    mode: "read",
  });
  const reshared = await runTurn(workers[0], [
    call("browser_snapshot", { tabId }),
  ]);
  assert.ok(toolText(reshared.at(-1).body).includes("PRIVATE_BRAND_BRIEF"));
  console.log(
    "Restart invalidates old grants; explicit sharing restores access: PASS",
  );
  const readonly = await runTurn(workers[0], [
    call("browser_snapshot", { tabId }),
    call("browser_type", (body) => ({
      tabId,
      ref: textboxRef(body),
      text: "MUST_NOT_WRITE",
    })),
  ]);
  assert.ok(toolText(readonly.at(-1).body).includes("read-only"));
  assert.equal(
    await app.evaluate(
      ({ webContents }, url) =>
        webContents
          .getAllWebContents()
          .find((wc) => wc.getURL() === url)
          .executeJavaScript("document.querySelector('textarea').value"),
      `${origin}/page`,
    ),
    "APPROVED_TEST_DRAFT",
  );
  console.log("Read-only sharing cannot edit the real page: PASS");
  const previousGeneration = workers[0].browser_generation;
  await app.close();
  await launch();
  workers[0] = await invoke("start_managed_agent", {
    pubkey: workers[0].pubkey,
  });
  assert.equal(workers[0].isolated, true);
  assert.notEqual(workers[0].browser_generation, previousGeneration);
  await request("business", { id: business, relay });
  await request("browser:open", { id: tabId, business, url: `${origin}/page` });
  await waitFor("reopened fixture page", () =>
    app.evaluate(
      ({ webContents }, url) =>
        webContents
          .getAllWebContents()
          .some((wc) => wc.getURL() === url && !wc.isLoading()),
      `${origin}/page`,
    ),
  );
  const relaunched = await runTurn(workers[0], [
    call("browser_snapshot", { tabId }),
  ]);
  assert.ok(
    toolText(relaunched.at(-1).body).includes("No browser tab is shared"),
  );
  await request("browser:share", {
    id: tabId,
    pubkey: workers[0].pubkey,
    mode: "read",
  });
  const restored = await runTurn(workers[0], [
    call("browser_snapshot", { tabId }),
  ]);
  assert.ok(toolText(restored.at(-1).body).includes("PRIVATE_BRAND_BRIEF"));
  console.log(
    "App relaunch requires fresh sharing and the isolated worker resumes useful work: PASS",
  );
  // Configure the synthetic business in renderer storage too. Native launch tests
  // above supply their business directly; the owner UI reads the saved community.
  await page.evaluate(
    ({ business, relay }) => {
      localStorage.setItem(
        "buzz-communities",
        JSON.stringify([
          {
            id: business,
            name: "Isolation Test Business",
            relayUrl: relay,
            addedAt: new Date().toISOString(),
          },
        ]),
      );
      localStorage.setItem("buzz-active-community-id", business);
    },
    { business, relay },
  );
  // Prove the owner can perform the same share through the shipped controls.
  await page.reload();
  await page
    .getByRole("button", { name: "Done / do this later", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.goto(
    new URL(`/#/channels/${channel.channel_id}`, page.url()).href,
  );
  await page.getByTestId("channel-workspace-toggle").click();
  await page.getByTestId("workspace-create-web").click();
  await page
    .getByRole("textbox", { name: "Website address" })
    .fill(`${origin}/page`);
  await page.getByRole("button", { name: "Go", exact: true }).click();
  await page.getByText("Share with a teammate", { exact: true }).click();
  await page
    .getByRole("combobox", { name: "Browser teammate" })
    .selectOption(workers[0].pubkey);
  await page
    .getByRole("combobox", { name: "Browser access" })
    .selectOption("read");
  await page
    .getByRole("button", { name: "Share this tab", exact: true })
    .click();
  await expect(
    page.getByText("Assigned · read only", { exact: true }),
  ).toBeVisible();
  await waitForAnimations(page);
  const controls = await page.getByTestId("channel-workspace").boundingBox();
  assert.ok(controls);
  await page.screenshot({
    path: path.join(data, "teammate-sharing.png"),
    clip: { ...controls, height: Math.min(controls.height, 180) },
  });
  await page.getByRole("button", { name: "Take control", exact: true }).click();
  await expect(
    page.getByText("You are in control", { exact: true }),
  ).toBeVisible();
  console.log("Owner sharing controls and takeover in the packaged UI: PASS");
  await writeFile(
    path.join(data, "managed-proof.json"),
    JSON.stringify(
      {
        isolated: true,
        browserWork: true,
        providerRouting: ["openrouter-custom-base", "deepseek-native-key"],
        siblingDenial: true,
        takeover: true,
        restart: true,
        readonly: true,
        sharingUi: true,
        relaunch: true,
      },
      null,
      2,
    ),
  );
  console.log("Packaged managed browser isolation proof: PASS", data);
} catch (error) {
  console.error("Managed proof failed:", error.message, "Evidence:", data);
  if (page && !page.isClosed()) {
    await writeFile(
      path.join(data, "renderer-failure.txt"),
      `${page.url()}\n${await page.locator("body").innerText()}`,
    );
  }
  await writeFile(
    path.join(data, "model-requests.json"),
    JSON.stringify(requests, null, 2),
  );
  for (const worker of workers) {
    if (worker.log_path?.startsWith(data))
      console.error((await readFile(worker.log_path, "utf8")).slice(-10000));
  }
  throw error;
} finally {
  if (page)
    for (const worker of workers) {
      try {
        await invoke("stop_managed_agent", { pubkey: worker.pubkey });
      } catch {}
    }
  await app?.close();
  await new Promise((resolve) => server.close(resolve));
}
