import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AccountScreen } from "./AccountScreen.tsx";

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

test("account errors distinguish identity, connectivity and local failures", () => {
  for (const [kind, copy] of [
    ["identity-taken", "This device already has an account"],
    ["email-taken", "That email already has an account"],
    ["unreachable", "We could not connect to Colony"],
    ["local-storage", "safely save your account recovery"],
    ["local-identity", "prepare your account securely"],
    ["server", "Colony could not finish"],
  ]) {
    const markup = render({ kind });
    assert.ok(markup.includes(copy), kind);
    assert.ok(
      markup.includes("Sign in"),
      "every account state keeps sign-in available",
    );
    assert.ok(markup.includes('value="second@example.com"'));
    assert.ok(markup.includes('value="correct horse battery"'));
  }
});
