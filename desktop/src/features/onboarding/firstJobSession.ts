import type { CreditPackList } from "./contracts";
import type { FirstJobCheckoutAttempt } from "./firstJobCredits";
import { FirstJobTaskRefused } from "./firstJobDispatch";
import type { FirstJobRuntime } from "./firstJobRuntime";
import { FIRST_JOB_BRIEF_MAX_LENGTH } from "./firstJobStart";
import type { FirstJobSuggestionPhase } from "./ui/FirstJobSuggestionView";
import type { FirstJobFundingPhase } from "./ui/FirstJobFundingView";

/** Ephemeral presentation state for one existing root, shared by both panes. */
export type FirstJobSessionSnapshot = {
  brief: string;
  briefLocked: boolean;
  phase: FirstJobSuggestionPhase;
  error: string | null;
  taskId: string | null;
  funding: {
    catalogue: CreditPackList | null;
    selectedPackId: string | null;
    receiptEmail: string;
    phase: FirstJobFundingPhase;
    canReopen: boolean;
    error: string | null;
  } | null;
};

const fundingDefaults = () => ({
  catalogue: null,
  selectedPackId: null,
  receiptEmail: "",
  phase: "choose" as FirstJobFundingPhase,
  canReopen: false,
  error: null,
});
const messageOf = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "This step could not be completed. Try again.";

