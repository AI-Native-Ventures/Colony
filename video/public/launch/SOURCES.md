# Launch film audio sources

All files generated on 2026-10-10 through OpenRouter on the AI Native Ventures
account. Total spend for voice and music trials: about $0.10.

## Voice: `vo-*.mp3`

- Model: `google/gemini-3.8-flash-tts`, voice `Aoede` (chosen by the owner from
  three samples: Gemini Aoede, ElevenLabs v4 Brian, ElevenLabs v4 Sarah).
- One read of the full script, returned as 24 kHz PCM, converted with ffmpeg,
  loudness normalised to -16 LUFS (`loudnorm=I=-16:TP=-1.5:LRA=11`), then cut
  at the pauses into the seven lines below (start and end seconds in the read):

| File | Read | Words |
|---|---|---|
| vo-l1.mp3 | 0.18 to 3.28 | Running a business means doing every job yourself. |
| vo-l2.mp3 | 3.43 to 4.65 | What if you had a team? |
| vo-l3.mp3 | 4.84 to 6.38 | Introducing Colony. |
| vo-l4a.mp3 | 6.46 to 7.47 | Paste your website, |
| vo-l4b.mp3 | 7.47 to 11.64 | and meet your AI employees: software that does office work for you. |
| vo-l5.mp3 | 11.74 to 14.69 | They do the work. Nothing goes out without your yes. |
| vo-l6.mp3 | 14.84 to 19.50 | Colony. Your business. Your AI employees. Early access is open. |

Every cut was transcribed with `google/gemini-2.5-flash` and matched its words,
except `vo-l2.mp3`, which transcribed as "had", "own" and "have got" across
four runs; the full read transcribes as "had". Check it by ear.

Style instructions must not be sent with the text: Gemini TTS reads them aloud.

## Music: `music-b.mp3`

- Model: `bytedance-seed/seed-audio-1-0` on `/api/v1/audio/speech` (no voice),
  30.04 s stereo, loudness normalised to -16 LUFS. Chosen by the owner as
  "draft B" over draft A.
- Prompt:

> Instrumental music, 30 seconds, for a warm and confident tech launch film. No vocals.
> Opens sparse and curious: plucked strings and soft marimba with a gentle ticking pulse, slowly building.
> At 7 seconds the full groove arrives: warm bass, soft punchy drums with claps, shimmering pads and a bright, hopeful melody.
> Stays uplifting and steady, cinematic but modern, 105 BPM.
> Ends on a warm, satisfying final chord at 28 seconds that rings out softly to 30 seconds. No abrupt cut, no crash.

- Measured: quiet intro, a clear lift at 7 s, steady to 27 s, decays from 28 s.
- Google Lyria 3 (clip and pro) was tried first and refused with a Google
  free-tier quota error on the provider side.

## Licence

Generated audio, owned by AI Native Ventures under the providers' output terms
as offered through OpenRouter. No third-party samples were used. Check each
provider's current terms before paid advertising.

## 90 second film voice: `f90-*.mp3` (2026-10-11)

- Model `google/gemini-3.8-flash-tts`, voice `Aoede`: one 48.2 s read of the
  full script (in `video/src/launch/wide/film90.ts`, one line per `LINES`
  entry), normalised to -16 LUFS and cut at measured pauses; the cut points
  are the `cut` values in `film90.ts`.
- `f90-l04.mp3` ("Introducing: Colony.") is a separate take: in the full
  read the name transcribed as "Holiday" or "Collie" on its own, while the
  colon take transcribed as "Colony" in two of two runs.
- Every pause-separated piece was transcribed with `google/gemini-2.5-flash`
  and matched the script, except that "Sandton" comes back as "Santa" or
  "Santon" (check by ear).
- `vo-blue-1.mp3` and `vo-blue-2.mp3` are the proof beat's separate read.
- `sfx-pop.mp3` and `sfx-whoosh.mp3` are synthesised with ffmpeg
  (`aevalsrc` sine chirp; pink `anoisesrc` band-passed); no third-party audio.
- `sfx-scribble.mp3` (4 s, the amber email writing itself) and
  `sfx-shimmer.mp3` (2.4 s, the green website repaint) are synthesised with
  ffmpeg on 2026-10-11: band-passed white `anoisesrc` with two `tremolo`
  stages for the scribble; a rising `aevalsrc` sine pair over high-passed pink
  noise for the shimmer; both loudness normalised to -22 LUFS. No third-party
  audio.

