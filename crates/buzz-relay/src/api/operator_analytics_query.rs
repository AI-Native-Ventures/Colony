//! Strict query parsing and filter-bound cursors for operator analytics.

use std::collections::BTreeMap;

use buzz_db::operator_analytics::{
    ActivityFamily, OperatorAnalyticsFilter, OperatorListCursor, OperatorListCursorWire,
    OperatorPersonType, OPERATOR_ANALYTICS_PAGE_LIMIT,
};
use buzz_pubsub::operator_sessions::OperatorSessionStore;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::AnalyticsRoute;

#[derive(Debug)]
pub(super) struct ParsedQuery {
    pub(super) filter: OperatorAnalyticsFilter,
    pub(super) filter_digest: [u8; 32],
    pub(super) session_cursor: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ListCursor {
    version: u8,
    kind: String,
    filter_digest: String,
    timestamp: Option<String>,
    tie_breaker: String,
}

pub(super) fn parse_query(
    raw_query: Option<&str>,
    route: AnalyticsRoute,
) -> Result<ParsedQuery, &'static str> {
    if raw_query.is_some_and(|value| value.len() > 4_096) {
        return Err("analytics query is too long");
    }
    let mut values = BTreeMap::new();
    for (key, value) in url::form_urlencoded::parse(raw_query.unwrap_or_default().as_bytes()) {
        let key = key.into_owned();
        if !route.allowed_keys().contains(&key.as_str()) {
            return Err("unknown analytics filter");
        }
        if values.insert(key, value.into_owned()).is_some() {
            return Err("duplicate analytics filter");
        }
    }
    let filter_digest = canonical_filter_digest(&values);
    let community_id = values
        .get("community")
        .map(|value| Uuid::parse_str(value).map_err(|_| "invalid community filter"))
        .transpose()?;
    let start = values
        .get("start")
        .map(|value| parse_timestamp(value).ok_or("invalid start timestamp"))
        .transpose()?;
    let end = values
        .get("end")
        .map(|value| parse_timestamp(value).ok_or("invalid end timestamp"))
        .transpose()?;
    if start.zip(end).is_some_and(|(start, end)| start >= end) {
        return Err("start must precede end");
    }
    let activity_family = values
        .get("family")
        .map(|value| {
            value
                .parse::<ActivityFamily>()
                .map_err(|_| "invalid activity family")
        })
        .transpose()?;
    let person_type = values
        .get("type")
        .map(|value| match value.as_str() {
            "human" => Ok(OperatorPersonType::Human),
            "agent" => Ok(OperatorPersonType::Agent),
            "unknown" => Ok(OperatorPersonType::Unknown),
            _ => Err("invalid person type"),
        })
        .transpose()?;
    let online = values
        .get("online")
        .map(|value| parse_bool(value))
        .transpose()?;
    let include_archived = values
        .get("include_archived")
        .map(|value| parse_bool(value))
        .transpose()?
        .unwrap_or(false);
    if values.get("status").is_some_and(|value| value != "active") {
        return Err("invalid session status");
    }
    let search = values.get("search").cloned();
    if search
        .as_ref()
        .is_some_and(|value| value.is_empty() || value.len() > 128)
    {
        return Err("invalid search filter");
    }
    let limit = values
        .get("limit")
        .map(|value| value.parse::<i64>().map_err(|_| "invalid page limit"))
        .transpose()?
        .unwrap_or(50);
    if !(1..=OPERATOR_ANALYTICS_PAGE_LIMIT).contains(&limit) {
        return Err("page limit must be between 1 and 200");
    }
    let raw_cursor = values.get("cursor").cloned();
    let cursor = match route {
        AnalyticsRoute::People => raw_cursor
            .as_deref()
            .map(|value| decode_list_cursor(value, "people", filter_digest))
            .transpose()?,
        AnalyticsRoute::Communities => raw_cursor
            .as_deref()
            .map(|value| decode_list_cursor(value, "communities", filter_digest))
            .transpose()?,
        AnalyticsRoute::Sessions => {
            if let Some(value) = raw_cursor.as_deref() {
                OperatorSessionStore::validate_cursor(value)
                    .map_err(|_| "invalid session cursor")?;
            }
            None
        }
        _ if raw_cursor.is_some() => return Err("cursor is not supported for this route"),
        _ => None,
    };
    Ok(ParsedQuery {
        filter: OperatorAnalyticsFilter {
            community_id,
            start,
            end,
            activity_family,
            person_type,
            online,
            include_archived,
            search,
            limit,
            cursor,
        },
        filter_digest,
        session_cursor: (route == AnalyticsRoute::Sessions)
            .then_some(raw_cursor)
            .flatten(),
    })
}

fn parse_timestamp(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|value| value.with_timezone(&Utc))
}

fn parse_bool(value: &str) -> Result<bool, &'static str> {
    match value {
        "true" => Ok(true),
        "false" => Ok(false),
        _ => Err("invalid boolean filter"),
    }
}

