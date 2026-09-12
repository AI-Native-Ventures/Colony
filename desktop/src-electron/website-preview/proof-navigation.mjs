/**
 * Bounded navigation and frame evidence for the real-Electron preview proof.
 *
 * These helpers keep the proof's refusal claims tied to an observed guard
 * denial, a specific blocked load error, and the actual frame URLs that
 * Chromium retained after the attempt.
 */

function frameSnapshot(entry) {
  try {
    const mainFrame = entry.webContents.mainFrame;
    const frames = Array.isArray(mainFrame?.frames) ? mainFrame.frames : [];
    const main =
      typeof mainFrame?.url === "string" && mainFrame.url !== ""
        ? [
            {
              isMainFrame: true,
              url: mainFrame.url,
              processId: mainFrame.processId ?? mainFrame.frameProcessId ?? null,
              routingId: mainFrame.routingId ?? mainFrame.frameRoutingId ?? null,
            },
          ]
        : [];
    return [
      ...main,
      ...frames.map((frame) => ({
        isMainFrame: false,
        url: typeof frame?.url === "string" ? frame.url : "",
        processId: frame?.processId ?? frame?.frameProcessId ?? null,
        routingId: frame?.routingId ?? frame?.frameRoutingId ?? null,
      })),
    ];
  } catch {
    return [];
  }
}

function navigationDetails(args) {
  const event = args[0];
  const details = args.find(
    (value, index) => index > 0 && value !== null && typeof value === "object",
  );
  const url =
    typeof details?.url === "string"
      ? details.url
      : typeof args[1] === "string"
        ? args[1]
        : typeof event?.url === "string"
          ? event.url
          : "";
  const isMainFrame =
    typeof details?.isMainFrame === "boolean"
      ? details.isMainFrame
      : typeof event?.isMainFrame === "boolean"
        ? event.isMainFrame
        : typeof args[4] === "boolean"
          ? args[4]
          : typeof args[3] === "boolean"
            ? args[3]
            : undefined;
  return { url, isMainFrame };
}

function navigationFailureDetails(args) {
  const details = args.find(
    (value, index) => index > 0 && value !== null && typeof value === "object",
  );
  const code =
    Number.isInteger(details?.errorCode) && details.errorCode !== undefined
      ? details.errorCode
      : Number.isInteger(args[1])
        ? args[1]
        : null;
  const description =
    typeof details?.errorDescription === "string"
      ? details.errorDescription
      : typeof args[2] === "string"
        ? args[2]
        : "";
  const url =
    typeof details?.validatedURL === "string"
      ? details.validatedURL
      : typeof details?.url === "string"
        ? details.url
        : typeof args[3] === "string"
          ? args[3]
          : "";
  const isMainFrame =
    typeof details?.isMainFrame === "boolean"
      ? details.isMainFrame
      : typeof args[4] === "boolean"
        ? args[4]
        : undefined;
  return { code, description, url, isMainFrame };
}

const BLOCKED_NAVIGATION_CODES = new Set([-20, -30]);

function isSpecificBlockedFailure(failure) {
  return (
    BLOCKED_NAVIGATION_CODES.has(failure.code) ||
    /ERR_BLOCKED_BY_(?:CLIENT|CSP)|blocked by|content security policy/i.test(
      `${failure.description}`,
    )
  );
}

/** Observe one exact child navigation without treating a timeout as refusal. */
export function observeFrameNavigation(entry, targetUrl) {
  const webContents = entry.webContents;
  const state = {
    started: false,
    attempted: false,
    completed: false,
    failures: [],
    guardCancelled: false,
  };
  const denialFloor = Number.isSafeInteger(entry.navigationDenialSequence)
    ? entry.navigationDenialSequence
    : 0;
  const matches = (args) => {
    const details = navigationDetails(args);
    return details.isMainFrame !== true && details.url === targetUrl;
  };
  const onStart = (...args) => {
    if (matches(args)) state.started = true;
  };
  const onWill = (...args) => {
    if (!matches(args)) return;
    state.attempted = true;
    if (args[0]?.defaultPrevented === true) state.guardCancelled = true;
  };
  const onDid = (...args) => {
    if (matches(args)) state.completed = true;
  };
  const onFail = (...args) => {
    const failure = navigationFailureDetails(args);
    if (failure.isMainFrame !== true && failure.url === targetUrl) {
      state.failures.push(failure);
    }
  };
  webContents.on("did-start-navigation", onStart);
  webContents.on("will-frame-navigate", onWill);
  webContents.on("did-frame-navigate", onDid);
  webContents.on("did-fail-load", onFail);
  return {
    state,
    stop() {
      state.guardCancelled =
        state.guardCancelled === true ||
        (Array.isArray(entry.navigationDenials) &&
          entry.navigationDenials.some(
            (denial) =>
              denial.sequence > denialFloor &&
              denial.url === targetUrl &&
              denial.isMainFrame !== true,
          ));
      webContents.removeListener?.("did-start-navigation", onStart);
      webContents.removeListener?.("will-frame-navigate", onWill);
      webContents.removeListener?.("did-frame-navigate", onDid);
      webContents.removeListener?.("did-fail-load", onFail);
    },
  };
}

/** Summarize refusal, completion, retained child URLs, and recovery state. */
export function navigationEvidence(entry, beforeUrl, targetUrl, observer) {
  const frames = frameSnapshot(entry);
  const targetFrames = frames.filter((frame) => frame.url === targetUrl);
  const originalFrames = frames.filter(
    (frame) => frame.isMainFrame !== true && frame.url === beforeUrl,
  );
  const blockedFailure = observer.state.failures.find(
    (failure) =>
      failure.url === targetUrl &&
      failure.isMainFrame !== true &&
      isSpecificBlockedFailure(failure),
  );
  const explicitRefusal =
    observer.state.guardCancelled === true || blockedFailure !== undefined;
  const completed =
    observer.state.completed === true || targetFrames.length > 0;
  const recoverableFailure =
    entry.failed === true &&
    typeof entry.lastError === "string" &&
    entry.lastError !== "";
  return {
    ok:
      explicitRefusal &&
      !completed &&
      (originalFrames.length > 0 || recoverableFailure),
    beforeUrl,
    targetUrl,
    frames,
    targetFrames,
    originalFrames,
    explicitRefusal,
    guardCancelled: observer.state.guardCancelled === true,
    blockedFailure: blockedFailure ?? null,
    completed,
    recoverableFailure,
    failedState: entry.failed === true ? entry.lastError : null,
    events: observer.state,
  };
}
