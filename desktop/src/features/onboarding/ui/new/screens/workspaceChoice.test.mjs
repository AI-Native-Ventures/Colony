import assert from "node:assert/strict";
import test from "node:test";

import { workspaceChoiceOptions } from "./WorkspaceChoiceScreen.tsx";

test("workspace_choice_offers_join_create_and_reconnect", () => {
  const ids = workspaceChoiceOptions("welcome").map((option) => option.id);
  assert.deepEqual(ids, ["join", "create", "existing"]);
});

test("workspace_choice_keeps_the_testids_the_specs_drive", () => {
  const testIds = workspaceChoiceOptions("welcome").map(
    (option) => option.testId,
  );
  assert.deepEqual(testIds, [
    "community-choice-join",
    "community-choice-create",
    "community-choice-existing",
  ]);
});

test("workspace_choice_asks_for_a_role_on_the_existing_page", () => {
  const options = workspaceChoiceOptions("existing");
  assert.deepEqual(
    options.map((option) => option.id),
    ["owner", "member"],
  );
  assert.deepEqual(
    options.map((option) => option.testId),
    ["existing-choice-owner", "existing-choice-member"],
  );
});

test("workspace_choice_gives_every_option_a_line_of_its_own", () => {
  for (const mode of ["welcome", "existing"]) {
    for (const option of workspaceChoiceOptions(mode)) {
      assert.ok(option.title.length > 0, `${option.id} has no title`);
      assert.ok(option.meta.length > 0, `${option.id} has no meta`);
    }
  }
});
