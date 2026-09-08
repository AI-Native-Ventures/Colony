import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
before(() => {
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
});
afterEach(async () => {
  (await import("@testing-library/react")).cleanup();
});
after(() => dom.window.close());
async function mountRecovery(props = {}) {
  const React = await import("react");
  const ui = await import("@testing-library/react");
  const { RecoveryScreen } = await import("./RecoveryScreen.tsx");
  let continued = 0;
  const view = ui.render(
    React.createElement(RecoveryScreen, {
      code: "SYNTHETIC-CODE",
      onSave: async () => null,
      onContinue: async () => {
        continued += 1;
      },
      ...props,
    }),
  );
  return { ...ui, ...view, continued: () => continued };
}
test("cancelled and failed native saves cannot acknowledge recovery", async () => {
  const screen = await mountRecovery();
  await screen.act(async () =>
    screen.fireEvent.click(
      screen.getByRole("button", { name: "Save and continue" }),
    ),
  );
  assert.match(screen.getByRole("alert").textContent, /not saved/);
  assert.equal(screen.continued(), 0);
  screen.unmount();
  const failed = await mountRecovery({
    onSave: async () => {
      throw new Error("synthetic write failure");
    },
  });
  await failed.act(async () =>
    failed.fireEvent.click(
      failed.getByRole("button", { name: "Save and continue" }),
    ),
  );
  assert.match(
    failed.getByRole("alert").textContent,
    /could not finish saving/,
  );
  assert.equal(failed.continued(), 0);
});
test("successful native save advances while an unavailable old code cannot", async () => {
  const saved = await mountRecovery({ onSave: async () => "synthetic.txt" });
  await saved.act(async () =>
    saved.fireEvent.click(
      saved.getByRole("button", { name: "Save and continue" }),
    ),
  );
  assert.equal(saved.continued(), 1);
  saved.unmount();
  const missing = await mountRecovery({ code: "", onSignIn: () => {} });
  assert.equal(
    missing.queryByRole("button", { name: "Save and continue" }),
    null,
  );
  assert.match(
    missing.getByRole("alert").textContent,
    /original recovery code/,
  );
  assert.ok(missing.getByRole("button", { name: "Sign in to your account" }));
});
test("failed clipboard copy never unlocks acknowledgement", async () => {
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async () => {
        throw new Error("denied");
      },
    },
  });
  const screen = await mountRecovery();
  await screen.act(async () =>
    screen.fireEvent.click(
      screen.getByRole("button", { name: "Copy instead" }),
    ),
  );
  assert.match(screen.getByRole("alert").textContent, /could not copy/);
  assert.equal(screen.queryByRole("checkbox"), null);
  assert.equal(screen.continued(), 0);
});
test("late website read cannot overwrite edited business description", async () => {
  const React = await import("react");
  const { render, fireEvent, act } = await import("@testing-library/react");
  const { CompanyScreen } = await import("./CompanyScreen.tsx");
  let resolve;
  const response = new Promise((done) => {
    resolve = done;
  });
  function Business() {
    const [values, setValues] = React.useState({
      company: "Horizon",
      website: "horizon.example",
      description: "",
    });
    return React.createElement(CompanyScreen, {
      values,
      onChange: (patch) => setValues((current) => ({ ...current, ...patch })),
      onSubmit: () => {},
      scrape: { describeBusiness: async () => response },
    });
  }
  const screen = render(React.createElement(Business));
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Read website" })),
  );
  await act(async () =>
    fireEvent.change(
      screen.getByLabelText(/What does your business do\?|Business summary/),
      {
        target: { value: "My corrected description." },
      },
    ),
  );
  await act(async () =>
    resolve({
      ok: true,
      description: "A late machine summary",
      sourcePages: [],
    }),
  );
  assert.equal(
    screen.getByLabelText(/What does your business do\?|Business summary/)
      .value,
    "My corrected description.",
  );
  assert.match(screen.getByRole("status").textContent, /kept your wording/);
});

async function mountBusinessReader(describeBusiness) {
  const React = await import("react");
  const ui = await import("@testing-library/react");
  const { CompanyScreen } = await import("./CompanyScreen.tsx");
  const submitted = [];
  function Business() {
    const [values, setValues] = React.useState({
      company: "Horizon Labs",
      website: "horizon.example/",
      description: "",
    });
    return React.createElement(CompanyScreen, {
      values,
      onChange: (patch) => setValues((current) => ({ ...current, ...patch })),
      onSubmit: (website) => submitted.push({ ...values, website }),
      scrape: { describeBusiness },
    });
  }
  return { ...ui, ...ui.render(React.createElement(Business)), submitted };
}

for (const outcome of ["unreachable", "timeout", "throw"]) {
  test(`website ${outcome} shows manual fallback and submits retained business context`, async () => {
    const calls = [];
    const screen = await mountBusinessReader(async (url) => {
      calls.push(url);
      if (outcome === "throw") throw new Error("Synthetic scan failure");
      return { ok: false, reason: outcome };
    });
    await screen.act(async () =>
      screen.fireEvent.click(
        screen.getByRole("button", { name: "Read website", exact: true }),
      ),
    );
    assert.deepEqual(calls, ["https://horizon.example"]);
    assert.match(
      screen.getByRole("status").textContent,
      /could not read that website.*Describe your business below/,
    );
    assert.equal(screen.getByLabelText("Business name").value, "Horizon Labs");
    assert.equal(screen.getByLabelText(/Website/).value, "horizon.example/");
    assert.equal(screen.getByLabelText("Business summary").value, "");
    const submit = screen.getByRole("button", { name: "Open my Colony" });
    assert.equal(submit.disabled, true);
    assert.equal(screen.submitted.length, 0);
    await screen.act(async () =>
      screen.fireEvent.change(screen.getByLabelText("Business summary"), {
        target: { value: "We design brands for small businesses." },
      }),
    );
    assert.equal(submit.disabled, false);
    await screen.act(async () => screen.fireEvent.click(submit));
    assert.deepEqual(screen.submitted, [
      {
        company: "Horizon Labs",
        website: "https://horizon.example",
        description: "We design brands for small businesses.",
      },
    ]);
    assert.equal(screen.queryByRole("button", { name: "Add credits" }), null);
  });
}

test("manual business context can continue while a website read is still pending", async () => {
  const calls = [];
  let resolve;
  const response = new Promise((done) => {
    resolve = done;
  });
  const screen = await mountBusinessReader(async (url) => {
    calls.push(url);
    return response;
  });
  await screen.act(async () =>
    screen.fireEvent.click(
      screen.getByRole("button", { name: "Read website", exact: true }),
    ),
  );
  assert.deepEqual(calls, ["https://horizon.example"]);
  assert.ok(screen.getByRole("button", { name: "Reading your website…" }));
  await screen.act(async () =>
    screen.fireEvent.change(screen.getByLabelText("Business summary"), {
      target: { value: "My business description while the site is pending." },
    }),
  );
  const submit = screen.getByRole("button", { name: "Open my Colony" });
  assert.equal(submit.disabled, false);
  await screen.act(async () => screen.fireEvent.click(submit));
  assert.deepEqual(screen.submitted, [
    {
      company: "Horizon Labs",
      website: "https://horizon.example",
      description: "My business description while the site is pending.",
    },
  ]);
  await screen.act(async () => resolve({ ok: false, reason: "timeout" }));
  assert.equal(screen.submitted.length, 1);
  assert.equal(
    screen.getByLabelText("Business summary").value,
    "My business description while the site is pending.",
  );
});
