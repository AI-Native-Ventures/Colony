use std::collections::HashSet;

use buzz_core_pkg::discovery_worker::{
    deterministic_business_observation_id, DiscoveryBusinessObservationInput,
    DiscoveryBusinessStatus, DiscoveryProvider,
};
use serde::Deserialize;
use sha2::{Digest as _, Sha256};
use url::Url;

const EXCLUDED_BUSINESS_HOSTS: &[&str] = &[
    "bing.com",
    "bloomberg.com",
    "brabys.com",
    "crunchbase.com",
    "facebook.com",
    "foursquare.com",
    "glassdoor.com",
    "google.com",
    "indeed.com",
    "instagram.com",
    "linkedin.com",
    "opentable.com",
    "pinterest.com",
    "restaurantguru.com",
    "snupit.co.za",
    "tiktok.com",
    "tripadvisor.com",
    "trustpilot.com",
    "twitter.com",
    "wikipedia.org",
    "x.com",
    "yelp.com",
    "yellowpages.co.za",
    "youtube.com",
    "zoominfo.com",
];

const GENERIC_TITLE_SEGMENTS: &[&str] = &[
    "about",
    "about us",
    "contact",
    "contact us",
    "home",
    "homepage",
    "our services",
    "services",
    "welcome",
];

/// Provider-edge web result reduced to fields shared by Brave and Exa.
pub(super) struct WebBusinessCandidate {
    pub(super) title: Option<String>,
    pub(super) url: Option<String>,
    pub(super) description: Option<String>,
    pub(super) image_url: Option<String>,
    pub(super) profile_name: Option<String>,
}

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

/// Normalize public web search results into the same strict business contract
/// used by Google Maps observations. Search context is retained only as a
/// geography hint; arbitrary provider fields never cross this boundary.
pub(super) fn normalize_web_businesses(
    provider: DiscoveryProvider,
    candidates: Vec<WebBusinessCandidate>,
    search: &buzz_core_pkg::discovery::DiscoveryBusinessSearchSpec,
) -> Vec<DiscoveryBusinessObservationInput> {
    let mut provider_ids = HashSet::new();
    candidates
        .into_iter()
        .filter_map(|candidate| normalize_web_business(provider, candidate, search))
        .filter(|observation| provider_ids.insert(observation.provider_record_id.clone()))
        .collect()
}

fn normalize_web_business(
    provider: DiscoveryProvider,
    candidate: WebBusinessCandidate,
    search: &buzz_core_pkg::discovery::DiscoveryBusinessSearchSpec,
) -> Option<DiscoveryBusinessObservationInput> {
    let website = canonical_business_url(candidate.url.as_deref()?)?;
    let provider_record_id = format!("url:{}", hex_digest(website.as_bytes()));
    let name = candidate
        .profile_name
        .and_then(|value| required_text(Some(value), 256))
        .or_else(|| title_business_name(candidate.title.as_deref(), &search.query))
        .or_else(|| domain_business_name(&website))?;
    let source_url = Some(website.clone());
    let observation = DiscoveryBusinessObservationInput {
        observation_id: deterministic_business_observation_id(provider, &provider_record_id),
        provider,
        provider_record_id,
        place_id: None,
        google_id: None,
        name,
        website: Some(website),
        phone: None,
        full_address: None,
        city: optional_text(Some(search.location.clone()), 128),
        state: None,
        postal_code: None,
        country: None,
        country_code: search.region.clone(),
        latitude_micros: None,
        longitude_micros: None,
        category: optional_text(Some(search.query.clone()), 128),
        subtypes: Vec::new(),
        rating_hundredths: None,
        reviews_count: None,
        business_status: None,
        verified: None,
        source_url,
        image_url: candidate
            .image_url
            .as_deref()
            .and_then(canonical_public_url),
        description: optional_text(candidate.description, 2_048),
    };
    observation.validate().ok()?;
    Some(observation)
}

fn canonical_business_url(value: &str) -> Option<String> {
    let canonical = canonical_public_url(value)?;
    let host = Url::parse(&canonical)
        .ok()?
        .host_str()?
        .to_ascii_lowercase();
    (!host_is_excluded(&host)).then_some(canonical)
}

fn canonical_public_url(value: &str) -> Option<String> {
    let mut url = Url::parse(value.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    let host = url.host_str()?.to_ascii_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host).to_owned();
    if host.is_empty() {
        return None;
    }
    url.set_host(Some(&host)).ok()?;
    if (url.scheme() == "https" && url.port() == Some(443))
        || (url.scheme() == "http" && url.port() == Some(80))
    {
        url.set_port(None).ok()?;
    }
    url.set_fragment(None);
    let mut query = url
        .query_pairs()
        .into_owned()
        .filter(|(name, _)| !is_tracking_parameter(name))
        .collect::<Vec<_>>();
    query.sort();
    url.set_query(None);
    if !query.is_empty() {
        url.query_pairs_mut().extend_pairs(query);
    }
    if url.path() != "/" && url.path().ends_with('/') {
        let path = url.path().trim_end_matches('/').to_owned();
        url.set_path(&path);
    }
    let mut canonical = url.to_string();
    if url.path() == "/" && url.query().is_none() {
        canonical.pop();
    }
    (canonical.len() <= 2_048).then_some(canonical)
}

