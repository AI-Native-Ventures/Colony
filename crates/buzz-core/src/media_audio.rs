//! Canonical audio attachments with no container metadata channels.

/// Cap matches the desktop's original-download limit (50 MiB).
pub const MAX_CANONICAL_AUDIO_BYTES: usize = 50 * 1024 * 1024;
/// PCM sample rate used by the canonical attachment format.
pub const AUDIO_SAMPLE_RATE: u32 = 48_000;
/// Stereo signed 16-bit PCM uses four bytes per sample frame.
pub const AUDIO_FRAME_BYTES: usize = 4;
/// Exact canonical RIFF/WAVE header length.
pub const AUDIO_HEADER_BYTES: usize = 44;

/// Validated facts derived from the actual samples rather than supplied tags.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CanonicalAudio {
    /// Duration of the delivered PCM samples in seconds.
    pub duration_secs: f64,
    /// Number of interleaved stereo sample frames.
    pub sample_frames: usize,
}

/// Whether bytes identify a RIFF/WAVE container, including noncanonical WAV.
pub fn looks_like_wav(bytes: &[u8]) -> bool {
    bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WAVE"
}

/// Build metadata-free WAV bytes from decoded, interleaved s16le stereo PCM.
pub fn canonical_wav_from_pcm(pcm: &[u8]) -> Result<Vec<u8>, &'static str> {
    if pcm.is_empty() || !pcm.len().is_multiple_of(AUDIO_FRAME_BYTES) {
        return Err("Audio must contain complete stereo PCM sample frames.");
    }
    if pcm.len() > MAX_CANONICAL_AUDIO_BYTES - AUDIO_HEADER_BYTES {
        return Err(
            "Converted audio exceeds the 50 MiB attachment limit. Choose a shorter recording.",
        );
    }
    let data_size = u32::try_from(pcm.len()).map_err(|_| "Audio is too large.")?;
    let mut bytes = Vec::with_capacity(AUDIO_HEADER_BYTES + pcm.len());
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(data_size + 36).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&AUDIO_SAMPLE_RATE.to_le_bytes());
    bytes.extend_from_slice(&(AUDIO_SAMPLE_RATE * AUDIO_FRAME_BYTES as u32).to_le_bytes());
    bytes.extend_from_slice(&(AUDIO_FRAME_BYTES as u16).to_le_bytes());
    bytes.extend_from_slice(&16u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_size.to_le_bytes());
    bytes.extend_from_slice(pcm);
    Ok(bytes)
}

/// Accept only a single fixed PCM format chunk followed by exact sample data.
///
/// No LIST/INFO, BEXT, iXML, ID3, cover art, optional chunks, duplicate data,
/// extended format payloads or trailing bytes are accepted. PCM samples are
/// data, never interpreted as strings, links, metadata or executable content.
pub fn validate_canonical_wav(bytes: &[u8]) -> Result<CanonicalAudio, &'static str> {
    if bytes.len() < AUDIO_HEADER_BYTES + AUDIO_FRAME_BYTES
        || bytes.len() > MAX_CANONICAL_AUDIO_BYTES
        || !looks_like_wav(bytes)
    {
        return Err("Invalid or oversized canonical audio.");
    }
    let sample_bytes = bytes.len() - AUDIO_HEADER_BYTES;
    if !sample_bytes.is_multiple_of(AUDIO_FRAME_BYTES)
        || bytes[4..8] != ((bytes.len() - 8) as u32).to_le_bytes()
        || &bytes[12..16] != b"fmt "
        || bytes[16..20] != 16u32.to_le_bytes()
        || bytes[20..22] != 1u16.to_le_bytes()
        || bytes[22..24] != 2u16.to_le_bytes()
        || bytes[24..28] != AUDIO_SAMPLE_RATE.to_le_bytes()
        || bytes[28..32] != (AUDIO_SAMPLE_RATE * AUDIO_FRAME_BYTES as u32).to_le_bytes()
        || bytes[32..34] != (AUDIO_FRAME_BYTES as u16).to_le_bytes()
        || bytes[34..36] != 16u16.to_le_bytes()
        || &bytes[36..40] != b"data"
        || bytes[40..44] != (sample_bytes as u32).to_le_bytes()
    {
        return Err("Audio contains metadata or a noncanonical WAV structure.");
    }
    let sample_frames = sample_bytes / AUDIO_FRAME_BYTES;
    Ok(CanonicalAudio {
        duration_secs: sample_frames as f64 / f64::from(AUDIO_SAMPLE_RATE),
        sample_frames,
    })
}

#[cfg(test)]
#[path = "media_audio_tests.rs"]
mod tests;
