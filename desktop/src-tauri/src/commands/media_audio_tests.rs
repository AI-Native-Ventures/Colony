use super::*;

const FIXTURE: &[u8] =
    include_bytes!("../../../../crates/buzz-core/tests/fixtures/canonical-audio.wav");

#[test]
fn canonical_audio_preserves_delivered_bytes_and_reports_real_filename() {
    let delivered = prepare_audio_bytes(FIXTURE.to_vec(), "wav", None).expect("canonical audio");
    assert_eq!(delivered, FIXTURE);
    assert_eq!(
        canonical_audio_filename(Some("../client/voice.mp3")),
        "voice.wav"
    );
    assert_eq!(canonical_audio_filename(None), "audio.wav");
    assert_eq!(
        super::super::media::detect_and_validate_mime(&delivered).as_deref(),
        Ok("audio/wav")
    );
}

#[test]
fn detection_uses_real_bytes_and_cancellation_prevents_conversion() {
    assert_eq!(audio_input_format(FIXTURE, None), Some("wav"));
    assert_eq!(
        audio_input_format(b"not audio", Some("misleading.mp3")),
        None
    );
    assert_eq!(
        audio_input_format(b"#EXTM3U\nfile:///secret", Some("playlist.m4a")),
        None
    );
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert_eq!(
        prepare_audio_bytes(FIXTURE.to_vec(), "wav", Some(&cancel)).as_deref(),
        Err("upload cancelled")
    );
}

#[test]
fn mp3_wav_m4a_and_ogg_metadata_are_removed_before_upload() {
    let ffmpeg = match find_ffmpeg() {
        Ok(ffmpeg) => ffmpeg,
        Err(error) if std::env::var("COLONY_REQUIRE_POSTER_PROOF").ok().as_deref() != Some("1") => {
            eprintln!("Audio round-trip needs ffmpeg: {error}");
            return;
        }
        Err(error) => {
            panic!("COLONY_REQUIRE_POSTER_PROOF requires FFmpeg for the audio proof: {error}")
        }
    };
    let mut needs_conversion = FIXTURE.to_vec();
    needs_conversion[24..28].copy_from_slice(&24_000u32.to_le_bytes());
    needs_conversion[28..32].copy_from_slice(&96_000u32.to_le_bytes());
    assert!(
        matches!(prepare_audio_with_limit(needs_conversion, "wav", None, 128), Err(message) if message == CONVERSION_LIMIT)
    );
    let directory = tempfile::tempdir().expect("fixture directory");
    let seed = directory.path().join("seed.wav");
    std::fs::write(&seed, FIXTURE).expect("write fixture");
    for (extension, encoder) in [
        ("mp3", "libmp3lame"),
        ("wav", "pcm_s16le"),
        ("m4a", "aac"),
        ("ogg", "libvorbis"),
    ] {
        let input = directory.path().join(format!("source.{extension}"));
        let generated = ffmpeg_command(&ffmpeg)
            .args(["-y", "-nostdin", "-loglevel", "fatal"])
            .arg("-i")
            .arg(&seed)
            .args([
                "-c:a",
                encoder,
                "-metadata",
                "comment=PRIVATE_GPS_LOCATION",
                "-metadata",
                "location=+27.000+028.000/",
                "-metadata",
                "title=PRIVATE_TITLE",
            ])
            .arg(&input)
            .output()
            .expect("generate audio fixture");
        assert!(generated.status.success(), "generate {extension}");
        let source = std::fs::read(&input).expect("fixture bytes");
        assert!(
            source
                .windows(b"PRIVATE".len())
                .any(|window| window == b"PRIVATE"),
            "fixture {extension} must actually carry metadata"
        );
        let format = audio_input_format(&source, input.to_str()).expect("recognized audio");
        let delivered = prepare_audio_bytes(source.clone(), format, None).expect("convert audio");
        assert_ne!(
            delivered, source,
            "{extension} must remove container metadata"
        );
        let audio = validate_canonical_wav(&delivered).expect("shared strict validator");
        assert!(audio.duration_secs >= 0.08 && audio.duration_secs <= 0.2);
        assert!(!delivered
            .windows(b"PRIVATE".len())
            .any(|window| window == b"PRIVATE"));
        let output = directory.path().join(format!("delivered-{extension}.wav"));
        std::fs::write(&output, &delivered).expect("write delivered artifact");
        let decoded = ffmpeg_command(&ffmpeg)
            .args(["-nostdin", "-loglevel", "fatal"])
            .arg("-i")
            .arg(&output)
            .args(["-f", "null", "-"])
            .output()
            .expect("decode delivered audio");
        assert!(decoded.status.success(), "delivered {extension} must play");
    }
}
