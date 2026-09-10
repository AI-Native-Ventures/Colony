// Passive diagnostics from the existing native Channel push, never a transport replacement.
import { redactReason } from "./failure-diagnostics.mjs";

/** Serialized by Playwright into the fixture renderer after its scoped reload. */
export function installNativePublishObserver(scope) {
  const key = "__COLONY_FIXTURE_NATIVE_PUBLISH_OBSERVER__";
  window[key]?.stop();
  const state = {
    scope,
    nativeTextMessages: 0,
    okMessages: 0,
    refusals: [],
    acknowledgements: [],
    lifecycle: [],
    unavailable: [],
    stopped: false,
  };
  const unavailable = (reason) => {
    if (!state.unavailable.includes(reason) && state.unavailable.length < 8)
      state.unavailable.push(reason);
  };
  const startedAt = Date.now();
  const push = (list, value, limit, name) => {
    if (list.length >= limit) {
      unavailable(`${name}-limit`);
      return;
    }
    list.push({ elapsedMs: Date.now() - startedAt, ...value });
  };
  let unsubscribe;
  const stop = () => {
    if (state.stopped) return;
    state.stopped = true;
    try {
      unsubscribe?.();
    } catch {
      unavailable("unsubscribe-failed");
    }
  };
  window[key] = { state, stop };
  try {
    unsubscribe = window.colonyDesktop.subscribe((message) => {
      // Preload delivers to multiple consumers. This observer must never throw,
      // mutate the message, or prevent the real relay client receiving it.
      try {
        if (state.stopped || message?.type !== "channel") return;
        const payload = message.payload;
        const channelId = Number.isSafeInteger(message.id) ? message.id : null;
        if (payload?.type === "Close" || payload?.type === "Error") {
          const reason =
            payload.type === "Error" ? payload.data : payload.data?.reason;
          if (typeof reason === "string" && reason.length > 32 * 1024) {
            unavailable("lifecycle-message-limit");
            return;
          }
          push(
            state.lifecycle,
            {
              type: payload.type,
              channelId,
              code: Number.isSafeInteger(payload.data?.code)
                ? payload.data.code
                : null,
              message: typeof reason === "string" ? reason : "",
            },
            40,
            "lifecycle",
          );
          return;
        }
        if (payload?.type !== "Text" || typeof payload.data !== "string")
          return;
        state.nativeTextMessages += 1;
        const text = payload.data;
        // Ignore EVENT/auth/history content entirely. Bound even prefix inspection.
        if (!/^\s*\[\s*"(?:OK|NOTICE)"\s*,/.test(text.slice(0, 64))) return;
        if (text.length > 32 * 1024) {
          unavailable("ok-message-limit");
          return;
        }
        const frame = JSON.parse(text);
        if (Array.isArray(frame) && frame[0] === "NOTICE") {
          if (frame.length !== 2 || typeof frame[1] !== "string") {
            unavailable("notice-message-shape");
            return;
          }
          push(
            state.lifecycle,
            { type: "NOTICE", channelId, message: frame[1] },
            40,
            "lifecycle",
          );
          return;
        }
        if (
          !Array.isArray(frame) ||
          frame.length !== 4 ||
          frame[0] !== "OK" ||
          typeof frame[1] !== "string" ||
          frame[1].length !== 64 ||
          !/^[a-f0-9]{64}$/.test(frame[1]) ||
          typeof frame[2] !== "boolean" ||
          typeof frame[3] !== "string"
        ) {
          unavailable("ok-message-shape");
          return;
        }
        state.okMessages += 1;
        push(
          state.acknowledgements,
          { eventId: frame[1], accepted: frame[2], channelId },
          40,
          "acknowledgement",
        );
        if (frame[2]) return;
        if (state.refusals.length >= 20) {
          unavailable("refusal-limit");
          return;
        }
        // Redaction happens before this bounded projection enters the proof artifact.
        state.refusals.push({ eventId: frame[1], message: frame[3] });
      } catch {
        unavailable("ok-message-read");
      }
    });
  } catch {
    unavailable("subscribe-failed");
    stop();
  }
}

/** Stop the observer and export only bounded refusal diagnostics, with no raw frames. */
export async function readNativePublishObservations(page) {
  const captured = await page
    .evaluate(() => {
      const observer = window.__COLONY_FIXTURE_NATIVE_PUBLISH_OBSERVER__;
      if (!observer) return { unavailable: ["not-installed"] };
      observer.stop();
      return observer.state;
    })
    .catch(() => ({ unavailable: ["renderer-unavailable"] }));
  return {
    ...captured,
    lifecycle: (captured.lifecycle ?? []).map((entry) => ({
      ...entry,
      message: redactReason(entry.message),
    })),
    refusals: (captured.refusals ?? []).map(({ eventId, message }) => ({
      eventId,
      message: redactReason(message),
    })),
  };
}
