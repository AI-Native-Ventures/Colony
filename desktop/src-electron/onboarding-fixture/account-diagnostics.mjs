// Passive, allowlisted signals only. Native account errors may be caught inside
// the packaged app without being logged; an empty list does not identify a cause.
const SIGNALS = [
  ["Native command timed out; its result is unknown", "native-command-timeout"],
  ["Native host startup timed out", "native-startup-timeout"],
  ["Native host is disconnected", "native-disconnected"],
  ["Native host pipe closed", "native-pipe-closed"],
  ["Malformed native response", "native-malformed-response"],
  [
    "Native renderer cleanup failed; restart the desktop",
    "native-cleanup-failed",
  ],
];

/** Observe owned process/page errors without retaining raw text or altering IPC. */
export function createPassiveAccountDiagnostics() {
  const signals = [];
  const detach = [];
  const record = (source, value) => {
    const text = String(value).slice(0, 8192);
    for (const [message, signal] of SIGNALS) {
      if (
        signals.length < 16 &&
        text.includes(message) &&
        !signals.some(
          (entry) => entry.source === source && entry.signal === signal,
        )
      )
        signals.push({ source, signal });
    }
  };
  const listen = (emitter, event, handler) => {
    if (!emitter) return;
    emitter.on(event, handler);
    detach.push(() => emitter.removeListener(event, handler));
  };
  return {
    observeApplication(application) {
      listen(application.process().stderr, "data", (chunk) =>
        record("electron-stderr", chunk),
      );
    },
    observePage(page) {
      listen(page, "pageerror", (error) => record("page-error", error.message));
      listen(page, "console", (message) => {
        if (["error", "warning"].includes(message.type()))
          record("page-console", message.text());
      });
    },
    snapshot() {
      return {
        signals: signals.map((entry) => ({ ...entry })),
        limitation:
          "The packaged account service discards the underlying local-identity error; absent passive signals do not establish its cause.",
      };
    },
    close() {
      for (const remove of detach.splice(0)) remove();
    },
  };
}
