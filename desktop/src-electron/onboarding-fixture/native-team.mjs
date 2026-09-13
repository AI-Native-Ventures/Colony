// Observe real native staffing and signed relay state. This helper never creates it.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { verifyEvent } from "nostr-tools/pure";
import { readCurrentFixtureTask } from "./task-head.mjs";
import { redactReason, wireEvent } from "./failure-diagnostics.mjs";

export function verifySigned(event, kind, author) {
  assert.equal(event.kind, kind);
  assert.equal(event.pubkey, author);
  const signed = Object.fromEntries(
    ["id", "pubkey", "created_at", "kind", "tags", "content", "sig"].map(
      (key) => [key, event[key]],
    ),
  );
  assert.equal(verifyEvent(signed), true, `Real signature for kind ${kind}`);
  return event;
}
const tag = (event, name) => {
  const values = event.tags.filter((entry) => entry[0] === name);
  assert.equal(values.length, 1, `Exactly one ${name} tag`);
  return values[0];
};

/** Match the native owner/community-scoped UUIDv5 for this canonical fixture relay. */
export function scopedFirstJobDefinitionId(action) {
  const { ownerPubkey, communityRelayUrl } = action.preparation;
  for (const value of [ownerPubkey, communityRelayUrl, action.requestId])
    assert.equal(
      value,
      value.trim(),
      "Canonical coordinate has no surrounding whitespace",
    );
  assert.match(ownerPubkey, /^[a-f0-9]{64}$/);
  // This gate only creates this canonical private host; never approximate the
  // production normalizer for an arbitrary relay URL.
  assert.match(
    communityRelayUrl,
    /^wss:\/\/horizon-labs\.onboarding-[a-f0-9]{16}\.invalid$/,
  );
  assert.match(
    action.requestId,
    /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/,
  );
  const coordinate = [ownerPubkey, communityRelayUrl, action.requestId].join(
    "\n",
  );
  const bytes = createHash("sha1")
    .update(Buffer.from("e812dfbd1ec943baa59d721ff70f3e49", "hex"))
    .update(coordinate)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

/** Bind Scout to the unchanged packaged builtin and workers to owner-signed definitions. */
export function personaAuthority({
  name,
  persona,
  record,
  starterScout,
  definition,
  ownerPubkey,
  action,
}) {
  verifySigned(record, 30177, ownerPubkey);
  const content = JSON.parse(record.content);
  assert.equal(content.persona_id, persona.id);
  if (name === "scout") {
    assert.equal(tag(record, "d")[1], starterScout.pubkey);
    assert.equal(persona.id, "builtin:fizz");
    assert.equal(persona.is_builtin, true);
    assert.equal(persona.role_id, "chief-of-staff");
    assert.equal(persona.role_title, "Chief of Staff");
    assert.equal(persona.is_active, true);
    for (const field of [
      "id",
      "is_builtin",
      "is_active",
      "role_id",
      "role_title",
      "system_prompt",
    ])
      assert.equal(
        persona[field],
        starterScout.persona[field],
        `Starter Scout ${field} stayed unchanged`,
      );
    assert.equal(content.role_id, "chief-of-staff");
    assert.ok(persona.system_prompt.length > 0);
    return {
      source: "unchanged native bundled builtin",
      personaId: persona.id,
      promptSha256: createHash("sha256")
        .update(persona.system_prompt)
        .digest("hex"),
    };
  }
  assert.equal(name, "worker");
  assert.equal(persona.is_builtin, false);
  assert.equal(action.preparation.ownerPubkey, ownerPubkey);
  assert.equal(persona.id, scopedFirstJobDefinitionId(action));
  assert.ok(
    definition,
    "New worker needs a real owner-published persona definition",
  );
  verifySigned(definition, 30175, ownerPubkey);
  assert.equal(tag(definition, "d")[1], persona.id);
  assert.equal(
    JSON.parse(definition.content).system_prompt,
    persona.system_prompt,
  );
  assert.equal(persona.system_prompt, action.definition.systemPrompt);
  return {
    source: "owner-signed persona head",
    eventId: definition.id,
    personaId: persona.id,
  };
}

/** Read only this run's public signed records from its isolated database. */
export function nativeProofReader({
  relay,
  account,
  invoke,
  relayPubkey,
  starterScout,
}) {
  const host = new URL(account.relayUrl).hostname;
  assert.match(host, /^horizon-labs\.onboarding-[a-f0-9]{16}\.invalid$/);
  const where = `community_id=(SELECT id FROM communities WHERE host='${host}')`;
  const events = async (kind) => {
    assert.ok(
      [9, 30175, 30176, 30177, 30179, 30181, 39002, 40013, 40014].includes(
        kind,
      ),
    );
    const raw = await relay.query(
      `SELECT coalesce(json_agg(e),'[]')::text FROM (SELECT encode(id,'hex') AS id,encode(pubkey,'hex') AS pubkey,extract(epoch FROM created_at)::bigint AS created_at,kind,tags,content,encode(sig,'hex') AS sig FROM events WHERE ${where} AND kind=${kind} AND deleted_at IS NULL ORDER BY created_at DESC,id ASC LIMIT 101) e;`,
    );
    const values = JSON.parse(raw);
    assert.ok(values.length < 101, "No silently truncated proof lookup");
    for (const event of values) assert.equal(verifyEvent(event), true);
    return values;
  };
  const head = async (kind, author, id) => {
    const values = (await events(kind)).filter(
      (event) => event.pubkey === author && tag(event, "d")[1] === id,
    );
    assert.ok(values.length > 0, `Missing signed kind ${kind} head`);
    return verifySigned(values[0], kind, author);
  };
  const replies = async (marker) =>
    (await events(9)).filter(
      (event) =>
        event.tags.some((t) => t[0] === "h" && t[1] === account.channelId) &&
        event.tags.some((t) => t[0] === "e" && t[1] === account.rootEventId) &&
        event.tags.some((t) => t[0] === "client" && t[1] === marker),
    );
  const readTask = async () =>
    readCurrentFixtureTask(await events(30181), {
      relayPubkey,
      channelId: account.channelId,
      rootId: account.rootEventId,
    });
  const taskHeadEvidence = async () => {
    let candidates = [];
    try {
      const heads = await events(30181);
      let current;
      try {
        current = readCurrentFixtureTask(
          heads,
          {
            relayPubkey,
            channelId: account.channelId,
            rootId: account.rootEventId,
          },
          (value) => {
            candidates = value;
          },
        );
      } catch (error) {
        return {
          current: null,
          candidates,
          validationError: redactReason(
            error instanceof Error ? error.message : String(error),
          ),
        };
      }
      return {
        current:
          candidates.find(
            (candidate) =>
              candidate.taskId === current.id &&
              candidate.channelId === account.channelId &&
              candidate.rootId === account.rootEventId,
          ) ?? null,
        candidates,
      };
    } catch (error) {
      return {
        current: null,
        candidates,
        unavailable: redactReason(
          error instanceof Error ? error.message : String(error),
        ),
      };
    }
  };
  const failureEvidence = async () => ({
    ...taskFailureEvidence({
      account,
      relayPubkey,
      actions: await events(40013),
      receipts: await events(40014),
      teams: await events(30176),
    }),
    taskHeads: await taskHeadEvidence(),
  });
  async function readTeam() {
    const approvals = await replies("colony:first-job-team-approval:v1");
    const receipts = await replies("colony:first-job-team-receipt:v1");
    assert.equal(approvals.length, 1, "Exactly one actual owner approval");
    assert.equal(receipts.length, 1, "Exactly one actual team receipt");
    const approval = verifySigned(approvals[0], 9, account.ownerPubkey);
    const receipt = verifySigned(receipts[0], 9, account.ownerPubkey);
    const approved = JSON.parse(tag(approval, "first-job-team")[1]);
    const result = JSON.parse(tag(receipt, "first-job-team")[1]);
    assert.equal(result.approval, approval.id);
    assert.equal(result.team.scoutPubkey, starterScout.pubkey);
    assert.equal(
      approved.proposal.action.preparation.leaderPubkey,
      starterScout.pubkey,
    );
    assert.equal(approved.brief, account.suggestion.brief);
    assert.equal(
      approved.proposal.worker.pubkey,
      null,
      "Owner approved a genuinely new worker",
    );
    assert.equal(approved.proposal.action.preparation.mode, "first-job-worker");
    assert.equal(
      approved.proposal.action.preparation.ownerPubkey,
      account.ownerPubkey,
    );
    assert.equal(
      approved.proposal.action.preparation.communityRelayUrl,
      account.relayUrl,
    );
    assert.equal(
      approved.proposal.action.preparation.channelId,
      account.channelId,
    );
    const agents = (await invoke("list_managed_agents")).filter(
      (agent) => agent.relay_url === account.relayUrl,
    );
    assert.equal(
      agents.length,
      2,
      "Only starter Scout and one prepared worker",
    );
    const refs = [];
    for (const [name, rank] of [
      ["scout", "executive"],
      ["worker", "worker"],
    ]) {
      const pubkey = result.team[`${name}Pubkey`];
      assert.match(pubkey, /^[a-f0-9]{64}$/);
      const agent = agents.find((value) => value.pubkey === pubkey);
      assert.ok(agent);
      const record = await head(30177, account.ownerPubkey, pubkey);
      const content = JSON.parse(record.content);
      assert.equal(content.tier, rank);
      assert.equal(content.persona_id, agent.persona_id);
      if (name === "worker") {
        assert.equal(tag(record, "manager")[1], result.team.scoutPubkey);
        assert.equal(agent.name, approved.proposal.worker.name);
        assert.equal(
          content.role_id,
          approved.proposal.action.preparation.roleId,
        );
        assert.deepEqual(agent.env_vars ?? {}, {});
        assert.equal(agent.start_on_app_launch, false);
        const defaults = await invoke("get_global_agent_config");
        assert.equal(agent.model, defaults.model);
        assert.equal(agent.provider, defaults.provider);
        assert.equal(agent.agent_command_override, null);
      }
      const personas = await invoke("list_personas");
      const persona = personas.find((value) => value.id === agent.persona_id);
      assert.ok(persona);
      const definition =
        name === "worker"
          ? await head(30175, account.ownerPubkey, persona.id)
          : null;
      const definitionAuthority = personaAuthority({
        name,
        persona,
        record,
        starterScout,
        definition,
        ownerPubkey: account.ownerPubkey,
        action: approved.proposal.action,
      });
      refs.push({
        pubkey,
        personaId: agent.persona_id,
        name: agent.name,
        headEventId: record.id,
        definitionAuthority,
        prompt: persona.system_prompt,
      });
    }
    const membership = await head(39002, relayPubkey, account.channelId);
    for (const ref of refs)
      assert.ok(
        membership.tags.some(
          (t) => t[0] === "p" && t[1] === ref.pubkey && t[3] === "bot",
        ),
        "Native preparation actually enrolled the worker",
      );
    return {
      scout: refs[0],
      worker: refs[1],
      approvalId: approval.id,
      receiptId: receipt.id,
      membershipId: membership.id,
    };
  }
  async function business() {
    const profileHead = await head(30179, relayPubkey, "profile");
    const profile = JSON.parse(profileHead.content);
    assert.equal(profile.tradingName, account.suggestion.businessName);
    assert.equal(profile.summary, account.suggestion.business);
    assert.equal(
      profile.website ?? null,
      account.suggestion.website?.trim() || null,
    );
    const actions = (await events(40013)).filter(
      (e) => e.pubkey === account.ownerPubkey,
    );
    assert.equal(
      actions.length,
      1,
      "Onboarding retained its business via one canonical action",
    );
    const receipts = (await events(40014)).filter(
      (e) =>
        e.pubkey === relayPubkey &&
        e.tags.some((t) => t[0] === "e" && t[1] === actions[0].id),
    );
    assert.equal(receipts.length, 1);
    assert.equal(JSON.parse(receipts[0].content).headEventId, profileHead.id);
    return profileHead;
  }
  return { events, readTask, readTeam, business, failureEvidence };
}

/** Export only verified requests for this thread and their exact relay outcomes. */
export function taskFailureEvidence({
  account,
  relayPubkey,
  actions,
  receipts,
  teams,
}) {
  const requests = actions.filter((event) => {
    if (event.pubkey !== account.ownerPubkey) return false;
    verifySigned(event, 40013, account.ownerPubkey);
    const content = JSON.parse(event.content);
    const record = content.payload?.record;
    return (
      content.operation === "attach" &&
      content.payload?.kind === "threadAttach" &&
      record?.channelId === account.channelId &&
      record?.threadRoot === account.rootEventId
    );
  });
  return {
    // Receipts intentionally omit a refusal reason. The separate sanitized
    // ingest log is supporting diagnostics, never signed request authority.
    taskRequests: requests.map((action) => {
      const tuple = tag(action, "company-action");
      assert.equal(tuple.length, 5);
      assert.equal(tuple[2], "attach");
      assert.equal(tag(action, "p")[1], relayPubkey);
      const outcomes = receipts.filter((event) =>
        event.tags.some(
          (value) =>
            value[0] === "e" &&
            value[1] === action.id &&
            value[3] === "company-action",
        ),
      );
      for (const event of outcomes) {
        verifySigned(event, 40014, relayPubkey);
        assert.deepEqual(tag(event, "e"), [
          "e",
          action.id,
          "",
          "company-action",
        ]);
        assert.deepEqual(tag(event, "p"), ["p", account.ownerPubkey]);
        assert.deepEqual(tag(event, "a"), tag(action, "a"));
        const receiptTuple = tag(event, "company-receipt");
        assert.equal(receiptTuple.length, 5);
        assert.deepEqual(receiptTuple.slice(1, 4), ["1", tuple[3], tuple[4]]);
        assert.ok(
          ["applied", "conflict", "rejected", "failed"].includes(
            receiptTuple[4],
          ),
        );
        assert.equal(
          JSON.parse(event.content).schema,
          "colony.company-receipt/v1",
        );
      }
      return { action: wireEvent(action), receipts: outcomes.map(wireEvent) };
    }),
    ownerTeamHeads: teams
      .filter((event) => event.pubkey === account.ownerPubkey)
      .map((event) =>
        wireEvent(verifySigned(event, 30176, account.ownerPubkey)),
      ),
  };
}

/** Match the actual own persona section to verified team definitions, never quoted history. */
export function nativeRequestActor(messages, team, task) {
  const system = messages.filter((message) => message.role === "system");
  assert.equal(system.length, 1);
  assert.equal(typeof system[0].content, "string");
  const sections = system[0].content.split(/(?:^|\n\n)\[System\]\n/);
  assert.equal(sections.length, 2, "One real own-persona system section");
  const own = sections[1].split(
    /\n\n\[(?:Company Onboarding|Team Instructions|Agent Memory — core|Channel Canvas|Thread Canvas)\]\n/,
    1,
  )[0];
  const matches = ["scout", "worker"].filter(
    (actor) => own === team[actor].prompt,
  );
  assert.equal(
    matches.length,
    1,
    "Actual own persona exactly matches one verified team definition",
  );
  const actor = matches[0];
  const text = messages
    .filter(
      (message) =>
        message.role === "user" && typeof message.content === "string",
    )
    .map((message) => message.content)
    .reverse();
  const source = text.find((content) =>
    content.includes("<colony-work-context>\n"),
  );
  assert.ok(source, "Real ACP turn needs a work context");
  const blocks = [
    ...source.matchAll(
      /<colony-work-context>\n([\s\S]*?)<\/colony-work-context>/g,
    ),
  ];
  assert.equal(blocks.length, 1, "Unambiguous current harness work context");
  const lines = blocks[0][1].split("\n");
  assert.ok(lines.includes(`Task id: ${task.id}`));
  assert.ok(lines.includes(`Owning team: ${task.owningTeamId}`));
  // Managed first-job agents have signed30177 ranks. ACP only hydrates rank lines
  // for company employee30190 heads, so absent lines are current product behavior.
  const ranks = lines.filter((line) => line.startsWith("Your rank: "));
  assert.ok(ranks.length <= 1);
  if (ranks.length)
    assert.equal(
      ranks[0],
      `Your rank: ${actor === "scout" ? "executive" : "worker"}`,
    );
  return actor;
}