## 90 second film music (milestone A stand-in)

The "meet the team" preview (frames 747 to 1625) plays `music-b.mp3` from
film 25.4 s so its lift at 7 s lands on "20 found" (32.4 s). Two Seed Audio
90 s tries on 2026-10-11 came back (piano and strings with the lift at 69 s;
synth with the groove at 16 s and the peak at 66 s) and neither has draft B's
plucks and marimba. The 90 s music is decided in milestone C.
- `sfx-click.mp3` (0.22 s, the Approve press) is synthesised with ffmpeg
  `aevalsrc` (2.3 kHz and 4.6 kHz ticks over a 150 Hz thump, fast decay),
  normalised to -20 LUFS. No third-party audio.

## Second read for the longer film: `f130-*.mp3` (2026-10-11)

- Model `gemini-3.8-flash-tts`, voice `Aoede`, called directly on the Gemini
  API with the owner's key (OpenRouter was out of credits). One 39.8 s read
  of the new opening, how-it-works, Scout, sales and close lines (script in
  `video/src/launch/wide/film90.ts`, the `f130` lines), normalised to -16 LUFS
  and cut at measured pauses; the cut points are the `cut` values there. The
  sales line is cut at its comma so "and calls to book a meeting" lands on the
  call.
- Every piece was transcribed with `gemini-2.5-flash` and matched the script
  ("colony dot global" comes back as colony.global).
- `sfx-ring.mp3` (0.82 s ringback, 440 and 480 Hz) is synthesised with ffmpeg
  `aevalsrc`; no third-party audio.
- Music: Lyria 3 on the same key refused (free tier limit 0), so draft B is
  re-cut into four overlapping cues as a stand-in.

## Definition re-read: `f150-n06.mp3` (2026-10-11)

- The owner asked for AI employees to be defined as AI agents. Same model and
  voice (`gemini-3.8-flash-tts`, `Aoede`), read together with the line before
  and after it so the intonation matches, normalised to -16 LUFS and cut at
  the measured pauses (3.95 s to 8.85 s of that read).
- Transcribed with `gemini-2.5-flash`: "AI employees are AI agents that do
  office work for you like people on your team".

## Bright Plumbing's posts and website (2026-10-11)

- Drawn in code, no photos, after plumbing Instagram posts and plumbing
  websites the owner pointed to on Pinterest: navy and royal blue, an orange
  call to action, tall capitals, a phone number and a booking button.
- Fonts: Poppins, Anton and Caveat from Google Fonts (SIL Open Font License),
  loaded with `@remotion/google-fonts`.

## Explainer voices: `public/explainers/ep05-*.mp3` (2026-10-11)

- Episode 5 (Rise Bakery, "Makes your posts"): one read of the eight lines on
  `gemini-3.8-flash-tts`, voice `Aoede`, through the Gemini API; 25.9 s,
  normalised to -16 LUFS, cut at the measured pauses (cut points are the
  `cut` values in `video/src/explainers/ep05.ts`), 40 ms fade in, 60 ms out.
- Checked by transcribing the eight clips joined with a second of silence
  between them (`gemini-2.5-flash`): every line in order; the market line
  checked on its own reads "New sourdough and the Saturday market."
- Episode 1 (Mahlangu Builders, "Meet Scout"): one 32.4 s read, cut at the
  measured pauses (cut points in `video/src/explainers/ep01.ts`); the eight
  clips joined read back in order (`gemini-2.5-flash-lite`).
- Episode 2 (Studio Nala, "Your team in a minute"): one 31.7 s read, cut at
  the measured pauses (cut points in `video/src/explainers/ep02.ts`); the
  eight clips joined read back in order (`gemini-2.5-flash-lite`).
- Episode 3 (Bright Plumbing, "Finds customers"): one 28.9 s read, cut at
  the measured pauses (cut points in `video/src/explainers/ep03.ts`); the
  nine clips joined read back in order (`gemini-2.5-flash-lite`).
- Episode 4 (Golden Hour Photography, "Sells for you"): one 22.4 s read, cut
  at the measured pauses (cut points in `video/src/explainers/ep04.ts`; "When
  one replies," and "it calls and books the meeting." cut apart at their
  0.16 s pause); the eight clips joined read back in order
  (`gemini-2.5-flash-lite`).
