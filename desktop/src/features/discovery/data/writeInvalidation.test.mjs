import assert from "node:assert/strict";
import test from "node:test";

import { withWriteInvalidation } from "./writeInvalidation.ts";

function stubSource(overrides = {}) {
  const calls = [];
  const record =
    (name, result) =>
    (...args) => {
      calls.push([name, ...args]);
      return Promise.resolve(result);
    };
  return {
    calls,
    source: {
      getEntitlement: record("getEntitlement", { experience: "demo" }),
      getIndustries: record("getIndustries", []),
      getVerticals: record("getVerticals", []),
      getVertical: record("getVertical", null),
      getFields: record("getFields", []),
      getRoles: record("getRoles", []),
      getRole: record("getRole", null),
      getCampaign: record("getCampaign", null),
      getLeads: record("getLeads", { leads: [], total: 0 }),
      getPipelineColumns: record("getPipelineColumns", []),
      getLeadCounts: record("getLeadCounts", {}),
      getLead: record("getLead", null),
      updateLead: record("updateLead", { id: "lead-1" }),
      getOutreach: record("getOutreach", []),
      createOutreach: record("createOutreach", { id: "outreach-1" }),
      updateOutreachStatus: record("updateOutreachStatus", {}),
      getConversations: record("getConversations", []),
      markConversationRead: record("markConversationRead", {}),
      sendConversationReply: record("sendConversationReply", {}),
      createCampaign: record("createCampaign", { id: "campaign-1" }),
      updateSourceConfig: record("updateSourceConfig", { id: "campaign-1" }),
      cancelDiscovery: record("cancelDiscovery", undefined),
      startDiscovery: () => {
        calls.push(["startDiscovery"]);
        return (async function* run() {
          yield { type: "started" };
          yield { type: "completed" };
        })();
      },
      retryDiscovery: () => {
        calls.push(["retryDiscovery"]);
        return (async function* run() {
          yield { type: "started" };
        })();
      },
      ...overrides,
    },
  };
}

test("a read passes through without reporting a write", async () => {
  const { source } = stubSource();
  let writes = 0;
  const wrapped = withWriteInvalidation(source, () => {
    writes += 1;
  });

  await wrapped.getIndustries();
  await wrapped.getLeads({ scope: "global" });
  await wrapped.getLeadCounts();

  assert.equal(writes, 0);
});

test("every mutating method reports one write", async () => {
  const { source } = stubSource();
  let writes = 0;
  const wrapped = withWriteInvalidation(source, () => {
    writes += 1;
  });

  await wrapped.updateLead("lead-1", {});
  await wrapped.createOutreach("campaign-1");
  await wrapped.updateOutreachStatus("campaign-1", "outreach-1", "sent");
  await wrapped.markConversationRead("campaign-1", "thread-1");
  await wrapped.sendConversationReply("campaign-1", "thread-1", "hello");
  await wrapped.createCampaign({});
  await wrapped.updateSourceConfig("campaign-1", { mode: "waterfall" });
  await wrapped.cancelDiscovery("campaign-1");

  assert.equal(writes, 8);
});

test("a failed write still reports, because it may have half landed", async () => {
  const { source } = stubSource({
    updateLead: () => Promise.reject(new Error("relay refused the update")),
  });
  let writes = 0;
  const wrapped = withWriteInvalidation(source, () => {
    writes += 1;
  });

  await assert.rejects(
    () => wrapped.updateLead("lead-1", {}),
    /relay refused the update/,
  );
  assert.equal(writes, 1);
});

test("a discovery run reports when its events end, not when it starts", async () => {
  const { source } = stubSource();
  let writes = 0;
  const wrapped = withWriteInvalidation(source, () => {
    writes += 1;
  });

  const events = [];
  for await (const event of wrapped.startDiscovery("campaign-1")) {
    events.push(event);
    assert.equal(writes, 0, "the run must not report while it is still going");
  }

  assert.deepEqual(events, [{ type: "started" }, { type: "completed" }]);
  assert.equal(writes, 1);
});

test("abandoning a run mid-stream still reports", async () => {
  const { source } = stubSource();
  let writes = 0;
  const wrapped = withWriteInvalidation(source, () => {
    writes += 1;
  });

  for await (const _event of wrapped.retryDiscovery("campaign-1")) {
    break;
  }

  assert.equal(writes, 1);
});