pub(super) fn decode_pubkey(value: &str) -> Option<[u8; 32]> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return None;
    }
    hex::decode(value).ok()?.try_into().ok()
}

fn canonical_filter_digest(values: &BTreeMap<String, String>) -> [u8; 32] {
    let mut hasher = Sha256::new();
    for (key, value) in values.iter().filter(|(key, _)| key.as_str() != "cursor") {
        hasher.update((key.len() as u64).to_be_bytes());
        hasher.update(key.as_bytes());
        hasher.update((value.len() as u64).to_be_bytes());
        hasher.update(value.as_bytes());
    }
    hasher.finalize().into()
}

pub(super) fn raw_filter_digest(raw_query: Option<&str>) -> [u8; 32] {
    digest(raw_query.unwrap_or_default().as_bytes())
}

pub(super) fn digest(value: &[u8]) -> [u8; 32] {
    Sha256::digest(value).into()
}

pub(super) fn encode_list_cursor(
    kind: &str,
    filter_digest: [u8; 32],
    cursor: Option<OperatorListCursorWire>,
) -> Option<String> {
    let cursor = cursor?;
    let payload = ListCursor {
        version: 1,
        kind: kind.to_owned(),
        filter_digest: hex::encode(filter_digest),
        timestamp: cursor.timestamp.map(|value| value.to_rfc3339()),
        tie_breaker: cursor.tie_breaker,
    };
    serde_json::to_vec(&payload).ok().map(hex::encode)
}

fn decode_list_cursor(
    value: &str,
    expected_kind: &str,
    filter_digest: [u8; 32],
) -> Result<OperatorListCursor, &'static str> {
    let bytes = hex::decode(value).map_err(|_| "invalid analytics cursor")?;
    let cursor: ListCursor =
        serde_json::from_slice(&bytes).map_err(|_| "invalid analytics cursor")?;
    if cursor.version != 1
        || cursor.kind != expected_kind
        || cursor.filter_digest != hex::encode(filter_digest)
    {
        return Err("analytics cursor does not match filters");
    }
    match expected_kind {
        "people" => Ok(OperatorListCursor::People {
            first_seen: cursor
                .timestamp
                .as_deref()
                .map(|value| parse_timestamp(value).ok_or("invalid analytics cursor"))
                .transpose()?,
            pubkey: decode_pubkey(&cursor.tie_breaker)
                .ok_or("invalid analytics cursor")?
                .to_vec(),
        }),
        "communities" => Ok(OperatorListCursor::Communities {
            created_at: cursor
                .timestamp
                .as_deref()
                .and_then(parse_timestamp)
                .ok_or("invalid analytics cursor")?,
            community_id: Uuid::parse_str(&cursor.tie_breaker)
                .map_err(|_| "invalid analytics cursor")?,
        }),
        _ => Err("invalid analytics cursor"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unknown_duplicate_and_unbounded_filters() {
        assert!(parse_query(Some("wat=1"), AnalyticsRoute::Overview).is_err());
        assert!(parse_query(Some("limit=10&limit=11"), AnalyticsRoute::People).is_err());
        assert!(parse_query(Some("limit=201"), AnalyticsRoute::People).is_err());
        assert!(parse_query(Some("start=nope"), AnalyticsRoute::Activity).is_err());
        assert!(parse_query(
            Some("start=2026-08-11T12%3A00%3A00Z&end=2026-08-10T12%3A00%3A00Z"),
            AnalyticsRoute::Activity,
        )
        .is_err());
    }

    #[test]
    fn list_cursor_is_filter_bound() {
        let first =
            parse_query(Some("limit=50"), AnalyticsRoute::People).expect("valid first filter");
        let encoded = encode_list_cursor(
            "people",
            first.filter_digest,
            Some(OperatorListCursorWire {
                timestamp: Some(Utc::now()),
                tie_breaker: "11".repeat(32),
            }),
        )
        .expect("cursor");
        assert!(decode_list_cursor(&encoded, "people", first.filter_digest).is_ok());
        let changed =
            parse_query(Some("limit=51"), AnalyticsRoute::People).expect("valid changed filter");
        assert!(decode_list_cursor(&encoded, "people", changed.filter_digest).is_err());
    }

    #[test]
    fn malformed_person_and_session_cursors_are_rejected() {
        assert!(decode_pubkey(&"AA".repeat(32)).is_none());
        assert!(decode_pubkey("abcd").is_none());
        assert!(parse_query(Some("cursor=bad"), AnalyticsRoute::Sessions).is_err());
    }

    #[test]
    fn canonical_digest_changes_with_filters() {
        let first = parse_query(Some("limit=50"), AnalyticsRoute::People).expect("valid filter");
        let changed = parse_query(Some("limit=51"), AnalyticsRoute::People).expect("valid filter");
        assert_ne!(first.filter_digest, changed.filter_digest);
    }
}
