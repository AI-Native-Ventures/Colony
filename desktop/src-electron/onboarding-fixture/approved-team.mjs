// Explicit fixture-owner approval through real APIs, after real provisioning.
// No database seeds, runtime starts, Task creation or generated output belongs here.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { verifyEvent } from "nostr-tools/pure";
import { readCurrentFixtureTask } from "./task-head.mjs";

export const SCOUT_MARKER = "ONBOARDING_FIXTURE_SCOUT_APPROVED_V1";
export const WORKER_MARKER = "ONBOARDING_FIXTURE_WORKER_APPROVED_V1";
const OWNER =
  "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const exec = promisify(execFile);

async function until(label, read, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`);
}

function tag(event, name) {
  const values = event.tags.filter((item) => item[0] === name);
  assert.equal(values.length, 1, `Exactly one ${name} tag`);
  return values[0];
}

function signed(event, kind, author) {
  assert.equal(event.kind, kind);
  assert.equal(event.pubkey, author);
  assert.ok(verifyEvent(event), `Valid real signature for kind ${kind}`);
  return event;
}

/** Approve this isolated owner's company and stopped Scout/worker through public APIs.
 * The caller owns the packaged app, exact-host fixture proxy and final cleanup.
 * Returned agent objects contain public references only, never creation secrets.
 */
export async function approveFixtureTeam({
  page,
  account,
  buzzBinary,
  proxy,
  directory,
  onProgress = () => {},
  beforeTeamApproval = async () => {},
  onTaskCandidates = () => {},
}) {
  assert.equal(account.ownerPubkey, OWNER);
  assert.equal(account.relayUrl, proxy.businessRelayUrl);
  assert.match(
    new URL(account.relayUrl).hostname,
    /^horizon-labs\.onboarding-[a-f0-9]{16}\.invalid$/,
  );
  assert.match(account.rootEventId, /^[a-f0-9]{64}$/);
  assert.match(account.channelId, /^[a-f0-9-]{36}$/);
  assert.ok(path.isAbsolute(directory));
  assert.ok(path.isAbsolute(buzzBinary));
  const scope = { ownerPubkey: OWNER, relayUrl: account.relayUrl };
  const rawInvoke = (command, args) =>
    page.evaluate(
      ({ command, args }) =>
        window.colonyDesktop.request("invoke", { command, args }),
      { command, args },
    );
  const assertScope = async () => {
    assert.equal((await rawInvoke("get_identity")).pubkey, OWNER);
    assert.equal(await rawInvoke("get_relay_ws_url"), scope.relayUrl);
  };
  const invoke = async (command, args) => {
    await assertScope();
    const value = await rawInvoke(command, args);
    await assertScope();
    return value;
  };
  const relayPubkey = await invoke("get_relay_self");
  assert.match(relayPubkey, /^[a-f0-9]{64}$/);
  const http = scope.relayUrl.replace(/^wss:/, "https:");
  const fixtureHttpRequests = { queries: 0, taskQueries: 0, eventPosts: 0 };
  // The same NIP-98 /query and /events bridge used by buzz-cli. The native
  // signer never exposes the owner's key; Chromium's fixture guard pins egress.
  const post = async (endpoint, value) => {
    assert.ok(endpoint === "/query" || endpoint === "/events");
    if (endpoint === "/events") fixtureHttpRequests.eventPosts += 1;
    const url = `${http}${endpoint}`;
    const body = JSON.stringify(value);
    const auth = JSON.parse(
      await invoke("sign_event", {
        kind: 27235,
        content: "",
        tags: [
          ["u", url],
          ["method", "POST"],
          ["payload", createHash("sha256").update(body).digest("hex")],
          ["nonce", randomUUID()],
        ],
      }),
    );
    signed(auth, 27235, OWNER);
    await assertScope();
    const result = await page.evaluate(
      async ({ url, body, authorization, scope }) => {
        const invoke = (command) =>
          window.colonyDesktop.request("invoke", { command });
        if (
          (await invoke("get_identity")).pubkey !== scope.ownerPubkey ||
          (await invoke("get_relay_ws_url")) !== scope.relayUrl
        )
          throw new Error("Fixture scope changed");
        const response = await fetch(url, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
          headers: {
            "Content-Type": "application/json",
            Authorization: authorization,
          },
          body,
        });
        if (!response.ok) throw new Error(`Fixture relay ${response.status}`);
        return response.json();
      },
      {
        url,
        body,
        authorization: `Nostr ${Buffer.from(JSON.stringify(auth)).toString("base64")}`,
        scope,
      },
    );
    await assertScope();
    return result;
  };
  const query = async (filter) => {
    assert.ok(Array.isArray(filter.kinds) && filter.kinds.length > 0);
    fixtureHttpRequests.queries += 1;
    if (filter.kinds.includes(30181)) fixtureHttpRequests.taskQueries += 1;
    const events = await post("/query", [filter]);
    assert.ok(Array.isArray(events));
    return events;
  };
  const head = async (kind, author, id) => {
    const events = await query({
      kinds: [kind],
      authors: [author],
      "#d": [id],
      limit: 1,
    });
    if (!events.length) return null;
    signed(events[0], kind, author);
    assert.equal(tag(events[0], "d")[1], id);
    return events[0];
  };

  const oldProfile = await head(30179, relayPubkey, "profile");
  const now = Math.floor(Date.now() / 1000);
  const profile = {
    schema: "colony.company/v1",
    tradingName: account.suggestion.businessName,
    legalName: null,
    website: null,
    summary: account.suggestion.business,
    businessType: "agency",
    services: [],
    customerSegments: [],
    costCentres: [
      { id: "general", name: "General", kind: "internal", serviceId: null },
    ],
    sourceReportEventId: null,
    createdAt: oldProfile ? JSON.parse(oldProfile.content).createdAt : now,
    updatedAt: Math.max(
      now,
      oldProfile ? JSON.parse(oldProfile.content).updatedAt + 1 : now,
    ),
  };
  await mkdir(directory, { recursive: true });
  const profilePath = path.join(directory, "owner-approved-company.json");
  await writeFile(profilePath, JSON.stringify(profile), {
    mode: 0o600,
    flag: "wx",
  });
  await assertScope();
  const { stdout } = await exec(
    buzzBinary,
    ["company", "put", "--file", profilePath],
    {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        TMPDIR: directory,
        BUZZ_PRIVATE_KEY: `${"0".repeat(63)}1`,
        BUZZ_RELAY_URL: http,
        BUZZ_ONBOARDING_FIXTURE_TRANSPORT: proxy.transportConfig,
        BUZZ_CONNECT_TIMEOUT_SECS: "10",
        BUZZ_TIMEOUT_SECS: "20",
      },
      timeout: 45_000,
      maxBuffer: 1024 * 1024,
    },
  );
  await assertScope();
  const approval = JSON.parse(stdout);
  assert.equal(approval.accepted, true);
  assert.equal(approval.entity_id, "profile");
  assert.match(approval.event_id, /^[a-f0-9]{64}$/);
  const profileReceipt = await until(
    "canonical company approval receipt",
    async () => {
      const events = await query({
        kinds: [40014],
        authors: [relayPubkey],
        "#e": [approval.event_id],
        limit: 1,
      });
      return events[0] ?? null;
    },
  );
  signed(profileReceipt, 40014, relayPubkey);
  assert.deepEqual(tag(profileReceipt, "e"), [
    "e",
    approval.event_id,
    "",
    "company-action",
  ]);
  assert.equal(tag(profileReceipt, "p")[1], OWNER);
  assert.equal(tag(profileReceipt, "a")[1], `30179:${relayPubkey}:profile`);
  assert.deepEqual(tag(profileReceipt, "company-receipt"), [
    "company-receipt",
    "1",
    approval.request_id,
    approval.idempotency_key,
    "applied",
  ]);
  const profileHead = await head(30179, relayPubkey, "profile");
  assert.ok(profileHead);
  assert.equal(profileHead.id, JSON.parse(profileReceipt.content).headEventId);
  assert.deepEqual(JSON.parse(profileHead.content), profile);
  // Native get_event intentionally queries only displayable message kinds;
  // its allowlist excludes company actions. Query this exact action kind.
  const actions = await query({
    kinds: [40013],
    ids: [approval.event_id],
    authors: [OWNER],
    limit: 1,
  });
  assert.equal(actions.length, 1, "The approved action is stored on the relay");
  assert.equal(actions[0].id, approval.event_id);
  signed(actions[0], 40013, OWNER);
  onProgress("operating-profile-approved");
  await beforeTeamApproval();
  await assertScope();

  const config = await invoke("get_global_agent_config");
  assert.equal(config.credential_mode, "colony_credits");
  // Isolation validates the SDK base before ACP replaces it with its meter.
  // Approve the real canonical gateway as that explicit fixture setting; never
  // map the unused public vendor default into this private network.
  const runtimeBaseUrl = `https://${proxy.businessHost}/gateway/openai/v1`;
  const catalog = await invoke("discover_acp_providers");
  const runtime = catalog.find(
    (entry) => entry.id === config.preferred_runtime,
  );
  assert.ok(
    runtime &&
      runtime.availability === "available" &&
      runtime.command &&
      !runtime.requires_external_cli,
  );
  const personas = await invoke("list_personas");
  const originalScout = personas.find(
    (persona) => persona.id === "builtin:fizz",
  );
  assert.ok(originalScout, "Actual starter Scout definition exists");
  assert.ok(
    !personas.some((persona) => persona.system_prompt.includes(WORKER_MARKER)),
    "One approval per fresh fixture",
  );
  const scoutInput = {
    id: originalScout.id,
    displayName: originalScout.display_name,
    roleId: originalScout.role_id,
    roleTitle: originalScout.role_title,
    avatarUrl: originalScout.avatar_url,
    systemPrompt: `${originalScout.system_prompt}\n\n${SCOUT_MARKER}\nFor this isolated fixture, delegate the owner's first job to the approved worker in the original thread, then review their returned draft.`,
    runtime: null,
    model: null,
    provider: null,
    namePool: originalScout.name_pool ?? [],
  };
  const scoutDefinition = (
    await invoke("update_persona_and_publish", { input: scoutInput })
  ).persona;
  await invoke("set_persona_active", { id: scoutDefinition.id, active: true });
  const workerDefinition = await invoke("create_persona", {
    input: {
      displayName: "Sarah",
      roleId: "brand-designer",
      roleTitle: "Brand designer",
      avatarUrl: null,
      systemPrompt: `${WORKER_MARKER}\nDraft three practical branding improvements for the owner's business. Work in the original thread and mention the Chief of Staff when the draft is ready for review.`,
      runtime: null,
      model: null,
      provider: null,
      namePool: [],
      envVars: {},
    },
  });
  await invoke("update_persona_and_publish", {
    input: {
      id: workerDefinition.id,
      displayName: workerDefinition.display_name,
      roleId: workerDefinition.role_id,
      roleTitle: workerDefinition.role_title,
      avatarUrl: null,
      systemPrompt: workerDefinition.system_prompt,
      runtime: null,
      model: null,
      provider: null,
      namePool: [],
    },
  });
  const team = await invoke("create_team", {
    input: {
      name: "Horizon Labs first-job team",
      description: "Owner-approved isolated onboarding proof team.",
      instructions:
        "The Chief of Staff delegates and reviews. The brand designer prepares the draft in the owner's original thread.",
      personaIds: [scoutDefinition.id, workerDefinition.id],
      leadPersonaId: scoutDefinition.id,
    },
  });
  const agents = await invoke("list_managed_agents");
  const existingScouts = agents.filter(
    (agent) =>
      agent.persona_id === scoutDefinition.id &&
      agent.relay_url === scope.relayUrl,
  );
  assert.ok(existingScouts.length <= 1, "Unambiguous actual starter Scout");
  const create = async (definition) => {
    const result = await invoke("create_managed_agent", {
      input: {
        name: definition.display_name,
        personaId: definition.id,
        teamId: team.id,
        relayUrl: scope.relayUrl,
        agentCommand: runtime.command,
        harnessOverride: false,
        agentArgs: runtime.default_args,
        envVars: { OPENAI_COMPAT_BASE_URL: runtimeBaseUrl },
        spawnAfterCreate: false,
        startOnAppLaunch: false,
        backend: { type: "local" },
        respondTo: "owner-only",
        respondToAllowlist: [],
        parallelism: 1,
      },
    });
    assert.equal(result.spawn_error, null);
    assert.equal(result.profile_sync_error, null);
    // Deliberately discard the private_key_nsec returned by the real create API.
    return result.agent;
  };
  const scoutAgent = existingScouts[0] ?? (await create(scoutDefinition));
  const workerAgent = await create(workerDefinition);
  for (const agent of [scoutAgent, workerAgent]) {
    assert.equal(agent.pid, null, "Staffing cannot start model work");
    await invoke("set_managed_agent_start_on_app_launch", {
      pubkey: agent.pubkey,
      startOnAppLaunch: false,
    });
    await invoke("update_managed_agent", {
      input: {
        pubkey: agent.pubkey,
        respondTo: "owner-only",
        respondToAllowlist: [],
        parallelism: 1,
        envVars: { OPENAI_COMPAT_BASE_URL: runtimeBaseUrl },
      },
    });
  }
  const added = await invoke("add_channel_members", {
    channelId: account.channelId,
    pubkeys: [scoutAgent.pubkey, workerAgent.pubkey],
    role: "bot",
  });
  assert.deepEqual(added.errors, []);
  await until("actual Welcome bot enrollment", async () => {
    const { members } = await invoke("get_channel_members", {
      channelId: account.channelId,
    });
    return [scoutAgent, workerAgent].every((agent) =>
      members.some(
        (member) =>
          member.pubkey === agent.pubkey &&
          member.role === "bot" &&
          member.is_agent,
      ),
    );
  });
  for (const [definition, marker] of [
    [scoutDefinition, SCOUT_MARKER],
    [workerDefinition, WORKER_MARKER],
  ]) {
    await until("published owner-approved definition", async () => {
      // Built-in/local definition IDs and NIP-AP d-tags are different (for
      // example builtin:fizz → builtin-fizz). Read the real published head;
      // do not create a second slug-normalization implementation here.
      const events = await query({
        kinds: [30175],
        authors: [OWNER],
        limit: 100,
      });
      assert.ok(
        events.length < 100,
        "Fixture definition lookup cannot truncate",
      );
      const matches = events.filter((event) => {
        signed(event, 30175, OWNER);
        return JSON.parse(event.content).system_prompt?.includes(marker);
      });
      assert.ok(matches.length <= 1, "One approved definition per marker");
      if (!matches.length) return null;
      const content = JSON.parse(matches[0].content);
      assert.equal(content.display_name, definition.display_name);
      assert.equal(content.role_id, definition.role_id);
      return matches[0];
    });
  }
  const teamHead = await until("published owner-approved team", () =>
    head(30176, OWNER, team.id),
  );
  const teamContent = JSON.parse(teamHead.content);
  assert.deepEqual(teamContent.persona_ids, [
    scoutDefinition.id,
    workerDefinition.id,
  ]);
  assert.equal(teamContent.lead_persona_id, scoutDefinition.id);
  const rank = async (agent, tier, manager) => {
    const previous = await until("original managed-agent head", () =>
      head(30177, OWNER, agent.pubkey),
    );
    const content = { ...JSON.parse(previous.content), tier };
    assert.equal(content.persona_id, agent.persona_id);
    const event = JSON.parse(
      await invoke("sign_event", {
        kind: 30177,
        content: JSON.stringify(content),
        createdAt: Math.max(
          Math.floor(Date.now() / 1000),
          previous.created_at + 1,
        ),
        tags: [["d", agent.pubkey], ...(manager ? [["manager", manager]] : [])],
      }),
    );
    signed(event, 30177, OWNER);
    assert.equal((await post("/events", event)).accepted, true);
    await invoke("record_org_placement", {
      pubkey: agent.pubkey,
      tier,
      manager,
    });
    const confirmed = await head(30177, OWNER, agent.pubkey);
    assert.equal(confirmed?.id, event.id);
    assert.equal(JSON.parse(confirmed.content).tier, tier);
    return Object.freeze({
      pubkey: agent.pubkey,
      personaId: agent.persona_id,
      name: agent.name,
      headEventId: event.id,
    });
  };
  const scout = await rank(scoutAgent, "executive", null);
  const worker = await rank(workerAgent, "worker", scout.pubkey);
  const finalAgents = await invoke("list_managed_agents");
  for (const ref of [scout, worker]) {
    const agent = finalAgents.find(
      (candidate) => candidate.pubkey === ref.pubkey,
    );
    assert.ok(
      agent && agent.persona_id === ref.personaId && !agent.persona_orphaned,
    );
    assert.equal(agent.relay_url, scope.relayUrl);
    assert.equal(agent.respond_to, "owner-only");
    assert.equal(agent.pid, null);
    assert.equal(agent.start_on_app_launch, false);
    assert.equal(agent.backend.type, "local");
    assert.equal(agent.env_vars.OPENAI_COMPAT_BASE_URL, runtimeBaseUrl);
  }
  onProgress("team-approved-stopped");
  const readTask = async () => {
    const events = await query({
      kinds: [30181],
      authors: [relayPubkey],
      limit: 100,
    });
    assert.ok(
      events.length < 100,
      "Fixture Task lookup cannot silently truncate",
    );
    return readCurrentFixtureTask(
      events,
      {
        relayPubkey,
        channelId: account.channelId,
        rootId: account.rootEventId,
      },
      onTaskCandidates,
    );
  };
  // Diagnostics intentionally project an allowlist. Native agent/definition
  // records also contain prompts, env maps and local file paths: never return
  // the full records or raw event content to a failure report.
  const readApprovalEvidence = async () => {
    const pick = (value, keys) =>
      Object.fromEntries(keys.map((key) => [key, value[key] ?? null]));
    const markers = (prompt) => ({
      hasScoutMarker:
        typeof prompt === "string" && prompt.includes(SCOUT_MARKER),
      hasWorkerMarker:
        typeof prompt === "string" && prompt.includes(WORKER_MARKER),
    });
    const publicEvent = (event) => {
      let signatureVerified = false;
      let content = null;
      try {
        signatureVerified = verifyEvent(event);
      } catch {
        /* captured below */
      }
      try {
        content = JSON.parse(event.content);
      } catch {
        /* captured below */
      }
      return {
        ...pick(event, ["id", "kind", "pubkey", "created_at"]),
        signatureVerified,
        contentParsed:
          content !== null &&
          typeof content === "object" &&
          !Array.isArray(content),
        contentHash: createHash("sha256").update(event.content).digest("hex"),
        tags: event.tags.filter((item) =>
          ["d", "manager", "rank", "role", "name", "p", "member"].includes(
            item[0],
          ),
        ),
        content:
          content && typeof content === "object" && !Array.isArray(content)
            ? pick(content, [
                "name",
                "persona_id",
                "role_id",
                "tier",
                "parallelism",
                "respond_to",
              ])
            : null,
        ...markers(content?.system_prompt),
      };
    };
    const readers = {
      agents: async () =>
        (await invoke("list_managed_agents")).map((agent) => ({
          ...pick(agent, [
            "pubkey",
            "owner_identified",
            "name",
            "persona_id",
            "team_id",
            "relay_url",
            "runtime",
            "agent_command",
            "agent_command_override",
            "persona_orphaned",
            "persona_out_of_date",
            "respond_to",
            "respond_to_allowlist",
            "status",
            "pid",
            "start_on_app_launch",
            "isolated",
          ]),
          backendType: agent.backend?.type ?? null,
          fixtureRuntimeBaseUrl: agent.env_vars?.OPENAI_COMPAT_BASE_URL ?? null,
          ...markers(agent.system_prompt),
        })),
      personas: async () =>
        (await invoke("list_personas")).map((persona) => ({
          ...pick(persona, [
            "id",
            "display_name",
            "role_id",
            "role_title",
            "is_active",
            "is_builtin",
            "runtime",
          ]),
          ...markers(persona.system_prompt),
        })),
      runtimes: async () =>
        (await invoke("discover_acp_providers")).map((runtime) =>
          pick(runtime, [
            "id",
            "label",
            "availability",
            "command",
            "requires_external_cli",
            "auth_status",
          ]),
        ),
      members: async () =>
        (
          await invoke("get_channel_members", { channelId: account.channelId })
        ).members.map((member) =>
          pick(member, ["pubkey", "role", "is_agent", "display_name"]),
        ),
      heads: async () => {
        const events = await query({
          kinds: [30177, 30190, 13534],
          limit: 500,
        });
        return {
          truncated: events.length >= 500,
          events: events.map(publicEvent),
        };
      },
    };
    const entries = Object.entries(readers);
    const results = await Promise.allSettled(entries.map(([, read]) => read()));
    return {
      capturedAt: new Date().toISOString(),
      fixtureHttpRequests: { ...fixtureHttpRequests },
      scope: {
        ...scope,
        channelId: account.channelId,
        rootEventId: account.rootEventId,
      },
      expected: {
        scout,
        worker,
        relayPubkey,
        fixtureRuntimeBaseUrl: runtimeBaseUrl,
      },
      reads: Object.fromEntries(
        results.map((result, index) => [
          entries[index][0],
          result.status === "fulfilled"
            ? { ok: true, value: result.value }
            : {
                ok: false,
                errorType:
                  result.reason instanceof Error
                    ? result.reason.name
                    : typeof result.reason,
              },
        ]),
      ),
    };
  };
  return {
    scout,
    worker,
    team,
    teamHead,
    profileHead,
    profileReceipt,
    scoutMarker: SCOUT_MARKER,
    workerMarker: WORKER_MARKER,
    readTask,
    readApprovalEvidence,
    runtimeBaseUrl,
    fixtureHttpRequests,
  };
}
