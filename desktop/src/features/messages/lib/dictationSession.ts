export type DictationState = {
  phase: "idle" | "preparing" | "recording" | "transcribing";
  error: string | null;
  reviewed: boolean;
};

export type DictationRecording = {
  stop(): Promise<Uint8Array>;
  cancel(): void;
};

type Dependencies = {
  prepare(): Promise<void>;
  capture(signal: AbortSignal): Promise<DictationRecording>;
  transcribe(audio: Uint8Array): Promise<string>;
  insert(text: string): void;
  changed(state: DictationState): void;
};

// One microphone owner across composers in this renderer. Native decoding has
// its own process-wide guard for other windows and cancelled in-flight work.
let owner: symbol | null = null;

/** Cancellable dictation lifecycle; only an explicit Stop can insert text. */
export function createDictationSession(deps: Dependencies) {
  const id = Symbol("dictation");
  let generation = 0;
  let abort: AbortController | null = null;
  let recording: DictationRecording | null = null;
  let state: DictationState = { phase: "idle", error: null, reviewed: false };
  const update = (
    phase: DictationState["phase"],
    error: string | null = null,
    reviewed = false,
  ) => {
    state = { phase, error, reviewed };
    deps.changed(state);
  };
  const release = () => {
    if (owner === id) owner = null;
  };
  const fail = (error: unknown) => {
    recording?.cancel();
    recording = null;
    release();
    update("idle", error instanceof Error ? error.message : String(error));
  };
  return {
    busy: () => state.phase !== "idle",
    async start() {
      if (state.phase !== "idle") return;
      if (owner !== null) {
        update(
          "idle",
          "Finish dictating in the other composer before starting another recording.",
        );
        return;
      }
      owner = id;
      const current = ++generation;
      update("preparing");
      try {
        await deps.prepare();
        if (current !== generation) return;
        abort = new AbortController();
        const acquired = await deps.capture(abort.signal);
        if (current !== generation) {
          acquired.cancel();
          return;
        }
        recording = acquired;
        update("recording");
      } catch (error) {
        if (current === generation) fail(error);
      }
    },
    async stop() {
      if (state.phase !== "recording" || !recording) return;
      const current = generation;
      const captured = recording;
      update("transcribing");
      try {
        const audio = await captured.stop();
        if (current !== generation) return;
        recording = null;
        const text = (await deps.transcribe(audio)).trim();
        if (current !== generation) return;
        if (!text)
          throw new Error(
            "No speech detected. Try again a little closer to your microphone.",
          );
        deps.insert(text);
        release();
        update("idle", null, true);
      } catch (error) {
        if (current === generation) fail(error);
      }
    },
    cancel(error: string | null = null) {
      generation++;
      abort?.abort();
      abort = null;
      recording?.cancel();
      recording = null;
      release();
      update("idle", error);
    },
  };
}
