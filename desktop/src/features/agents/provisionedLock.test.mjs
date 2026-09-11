import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isProvisionedAgent,
  PROVISIONED_DELETE_LABEL,
} from "./provisionedLock.ts";

const agent = (provisioned) => ({ provisioned });

test("an agent carrying a bundled handle is provisioned", () => {
  assert.equal(isProvisionedAgent(agent("sales")), true);
});

test("an ordinary agent, a missing one, and a blank handle are not", () => {
  // A workspace's own agent is editable and deletable exactly as before.
  assert.equal(isProvisionedAgent(agent(null)), false);
  assert.equal(isProvisionedAgent(agent("")), false);
  // A whitespace-only handle is not a handle; locking on it would strand an
  // agent nobody can remove for the sake of a malformed record.
  assert.equal(isProvisionedAgent(agent("   ")), false);
  assert.equal(isProvisionedAgent(undefined), false);
  assert.equal(isProvisionedAgent(null), false);
});

test("the delete row names Colony rather than saying only 'disabled'", () => {
  assert.match(PROVISIONED_DELETE_LABEL, /Colony/);
});
