use super::{serve_inline, validate_file_content};
use crate::config::{MediaConfig, S3AddressingStyle};
use crate::error::MediaError;

const FIXTURE: &[u8] = include_bytes!("../../buzz-core/tests/fixtures/canonical-audio.wav");

fn config() -> MediaConfig {
    MediaConfig {
        s3_endpoint: String::new(),
        s3_access_key: String::new(),
        s3_secret_key: String::new(),
        s3_bucket: String::new(),
        s3_region: "us-east-1".to_string(),
        s3_addressing_style: S3AddressingStyle::Path,
        max_image_bytes: 50 * 1024 * 1024,
        max_gif_bytes: 10 * 1024 * 1024,
        max_video_bytes: 524_288_000,
        max_file_bytes: 104_857_600,
        public_base_url: String::new(),
        upload_records_enabled: false,
        upload_ip_header: None,
        upload_port_header: None,
    }
}

#[test]
fn only_canonical_wav_is_accepted_and_served_as_playable_audio() {
    let before = FIXTURE.to_vec();
    assert_eq!(
        validate_file_content(FIXTURE, &config()).expect("canonical audio"),
        ("audio/wav".to_string(), "wav".to_string())
    );
    assert_eq!(
        before, FIXTURE,
        "validation must not rewrite delivered audio"
    );
    assert!(serve_inline("audio/wav"));
    for mime in ["audio/mpeg", "audio/ogg", "audio/mp4", "audio/x-wav"] {
        assert!(!serve_inline(mime), "unsupported container {mime}");
    }
}

#[test]
fn metadata_and_actual_size_limits_cannot_bypass_audio_validation() {
    let mut tagged = FIXTURE.to_vec();
    tagged.extend_from_slice(b"LIST\x10\x00\x00\x00GPS_LOCATION");
    assert!(matches!(
        validate_file_content(&tagged, &config()),
        Err(MediaError::MetadataForbidden)
    ));
    let mut smaller_cap = config();
    smaller_cap.max_file_bytes = FIXTURE.len() as u64 - 1;
    assert!(matches!(
        validate_file_content(FIXTURE, &smaller_cap),
        Err(MediaError::FileTooLarge { .. })
    ));
    for bytes in [
        b"ID3\x04\x00\x00\x00\x00\x00\x00".as_slice(),
        b"OggS\x00\x02\x00\x00\x00\x00\x00\x00".as_slice(),
    ] {
        assert!(matches!(
            validate_file_content(bytes, &config()),
            Err(MediaError::DisallowedContentType(_))
        ));
    }
}
