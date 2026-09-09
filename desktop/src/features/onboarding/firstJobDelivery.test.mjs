import assert from "node:assert/strict";
import { test } from "node:test";
import { assertFirstJobRetryCanReachReceiver } from "./firstJobDelivery.ts";

test("unconfirmed old instructions require thread review rather than restart an ACP that cannot see them", () => {
  assert.throws(
    () => assertFirstJobRetryCanReachReceiver({ created_at: 1000 }, 1006),
    /Check this thread/,
  );
  assert.doesNotThrow(() =>
    assertFirstJobRetryCanReachReceiver({ created_at: 1000 }, 1005),
  );
  assert.doesNotThrow(() => assertFirstJobRetryCanReachReceiver(null, 1006));
});
