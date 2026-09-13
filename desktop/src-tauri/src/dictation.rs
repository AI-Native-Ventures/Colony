//! Composer-only local dictation. Never signs or publishes transcript events.
use std::sync::atomic::{AtomicBool, Ordering};

use std::time::{Duration, Instant};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

const MAX_SAMPLES: usize = 16_000 * 60;
static DECODING: AtomicBool = AtomicBool::new(false);

struct DecodeGuard;
impl Drop for DecodeGuard {
    fn drop(&mut self) {
        DECODING.store(false, Ordering::Release);
    }
}

/// Verify the installer-supplied English speech model before capture.
#[tauri::command]
pub async fn prepare_dictation(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::dictation_model::verified_path(&app).map(|_| ())
    })
    .await
    .map_err(|e| format!("Dictation preparation failed: {e}"))?
}

fn parse_audio(bytes: &[u8]) -> Result<Vec<f32>, String> {
    if bytes.is_empty() || !bytes.len().is_multiple_of(4) || bytes.len() > MAX_SAMPLES * 4 {
        return Err(
            "Dictation audio must be 16 kHz mono PCM, between 1 sample and 60 seconds.".into(),
        );
    }
    bytes
        .chunks_exact(4)
        .map(|b| {
            let value = f32::from_le_bytes([b[0], b[1], b[2], b[3]]);
            if value.is_finite() && (-1.0..=1.0).contains(&value) {
                Ok(value)
            } else {
                Err("Invalid dictation audio sample.".into())
            }
        })
        .collect()
}

/// Decode a bounded 16 kHz mono f32-LE recording locally and return draft text.
#[tauri::command]
pub async fn transcribe_dictation(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    let samples = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => parse_audio(bytes)?,
        _ => return Err("Expected raw dictation audio.".into()),
    };
    DECODING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "Another recording is still being transcribed. Please try again shortly.")?;
    let guard = DecodeGuard;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        // Match the huddle's minimum voiced duration; silence must not hallucinate text.
        let mut vad = earshot::Detector::new(earshot::DefaultPredictor::new());
        let voiced = samples
            .chunks_exact(256)
            .filter(|frame| vad.predict_f32(frame) > 0.5)
            .count();
        if voiced < 12 {
            return Ok(String::new());
        }
        let model_path = crate::dictation_model::verified_path(&app)?;
        decode(&model_path, &samples)
    })
    .await
    .map_err(|e| format!("Dictation failed: {e}"))?
}

fn decode(model_path: &std::path::Path, samples: &[f32]) -> Result<String, String> {
    let mut context_params = WhisperContextParameters::default();
    context_params.use_gpu(false);
    // Context and state are scoped to this recording: no model RAM retained idle.
    let context = WhisperContext::new_with_params(model_path, context_params)
        .map_err(|e| format!("Could not load offline dictation: {e}"))?;
    let mut state = context.create_state().map_err(|e| e.to_string())?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_n_threads(2);
    params.set_language(Some("en"));
    params.set_no_context(true);
    params.set_no_timestamps(true);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    let deadline = Instant::now() + Duration::from_secs(60);
    params.set_abort_callback_safe(move || Instant::now() >= deadline);
    state
        .full(params, samples)
        .map_err(|e| format!("Dictation failed: {e}"))?;
    let mut text = String::new();
    for segment in state.as_iter() {
        text.push_str(segment.to_str().map_err(|e| e.to_string())?);
    }
    Ok(text.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires staged model; explicitly run by hosted dictation proof"]
    fn bundled_whisper_transcribes_speech() -> Result<(), String> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources/dictation/ggml-base.en-q5_1.bin");
        let samples = parse_audio(include_bytes!("../tests/fixtures/dictation.f32"))?;
        let text = decode(&path, &samples)?.to_lowercase();
        assert!(
            text.contains("best of times"),
            "Missing expected phrase: {text}"
        );
        assert!(
            text.contains("worst of times"),
            "Missing expected phrase: {text}"
        );
        Ok(())
    }

    #[test]
    fn rejects_empty_misaligned_and_oversized_audio() {
        assert!(parse_audio(&[]).is_err());
        assert!(parse_audio(&[0; 3]).is_err());
        assert!(parse_audio(&vec![0; MAX_SAMPLES * 4 + 4]).is_err());
    }

    #[test]
    fn rejects_nonfinite_and_out_of_range_samples() {
        for sample in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY, 1.1, -1.1] {
            assert!(parse_audio(&sample.to_le_bytes()).is_err());
        }
    }

    #[test]
    fn accepts_bounded_pcm() {
        assert_eq!(parse_audio(&0.5_f32.to_le_bytes()), Ok(vec![0.5]));
        assert_eq!(
            parse_audio(&vec![0; MAX_SAMPLES * 4]).map(|v| v.len()),
            Ok(MAX_SAMPLES)
        );
    }
}
