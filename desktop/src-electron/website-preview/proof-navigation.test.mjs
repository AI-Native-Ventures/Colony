import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import {
  navigationEvidence,
  observeFrameNavigation,
} from "./proof-navigation.mjs";

const BEFORE_URL = "colony-preview://artifact/index.html";
const TARGET_URL = "https://example.com/";

function entryWithFrames(frames, overrides = {}) {
  const webContents = new EventEmitter();
  webContents.mainFrame = {
    url: "colony-preview://wrapper/__colony_preview_wrapper.html",
    frames,
  };
  return {
    webContents,
    failed: false,
    lastError: "",
    navigationDenialSequence: 0,
    navigationDenials: [],
    ...overrides,
  };
}

function classify(entry, observer) {
  observer.stop();
  return navigationEvidence(entry, BEFORE_URL, TARGET_URL, observer);
}

test("matching blocked child failure with recovery is a refusal", () => {
  const entry = entryWithFrames([{ url: TARGET_URL }], {
    failed: true,
    lastError: "ERR_BLOCKED_BY_CSP",
  });
  const observer = observeFrameNavigation(entry, TARGET_URL);

  entry.webContents.emit(
    "did-fail-load",
    {},
    -30,
    "ERR_BLOCKED_BY_CSP",
    TARGET_URL,
    false,
  );

  const evidence = classify(entry, observer);
  assert.equal(evidence.ok, true);
  assert.equal(evidence.explicitRefusal, true);
  assert.equal(evidence.completed, false);
  assert.equal(evidence.recoverableFailure, true);
  assert.deepEqual(evidence.blockedFailure, {
    code: -30,
    description: "ERR_BLOCKED_BY_CSP",
    url: TARGET_URL,
    isMainFrame: false,
  });
});

test("a blocked failure for another URL cannot prove the target was refused", () => {
  const otherUrl = "https://other.example/";
  const entry = entryWithFrames([{ url: BEFORE_URL }], {
    failed: true,
    lastError: "ERR_BLOCKED_BY_CSP",
  });
  const observer = observeFrameNavigation(entry, TARGET_URL);

  entry.webContents.emit(
    "did-fail-load",
    {},
    -30,
    "ERR_BLOCKED_BY_CSP",
    otherUrl,
    false,
  );

  const evidence = classify(entry, observer);
  assert.equal(evidence.ok, false);
  assert.equal(evidence.explicitRefusal, false);
  assert.equal(evidence.blockedFailure, null);
});

test("a completed target navigation fails even after an earlier blocked record", () => {
  const entry = entryWithFrames([{ url: TARGET_URL }], {
    failed: true,
    lastError: "ERR_BLOCKED_BY_CSP",
  });
  const observer = observeFrameNavigation(entry, TARGET_URL);

  entry.webContents.emit(
    "did-fail-load",
    {},
    -30,
    "ERR_BLOCKED_BY_CSP",
    TARGET_URL,
    false,
  );
  entry.webContents.emit(
    "did-frame-navigate",
    {},
    TARGET_URL,
    false,
  );

  const evidence = classify(entry, observer);
  assert.equal(evidence.explicitRefusal, true);
  assert.equal(evidence.completed, true);
  assert.equal(evidence.ok, false);
});

test("a retained target frame without denial evidence fails closed", () => {
  const entry = entryWithFrames([{ url: TARGET_URL }]);
  const observer = observeFrameNavigation(entry, TARGET_URL);

  const evidence = classify(entry, observer);
  assert.equal(evidence.targetFrames.length, 1);
  assert.equal(evidence.explicitRefusal, false);
  assert.equal(evidence.completed, true);
  assert.equal(evidence.ok, false);
});
