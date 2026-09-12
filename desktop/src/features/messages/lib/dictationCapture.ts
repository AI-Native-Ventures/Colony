import type { DictationRecording } from "./dictationSession";

type CaptureOptions = {
  signal: AbortSignal;
  level(value: number): void;
  limit(): void;
  failed(message: string): void;
};

/** Capture local PCM; audio stays in memory until Stop, and is never uploaded. */
export async function captureDictation(
  options: CaptureOptions,
): Promise<DictationRecording> {
  if (!navigator.mediaDevices?.getUserMedia)
    throw new Error("Microphone access is unavailable in this window.");
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
      video: false,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotAllowedError") {
      throw new Error(
        "Allow microphone access for Colony in system settings, then try again.",
      );
    }
    throw new Error(
      "Could not open your microphone. Check that it is connected and try again.",
    );
  }
  let context: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let worklet: AudioWorkletNode | null = null;
  let muted: GainNode | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chunks: Float32Array[] = [];
  let finished = false;
  let stopping = false;
  let closed = false;
  let settle: (() => void) | null = null;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    options.signal.removeEventListener("abort", cancel);
    for (const track of stream.getTracks()) {
      track.onended = null;
      track.stop();
    }
    source?.disconnect();
    worklet?.disconnect();
    muted?.disconnect();
    if (worklet) {
      worklet.port.onmessage = null;
      worklet.port.close();
    }
    if (context && context.state !== "closed")
      void context.close().catch(() => {});
  };
  const cancel = () => {
    cleanup();
    chunks = [];
    settle?.();
  };
  options.signal.addEventListener("abort", cancel, { once: true });
  try {
    if (options.signal.aborted) throw new Error("Dictation cancelled.");
    context = new AudioContext({ sampleRate: 16000 });
    if (context.sampleRate !== 16000)
      throw new Error(
        "Your audio device does not support dictation at 16 kHz.",
      );
    await context.resume();
    await context.audioWorklet.addModule("/dictation-worklet.js");
    if (closed || options.signal.aborted)
      throw new Error("Dictation cancelled.");
    source = context.createMediaStreamSource(stream);
    worklet = new AudioWorkletNode(context, "colony-dictation");
    muted = context.createGain();
    muted.gain.value = 0;
    worklet.port.onmessage = ({
      data,
    }: MessageEvent<{ samples?: Float32Array; finished?: boolean }>) => {
      if (closed) return;
      if (data.samples) {
        chunks.push(data.samples);
        let energy = 0;
        for (const sample of data.samples) energy += sample * sample;
        options.level(Math.min(1, Math.sqrt(energy / data.samples.length) * 6));
      }
      if (data.finished) {
        finished = true;
        settle?.();
        if (!stopping) options.limit();
      }
    };
    worklet.onprocessorerror = () => {
      cancel();
      options.failed(
        "Microphone recording stopped unexpectedly. Please try again.",
      );
    };
    for (const track of stream.getTracks())
      track.onended = () => {
        cancel();
        options.failed(
          "Your microphone disconnected. Reconnect it and try again.",
        );
      };
    source.connect(worklet);
    worklet.connect(muted);
    muted.connect(context.destination);
    timer = setTimeout(options.limit, 60_000);
    return {
      cancel,
      async stop() {
        if (closed) throw new Error("Dictation cancelled.");
        stopping = true;
        clearTimeout(timer);
        try {
          if (!finished) {
            await new Promise<void>((resolve, reject) => {
              settle = resolve;
              timer = setTimeout(
                () =>
                  reject(
                    new Error("Could not finish recording. Please try again."),
                  ),
                2000,
              );
              worklet?.port.postMessage("stop");
            });
          }
          if (closed) throw new Error("Dictation cancelled.");
          const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
          const audio = new Float32Array(length);
          let offset = 0;
          for (const chunk of chunks) {
            audio.set(chunk, offset);
            offset += chunk.length;
          }
          return new Uint8Array(audio.buffer);
        } finally {
          cleanup();
          chunks = [];
        }
      },
    };
  } catch (error) {
    cancel();
    throw error;
  }
}
