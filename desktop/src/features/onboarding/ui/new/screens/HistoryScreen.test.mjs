import assert from "node:assert/strict";
import { after, afterEach, mock, test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
const dom = new JSDOM("<html><body></body></html>", {
  url: "http://localhost",
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
let calls = [],
  failSave = false;
mock.module("@/shared/api/tauri", {
  namedExports: {
    invokeTauri: async (command, args) => {
      calls.push({ command, args });
      if (command === "discover_onboarding_history")
        return [
          {
            id: "codex",
            count: 1,
            status: "found",
            location: "fixture",
            limited: false,
          },
        ];
      if (command === "read_onboarding_history")
        return [
          {
            source: "codex",
            name: "fixture.jsonl",
            text: JSON.stringify({
              type: "response_item",
              payload: {
                type: "message",
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: "I prefer concise weekly updates.",
                  },
                ],
              },
            }),
          },
        ];
      if (command === "save_onboarding_memories" && failSave)
        throw new Error("Save unavailable");
      return 1;
    },
  },
});
const { HistoryScreen } = await import("./HistoryScreen.tsx");
const { render, fireEvent, act, cleanup } = await import(
  "@testing-library/react"
);
afterEach(() => {
  cleanup();
  calls = [];
  failSave = false;
});
after(() => dom.window.close());
const props = {
  proof: { agentPubkey: "agent", assertValid: async () => {} },
  scope: { ownerPubkey: "owner", relayUrl: "wss://fixture" },
  businessOnly: false,
  busy: false,
  error: null,
  onBack: () => {},
  onContinue: async () => {},
};
async function click(view, name) {
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name }));
  });
}
test("no scan without opt-in; source selection, edit and save are explicit; save failure preserves review", async () => {
  let view;
  await act(async () => {
    view = render(React.createElement(HistoryScreen, props));
  });
  assert.equal(calls.length, 0);
  assert.equal(
    view
      .getByRole("navigation", { name: "Setup progress" })
      .querySelectorAll("li").length,
    4,
  );
  await click(view, "Find my history");
  assert.equal(calls.length, 1);
  assert.equal(
    view.getByRole("button", { name: "Create my memories" }).disabled,
    true,
  );
  await act(async () => {
    fireEvent.click(view.getByRole("checkbox"));
  });
  await click(view, "Create my memories");
  assert.deepEqual(calls.at(-1).args.sourceIds, ["codex"]);
  assert.equal(
    calls.some((c) => c.command === "save_onboarding_memories"),
    false,
  );
  await act(async () => {
    fireEvent.change(view.getByLabelText("Memory 1"), {
      target: { value: "I prefer a short update every Friday." },
    });
  });
  failSave = true;
  await click(view, "Save and continue");
  assert.equal(
    view.getByLabelText("Memory 1").value,
    "I prefer a short update every Friday.",
  );
  assert.match(view.getByRole("alert").textContent, /Save unavailable/);
  failSave = false;
  await click(view, "Save and continue");
  assert.match(calls.at(-1).args.memories[0].text, /every Friday/);
  assert.ok(view.getByRole("button", { name: "Open my Colony" }));
});
test("skip never scans or creates memories", async () => {
  let completed = 0;
  const view = render(
    React.createElement(HistoryScreen, {
      ...props,
      onContinue: async () => {
        completed++;
      },
    }),
  );
  await click(view, "Skip for now");
  assert.equal(completed, 1);
  assert.equal(calls.length, 0);
});
