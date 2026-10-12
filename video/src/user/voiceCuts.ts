/**
 * Where each user-video line sits in its read, in seconds: the file's cut and
 * the words inside it. Written by scripts/cut-read.mjs from the reads in
 * public/user/voice/SOURCES.md; regenerate with the voice, never by hand.
 */
export const VOICE_CUTS: Readonly<
  Record<
    string,
    { cut: readonly [number, number]; spoken: readonly [number, number] }
  >
> = {
  "sh-intro": { cut: [0.079, 2.751], spoken: [0.229, 2.349] },
  "sh-account-1": { cut: [2.751, 5.304], spoken: [3.153, 4.751] },
  "sh-account-2": { cut: [5.304, 8.433], spoken: [5.857, 8.102] },
  "sh-recovery-1": { cut: [8.433, 11.083], spoken: [8.763, 10.828] },
  "sh-recovery-2": { cut: [11.083, 14.017], spoken: [11.339, 13.796] },
  "sh-recovery-3": { cut: [14.017, 17.647], spoken: [14.239, 17.124] },
  "sh-business-1": { cut: [17.647, 20.398], spoken: [18.17, 20.022] },
  "sh-business-2": { cut: [20.398, 24.116], spoken: [20.774, 23.606] },
  "sh-business-3": { cut: [0.112, 2.705], spoken: [0.262, 2.536] },
  "sh-business-4": { cut: [26.239, 28.773], spoken: [26.596, 28.316] },
  "sh-power-1": { cut: [28.773, 31.035], spoken: [29.231, 30.691] },
  "sh-power-2": { cut: [31.035, 34.542], spoken: [31.38, 34.171] },
  "sh-power-3": { cut: [2.705, 7.707], spoken: [2.874, 7.422] },
  "sh-power-4": { cut: [40.19, 43.028], spoken: [40.623, 42.581] },
  "sh-history-1": { cut: [43.028, 47.706], spoken: [43.475, 47.335] },
  "sh-history-2": { cut: [47.706, 50.116], spoken: [48.077, 49.842] },
  "sh-welcome-1": { cut: [50.116, 53.215], spoken: [50.39, 52.839] },
  "sh-welcome-2": { cut: [53.215, 54.916], spoken: [53.592, 54.318] },
  "sh-welcome-3": { cut: [54.916, 60.846], spoken: [55.515, 60.331] },
  "sh-priority-1": { cut: [7.707, 11.007], spoken: [7.992, 11.007] },
  "sh-priority-2": { cut: [64.526, 66.703], spoken: [64.966, 66.476] },
  "sh-priority-3": { cut: [66.703, 68.325], spoken: [66.93, 67.902] },
  "sh-setup-1": { cut: [68.325, 70.759], spoken: [68.748, 70.379] },
  "sh-setup-2": { cut: [70.759, 73.162], spoken: [71.14, 72.707] },
  "sh-job-1": { cut: [73.162, 77.815], spoken: [73.616, 77.463] },
  "sh-job-2": { cut: [77.815, 81.531], spoken: [78.166, 81.107] },
  "sh-job-3": { cut: [81.531, 83.953], spoken: [81.954, 83.777] },
  "sh-job-4": { cut: [83.953, 85.534], spoken: [84.128, 85.124] },
  "sh-thread-1": { cut: [85.534, 89.644], spoken: [85.944, 89.338] },
  "sh-end": { cut: [89.644, 92.007], spoken: [89.95, 92.007] },
  "cc-intro": { cut: [0.166, 3.042], spoken: [0.316, 2.785] },
  "cc-clients": { cut: [3.042, 7.999], spoken: [3.298, 7.712] },
  "cc-posts": { cut: [7.999, 12.406], spoken: [8.286, 12.158] },
  "cc-emails": { cut: [12.406, 16.345], spoken: [12.654, 15.916] },
  "cc-send-1": { cut: [16.345, 19.904], spoken: [16.775, 19.582] },
  "cc-send-2": { cut: [19.904, 24.113], spoken: [20.226, 23.789] },
  "cc-closed": { cut: [24.113, 27.123], spoken: [24.437, 26.892] },
  "cc-hire": { cut: [27.123, 30.835], spoken: [27.354, 30.541] },
  "cc-keep": { cut: [30.835, 34.656], spoken: [31.128, 34.364] },
  "cc-close-1": { cut: [34.656, 36.033], spoken: [34.948, 35.768] },
  "cc-close-2": { cut: [36.033, 38.287], spoken: [36.297, 38.287] },
};

/** How long line `id` speaks. */
export function voiceSeconds(id: string): number {
  const line = VOICE_CUTS[id];
  if (!line) throw new Error(`no voice for line "${id}"`);
  return line.spoken[1] - line.spoken[0];
}

/** Seconds of quiet at the start of line `id`'s file, before its first word. */
export function voiceLead(id: string): number {
  const line = VOICE_CUTS[id];
  if (!line) throw new Error(`no voice for line "${id}"`);
  return line.spoken[0] - line.cut[0];
}

/** Line `id`'s file, for staticFile. */
export function voiceFile(id: string): string {
  return `user/voice/${id}.mp3`;
}
