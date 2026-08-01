import assert from "node:assert/strict";
import test from "node:test";

import {
  KIND_APPROVAL_REQUEST,
  KIND_BLOCK_RECEIPT,
  KIND_EVENT_REMINDER,
  KIND_REMINDER,
  KIND_STREAM_MESSAGE,
} from "../shared/constants/kinds.ts";
import { homeFeedLiveFilters } from "./useLiveHomeFeedActions.ts";

test("home feed live filters refresh durable Block attention on instances and receipts", () => {
  const filters = homeFeedLiveFilters("owner-pubkey", 123);

  assert.deepEqual(filters.action, {
    kinds: [KIND_APPROVAL_REQUEST, KIND_REMINDER, KIND_STREAM_MESSAGE],
    "#p": ["owner-pubkey"],
    limit: 50,
    since: 123,
  });
  assert.deepEqual(filters.reminder, {
    authors: ["owner-pubkey"],
    kinds: [KIND_EVENT_REMINDER],
    limit: 50,
    since: 123,
  });
  assert.deepEqual(filters.receipt, {
    kinds: [KIND_BLOCK_RECEIPT],
    limit: 50,
    since: 123,
  });
});
