//! Composer-only local dictation. Never signs or publishes transcript events.
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::State;

use crate::app_state::AppState;

use crate::huddle::models;

const MAX_SAMPLES: usize = 16_000 * 60;
static DECODING: AtomicBool = AtomicBool::new(false);

struct DecodeGuard;
impl Drop for DecodeGuard {
    fn drop(&mut self) {
        DECODING.store(false, Ordering::Release);
    }
}

/// Ensure the existing on-device English speech model is ready before capture.
#[tauri::command]
pub fn prepare_dictation(state: State<'_, AppState>) -> Result<(), String> {
    let manager = models::global_model_manager()
        .ok_or("Dictation is unavailable. Restart Colony and try again.")?;
    if manager.is_stt_ready() {
        return Ok(());
    }
    manager.start_stt_download(state.http_client.clone());
    Err("Preparing on-device dictation for first use. Please try again shortly.".into())
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
pub async fn transcribe_dictation(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let samples = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => parse_audio(bytes)?,
        _ => return Err("Expected raw dictation audio.".into()),
    };
    let model_dir =
        models::stt_model_dir().ok_or("Dictation is still preparing. Please try again shortly.")?;
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
        let mut cfg = sherpa_onnx::OfflineRecognizerConfig::default();
        cfg.model_config.nemo_ctc.model = Some(
            model_dir
                .join("model.int8.onnx")
                .to_string_lossy()
                .into_owned(),
        );
        cfg.model_config.tokens = Some(model_dir.join("tokens.txt").to_string_lossy().into_owned());
        cfg.model_config.num_threads = 1;
        cfg.model_config.debug = false;
        let recognizer = sherpa_onnx::OfflineRecognizer::create(&cfg)
            .ok_or("Could not load dictation. Restart Colony and try again.")?;
        let stream = recognizer.create_stream();
        stream.accept_waveform(16_000, &samples);
        recognizer.decode(&stream);
        Ok(stream
            .get_result()
            .map(|result| result.text.trim().to_string())
            .unwrap_or_default())
    })
    .await
    .map_err(|e| format!("Dictation failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

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
