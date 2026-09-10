# Canonical audio attachments

## Acceptance gate

Normal MP3, WAV, M4A and Ogg inputs reach the existing attachment upload and audio player. The delivered file is explicitly named `.wav` and typed `audio/wav`; downloading returns those exact delivered bytes. Local conversion removes all container metadata, attached artwork, chapters and extra streams. No partial output is uploaded on size, conversion or cancellation failure.

Use a minimal canonical 16-bit PCM, stereo, 48 kHz WAV. This has broad native/browser playback support and a strict 44-byte header with no metadata channels. The output cap is 50 MiB, matching native downloads. Longer inputs that exceed it fail clearly; there is no duration truncation.

## Work

1. Add a zero-I/O shared `buzz-core` WAV builder/validator, bounded at 50 MiB, rejecting unknown chunks, invalid headers, trailing data and partial sample frames.
2. Reuse native ffmpeg discovery, isolated environment and bounded cancellation runner. Decode recognized audio through an explicitly selected demuxer to raw PCM in a private temporary directory, then construct the canonical header. Existing canonical input is validated and may retain its bytes. Integrate only audio branches in picked-file, temp-file and raw-byte upload paths.
3. Relay generic upload accepts only WAV passing the shared validator. Other recognized audio remains denied. Record duration from validated PCM size and serve canonical WAV with the normal protected media headers.
4. Add shared malformed/metadata/limit fixtures and native CI round trips from all four input containers. Keep image/video/SVG pipelines unchanged.

No local Rust compilation, tests, builds or full CI. Source formatting and static checks are permitted; native/relay tests run in GitHub CI.

## Evidence

Existing dependencies: ffmpeg, tempfile, buzz-core; no new dependency.

- https://ffmpeg.org/ffmpeg-formats.html#Raw-PCM-muxers — raw PCM muxers do not store metadata or timestamps.
- https://ffmpeg.org/ffmpeg.html — `-map_metadata -1`, `-map_chapters -1`, and output `-fs`; output may exceed the requested byte threshold, so actual bytes must be checked and rejected without uploading.

## Implementation checkpoint

Native temp-file, picker and raw-byte upload paths now recognize these audio containers and prepare the canonical artifact before signing/hash/upload. File reads for recognized audio are capped; conversion uses a private temp directory, explicit demuxer, no network protocols, disabled MP4 external data references, one worker thread, a 120-second deadline and cancellation. Actual output size is checked after ffmpeg's sentinel limit; no truncated artifact is sent. The existing exact-byte buffered relay upload path stores only WAV that passes the shared validator and records duration from actual PCM bytes.

CI coverage includes shared fixed-header/sample limits, metadata/trailing-chunk rejection, byte-preserving canonical WAV, native metadata-bearing MP3/WAV/M4A/Ogg round trips, decode/playback of delivered WAV and a tiny forced conversion cap. Relay tests accept canonical WAV, preserve bytes, reject metadata/noncanonical audio and respect configured limits. These Rust/FFmpeg tests have not been run locally. Only scoped Rust formatting and static fixture-header verification ran locally.

The input format may change to WAV and grow in size. The delivered filename and MIME identify the WAV artifact. Direct relay/CLI upload of compressed audio still requires prior conversion to canonical WAV; this phase proves the normal native attachment flow through CI, not a new server transcoder or mobile conversion workflow.
