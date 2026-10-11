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
