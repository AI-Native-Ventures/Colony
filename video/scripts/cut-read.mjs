#!/usr/bin/env node
/**
 * Cut one normalised read into a file per line, at the pauses that best match
 * where each line should end by its share of the words.
 * usage: node scripts/cut-read.mjs <read.wav> <lines.json> <out-dir> [min-pause-seconds]
 *   lines.json: [{ "id": "...", "text": "..." }, ...] in reading order
 * Prints one JSON object { id: { cut: [a, b], spoken: [c, d] } } on stdout,
 * seconds in the read; writes <out-dir>/<id>.mp3 for each line.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const [wav, linesFile, outDir, minPause = "0.35"] = process.argv.slice(2);
const lines = JSON.parse(readFileSync(linesFile, "utf8"));
/** The shortest quiet that can end a line; a read's commas pause for less. */
const MIN_PAUSE = Number(minPause);

const probe = spawnSync(
  "ffmpeg",
  ["-hide_banner", "-nostats", "-i", wav, "-af", "silencedetect=noise=-40dB:d=0.15", "-f", "null", "-"],
  { encoding: "utf8" },
);
const silences = [];
let start = null;
for (const row of probe.stderr.split("\n")) {
  const s = row.match(/silence_start: (-?[0-9.e-]+)/);
  if (s) start = Math.max(0, Number(s[1]));
  const e = row.match(/silence_end: ([0-9.]+) \| silence_duration: ([0-9.]+)/);
  if (e && start !== null) {
    silences.push({ start, end: Number(e[1]), dur: Number(e[2]) });
    start = null;
  }
}
const duration = Number(
  spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", wav], {
    encoding: "utf8",
  }).stdout,
);
const lead = silences[0] && silences[0].start < 0.05 ? silences[0].end : 0;
const tail = start !== null ? start : duration;
const words = lines.map((l) => l.text.split(/\s+/).filter(Boolean).length);
const total = words.reduce((a, b) => a + b, 0);
const expected = [];
let sum = 0;
for (let k = 0; k < lines.length - 1; k++) {
  sum += words[k];
  expected.push(lead + ((tail - lead) * sum) / total);
}
const candidates = silences.filter(
  (s) => s.dur >= MIN_PAUSE && s.start > lead && s.end < tail,
);
const mid = (s) => (s.start + s.end) / 2;
// Choose lines.length - 1 pauses, in order, closest overall to where the lines should end.
const n = expected.length;
const m = candidates.length;
if (m < n) throw new Error(`only ${m} pauses for ${n} line ends`);
const cost = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(Infinity));
const pick = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(false));
for (let j = 0; j <= m; j++) cost[0][j] = 0;
for (let i = 1; i <= n; i++)
  for (let j = i; j <= m; j++) {
    const skip = cost[i][j - 1];
    const take = cost[i - 1][j - 1] + Math.abs(mid(candidates[j - 1]) - expected[i - 1]);
    if (take <= skip) {
      cost[i][j] = take;
      pick[i][j] = true;
    } else cost[i][j] = skip;
  }
const ends = [];
for (let i = n, j = m; i > 0; j--) {
  if (pick[i][j]) {
    ends.unshift(candidates[j - 1]);
    i--;
  }
}
const out = {};
for (const [k, line] of lines.entries()) {
  const before = k === 0 ? null : ends[k - 1];
  const after = k === lines.length - 1 ? null : ends[k];
  const cut = [before ? mid(before) : Math.max(0, lead - 0.15), after ? mid(after) : Math.min(duration, tail + 0.15)];
  const spoken = [before ? before.end : lead, after ? after.start : tail];
  out[line.id] = {
    cut: cut.map((x) => Math.round(x * 1000) / 1000),
    spoken: spoken.map((x) => Math.round(x * 1000) / 1000),
  };
  spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-i", wav,
    "-ss", String(cut[0]), "-to", String(cut[1]),
    "-af", "afade=t=in:d=0.02,areverse,afade=t=in:d=0.04,areverse",
    "-ar", "48000", "-ac", "1", "-c:a", "libmp3lame", "-b:a", "192k",
    `${outDir}/${line.id}.mp3`,
  ]);
}
console.log(JSON.stringify(out, null, 2));
