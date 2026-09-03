import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AccountScreen } from "./AccountScreen.tsx";

const CONNECTION_COPY = "We could not reach your workspace";

function values() {
  return {
    name: "Aisha Bello",
    email: "second@example.com",
    password: "correct horse battery",
    city: "",
    country: "",
    gender: null,
    selfDescribedGender: "",
    avatarUrl: "",
  };
}

function render(failure) {
  return renderToStaticMarkup(
    React.createElement(AccountScreen, {
      values: values(),
      onChange: () => {},
      onSubmit: () => {},
      isSubmitting: false,
      failure,
      onSignInRequest: () => {},
    }),
  );
}

test("identity-taken names the computer's other account, not the connection", () => {
  const markup = render({ kind: "identity-taken" });
  assert.ok(
    markup.includes('data-testid="onboarding-account-identity-taken"'),
    "the identity note is rendered",
  );
  assert.ok(
    markup.includes(
      "This computer already has a Colony account under another email.",
    ),
  );
  assert.ok(
    !markup.includes(CONNECTION_COPY),
    "the connection banner must not be shown for identity-taken",
  );
});

test("identity-taken offers the sign-in door", () => {
  const markup = render({ kind: "identity-taken" });
  assert.ok(markup.includes('data-testid="onb-account-taken-sign-in"'));
});

test("email-taken keeps its own note and the sign-in door", () => {
  const markup = render({ kind: "email-taken" });
  assert.ok(markup.includes("That email already has an account."));
  assert.ok(markup.includes('data-testid="onb-account-taken-sign-in"'));
  assert.ok(
    !markup.includes('data-testid="onboarding-account-identity-taken"'),
    "the identity note belongs to identity-taken alone",
  );
  assert.ok(!markup.includes(CONNECTION_COPY));
});

test("unreachable still shows the connection banner", () => {
  const markup = render({ kind: "unreachable" });
  assert.ok(markup.includes(CONNECTION_COPY));
  assert.ok(!markup.includes('data-testid="onb-account-taken-sign-in"'));
});
