#!/usr/bin/env node
/**
 * One voice line from a Gemini TTS read: 24 kHz mono s16le PCM in, a trimmed,
 * levelled 48 kHz MP3 out.
 * usage: node scripts/voice-line.mjs <in.pcm> <out.mp3>
 *
 * Levels with one plain gain to -16 LUFS and a fast peak limiter at -2 dBFS
 * for the few peaks the gain pushes over, never a dynamic leveller: those lift
 * the quiet between words along with the words.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pcmFromGemini } from "./wav.mjs";

const [input, output] = process.argv.slice(2);
if (!input || !output)
  throw new Error("usage: voice-line.mjs <in.pcm> <out.mp3>");

// A reply saved whole (WAV header, C2PA credentials) is cut down to its samples.
const samples = pcmFromGemini(readFileSync(input));
const PCM = ["-f", "s16le", "-ar", "24000", "-ac", "1", "-i", "pipe:0"];
// Keep 50 ms of the room before the first word and after the last.
const TRIM =
  "silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05," +
  "areverse," +
  "silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05," +
  "areverse";

function ffmpeg(args) {
  const run = spawnSync("ffmpeg", ["-hide_banner", "-nostats", ...args], {
    input: samples,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.status !== 0) throw new Error(run.stderr.slice(-600));
  return run.stderr;
}

const report = ffmpeg([
  ...PCM,
  "-af",
  `${TRIM},ebur128=peak=true`,
  "-f",
  "null",
  "-",
]);
const summary = report.slice(report.lastIndexOf("Summary:"));
const loudness = Number(/I:\s+(-?[\d.]+) LUFS/.exec(summary)?.[1]);
const peak = Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(summary)?.[1]);
if (!Number.isFinite(loudness) || !Number.isFinite(peak))
  throw new Error(`could not measure ${input}`);
const gain = -16 - loudness;
ffmpeg([
  "-y",
  ...PCM,
  "-af",
  `${TRIM},volume=${gain.toFixed(2)}dB,alimiter=limit=0.79:attack=3:release=40:level=0,aresample=48000`,
  "-ac",
  "1",
  "-c:a",
  "libmp3lame",
  "-b:a",
  "192k",
  output,
]);
console.log(
  `${output}: ${loudness.toFixed(1)} LUFS, peak ${peak.toFixed(1)} dBTP, gain ${gain.toFixed(2)} dB`,
);
