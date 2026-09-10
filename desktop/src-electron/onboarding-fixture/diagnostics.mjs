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