/** All side effects come from the existing scoped runtime; mounting never starts or pays. */
export function createFirstJobSession(
  runtime: FirstJobRuntime,
  initialBrief: string,
) {
  let state: FirstJobSessionSnapshot = {
    brief: initialBrief,
    briefLocked: false,
    phase: "suggested",
    error: null,
    taskId: null,
    funding: null,
  };
  const listeners = new Set<() => void>();
  let removeStoreListeners: (() => void)[] = [];
  let action: Promise<void> | null = null;
  let savedCheckout: FirstJobCheckoutAttempt | null = null;
  let storageUnavailable = false;
  const busy = () => action !== null;
  function update(patch: Partial<FirstJobSessionSnapshot>) {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }
  function funding(
    patch: Partial<NonNullable<FirstJobSessionSnapshot["funding"]>>,
  ) {
    update({ funding: { ...(state.funding ?? fundingDefaults()), ...patch } });
  }
  function refresh() {
    try {
      const draft = runtime.draftStore.read(runtime.scope);
      const attempt = runtime.attemptStore.read(runtime.scope);
      const checkout = runtime.checkoutStore.read(runtime.scope);
      savedCheckout = checkout;
      storageUnavailable = false;
      const next: Partial<FirstJobSessionSnapshot> = {
        brief: attempt?.content ?? draft ?? state.brief,
        briefLocked: !!attempt,
        taskId: attempt?.work?.taskId ?? state.taskId,
      };
      if (attempt?.acknowledged) next.phase = "sent";
      else if (attempt) {
        next.phase = busy()
          ? "sending"
          : attempt.message
            ? "uncertain"
            : "error";
        if (!busy())
          next.error = attempt.message
            ? null
            : "Your earlier request is saved. Try again to resume it.";
      }
      if (checkout && state.funding?.phase !== "funded") {
        next.funding = {
          ...(state.funding ?? fundingDefaults()),
          receiptEmail: checkout.email,
          selectedPackId: checkout.packId,
          canReopen: checkout.phase === "ready",
          phase: busy()
            ? (state.funding?.phase ?? "pending")
            : checkout.phase === "ready"
              ? "pending"
              : "uncertain",
        };
      }
      update(next);
    } catch (error) {
      storageUnavailable = true;
      update({ phase: "error", briefLocked: true, error: messageOf(error) });
    }
  }
  refresh();
  function run(work: () => Promise<void>): Promise<void> {
    if (action) return action;
    // Deferring work one microtask sets single-flight before a synchronous store notification.
    const pending = Promise.resolve()
      .then(work)
      .finally(() => {
        action = null;
      });
    action = pending;
    return pending;
  }
  async function start() {
    return run(async () => {
      update({ phase: "checking", error: null });
      try {
        const existing = await runtime.checkExistingRequest();
        if (existing) {
          refresh();
          update({
            phase: "sent",
            taskId: existing.taskId,
            briefLocked: true,
            error: null,
          });
          return;
        }
        const result = await runtime.start(state.brief);
        refresh();
        if (result.kind === "sent")
          update({
            phase: "sent",
            taskId: result.taskId,
            briefLocked: true,
            error: null,
          });
        else if (result.kind === "needs-credits")
          update({
            phase: "needs-credits",
            funding: state.funding?.phase === "funded" ? null : state.funding,
          });
        else update({ phase: "blocked", error: result.message });
      } catch (error) {
        refresh();
        update({
          phase:
            state.phase === "sent"
              ? "sent"
              : error instanceof FirstJobTaskRefused
                ? "error"
                : state.briefLocked
                  ? "uncertain"
                  : "error",
          error: messageOf(error),
        });
      }
    });
  }
  async function loadPrices() {
    return run(async () => {
      funding({ phase: "loading", error: null });
      try {
        const catalogue = await runtime.credits.loadPacks(runtime.scope);
        refresh();
        funding({
          catalogue,
          selectedPackId:
            state.funding?.selectedPackId ?? catalogue.packs[0]?.id ?? null,
          phase:
            storageUnavailable || savedCheckout?.phase === "initializing"
              ? "uncertain"
              : savedCheckout?.phase === "ready"
                ? "pending"
                : "choose",
        });
      } catch (error) {
        funding({ phase: "error", error: messageOf(error) });
      }
    });
  }
  async function checkout(reopen: boolean) {
    return run(async () => {
      const selected = state.funding;
      funding({ phase: "opening", error: null });
      try {
        const result = reopen
          ? await runtime.credits.reopen(runtime.scope)
          : await runtime.credits.begin(runtime.scope, {
              packId: selected?.selectedPackId ?? "",
              email: selected?.receiptEmail ?? "",
            });
        refresh();
        funding({
          phase:
            result.kind === "initialization-uncertain"
              ? "uncertain"
              : "pending",
          canReopen: result.kind !== "initialization-uncertain",
          error:
            result.kind === "open-failed"
              ? "Checkout is ready but could not be opened. Reopen the existing checkout."
              : null,
        });
      } catch (error) {
        refresh();
        funding({
          phase:
            storageUnavailable || savedCheckout?.phase === "initializing"
              ? "uncertain"
              : savedCheckout?.phase === "ready"
                ? "pending"
                : "error",
          error: messageOf(error),
        });
      }
    });
  }
  async function checkCredits() {
    return run(async () => {
      funding({ phase: "checking", error: null });
      try {
        const result = await runtime.credits.check(runtime.scope);
        refresh();
        funding({
          phase:
            result.kind === "funded"
              ? "funded"
              : result.kind === "initialization-uncertain"
                ? "uncertain"
                : "pending",
        });
        // This is funding evidence, never permission to dispatch automatically.
        if (result.kind === "funded")
          update({
            phase:
              state.phase === "sent"
                ? "sent"
                : state.briefLocked
                  ? "uncertain"
                  : "suggested",
            error: null,
          });
      } catch (error) {
        refresh();
        funding({
          phase: state.funding?.canReopen ? "pending" : "uncertain",
          error: messageOf(error),
        });
      }
    });
  }
  return {
    isBusy: busy,
    whenIdle(callback: () => void) {
      if (action) void action.then(callback, callback);
      else callback();
    },
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        removeStoreListeners = [
          runtime.draftStore,
          runtime.attemptStore,
          runtime.checkoutStore,
        ].map((store) => store.subscribe(runtime.scope, refresh));
        refresh();
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          for (const remove of removeStoreListeners) remove();
          removeStoreListeners = [];
        }
      };
    },
    edit(brief: string) {
      if (
        busy() ||
        state.briefLocked ||
        brief.length > FIRST_JOB_BRIEF_MAX_LENGTH
      )
        return;
      update({ brief, error: null });
      try {
        runtime.draftStore.write(runtime.scope, brief);
      } catch (error) {
        update({ phase: "error", error: messageOf(error) });
      }
    },
    start,
    showFunding: loadPrices,
    reloadPrices: loadPrices,
    selectPack(packId: string) {
      if (
        !busy() &&
        state.funding &&
        !state.funding.canReopen &&
        state.funding.phase !== "uncertain"
      )
        funding({ selectedPackId: packId });
    },
    editEmail(email: string) {
      if (
        !busy() &&
        email.length <= 254 &&
        state.funding &&
        !state.funding.canReopen &&
        state.funding.phase !== "uncertain"
      )
        funding({ receiptEmail: email });
    },
    pay: () => checkout(false),
    reopen: () => checkout(true),
    checkCredits,
    explore() {
      if (!busy()) update({ funding: null });
    },
  };
}

/** A session contains presentation only; the relay remains the source of task truth. */
export type FirstJobSession = ReturnType<typeof createFirstJobSession>;
