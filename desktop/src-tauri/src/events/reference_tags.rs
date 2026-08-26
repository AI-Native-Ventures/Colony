//! Validated reference tags a stream message may carry alongside its body:
//! Block instance/manifest/data references, and typed addressable-entity
//! references (`["a", coordinate, "", <kind>]`, the standard NIP-01
//! addressable-event reference marked with a 4th-element kind) for Block and
//! Cohort mentions. A closed, explicitly validated set — callers cannot add
//! an arbitrary tag through this channel.

use nostr::Tag;
use uuid::Uuid;

fn valid_block_handle(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.bytes().enumerate().all(|(index, byte)| match byte {
            b'a'..=b'z' => true,
            b'0'..=b'9' | b'-' => index > 0,
            _ => false,
        })
}

/// Mirrors buzz-core's generic `validate_id` charset (see
/// `crates/buzz-core/src/company.rs`): a Cohort's `d` tag is not a slug like
/// a Block handle, just a bounded identifier.
fn valid_cohort_id(value: &str) -> bool {
    const MAX_ID_LEN: usize = 128;
    if value.is_empty() || value.len() > MAX_ID_LEN {
        return false;
    }
    let mut bytes = value.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    (first.is_ascii_lowercase() || first.is_ascii_digit())
        && bytes.all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(byte, b'.' | b'_' | b':' | b'-')
        })
}

fn check_lower_hex_64(value: &str, field: &str) -> Result<(), String> {
    if value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err(format!("{field} must be 64 lowercase hex characters"))
    }
}

pub(super) fn append_block_reference_tags(
    reference_tags: &[Vec<String>],
    tags: &mut Vec<Tag>,
) -> Result<(), String> {
    for reference in reference_tags {
        let valid = match reference.as_slice() {
            [kind, coordinate, relay, marker] if kind == "a" => {
                let parts = coordinate.split(':').collect::<Vec<_>>();
                relay.is_empty()
                    && parts.len() == 3
                    && match marker.as_str() {
                        "block" => {
                            parts[0] == "30178"
                                && check_lower_hex_64(parts[1], "Block publisher").is_ok()
                                && valid_block_handle(parts[2])
                        }
                        "cohort" => {
                            parts[0] == "30201"
                                && check_lower_hex_64(parts[1], "Cohort relay pubkey").is_ok()
                                && valid_cohort_id(parts[2])
                        }
                        _ => false,
                    }
            }
            [kind, version, handle, manifest, instance] if kind == "block" => {
                version == "1"
                    && valid_block_handle(handle)
                    && check_lower_hex_64(manifest, "Block manifest").is_ok()
                    && Uuid::parse_str(instance).is_ok()
            }
            [kind, data] if kind == "block-data" => {
                if data.len() > 32 * 1024 {
                    false
                } else if let Ok(value) = serde_json::from_str::<serde_json::Value>(data) {
                    buzz_core_pkg::block::canonical_json(&value).is_ok_and(|value| value == *data)
                } else {
                    false
                }
            }
            [kind, source, mime, sha256, size] if kind == "block-data-ref" => {
                url::Url::parse(source).is_ok_and(|url| {
                    url.scheme() == "https"
                        && url.host_str().is_some()
                        && mime == "application/json"
                        && check_lower_hex_64(sha256, "Block data hash").is_ok()
                        && size
                            .parse::<u64>()
                            .is_ok_and(|size| (1..=2 * 1024 * 1024).contains(&size))
                })
            }
            [kind, version, state] if kind == "block-attention" => {
                version == "1" && state == "required"
            }
            [kind, manifest, relay, marker] if kind == "e" => {
                check_lower_hex_64(manifest, "Block manifest").is_ok()
                    && relay.is_empty()
                    && marker == "block"
            }
            _ => false,
        };
        if !valid {
            return Err(format!("invalid Block reference tag: {reference:?}"));
        }
        tags.push(Tag::parse(reference.clone()).map_err(|e| format!("invalid Block tag: {e}"))?);
    }
    Ok(())
}
