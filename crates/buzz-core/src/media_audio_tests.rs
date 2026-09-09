use super::*;

const FIXTURE: &[u8] = include_bytes!("../tests/fixtures/canonical-audio.wav");

#[test]
fn actual_wav_samples_have_exact_duration_and_rebuild_byte_for_byte() {
    let audio = validate_canonical_wav(FIXTURE).expect("canonical fixture");
    assert_eq!(audio.sample_frames, 4800);
    assert!((audio.duration_secs - 0.1).abs() < f64::EPSILON);
    assert_eq!(
        canonical_wav_from_pcm(&FIXTURE[44..]).expect("PCM"),
        FIXTURE
    );
}

#[test]
fn every_header_field_is_strict_and_samples_cannot_be_truncated() {
    for offset in [0, 4, 8, 12, 16, 20, 22, 24, 28, 32, 34, 36, 40] {
        let mut invalid = FIXTURE.to_vec();
        invalid[offset] ^= 0xff;
        assert!(validate_canonical_wav(&invalid).is_err(), "offset {offset}");
    }
    for length in 0..48 {
        assert!(validate_canonical_wav(&FIXTURE[..length]).is_err());
    }
    assert!(canonical_wav_from_pcm(&[]).is_err());
    assert!(canonical_wav_from_pcm(&[1, 2, 3]).is_err());
}

#[test]
fn metadata_chunks_duplicate_data_and_trailing_payloads_are_rejected() {
    for name in [b"LIST", b"bext", b"iXML", b"id3 ", b"JUNK", b"data"] {
        let mut bytes = FIXTURE[..36].to_vec();
        bytes.extend_from_slice(name);
        bytes.extend_from_slice(&8u32.to_le_bytes());
        bytes.extend_from_slice(b"GPS:-26");
        bytes.push(0);
        bytes.extend_from_slice(&FIXTURE[36..]);
        let riff_size = (bytes.len() - 8) as u32;
        bytes[4..8].copy_from_slice(&riff_size.to_le_bytes());
        assert!(validate_canonical_wav(&bytes).is_err(), "chunk {name:?}");
    }
    let mut trailing = FIXTURE.to_vec();
    trailing.extend_from_slice(b"ID3-location");
    let riff_size = (trailing.len() - 8) as u32;
    trailing[4..8].copy_from_slice(&riff_size.to_le_bytes());
    assert!(validate_canonical_wav(&trailing).is_err());
}

#[test]
fn declared_giant_data_and_outputs_beyond_the_download_budget_are_rejected() {
    let mut lying = FIXTURE.to_vec();
    lying[40..44].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(validate_canonical_wav(&lying).is_err());
    let too_large = vec![0; MAX_CANONICAL_AUDIO_BYTES];
    assert!(canonical_wav_from_pcm(&too_large).is_err());
}
