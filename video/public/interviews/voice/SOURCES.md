# Job interview voices

Generated 2026-10-12 with the Gemini API (`GEMINI_API_KEY`, free tier),
model `gemini-3.8-flash-tts`: the interviewer ("You") is voice `Charon`, the
employee is voice `Aoede`, the launch film's and explainers' voice.

- One read per line, the words only (Gemini TTS reads style instructions
  aloud): `node scripts/tts-gemini.mjs <line.txt> <line.pcm> gemini-3.8-flash-tts <voice>`.
  The reply is a whole WAV file with a C2PA credentials chunk after the
  samples; `scripts/wav.mjs` keeps only the samples.
- Each line levelled by `node scripts/voice-line.mjs <line.pcm> <line.mp3>`:
  silence trimmed to 50 ms at each end, one plain gain to -16 LUFS, a fast
  peak limiter at -2 dBFS, 48 kHz mono MP3 at 192 kbps.
- Every file transcribed with `scripts/transcribe-gemini.mjs` and matched its
  line word for word in at least one of gemini-3.6-flash and gemini-3.7-flash
  (gemini-2.5-flash-lite dropped "here" from iv1-q1; one hearing of iv1-a2 was
  "sign", two were "send").
- Checked: no sample within 2% of full scale in any file, the last 150 ms of
  each file quiet (no burst), each line -16.4 to -16.5 LUFS.

| File | Voice | Words |
| --- | --- | --- |
| iv1-q1.mp3 | Charon | So, what would you do here? |
| iv1-a1.mp3 | Aoede | Plan the work and hand out the jobs. |
| iv1-q2.mp3 | Charon | Biggest weakness? |
| iv1-a2.mp3 | Aoede | I can't send anything without your yes. |
| iv1-q3.mp3 | Charon | When can you start? |
| iv1-a3.mp3 | Aoede | As soon as you say yes. |
| iv1-q4.mp3 | Charon | You're hired. |
