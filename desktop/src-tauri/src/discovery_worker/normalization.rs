use std::collections::HashSet;

use buzz_core_pkg::discovery_worker::{
    deterministic_business_observation_id, DiscoveryBusinessObservationInput,
    DiscoveryBusinessStatus,
};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum RawSubtypes {
    Text(String),
    List(Vec<String>),
}

/// Tolerant provider-edge shape. Unknown fields are deliberately ignored and
/// only this allowlist can cross into Colony's normalized contract.
#[derive(Debug, Deserialize)]
pub(super) struct RawOutscraperPlace {
    name: Option<String>,
    place_id: Option<String>,
    google_id: Option<String>,
    cid: Option<String>,
    phone: Option<String>,
    site: Option<String>,
    website: Option<String>,
    full_address: Option<String>,
    address: Option<String>,
    city: Option<String>,
    state: Option<String>,
    postal_code: Option<String>,
    country: Option<String>,
    country_code: Option<String>,
    latitude: Option<f64>,
    longitude: Option<f64>,
    rating: Option<f64>,
    reviews: Option<u64>,
    #[serde(rename = "type")]
    place_type: Option<String>,
    category: Option<String>,
    subtypes: Option<RawSubtypes>,
    business_status: Option<String>,
    verified: Option<bool>,
    location_link: Option<String>,
    photo: Option<String>,
    logo: Option<String>,
}

pub(super) fn normalize_places(
    values: Vec<serde_json::Value>,
) -> Vec<DiscoveryBusinessObservationInput> {
    let mut provider_ids = HashSet::new();
    values
        .into_iter()
        .filter_map(|value| serde_json::from_value::<RawOutscraperPlace>(value).ok())
        .filter_map(normalize_place)
        .filter(|observation| provider_ids.insert(observation.provider_record_id.clone()))
        .collect()
}

fn normalize_place(raw: RawOutscraperPlace) -> Option<DiscoveryBusinessObservationInput> {
    let name = required_text(raw.name, 256)?;
    let (provider_record_id, place_id, google_id) =
        provider_identity(raw.place_id, raw.google_id, raw.cid)?;
    let category = optional_text(raw.category.or(raw.place_type), 128);
    let observation = DiscoveryBusinessObservationInput {
        observation_id: deterministic_business_observation_id(
            buzz_core_pkg::discovery_worker::DiscoveryProvider::Outscraper,
            &provider_record_id,
        ),
        provider: buzz_core_pkg::discovery_worker::DiscoveryProvider::Outscraper,
        provider_record_id,
        place_id,
        google_id,
        name,
        website: optional_url(raw.website.or(raw.site)),
        phone: optional_text(raw.phone, 64),
        full_address: optional_text(raw.full_address.or(raw.address), 512),
        city: optional_text(raw.city, 128),
        state: optional_text(raw.state, 128),
        postal_code: optional_text(raw.postal_code, 128),
        country: optional_text(raw.country, 128),
        country_code: country_code(raw.country_code),
        latitude_micros: coordinate_micros(raw.latitude, 90.0),
        longitude_micros: coordinate_micros(raw.longitude, 180.0),
        category,
        subtypes: normalize_subtypes(raw.subtypes),
        rating_hundredths: raw.rating.and_then(rating_hundredths),
        reviews_count: raw.reviews.and_then(|value| u32::try_from(value).ok()),
        business_status: raw.business_status.and_then(normalize_status),
        verified: raw.verified,
        source_url: optional_url(raw.location_link),
        image_url: optional_url(raw.photo.or(raw.logo)),
        description: None,
    };
    observation.validate().ok()?;
    Some(observation)
}

fn provider_identity(
    place_id: Option<String>,
    google_id: Option<String>,
    cid: Option<String>,
) -> Option<(String, Option<String>, Option<String>)> {
    let place_id = optional_identifier(place_id);
    let google_id = optional_identifier(google_id);
    let cid = optional_identifier(cid);
    let provider_record_id = if let Some(value) = &place_id {
        format!("place:{value}")
    } else if let Some(value) = &google_id {
        format!("google:{value}")
    } else {
        format!("cid:{}", cid.as_deref()?)
    };
    Some((provider_record_id, place_id, google_id))
}

fn optional_identifier(value: Option<String>) -> Option<String> {
    let value = value?.trim().to_owned();
    (!value.is_empty()
        && value.len() <= 240
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'-' | b'_')))
    .then_some(value)
}

