#!/usr/bin/env node
/**
 * The words in an audio file, by Gemini, for checking voice cuts against their lines.
 * usage: node scripts/transcribe-gemini.mjs <audio.mp3> [model]
 * Reads GEMINI_API_KEY from the environment and never prints it.
 */
import { readFileSync } from "node:fs";

const [audioFile, model = "gemini-2.5-flash"] = process.argv.slice(2);
const key = process.env.GEMINI_API_KEY;
if (!audioFile) throw new Error("usage: transcribe-gemini.mjs <audio.mp3>");
if (!key) throw new Error("GEMINI_API_KEY is not set");

const response = await fetch(
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
  {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            {
              text: "Transcribe this audio exactly. Reply with the words only.",
            },
            {
              inlineData: {
                mimeType: "audio/mpeg",
                data: readFileSync(audioFile).toString("base64"),
              },
            },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  },
);
const body = await response.json();
if (!response.ok) {
  console.error(`HTTP ${response.status}`, JSON.stringify(body).slice(0, 300));
  process.exit(1);
}
console.log(body.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "");
