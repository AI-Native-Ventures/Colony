import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
const originalConsoleError = console.error;

before(() => {
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    window: dom.window,
  });
  dom.window.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
});

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
  console.error = originalConsoleError;
});

after(() => dom.window.close());

/** Auth fakes that record what the screen sent and can throw typed failures. */
function fakeAuth({ resolve = true, failure = null } = {}) {
  const calls = { signIn: [], recover: [] };
  const attempt = async (method, args) => {
    calls[method].push(args);
    if (!resolve) throw failure;
    return method === "signIn"
      ? { pubkey: "a".repeat(64) }
      : { pubkey: "a".repeat(64), resetToken: "tok" };
  };
  const auth = {
    signIn: async (...args) => attempt("signIn", args),
    recover: async (...args) => attempt("recover", args),
  };
  return { auth, calls };
}

async function renderStep(props) {
  const { createElement } = await import("react");
  const react = await import("@testing-library/react");
  const { AccountSignInStep } = await import("./AccountSignInStep.tsx");
  const view = react.render(createElement(AccountSignInStep, props));
  // @testing-library/user-event is not a dependency here, so interactions go
  // through fireEvent like the rest of the node:test component specs.
  const type = (element, text) => {
    for (const character of String(text)) {
      react.fireEvent.keyDown(element, { key: character });
      react.fireEvent.input(element, {
        target: { value: element.value + character },
      });
    }
  };
  return {
    ...view,
    userEvent: { type },
    fireEvent: react.fireEvent,
    /** Resolves once the given text appears anywhere on the page. */
    waitForText: (needle) =>
      react.waitFor(() => {
        if (!document.body.textContent.includes(needle)) {
          throw new Error(`waiting for text: ${needle}`);
        }
      }),
    /** Lets a clicked submit's promise chain settle. */
    settle: () => new Promise((resolve) => setTimeout(resolve, 0)),
  };
}

function basicProps(auth) {
  return { auth, onCompleteIdentity: async () => {} };
}

test("renders the welcome headline with email and password fields", async () => {
  const screen = await renderStep(basicProps(fakeAuth().auth));
  assert.ok(screen.getByRole("heading", { name: "Welcome back." }));
  assert.ok(screen.getByLabelText("Email"));
  assert.ok(screen.getByLabelText("Password"));
  assert.ok(
    screen.queryByLabelText(/Recovery code/) === null,
    "recovery field stays hidden until asked for",
  );
});

test("sign in sends the trimmed email and password to signIn", async () => {
  const { auth, calls } = fakeAuth();
  const screen = await renderStep(basicProps(auth));
  // Trailing space included on purpose: trimming happens in the component,
  // so the recorded call must hold the trimmed form.
  await screen.userEvent.type(
    screen.getByLabelText("Email"),
    "founder@Example.com ",
  );
  await screen.userEvent.type(
    screen.getByLabelText("Password"),
    "correct horse",
  );
  await screen.getByRole("button", { name: "Sign in" }).click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls.signIn, [["founder@Example.com", "correct horse"]]);
  assert.deepEqual(calls.recover, []);
});

test("a wrong password renders the invalid-credentials copy and keeps fields", async () => {
  const { auth } = fakeAuth({
    resolve: false,
    failure: { kind: "invalid-credentials" },
  });
  const screen = await renderStep(basicProps(auth));
  await screen.userEvent.type(
    screen.getByLabelText("Email"),
    "founder@example.com",
  );
  await screen.userEvent.type(screen.getByLabelText("Password"), "wrong horse");
  await screen.getByRole("button", { name: "Sign in" }).click();
  await screen.waitForText("That email or password does not match an account.");
  const emailAfter = screen.getByLabelText("Email");
  assert.equal(emailAfter.value, "founder@example.com", "email is preserved");
});

test("a lockout renders the countdown copy with the relay's delay", async () => {
  const { auth } = fakeAuth({
    resolve: false,
    failure: { kind: "locked", retryAfterSecs: 900 },
  });
  const screen = await renderStep(basicProps(auth));
  await screen.userEvent.type(
    screen.getByLabelText("Email"),
    "founder@example.com",
  );
  await screen.userEvent.type(
    screen.getByLabelText("Password"),
    "correct horse",
  );
  await screen.getByRole("button", { name: "Sign in" }).click();
  await screen.waitForText("Try again in 15:00.");
});

test("update-required renders the update copy", async () => {
  const { auth } = fakeAuth({
    resolve: false,
    failure: { kind: "update-required" },
  });
  const screen = await renderStep(basicProps(auth));
  await screen.userEvent.type(
    screen.getByLabelText("Email"),
    "founder@example.com",
  );
  await screen.userEvent.type(
    screen.getByLabelText("Password"),
    "correct horse",
  );
  await screen.getByRole("button", { name: "Sign in" }).click();
  await screen.waitForText("Update the app");
});

test("an unreachable server renders the retry copy and keeps the password", async () => {
  const { auth } = fakeAuth({
    resolve: false,
    failure: { kind: "unreachable" },
  });
  const screen = await renderStep(basicProps(auth));
  await screen.userEvent.type(
    screen.getByLabelText("Email"),
    "founder@example.com",
  );
  await screen.userEvent.type(screen.getByLabelText("Password"), "kept secret");
  await screen.getByRole("button", { name: "Sign in" }).click();
  await screen.waitForText("We could not reach your workspace.");
  assert.equal(screen.getByLabelText("Password").value, "kept secret");
});

test("the recovery link swaps to code mode and recover gets the typed values", async () => {
  const { auth, calls } = fakeAuth();
  const screen = await renderStep(basicProps(auth));
  await screen.getByRole("button", { name: /Use your recovery code/ }).click();
  assert.ok(
    document.body.textContent.includes("colony-recovery-code.txt"),
    "recovery helper names the file the code lives in",
  );
  await screen.userEvent.type(
    screen.getByLabelText("Email"),
    "Founder@Example.COM",
  );
  await screen.userEvent.type(
    screen.getByLabelText("Recovery code"),
    "ABCDE-FGHJK-MNPQR-STVWX",
  );
  await screen.getByRole("button", { name: "Sign in" }).click();
  await screen.settle();
  assert.deepEqual(calls.recover, [
    ["Founder@Example.COM", "ABCDE-FGHJK-MNPQR-STVWX"],
  ]);
  assert.deepEqual(calls.signIn, []);
});

test("a bad recovery code renders its own invalid-credentials copy", async () => {
  const { auth } = fakeAuth({
    resolve: false,
    failure: { kind: "invalid-credentials" },
  });
  const screen = await renderStep(basicProps(auth));
  await screen.getByRole("button", { name: /Use your recovery code/ }).click();
  await screen.userEvent.type(
    screen.getByLabelText("Email"),
    "founder@example.com",
  );
  await screen.userEvent.type(
    screen.getByLabelText("Recovery code"),
    "ABCDE-FGHJK-MNPQR-STVWX",
  );
  await screen.getByRole("button", { name: "Sign in" }).click();
  await screen.waitForText("That recovery code does not match that email.");
});

test("switching back from recovery mode returns to the password form", async () => {
  const { auth } = fakeAuth();
  const screen = await renderStep(basicProps(auth));
  await screen.getByRole("button", { name: /Use your recovery code/ }).click();
  await screen
    .getByRole("button", { name: /Use your password instead/ })
    .click();
  assert.ok(screen.getByLabelText("Password"));
  assert.ok(screen.queryByLabelText("Recovery code") === null);
});
