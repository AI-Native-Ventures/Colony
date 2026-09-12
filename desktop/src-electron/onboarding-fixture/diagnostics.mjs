import { redactReason } from "./failure-diagnostics.mjs";

// Read-only diagnostics from the exact loaded production module, not a fixture
// replacement for company reads. Used only after the real Start has failed.
export async function readRenderedCompany(page, moduleUrls = []) {
  return page
    .evaluate(async (moduleUrls) => {
      const candidates = [
        ...moduleUrls,
        ...performance
          .getEntriesByType("resource")
          .map((entry) => entry.name)
          .filter((name) =>
            /^colony:\/\/app\/assets\/(?:workRepository|companyRepository)-[^/]+\.js$/.test(
              name,
            ),
          ),
      ];
      for (const name of new Set(candidates)) {
        const module = await import(name);
        const repository = Object.values(module).find(
          (value) => value && typeof value.getActiveCompany === "function",
        );
        if (!repository) continue;
        const result = await repository.getActiveCompany();
        return result.ok
          ? {
              ok: true,
              internalBudget: result.value.costCentres.some(
                (centre) => centre.kind === "internal",
              ),
            }
          : {
              ok: false,
              code: result.code,
              message: String(result.message)
                .replace(/[a-f0-9]{64}/gi, "[redacted-key]")
                .replace(/\b[a-z]+:\/\/\S+/gi, "[redacted-url]"),
            };
      }
      return { unavailable: "Loaded repository export not found" };
    }, moduleUrls)
    .catch((error) => ({ unavailable: error.name }));
}

/**
 * Read the exact production Task lookup once after Start fails. This is
 * failure evidence only: it does not retry, accept a receipt as a Task, or
 * export the parsed record. The bounded result distinguishes a repository
 * miss/parse failure from a task that became visible after the action.
 */
export async function readRenderedTask(page, taskId, moduleUrls = []) {
  if (typeof taskId !== "string" || taskId.length === 0)
    return { unavailable: "task-id-not-retained" };
  return page
    .evaluate(async ({ moduleUrls, taskId }) => {
      const candidates = [
        ...moduleUrls,
        ...performance
          .getEntriesByType("resource")
          .map((entry) => entry.name)
          .filter((name) =>
            /^colony:\/\/app\/assets\/(?:workRepository|companyRepository)-[^/]+\.js$/.test(
              name,
            ),
          ),
      ];
      const safeMessage = (reason) =>
        Array.from(String(reason), (char) =>
          char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char,
        )
          .join("")
          .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[redacted-url]")
          .replace(/\b(?:nsec1|npub1)[a-z0-9]+\b/gi, "[redacted-key]")
          .replace(/\b[a-f0-9]{64,}\b/gi, "[redacted-key]")
          .replace(
            /["']?\b(?:password|(?:access[_-]|refresh[_-])?token|(?:client[_-])?secret|api[_-]?key)["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+)/gi,
            "[redacted-credential]",
          )
          .replace(/\b(?:Bearer|Basic)\s+\S+/gi, "[redacted-credential]")
          .replace(/\s+/g, " ")
          .slice(0, 500);
      for (const name of new Set(candidates)) {
        let module;
        try {
          module = await import(name);
        } catch {
          continue;
        }
        const repository = Object.values(module).find(
          (value) =>
            value &&
            typeof value.getActiveCompany === "function" &&
            typeof value.getTask === "function",
        );
        if (!repository) continue;
        let read;
        try {
          read = repository.getTask(taskId);
        } catch (error) {
          return {
            unavailable: "getTask-throw",
            message: safeMessage(error?.message ?? error),
          };
        }
        const result = await Promise.race([
          read,
          new Promise((resolve) =>
            setTimeout(() => resolve({ unavailable: "getTask-timeout" }), 5_000),
          ),
        ]);
        if (result?.unavailable) return result;
        if (result?.ok === true)
          return {
            ok: true,
            taskId: result.value?.id ?? null,
            status: result.value?.status ?? null,
          };
        if (result?.ok === false)
          return {
            ok: false,
            code: result.code,
            message: safeMessage(result.message),
          };
        return { unavailable: "getTask-shape" };
      }
      return { unavailable: "Loaded repository export not found" };
    }, { moduleUrls, taskId })
    .catch((error) => ({ unavailable: error.name }));
}

/** Read only public attempt references from this exact owner/business/root slot. */
export async function readPendingAttempt(page, account) {
  const tuple = [
    account.ownerPubkey,
    account.relayUrl,
    account.channelId,
    account.rootEventId,
    account.suggestion.requestId,
    "dispatch",
  ];
  return page.evaluate((tuple) => {
    const raw = localStorage.getItem(
      `colony.first-job.v1:${JSON.stringify(tuple)}`,
    );
    if (raw === null) return { exists: false };
    const saved = JSON.parse(raw);
    const scope = saved.scope;
    if (
      saved.version !== 1 ||
      JSON.stringify([
        scope.ownerPubkey,
        scope.relayUrl,
        scope.channelId,
        scope.threadRootId,
        scope.requestId,
        "dispatch",
      ]) !== JSON.stringify(tuple)
    )
      throw new Error("Saved attempt scope does not match this fixture");
    const value = saved.value;
    return {
      exists: true,
      actionId: value.action?.id ?? null,
      taskId: value.work?.taskId ?? null,
      messageId: value.message?.id ?? null,
      messageCreatedAt: value.message?.created_at ?? null,
      acknowledged: value.acknowledged === true,
    };
  }, tuple);
}

/** Observe the real preview without retrying its query or changing owner state. */
export async function waitForTeamPreview({
  readState,
  onObservation = () => {},
  now = Date.now,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  startedAt = now(),
}) {
  // This is a fixture observation budget, not a product latency guarantee.
  // Native IPC may take 60s; relay auth and history each allow 25s.
  const deadline = now() + 75_000;
  let state = { status: "not-observed" };
  try {
    while (true) {
      const observed = await readState();
      state = {
        status: observed.error
          ? "error"
          : observed.pending
            ? "pending"
            : observed.ready
              ? "ready"
              : "unavailable",
        error: observed.error ? redactReason(observed.error) : null,
      };
      if (state.error) throw new Error(`Team preview failed: ${state.error}`);
      if (state.status === "ready") return;
      if (observed.retryAvailable)
        throw new Error("Team preview finished without a usable proposal");
      if (now() >= deadline)
        throw new Error(
          `Team preview did not settle within 75s (${state.status})`,
        );
      await delay(250);
    }
  } finally {
    onObservation({ ...state, elapsedMs: now() - startedAt });
  }
}
