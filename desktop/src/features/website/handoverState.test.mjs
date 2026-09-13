import assert from "node:assert/strict";
import test from "node:test";

import {
  beginHandoverDownload,
  beginHandoverDraftRequest,
  clearHandoverDraftCopied,
  completeHandoverDownload,
  createHandoverLocalState,
  draftScopesEqual,
  failHandoverDownload,
  failHandoverDraftRequest,
  handoverScopeKey,
  markHandoverDraftCopied,
  resolveHandoverDraftResponse,
} from "./handoverState.ts";

const SCOPE = {
  jobId: "job-1",
  taskId: "task-1",
  channel: "chan-1",
  approvedRevision: 2,
  approvedManifestSha256: "a".repeat(64),
};

const OTHER_SCOPE = { ...SCOPE, approvedRevision: 3 };
const KEY = handoverScopeKey(SCOPE);

test("the handover scope key covers the approved revision and hash", () => {
  assert.equal(handoverScopeKey(SCOPE), handoverScopeKey({ ...SCOPE }));
  assert.notEqual(handoverScopeKey(SCOPE), handoverScopeKey(OTHER_SCOPE));
  assert.notEqual(
    handoverScopeKey(SCOPE),
    handoverScopeKey({ ...SCOPE, approvedManifestSha256: "b".repeat(64) }),
  );
  assert.equal(draftScopesEqual(SCOPE, { ...SCOPE }), true);
  assert.equal(draftScopesEqual(SCOPE, OTHER_SCOPE), false);
});

test("a response for another scope is rejected, never displayed", () => {
  let state = createHandoverLocalState(KEY);
  state = beginHandoverDraftRequest(state);
  assert.equal(state.draft.status, "requesting");

  state = resolveHandoverDraftResponse(state, {
    requestedScope: SCOPE,
    response: {
      status: "returned",
      scope: OTHER_SCOPE,
      accessRequest: "A different version's request.",
    },
  });
  assert.equal(state.draft.status, "failed");
  assert.ok(state.draft.message.includes("different job or version"));
});

test("a returned draft for the exact scope is accepted", () => {
  let state = createHandoverLocalState(KEY);
  state = beginHandoverDraftRequest(state);
  state = resolveHandoverDraftResponse(state, {
    requestedScope: SCOPE,
    response: {
      status: "returned",
      scope: { ...SCOPE },
      domain: "example.com",
      accessRequest: "Please share who manages the domain.",
    },
  });
  assert.equal(state.draft.status, "returned");
  assert.equal(state.draft.view.domain, "example.com");
});

test("a returned draft with no content is refused", () => {
  let state = createHandoverLocalState(KEY);
  state = resolveHandoverDraftResponse(state, {
    requestedScope: SCOPE,
    response: { status: "returned", scope: { ...SCOPE } },
  });
  assert.equal(state.draft.status, "failed");
  assert.ok(state.draft.message.includes("empty"));
});

test("requested and failed responses keep precise states", () => {
  let pending = createHandoverLocalState(KEY);
  pending = resolveHandoverDraftResponse(pending, {
    requestedScope: SCOPE,
    response: { status: "requested", scope: { ...SCOPE } },
  });
  assert.equal(pending.draft.status, "requesting");

  let failed = createHandoverLocalState(KEY);
  failed = resolveHandoverDraftResponse(failed, {
    requestedScope: SCOPE,
    response: {
      status: "failed",
      scope: { ...SCOPE },
      error: "The team could not be reached.",
    },
  });
  assert.equal(failed.draft.status, "failed");
  assert.equal(failed.draft.message, "The team could not be reached.");

  const adapterFailure = failHandoverDraftRequest(
    createHandoverLocalState(KEY),
    "Transport closed.",
  );
  assert.equal(adapterFailure.draft.status, "failed");
  assert.equal(adapterFailure.draft.message, "Transport closed.");
});

test("download results are ignored when they answer a different resource", () => {
  let state = createHandoverLocalState(KEY);
  state = beginHandoverDownload(state, "asset:index.html");
  assert.equal(state.download.status, "downloading");
  const untouched = completeHandoverDownload(state, "asset:app.css");
  assert.equal(untouched, state);

  const done = completeHandoverDownload(state, "asset:index.html");
  assert.equal(done.download.status, "done");

  const failed = failHandoverDownload(
    state,
    "asset:index.html",
    "Write failed.",
  );
  assert.equal(failed.download.status, "failed");
  assert.equal(failed.download.message, "Write failed.");
});

test("the copied marker toggles for the current scope only", () => {
  let state = createHandoverLocalState(KEY);
  state = markHandoverDraftCopied(state);
  assert.equal(state.copied, true);
  state = clearHandoverDraftCopied(state);
  assert.equal(state.copied, false);
});

test("a fresh state for a new scope carries no previous work", () => {
  let state = createHandoverLocalState(KEY);
  state = beginHandoverDownload(state, "asset:index.html");
  state = markHandoverDraftCopied(state);
  const other = createHandoverLocalState(handoverScopeKey(OTHER_SCOPE));
  assert.equal(other.download, null);
  assert.equal(other.copied, false);
  assert.equal(other.draft.status, "idle");
  assert.notEqual(other.scopeKey, state.scopeKey);
});
