import assert from "node:assert/strict";
import test from "node:test";

import { openAsksQueryKey, askClosuresQueryKey } from "../asks/useOpenAsks.ts";
import { activeCompanyQueryKey } from "../company/hooks.ts";
import { homeFeedQueryKey } from "../home/hooks.ts";
import { pendingLiveMentionsQueryKey } from "../home/lib/liveMentionFeed.ts";
import { remindersQueryKey } from "../reminders/hooks.ts";
import { reminderWatermarkStorageKey } from "../reminders/useReminderNotifications.ts";
import {
  actionCenterApprovalsQueryKey,
  actionCenterTaskRunsQueryKey,
  actionCenterWorkflowQueryKey,
  actionCenterWorkflowRunsQueryKey,
} from "./lib/actionCenterQueryKeys.ts";

const communityA = "community-a";
const communityB = "community-b";

function assertCommunityScoped(keyFor) {
  assert.notDeepEqual(keyFor(communityA), keyFor(communityB));
}

test("Action Center source query keys separate communities", () => {
  assertCommunityScoped((communityId) =>
    actionCenterTaskRunsQueryKey(communityId, ["task-1"]),
  );
  assertCommunityScoped((communityId) =>
    actionCenterWorkflowQueryKey(communityId, "channel-1"),
  );
  assertCommunityScoped((communityId) =>
    actionCenterWorkflowRunsQueryKey(communityId, "workflow-1"),
  );
  assertCommunityScoped((communityId) =>
    actionCenterApprovalsQueryKey(communityId, "workflow-1", "run-1"),
  );
});

test("canonical source query keys separate communities", () => {
  assertCommunityScoped(homeFeedQueryKey);
  assertCommunityScoped(pendingLiveMentionsQueryKey);
  assertCommunityScoped((communityId) =>
    openAsksQueryKey(communityId, "owner"),
  );
  assertCommunityScoped((communityId) =>
    askClosuresQueryKey(communityId, ["ask-1"]),
  );
  assertCommunityScoped((communityId) =>
    remindersQueryKey("owner", communityId),
  );
  assertCommunityScoped((communityId) =>
    reminderWatermarkStorageKey("owner", communityId),
  );
  assertCommunityScoped(activeCompanyQueryKey);
});
