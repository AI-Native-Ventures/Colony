import assert from "node:assert/strict";
import { test } from "node:test";
import { pcmFromGemini } from "./wav.mjs";

function chunk(id, payload) {
  const head = Buffer.alloc(8);
  head.write(id, 0, "ascii");
  head.writeUInt32LE(payload.length, 4);
  return Buffer.concat([
    head,
    payload,
    payload.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0),
  ]);
}

function fmt(rate, channels, bits) {
  const body = Buffer.alloc(16);
  body.writeUInt16LE(1, 0);
  body.writeUInt16LE(channels, 2);
  body.writeUInt32LE(rate, 4);
  body.writeUInt32LE((rate * channels * bits) / 8, 8);
  body.writeUInt16LE((channels * bits) / 8, 12);
  body.writeUInt16LE(bits, 14);
  return chunk("fmt ", body);
}

function riff(...chunks) {
  const body = Buffer.concat([Buffer.from("WAVE", "ascii"), ...chunks]);
  const head = Buffer.alloc(8);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

test("a WAV reply gives only its samples: no header, no C2PA credentials after them", () => {
  const samples = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]);
  const credentials = Buffer.alloc(6062, 0xff);
  const wav = riff(
    fmt(24000, 1, 16),
    chunk("data", samples),
    chunk("C2PA", credentials),
  );
  assert.deepEqual(pcmFromGemini(wav), samples);
});

test("raw PCM passes through unchanged", () => {
  const raw = Buffer.from([5, 0, 6, 0]);
  assert.deepEqual(pcmFromGemini(raw), raw);
});

test("a WAV that is not 24 kHz mono 16-bit is refused, not misread", () => {
  const wav = riff(fmt(44100, 2, 16), chunk("data", Buffer.alloc(8)));
  assert.throws(() => pcmFromGemini(wav), /44100 Hz, 2 channel/);
});

test("a WAV without samples is refused", () => {
  assert.throws(() => pcmFromGemini(riff(fmt(24000, 1, 16))), /no data chunk/);
});
