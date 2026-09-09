//! Local audio normalization to the relay's metadata-free PCM/WAV contract.

use std::path::Path;
use std::time::Duration;

use buzz_core_pkg::media_audio::{
    canonical_wav_from_pcm, validate_canonical_wav, AUDIO_HEADER_BYTES, MAX_CANONICAL_AUDIO_BYTES,
};
use tokio_util::sync::CancellationToken;

use super::media::sanitize_filename;
use super::media_transcode::{ffmpeg_command, find_ffmpeg, run_ffmpeg_with_cancellation};

const CONVERSION_LIMIT: &str =
    "Converted audio exceeds the 50 MiB attachment limit. Choose a shorter recording; no partial audio was uploaded.";

/// Select a demuxer from actual audio bytes; an M4A hint is only useful with BMFF bytes.
pub(super) fn audio_input_format(bytes: &[u8], filename: Option<&str>) -> Option<&'static str> {
    match infer::get(bytes).map(|kind| kind.mime_type()) {
        Some("audio/mpeg") => Some("mp3"),
        Some("audio/wav" | "audio/x-wav") => Some("wav"),
        Some("audio/ogg" | "audio/opus") => Some("ogg"),
        Some("audio/mp4" | "audio/m4a" | "audio/x-m4a") => Some("mov"),
        _ if bytes.len() >= 12
            && &bytes[4..8] == b"ftyp"
            && filename.is_some_and(|name| name.to_ascii_lowercase().ends_with(".m4a")) =>
        {
            Some("mov")
        }
        _ => None,
    }
}

/// Label the delivered artifact by its actual canonical container, never the input extension.
pub(super) fn canonical_audio_filename(filename: Option<&str>) -> String {
    let safe = sanitize_filename(filename.unwrap_or("audio"));
    let stem = Path::new(&safe)
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("audio");
    format!("{stem}.wav")
}

/// Decode only the first audio stream and construct an exact, metadata-free WAV.
///
/// Input and output live in an OS-private temporary directory and are removed on
/// every return. FFmpeg receives no application credentials, no shell, no network
/// protocol, and an explicit demuxer. Its raw PCM muxer cannot retain container
/// metadata; the shared validator checks the final artifact before any upload.
pub(super) fn prepare_audio_bytes(
    bytes: Vec<u8>,
    format: &'static str,
    cancellation: Option<&CancellationToken>,
) -> Result<Vec<u8>, String> {
    prepare_audio_with_limit(
        bytes,
        format,
        cancellation,
        MAX_CANONICAL_AUDIO_BYTES - AUDIO_HEADER_BYTES,
    )
}

fn prepare_audio_with_limit(
    bytes: Vec<u8>,
    format: &'static str,
    cancellation: Option<&CancellationToken>,
    max_samples: usize,
) -> Result<Vec<u8>, String> {
    if cancellation.is_some_and(CancellationToken::is_cancelled) {
        return Err("upload cancelled".to_string());
    }
    if bytes.len() > MAX_CANONICAL_AUDIO_BYTES {
        return Err("Audio source exceeds the 50 MiB attachment limit.".to_string());
    }
    if validate_canonical_wav(&bytes).is_ok() {
        if bytes.len() - AUDIO_HEADER_BYTES > max_samples {
            return Err(CONVERSION_LIMIT.to_string());
        }
        return Ok(bytes);
    }
    let directory = tempfile::Builder::new()
        .prefix("colony-audio-")
        .tempdir()
        .map_err(|_| "Could not prepare audio conversion.".to_string())?;
    let input = directory.path().join("source");
    let output = directory.path().join("samples.pcm");
    std::fs::write(&input, bytes).map_err(|_| "Could not prepare audio conversion.".to_string())?;
    let ffmpeg = find_ffmpeg().map_err(|_| {
        "Audio conversion requires ffmpeg. Install ffmpeg or attach a canonical WAV recording."
            .to_string()
    })?;
    let mut command = ffmpeg_command(&ffmpeg);
    command.args([
        "-y",
        "-nostdin",
        "-loglevel",
        "fatal",
        "-max_alloc",
        "33554432",
        "-protocol_whitelist",
        "file,pipe",
        "-threads",
        "1",
        "-f",
        format,
    ]);
    if format == "mov" {
        // MP4 data references must never cause reads of another local file.
        command.args(["-enable_drefs", "0", "-use_absolute_path", "0"]);
    }
    command
        .arg("-i")
        .arg(&input)
        .args([
            "-map",
            "0:a:0",
            "-map_metadata",
            "-1",
            "-map_chapters",
            "-1",
            "-vn",
            "-sn",
            "-dn",
            "-threads",
            "1",
            "-c:a",
            "pcm_s16le",
            "-ac",
            "2",
            "-ar",
            "48000",
            "-f",
            "s16le",
            "-fs",
        ])
        .arg((max_samples + 1).to_string())
        .arg(&output)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let result =
        run_ffmpeg_with_cancellation(&mut command, Duration::from_secs(120), cancellation)?;
    if cancellation.is_some_and(CancellationToken::is_cancelled) {
        return Err("upload cancelled".to_string());
    }
    let length = std::fs::metadata(&output)
        .map(|meta| meta.len())
        .unwrap_or(0);
    // -fs can stop successfully with a partial output. The sentinel threshold
    // is larger than the accepted payload, so any capped output is rejected.
    if length > max_samples as u64 {
        return Err(CONVERSION_LIMIT.to_string());
    }
    if !result.status.success() || length == 0 {
        return Err(
            "This audio could not be converted. No partial audio was uploaded.".to_string(),
        );
    }
    let pcm = std::fs::read(&output).map_err(|_| "Could not read converted audio.".to_string())?;
    let wav = canonical_wav_from_pcm(&pcm).map_err(str::to_string)?;
    validate_canonical_wav(&wav).map_err(str::to_string)?;
    Ok(wav)
}

#[cfg(test)]
#[path = "media_audio_tests.rs"]
mod tests;
