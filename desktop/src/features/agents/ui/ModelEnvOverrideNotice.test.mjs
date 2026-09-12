import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { JSDOM } from "jsdom";

/**
 * Proves the ignored-env warning is visible while the stale key exists.
 *
 * An agent showed harness "Claude Code" and model `opus[1m]` in its Edit dialog
 * while launching with `--model metered/grok-4.5`, because a leftover
 * `BUZZ_ACP_MODEL` sat in its env vars. The launch now ignores that key, so the
 * dialog has to say so instead of showing a model that silently is not the one
 * the key names.
 */
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});

before(() => {
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    window: dom.window,
  });
});

after(() => dom.window.close());

async function renderNotice(envVars) {
  const React = await import("react");
  const { act, render } = await import("@testing-library/react");
  const { ModelEnvOverrideNotice } = await import(
    `./ModelEnvOverrideNotice.tsx?test=${Date.now()}`
  );

  let result;
  await act(async () => {
    result = render(React.createElement(ModelEnvOverrideNotice, { envVars }));
  });
  return result;
}

test("the warning names the stale key and its value", async () => {
  const result = await renderNotice({
    BUZZ_ACP_MODEL: "metered/grok-4.5",
    ANTHROPIC_API_KEY: "sk-secret",
  });

  const notice = result.getByTestId("model-env-override-notice");
  assert.match(notice.textContent, /BUZZ_ACP_MODEL=metered\/grok-4\.5/);
  assert.match(
    notice.textContent,
    /ignored/,
    "the point of the warning is that the env var does not win",
  );
  assert.doesNotMatch(
    notice.textContent,
    /sk-secret/,
    "unrelated env values must not be echoed into the dialog",
  );

  result.unmount();
});

test("no warning when the agent carries no config-owned model env var", async () => {
  const result = await renderNotice({
    ANTHROPIC_API_KEY: "sk-secret",
    BUZZ_METER_OPENAI_PROVIDER: "xai",
  });

  assert.equal(result.queryByTestId("model-env-override-notice"), null);

  result.unmount();
});

test("no warning for an agent with no env vars at all", async () => {
  const result = await renderNotice({});
  assert.equal(result.queryByTestId("model-env-override-notice"), null);
  result.unmount();
});

test("a stale provider key is named too", async () => {
  const result = await renderNotice({ BUZZ_ACP_PROVIDER: "xai" });
  const notice = result.getByTestId("model-env-override-notice");
  assert.match(notice.textContent, /BUZZ_ACP_PROVIDER=xai/);
  assert.match(notice.textContent, /provider above is what runs/);
  result.unmount();
});