fn required_text(value: Option<String>, max_bytes: usize) -> Option<String> {
    let value = value?.trim().to_owned();
    (!value.is_empty() && value.len() <= max_bytes && !value.chars().any(char::is_control))
        .then_some(value)
}

fn optional_text(value: Option<String>, max_bytes: usize) -> Option<String> {
    required_text(value, max_bytes)
}

fn optional_url(value: Option<String>) -> Option<String> {
    let value = value?.trim().to_owned();
    (value.len() <= 2_048
        && !value.chars().any(char::is_control)
        && (value.starts_with("https://") || value.starts_with("http://")))
    .then_some(value)
}

fn country_code(value: Option<String>) -> Option<String> {
    let value = value?.trim().to_ascii_uppercase();
    (value.len() == 2 && value.bytes().all(|byte| byte.is_ascii_uppercase())).then_some(value)
}

fn coordinate_micros(value: Option<f64>, maximum: f64) -> Option<i32> {
    let value = value?;
    if !value.is_finite() || !(-maximum..=maximum).contains(&value) {
        return None;
    }
    let micros = (value * 1_000_000.0).round();
    if micros < f64::from(i32::MIN) || micros > f64::from(i32::MAX) {
        return None;
    }
    Some(micros as i32)
}

fn rating_hundredths(value: f64) -> Option<u16> {
    if !value.is_finite() || !(0.0..=5.0).contains(&value) {
        return None;
    }
    Some((value * 100.0).round() as u16)
}

fn normalize_subtypes(value: Option<RawSubtypes>) -> Vec<String> {
    let values = match value {
        Some(RawSubtypes::Text(value)) => {
            value.split(',').map(ToOwned::to_owned).collect::<Vec<_>>()
        }
        Some(RawSubtypes::List(values)) => values,
        None => Vec::new(),
    };
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter_map(|value| required_text(Some(value), 128))
        .filter(|value| seen.insert(value.clone()))
        .take(20)
        .collect()
}

fn normalize_status(value: String) -> Option<DiscoveryBusinessStatus> {
    match value.trim().to_ascii_uppercase().as_str() {
        "OPERATIONAL" | "OPEN" => Some(DiscoveryBusinessStatus::Operational),
        "CLOSED_TEMPORARILY" | "TEMPORARILY_CLOSED" => {
            Some(DiscoveryBusinessStatus::TemporarilyClosed)
        }
        "CLOSED_PERMANENTLY" | "PERMANENTLY_CLOSED" => {
            Some(DiscoveryBusinessStatus::PermanentlyClosed)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalization_keeps_only_allowlisted_valid_fields() {
        let values = vec![serde_json::json!({
            "name": " Sandton Dental Studio ",
            "place_id": "ChIJ_test",
            "google_id": "0xabc:0xdef",
            "site": "https://example.test",
            "country_code": "za",
            "latitude": -26.1076,
            "longitude": 28.0567,
            "rating": 4.7,
            "reviews": 52,
            "subtypes": "Dentist, Dental clinic, Dentist",
            "business_status": "OPERATIONAL",
            "photo": "javascript:alert(1)",
            "email_1": "must-not-cross@example.test",
            "unknown_future_field": {"raw": true}
        })];
        let normalized = normalize_places(values);
        assert_eq!(normalized.len(), 1);
        let place = &normalized[0];
        assert_eq!(place.name, "Sandton Dental Studio");
        assert_eq!(place.provider_record_id, "place:ChIJ_test");
        assert_eq!(place.country_code.as_deref(), Some("ZA"));
        assert_eq!(place.rating_hundredths, Some(470));
        assert_eq!(place.subtypes, ["Dentist", "Dental clinic"]);
        assert_eq!(place.image_url, None);
        let serialized = serde_json::to_string(place).expect("serialize normalized place");
        assert!(!serialized.contains("email_1"));
        assert!(!serialized.contains("unknown_future_field"));
    }

    #[test]
    fn normalization_rejects_missing_identity_or_name() {
        assert!(normalize_places(vec![serde_json::json!({"name": "No identity"})]).is_empty());
        assert!(normalize_places(vec![serde_json::json!({"place_id": "ChIJ_test"})]).is_empty());
    }

    #[test]
    fn normalization_deduplicates_provider_records_before_batching() {
        let normalized = normalize_places(vec![
            serde_json::json!({"name": "First", "place_id": "same"}),
            serde_json::json!({"name": "Duplicate", "place_id": "same"}),
        ]);
        assert_eq!(normalized.len(), 1);
        assert_eq!(normalized[0].name, "First");
    }
}
