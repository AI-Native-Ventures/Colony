# User video voice

Generated 2026-10-12 with the Gemini API (`GEMINI_API_KEY`, free tier).

- Model `gemini-3.8-flash-tts`, voice `Aoede`, the explainers' and launch film's voice.
- One read per video, the words only (Gemini TTS reads style instructions aloud):
  the lines of `src/user/startHereBeats.ts` and of `src/user/canCantClaims.ts`
  (its title first), one paragraph per line.
- Each read converted from 24 kHz PCM and normalised to -16 LUFS
  (`loudnorm=I=-16:TP=-1.5:LRA=11`, 48 kHz), then cut into one file per line by
  `scripts/cut-read.mjs`: the pauses (silence under -40 dB, at least 0.35 s)
  that best match where each line should end by its share of the words. Cut and
  spoken seconds are in `src/user/voiceCuts.ts`.
- Every cut transcribed with `scripts/transcribe-gemini.mjs` and compared with
  its line, word for word: all 41 matched in at least one of gemini-2.5-flash,
  gemini-2.5-flash-lite, gemini-3.8-flash, gemini-3.7-flash and
  gemini-3.6-flash (the free tier allows 20 checks per model per day).
- Three lines were reworded and read again on their own after two models
  heard them otherwise ("writes" as "rates", "Claude Code" as "Claude Codex",
  "Tell Scout" as "Tell Scott"): `sh-business-3`, `sh-power-3` and
  `sh-priority-1` come from that second read (pauses of 0.3 s or more).
- The check also caught a line whose inner full stop moved a cut; it is now
  two lines (`sh-job-3`, `sh-job-4`).

Re-make: `node scripts/tts-gemini.mjs <read.txt> <read.pcm>`, convert and
normalise with ffmpeg, then `node scripts/cut-read.mjs <read.wav> <lines.json> public/user/voice`.