fn is_tracking_parameter(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.starts_with("utm_") || matches!(name.as_str(), "fbclid" | "gclid")
}

fn host_is_excluded(host: &str) -> bool {
    EXCLUDED_BUSINESS_HOSTS
        .iter()
        .any(|excluded| host == *excluded || host.ends_with(&format!(".{excluded}")))
}

fn title_business_name(title: Option<&str>, query: &str) -> Option<String> {
    let candidates = title?
        .split(['|', '–', '—'])
        .flat_map(|segment| segment.split(" - "))
        .filter_map(|segment| required_text(Some(segment.to_owned()), 256))
        .filter(|segment| {
            !GENERIC_TITLE_SEGMENTS
                .iter()
                .any(|generic| segment.eq_ignore_ascii_case(generic))
        })
        .collect::<Vec<_>>();
    candidates
        .iter()
        .find(|candidate| !candidate.eq_ignore_ascii_case(query))
        .cloned()
        .or_else(|| candidates.into_iter().next())
}

fn domain_business_name(website: &str) -> Option<String> {
    let host = Url::parse(website).ok()?.host_str()?.to_owned();
    let label = host.split('.').next()?;
    let name = label
        .split(['-', '_'])
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut characters = part.chars();
            match characters.next() {
                Some(first) => first
                    .to_uppercase()
                    .chain(characters.flat_map(char::to_lowercase))
                    .collect::<String>(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    required_text(Some(name), 256)
}

fn hex_digest(value: &[u8]) -> String {
    Sha256::digest(value)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
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

    #[test]
    fn web_normalization_canonicalizes_and_excludes_non_business_hosts() {
        let search = buzz_core_pkg::discovery::DiscoveryBusinessSearchSpec {
            query: "dentist".to_owned(),
            location: "Sandton".to_owned(),
            limit: 3,
            language: "en".to_owned(),
            region: Some("ZA".to_owned()),
        };
        let normalized = normalize_web_businesses(
            DiscoveryProvider::BraveSearch,
            vec![
                WebBusinessCandidate {
                    title: Some("Home - Acme Dental | Dentist".to_owned()),
                    url: Some(
                        "HTTPS://WWW.Acme.Example:443/about/?utm_source=test&b=2&a=1#team"
                            .to_owned(),
                    ),
                    description: Some("Public snippet".to_owned()),
                    image_url: Some("https://cdn.example/logo.png#fragment".to_owned()),
                    profile_name: None,
                },
                WebBusinessCandidate {
                    title: Some("Acme directory profile".to_owned()),
                    url: Some("https://za.linkedin.com/company/acme".to_owned()),
                    description: None,
                    image_url: None,
                    profile_name: None,
                },
            ],
            &search,
        );
        assert_eq!(normalized.len(), 1);
        let business = &normalized[0];
        assert_eq!(business.name, "Acme Dental");
        assert_eq!(
            business.website.as_deref(),
            Some("https://acme.example/about?a=1&b=2")
        );
        assert_eq!(business.source_url, business.website);
        assert_eq!(business.city.as_deref(), Some("Sandton"));
        assert_eq!(business.country_code.as_deref(), Some("ZA"));
        assert_eq!(business.category.as_deref(), Some("dentist"));
        assert_eq!(
            business.image_url.as_deref(),
            Some("https://cdn.example/logo.png")
        );
        assert!(business.provider_record_id.starts_with("url:"));
        assert_eq!(business.provider_record_id.len(), 68);
        assert_eq!(business.validate(), Ok(()));
    }

    #[test]
    fn web_normalization_deduplicates_canonical_urls_and_falls_back_to_domain_name() {
        let search = buzz_core_pkg::discovery::DiscoveryBusinessSearchSpec {
            query: "accountant".to_owned(),
            location: "Cape Town".to_owned(),
            limit: 3,
            language: "en".to_owned(),
            region: Some("ZA".to_owned()),
        };
        let normalized = normalize_web_businesses(
            DiscoveryProvider::ExaSearch,
            vec![
                WebBusinessCandidate {
                    title: Some("Home".to_owned()),
                    url: Some("https://north-star.example/".to_owned()),
                    description: None,
                    image_url: None,
                    profile_name: None,
                },
                WebBusinessCandidate {
                    title: Some("Duplicate".to_owned()),
                    url: Some("https://www.north-star.example/".to_owned()),
                    description: None,
                    image_url: None,
                    profile_name: None,
                },
                WebBusinessCandidate {
                    title: Some("Unsafe".to_owned()),
                    url: Some("file:///tmp/unsafe".to_owned()),
                    description: None,
                    image_url: None,
                    profile_name: None,
                },
            ],
            &search,
        );
        assert_eq!(normalized.len(), 1);
        assert_eq!(normalized[0].name, "North Star");
        assert_eq!(
            normalized[0].website.as_deref(),
            Some("https://north-star.example")
        );
    }
}
