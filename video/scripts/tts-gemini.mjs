#!/usr/bin/env node
/**
 * One Aoede read of a text file through the Gemini API, as 24 kHz mono s16le PCM.
 * usage: node scripts/tts-gemini.mjs <text-file> <out.pcm> [model] [voice]
 * Reads GEMINI_API_KEY from the environment and never prints it. Send the words
 * only: Gemini TTS reads style instructions aloud.
 */
import { readFileSync, writeFileSync } from "node:fs";

const [textFile, outFile, model = "gemini-3.8-flash-tts", voice = "Aoede"] =
  process.argv.slice(2);
const key = process.env.GEMINI_API_KEY;
if (!textFile || !outFile) throw new Error("usage: tts-gemini.mjs <text-file> <out.pcm>");
if (!key) throw new Error("GEMINI_API_KEY is not set");

const response = await fetch(
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
  {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: readFileSync(textFile, "utf8") }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      },
    }),
    signal: AbortSignal.timeout(300_000),
  },
);
const body = await response.json();
if (!response.ok) {
  console.error(`${model} ${voice}: HTTP ${response.status}`, JSON.stringify(body).slice(0, 400));
  process.exit(1);
}
const data = body.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
if (!data) throw new Error("no audio in the response");
writeFileSync(outFile, Buffer.from(data, "base64"));
console.log(`${model} ${voice}: ${outFile}`);
