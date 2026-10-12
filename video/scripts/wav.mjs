/**
 * Gemini TTS replies with a whole WAV file: a RIFF header, the samples, and
 * then a C2PA chunk (about 6 KB of content credentials). Read as raw PCM, the
 * header is a click before the first word and the credentials are a burst of
 * full-scale noise after the last one: the static in the user videos.
 */

/**
 * The 24 kHz mono 16-bit samples of a Gemini TTS reply, without header or
 * credentials. Raw PCM (no RIFF header) passes through unchanged.
 */
export function pcmFromGemini(buffer) {
  if (buffer.length < 12 || buffer.toString("ascii", 0, 4) !== "RIFF")
    return buffer;
  if (buffer.toString("ascii", 8, 12) !== "WAVE")
    throw new Error("a RIFF reply that is not WAVE");
  let format = null;
  for (let at = 12; at + 8 <= buffer.length; ) {
    const id = buffer.toString("ascii", at, at + 4);
    const size = buffer.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === "fmt ") {
      format = {
        channels: buffer.readUInt16LE(body + 2),
        rate: buffer.readUInt32LE(body + 4),
        bits: buffer.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      if (
        !format ||
        format.rate !== 24000 ||
        format.channels !== 1 ||
        format.bits !== 16
      )
        throw new Error(
          `expected 24000 Hz, 1 channel, 16-bit; got ${format?.rate} Hz, ${format?.channels} channel, ${format?.bits}-bit`,
        );
      return buffer.subarray(body, Math.min(body + size, buffer.length));
    }
    at = body + size + (size % 2);
  }
  throw new Error("a WAV reply with no data chunk");
}
