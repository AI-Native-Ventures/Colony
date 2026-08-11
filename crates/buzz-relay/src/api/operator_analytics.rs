//! Read-only deployment operator analytics API.
//!
//! The adapter keeps authority, filter validation, source freshness, and
//! privacy-safe accountability at the HTTP boundary. Database queries expose
//! metadata-only read models; Redis supplies deployment-wide live leases.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

use axum::{
    extract::{Path, RawQuery, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use buzz_core::CommunityId;
use buzz_db::operator_analytics::{
    operator_definitions, ActivityFamily, AnalyticsFreshness, AnalyticsSourceFreshness,
    FreshnessStatus, OperatorAccessOutcome, OperatorAnalyticsFilter,
    OPERATOR_ANALYTICS_DEFINITIONS_VERSION,
};
use buzz_pubsub::operator_sessions::{
    OperatorSessionLease, OperatorSessionScope, OperatorSessionSnapshot,
};
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::state::AppState;

use super::operator_auth::{
    operator_is_allowed, verify_operator_request, OPERATOR_ANALYTICS_REPLAY_SCOPE,
};

#[path = "operator_analytics_query.rs"]
mod query;
use query::{
    decode_pubkey, digest, encode_list_cursor, parse_query, raw_filter_digest, ParsedQuery,
};

const OVERVIEW_PATH: &str = "/operator/analytics/overview";
const COMMUNITIES_PATH: &str = "/operator/analytics/communities";
const PEOPLE_PATH: &str = "/operator/analytics/people";
const PERSON_ROUTE: &str = "/operator/analytics/people/{pubkey}";
const ACTIVITY_PATH: &str = "/operator/analytics/activity";
const SESSIONS_PATH: &str = "/operator/analytics/sessions";
const DEFINITIONS_PATH: &str = "/operator/analytics/definitions";
const HISTORICAL_FRESH_SECS: i64 = 90;

type HandlerResult = Result<Response, Response>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AnalyticsRoute {
    Overview,
    Communities,
    People,
    Person,
    Activity,
    Sessions,
    Definitions,
}

impl AnalyticsRoute {
    const fn audit_path(self) -> &'static str {
        match self {
            Self::Overview => OVERVIEW_PATH,
            Self::Communities => COMMUNITIES_PATH,
            Self::People => PEOPLE_PATH,
            Self::Person => PERSON_ROUTE,
            Self::Activity => ACTIVITY_PATH,
            Self::Sessions => SESSIONS_PATH,
            Self::Definitions => DEFINITIONS_PATH,
        }
    }

    const fn allowed_keys(self) -> &'static [&'static str] {
        match self {
            Self::Overview => &["community", "start", "end", "family"],
            Self::Communities => &[
                "community",
                "start",
                "end",
                "family",
                "include_archived",
                "cursor",
                "limit",
            ],
            Self::People => &[
                "community",
                "start",
                "end",
                "family",
                "type",
                "online",
                "search",
                "cursor",
                "limit",
            ],
            Self::Person => &["community", "start", "end"],
            Self::Activity => &["community", "start", "end", "family"],
            Self::Sessions => &["community", "status", "cursor", "limit"],
            Self::Definitions => &[],
        }
    }
}

struct RequestAudit {
    request_id: Uuid,
    operator_pubkey: [u8; 32],
    route: AnalyticsRoute,
    filter_digest: [u8; 32],
    target_digest: Option<[u8; 32]>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
struct SessionWire {
    session_id: String,
    connection_id: String,
    pubkey: String,
    community_id: String,
    started_at: DateTime<Utc>,
    last_seen_at: DateTime<Utc>,
    pod_id: String,
    network_cidr: Option<String>,
    client_label: Option<String>,
}

/// Deployment overview and source-health cards.
pub async fn overview(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    RawQuery(raw_query): RawQuery,
) -> HandlerResult {
    let mut audit = authenticate(
        &state,
        &headers,
        OVERVIEW_PATH,
        raw_query.as_deref(),
        AnalyticsRoute::Overview,
        None,
    )
    .await?;
    let parsed = parse_or_record(&state, &audit, raw_query.as_deref()).await?;
    audit.filter_digest = parsed.filter_digest;
    let as_of = Utc::now();
    let mut data = match state.db.operator_overview(&parsed.filter).await {
        Ok(value) => value,
        Err(error) => return Err(source_failure(&state, &audit, error).await),
    };
    let historical = match historical_freshness(&state, &parsed.filter, as_of).await {
        Ok(value) => value,
        Err(error) => return Err(source_failure(&state, &audit, error).await),
    };
    let (live, warnings, outcome) = match live_snapshot(&state, &parsed.filter).await {
        Ok(snapshot) => {
            data.live.online_people = to_i64(snapshot.counts.distinct_pubkeys);
            data.live.authenticated_sessions = to_i64(snapshot.counts.authenticated_sessions);
            data.live.open_connections = to_i64(snapshot.counts.raw_connections);
            overlay_community_rows(&mut data.communities, &snapshot.rows);
            (
                live_fresh(as_of),
                Vec::new(),
                OperatorAccessOutcome::Success,
            )
        }
        Err(error) => {
            tracing::warn!(%error, "operator analytics live overview unavailable");
            (
                live_unavailable(),
                vec!["Deployment-wide live sessions are unavailable.".to_owned()],
                OperatorAccessOutcome::SourceError,
            )
        }
    };
    record(&state, &audit, outcome).await?;
    Ok(envelope_response(
        StatusCode::OK,
        json!(data),
        historical,
        live,
        warnings,
        as_of,
        audit.request_id,
    ))
}

/// Community fleet metrics.
pub async fn communities(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    RawQuery(raw_query): RawQuery,
) -> HandlerResult {
    let mut audit = authenticate(
        &state,
        &headers,
        COMMUNITIES_PATH,
        raw_query.as_deref(),
        AnalyticsRoute::Communities,
        None,
    )
    .await?;
    let parsed = parse_or_record(&state, &audit, raw_query.as_deref()).await?;
    audit.filter_digest = parsed.filter_digest;
    let as_of = Utc::now();
    let mut page = match state.db.operator_communities(&parsed.filter).await {
        Ok(value) => value,
        Err(error) => return Err(source_failure(&state, &audit, error).await),
    };
    let historical = match historical_freshness(&state, &parsed.filter, as_of).await {
        Ok(value) => value,
        Err(error) => return Err(source_failure(&state, &audit, error).await),
    };
    let (live, warnings, outcome) = match live_snapshot(&state, &parsed.filter).await {
        Ok(snapshot) => {
            overlay_community_rows(&mut page.rows, &snapshot.rows);
            (
                live_fresh(as_of),
                Vec::new(),
                OperatorAccessOutcome::Success,
            )
        }
        Err(error) => {
            tracing::warn!(%error, "operator analytics live community overlay unavailable");
            (
                live_unavailable(),
                vec!["Online community counts are unavailable.".to_owned()],
                OperatorAccessOutcome::SourceError,
            )
        }
    };
    let next_cursor =
        encode_list_cursor("communities", parsed.filter_digest, page.next_cursor.take());
    let data = json!({ "rows": page.rows, "next_cursor": next_cursor });
    record(&state, &audit, outcome).await?;
    Ok(envelope_response(
        StatusCode::OK,
        data,
        historical,
        live,
        warnings,
        as_of,
        audit.request_id,
    ))
}

/// Bounded metadata-only people directory.
pub async fn people(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    RawQuery(raw_query): RawQuery,
) -> HandlerResult {
    let mut audit = authenticate(
        &state,
        &headers,
        PEOPLE_PATH,
        raw_query.as_deref(),
        AnalyticsRoute::People,
        None,
    )
    .await?;
    let parsed = parse_or_record(&state, &audit, raw_query.as_deref()).await?;
    audit.filter_digest = parsed.filter_digest;
    let as_of = Utc::now();
    let mut page = match state.db.operator_people(&parsed.filter).await {
        Ok(value) => value,
        Err(error) => return Err(source_failure(&state, &audit, error).await),
    };
    let historical = match historical_freshness(&state, &parsed.filter, as_of).await {
        Ok(value) => value,
        Err(error) => return Err(source_failure(&state, &audit, error).await),
    };
    let (data, live, warnings, outcome, status) = match live_snapshot(&state, &parsed.filter).await
    {
        Ok(snapshot) => {
            let session_counts = sessions_by_pubkey(&snapshot.rows);
            let mut rows = page
                .rows
                .into_iter()
                .filter_map(|mut row| {
                    let count = session_counts.get(&row.pubkey).copied().unwrap_or(0);
                    row.online = count > 0;
                    if parsed
                        .filter
                        .online
                        .is_some_and(|expected| expected != row.online)
                    {
                        return None;
                    }
                    let mut value = serde_json::to_value(row).ok()?;
                    value["session_count"] = json!(count);
                    Some(value)
                })
                .collect::<Vec<_>>();
            rows.truncate(parsed.filter.limit as usize);
            let cursor =
                encode_list_cursor("people", parsed.filter_digest, page.next_cursor.take());
            (
                json!({ "rows": rows, "next_cursor": cursor }),
                live_fresh(as_of),
                Vec::new(),
                OperatorAccessOutcome::Success,
                StatusCode::OK,
            )
        }
        Err(error) => {
            tracing::warn!(%error, "operator analytics live people overlay unavailable");
            let rows = if parsed.filter.online.is_some() {
                Vec::new()
            } else {
                page.rows
                    .into_iter()
                    .filter_map(|row| {
                        let mut value = serde_json::to_value(row).ok()?;
                        value["session_count"] = json!(0);
                        Some(value)
                    })
                    .collect()
            };
            (
                json!({ "rows": rows, "next_cursor": Value::Null }),
                live_unavailable(),
                vec!["Online people and session counts are unavailable.".to_owned()],
                OperatorAccessOutcome::SourceError,
                if parsed.filter.online.is_some() {
                    StatusCode::SERVICE_UNAVAILABLE
                } else {
                    StatusCode::OK
                },
            )
        }
    };
    record(&state, &audit, outcome).await?;
    Ok(envelope_response(
        status,
        data,
        historical,
        live,
        warnings,
        as_of,
        audit.request_id,
    ))
}

/// Metadata-only person drill-down with current sessions.
pub async fn person(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(pubkey): Path<String>,
    RawQuery(raw_query): RawQuery,
) -> HandlerResult {
    let path = format!("{PEOPLE_PATH}/{pubkey}");
    let target_digest = digest(pubkey.as_bytes());
    let mut audit = authenticate(
        &state,
        &headers,
        &path,
        raw_query.as_deref(),
        AnalyticsRoute::Person,
        Some(target_digest),
    )
    .await?;
    let parsed = parse_or_record(&state, &audit, raw_query.as_deref()).await?;
    audit.filter_digest = parsed.filter_digest;
    let pubkey_bytes = match decode_pubkey(&pubkey) {
        Some(value) => value,
        None => {
            return Err(recorded_error(
                &state,
                &audit,
                OperatorAccessOutcome::InvalidFilter,
                StatusCode::BAD_REQUEST,
                "invalid person identifier",
            )
            .await)
        }
    };
    let as_of = Utc::now();
    let detail = match state
        .db
        .operator_person(
            parsed.filter.community_id,
            &pubkey_bytes,
            parsed.filter.start,
            parsed.filter.end,
        )
        .await
    {
        Ok(Some(value)) => value,
        Ok(None) => {
            record(&state, &audit, OperatorAccessOutcome::Success).await?;
            return Err(response(
                StatusCode::NOT_FOUND,
                json!({ "error": "person not found" }),
                Some(audit.request_id),
            ));
        }
        Err(error) => return Err(source_failure(&state, &audit, error).await),
    };
    let historical = match historical_freshness(&state, &parsed.filter, as_of).await {
        Ok(value) => value,
        Err(error) => return Err(source_failure(&state, &audit, error).await),
    };
    let (sessions, live, warnings, outcome) = match live_snapshot(&state, &parsed.filter).await {
        Ok(snapshot) => (
            snapshot
                .rows
                .iter()
                .filter(|row| row.pubkey == pubkey_bytes)
                .map(session_wire)
                .collect::<Vec<_>>(),
            live_fresh(as_of),
            Vec::new(),
            OperatorAccessOutcome::Success,
        ),
        Err(error) => {
            tracing::warn!(%error, "operator analytics person sessions unavailable");
            (
                Vec::new(),
                live_unavailable(),
                vec!["Current sessions are unavailable.".to_owned()],
                OperatorAccessOutcome::SourceError,
            )
        }
    };
    let mut data = serde_json::to_value(detail).unwrap_or_else(|_| json!({}));
    data["sessions"] = json!(sessions);
    record(&state, &audit, outcome).await?;
    Ok(envelope_response(
        StatusCode::OK,
        data,
        historical,
        live,
        warnings,
        as_of,
        audit.request_id,
    ))
}

/// Daily meaningful-activity trends and family totals.
pub async fn activity(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    RawQuery(raw_query): RawQuery,
) -> HandlerResult {
    let mut audit = authenticate(
        &state,
        &headers,
        ACTIVITY_PATH,
        raw_query.as_deref(),
        AnalyticsRoute::Activity,
        None,
    )
    .await?;
    let parsed = parse_or_record(&state, &audit, raw_query.as_deref()).await?;
    audit.filter_digest = parsed.filter_digest;
    let as_of = Utc::now();
    let data = match state.db.operator_activity(&parsed.filter).await {
        Ok(value) => value,
        Err(error) => return Err(source_failure(&state, &audit, error).await),
    };
    let historical = match historical_freshness(&state, &parsed.filter, as_of).await {
        Ok(value) => value,
        Err(error) => return Err(source_failure(&state, &audit, error).await),
    };
    record(&state, &audit, OperatorAccessOutcome::Success).await?;
    Ok(envelope_response(
        StatusCode::OK,
        json!(data),
        historical,
        live_not_used(),
        Vec::new(),
        as_of,
        audit.request_id,
    ))
}

/// Active authenticated connection leases from shared Redis.
pub async fn sessions(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    RawQuery(raw_query): RawQuery,
) -> HandlerResult {
    let mut audit = authenticate(
        &state,
        &headers,
        SESSIONS_PATH,
        raw_query.as_deref(),
        AnalyticsRoute::Sessions,
        None,
    )
    .await?;
    let parsed = parse_or_record(&state, &audit, raw_query.as_deref()).await?;
    audit.filter_digest = parsed.filter_digest;
    let as_of = Utc::now();
    let scope = session_scope(&parsed.filter);
    let result = state
        .operator_sessions
        .list(
            scope,
            parsed.session_cursor.as_deref(),
            parsed.filter.limit as usize,
        )
        .await;
    let counts = state.operator_sessions.counts(scope).await;
    match (result, counts) {
        (Ok(page), Ok(counts)) => {
            let rows = page.rows.iter().map(session_wire).collect::<Vec<_>>();
            let data = json!({
                "rows": rows,
                "online_people": counts.distinct_pubkeys,
                "authenticated_sessions": counts.authenticated_sessions,
                "open_connections": counts.raw_connections,
                "next_cursor": page.next_cursor,
            });
            record(&state, &audit, OperatorAccessOutcome::Success).await?;
            Ok(envelope_response(
                StatusCode::OK,
                data,
                historical_not_used(),
                live_fresh(as_of),
                Vec::new(),
                as_of,
                audit.request_id,
            ))
        }
        (page, counts) => {
            tracing::warn!(page_error = ?page.err(), counts_error = ?counts.err(), "operator analytics sessions unavailable");
            record(&state, &audit, OperatorAccessOutcome::SourceError).await?;
            Ok(envelope_response(
                StatusCode::SERVICE_UNAVAILABLE,
                json!({
                    "rows": [],
                    "online_people": 0,
                    "authenticated_sessions": 0,
                    "open_connections": 0,
                    "next_cursor": Value::Null,
                }),
                historical_not_used(),
                live_unavailable(),
                vec!["Deployment-wide live sessions are unavailable.".to_owned()],
                as_of,
                audit.request_id,
            ))
        }
    }
}

/// Static activity, metric, source, and privacy definitions.
pub async fn definitions(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    RawQuery(raw_query): RawQuery,
) -> HandlerResult {
    let mut audit = authenticate(
        &state,
        &headers,
        DEFINITIONS_PATH,
        raw_query.as_deref(),
        AnalyticsRoute::Definitions,
        None,
    )
    .await?;
    let parsed = parse_or_record(&state, &audit, raw_query.as_deref()).await?;
    audit.filter_digest = parsed.filter_digest;
    let as_of = Utc::now();
    record(&state, &audit, OperatorAccessOutcome::Success).await?;
    Ok(envelope_response(
        StatusCode::OK,
        definitions_wire(),
        static_fresh(as_of),
        live_not_used(),
        Vec::new(),
        as_of,
        audit.request_id,
    ))
}

async fn authenticate(
    state: &Arc<AppState>,
    headers: &HeaderMap,
    exact_path: &str,
    raw_query: Option<&str>,
    route: AnalyticsRoute,
    target_digest: Option<[u8; 32]>,
) -> Result<RequestAudit, Response> {
    let pubkey = verify_operator_request(
        state,
        headers,
        "GET",
        exact_path,
        raw_query,
        None,
        OPERATOR_ANALYTICS_REPLAY_SCOPE,
    )
    .await
    .map_err(IntoResponse::into_response)?;
    let audit = RequestAudit {
        request_id: Uuid::new_v4(),
        operator_pubkey: pubkey.to_bytes(),
        route,
        filter_digest: raw_filter_digest(raw_query),
        target_digest,
    };
    if !operator_is_allowed(state, &pubkey) {
        record(state, &audit, OperatorAccessOutcome::Forbidden).await?;
        return Err(response(
            StatusCode::FORBIDDEN,
            json!({ "error": "actor not authorized: not a relay operator" }),
            Some(audit.request_id),
        ));
    }
    Ok(audit)
}

async fn parse_or_record(
    state: &Arc<AppState>,
    audit: &RequestAudit,
    raw_query: Option<&str>,
) -> Result<ParsedQuery, Response> {
    match parse_query(raw_query, audit.route) {
        Ok(parsed) => Ok(parsed),
        Err(message) => Err(recorded_error(
            state,
            audit,
            OperatorAccessOutcome::InvalidFilter,
            StatusCode::BAD_REQUEST,
            message,
        )
        .await),
    }
}

async fn historical_freshness(
    state: &AppState,
    filter: &OperatorAnalyticsFilter,
    as_of: DateTime<Utc>,
) -> Result<AnalyticsSourceFreshness, buzz_db::DbError> {
    let freshness = state
        .db
        .operator_activity_freshness(filter.community_id)
        .await?;
    let lag_seconds = freshness
        .updated_at
        .map(|value| as_of.signed_duration_since(value).num_seconds().max(0));
    let status = match lag_seconds {
        Some(lag) if lag <= HISTORICAL_FRESH_SECS => FreshnessStatus::Fresh,
        _ => FreshnessStatus::Stale,
    };
    Ok(AnalyticsSourceFreshness {
        status,
        watermark: freshness.watermark,
        observed_at: freshness.updated_at,
        lag_seconds,
    })
}

async fn live_snapshot(
    state: &AppState,
    filter: &OperatorAnalyticsFilter,
) -> Result<OperatorSessionSnapshot, buzz_pubsub::PubSubError> {
    state
        .operator_sessions
        .snapshot(session_scope(filter))
        .await
}

fn session_scope(filter: &OperatorAnalyticsFilter) -> OperatorSessionScope {
    filter
        .community_id
        .map_or_else(OperatorSessionScope::all, |id| {
            OperatorSessionScope::community(CommunityId::from_uuid(id))
        })
}

fn sessions_by_pubkey(rows: &[OperatorSessionLease]) -> HashMap<String, usize> {
    let mut counts = HashMap::new();
    for row in rows {
        *counts.entry(hex::encode(row.pubkey)).or_insert(0) += 1;
    }
    counts
}

fn overlay_community_rows(
    communities: &mut [buzz_db::operator_analytics::OperatorCommunityRow],
    sessions: &[OperatorSessionLease],
) {
    let mut online: HashMap<Uuid, HashSet<[u8; 32]>> = HashMap::new();
    for session in sessions {
        online
            .entry(*session.community_id.as_uuid())
            .or_default()
            .insert(session.pubkey);
    }
    for community in communities {
        community.online_people = online
            .get(&community.community_id)
            .map_or(0, |pubkeys| pubkeys.len() as i64);
    }
}

fn session_wire(row: &OperatorSessionLease) -> SessionWire {
    SessionWire {
        session_id: row.connection_id.to_string(),
        connection_id: row.connection_id.to_string(),
        pubkey: hex::encode(row.pubkey),
        community_id: row.community_id.to_string(),
        started_at: row.started_at,
        last_seen_at: row.last_seen_at,
        pod_id: row.pod_id.clone(),
        network_cidr: row.network_cidr.clone(),
        client_label: row.client_label.clone(),
    }
}

fn definitions_wire() -> Value {
    let definitions = operator_definitions();
    let mut kinds: BTreeMap<ActivityFamily, Vec<u32>> = BTreeMap::new();
    for entry in definitions.activity_kinds {
        kinds.entry(entry.family).or_default().push(entry.kind);
    }
    let families = kinds
        .into_iter()
        .map(|(family, kinds)| json!({ "family": family, "kinds": kinds }))
        .collect::<Vec<_>>();
    let metrics = definitions
        .metric_formulas
        .into_iter()
        .map(|(key, definition)| {
            let label = key
                .split('_')
                .map(|word| {
                    let mut chars = word.chars();
                    chars.next().map_or_else(String::new, |first| {
                        first.to_uppercase().collect::<String>() + chars.as_str()
                    })
                })
                .collect::<Vec<_>>()
                .join(" ");
            json!({
                "key": key,
                "label": label,
                "definition": definition,
                "source": "Postgres metadata read model",
            })
        })
        .collect::<Vec<_>>();
    let mut exclusions = definitions.privacy_exclusions;
    exclusions.push(format!(
        "Excluded Nostr kinds: {}",
        definitions
            .excluded_kinds
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(", ")
    ));
    exclusions.push(definitions.identity_classification);
    exclusions.push(definitions.utc_semantics);
    exclusions.push(definitions.freshness_semantics);
    json!({
        "version": definitions.definitions_version,
        "families": families,
        "metrics": metrics,
        "exclusions": exclusions,
        "sources": definitions.source_tables,
    })
}

fn live_fresh(as_of: DateTime<Utc>) -> AnalyticsSourceFreshness {
    AnalyticsSourceFreshness {
        status: FreshnessStatus::Fresh,
        watermark: None,
        observed_at: Some(as_of),
        lag_seconds: Some(0),
    }
}

fn live_unavailable() -> AnalyticsSourceFreshness {
    AnalyticsSourceFreshness {
        status: FreshnessStatus::Unavailable,
        watermark: None,
        observed_at: None,
        lag_seconds: None,
    }
}

fn live_not_used() -> AnalyticsSourceFreshness {
    AnalyticsSourceFreshness {
        status: FreshnessStatus::Fresh,
        watermark: None,
        observed_at: None,
        lag_seconds: None,
    }
}

fn static_fresh(as_of: DateTime<Utc>) -> AnalyticsSourceFreshness {
    AnalyticsSourceFreshness {
        status: FreshnessStatus::Fresh,
        watermark: Some(as_of),
        observed_at: Some(as_of),
        lag_seconds: Some(0),
    }
}

fn historical_not_used() -> AnalyticsSourceFreshness {
    AnalyticsSourceFreshness {
        status: FreshnessStatus::Fresh,
        watermark: None,
        observed_at: None,
        lag_seconds: None,
    }
}

async fn record(
    state: &AppState,
    audit: &RequestAudit,
    outcome: OperatorAccessOutcome,
) -> Result<(), Response> {
    state
        .db
        .operator_record_access(
            audit.request_id,
            &audit.operator_pubkey,
            audit.route.audit_path(),
            Some(&audit.filter_digest),
            audit.target_digest.as_ref().map(<[u8; 32]>::as_slice),
            outcome,
        )
        .await
        .map_err(|error| {
            tracing::error!(request_id = %audit.request_id, %error, "operator access log write failed");
            response(
                StatusCode::SERVICE_UNAVAILABLE,
                json!({ "error": "operator accountability log unavailable" }),
                Some(audit.request_id),
            )
        })
}

async fn recorded_error(
    state: &AppState,
    audit: &RequestAudit,
    outcome: OperatorAccessOutcome,
    status: StatusCode,
    message: &'static str,
) -> Response {
    if let Err(response) = record(state, audit, outcome).await {
        return response;
    }
    response(status, json!({ "error": message }), Some(audit.request_id))
}

async fn source_failure(
    state: &AppState,
    audit: &RequestAudit,
    error: impl std::fmt::Display,
) -> Response {
    tracing::error!(request_id = %audit.request_id, %error, "operator analytics source failed");
    recorded_error(
        state,
        audit,
        OperatorAccessOutcome::SourceError,
        StatusCode::SERVICE_UNAVAILABLE,
        "analytics source unavailable",
    )
    .await
}

fn envelope_response(
    status: StatusCode,
    data: Value,
    historical: AnalyticsSourceFreshness,
    live: AnalyticsSourceFreshness,
    warnings: Vec<String>,
    as_of: DateTime<Utc>,
    request_id: Uuid,
) -> Response {
    response(
        status,
        json!({
            "data": data,
            "as_of": as_of,
            "freshness": AnalyticsFreshness { historical, live },
            "definitions_version": OPERATOR_ANALYTICS_DEFINITIONS_VERSION,
            "warnings": warnings,
        }),
        Some(request_id),
    )
}

fn response(status: StatusCode, body: Value, request_id: Option<Uuid>) -> Response {
    let mut response = (status, Json(body)).into_response();
    if let Some(request_id) = request_id {
        if let Ok(value) = HeaderValue::from_str(&request_id.to_string()) {
            response.headers_mut().insert("x-request-id", value);
        }
    }
    response
}

fn to_i64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::api_error;

    #[test]
    fn definitions_wire_exposes_metadata_only_contract() {
        let serialized = definitions_wire().to_string();
        for forbidden in [
            "content",
            "private_key",
            "signature",
            "provider",
            "model",
            "raw_ip",
        ] {
            assert!(!serialized.contains(&format!("\"{forbidden}\"")));
        }
        assert!(serialized.contains("\"version\":\"v1\""));
        assert!(serialized.contains("\"families\""));
    }

    #[test]
    fn api_errors_never_echo_filter_values() {
        let error = parse_query(Some("community=secret"), AnalyticsRoute::Overview)
            .expect_err("invalid community");
        assert_eq!(error, "invalid community filter");
        assert!(!error.contains("secret"));
        let (_status, Json(body)) = api_error(StatusCode::BAD_REQUEST, error);
        assert!(!body.to_string().contains("secret"));
    }
}

#[cfg(test)]
#[path = "operator_analytics_integration_tests.rs"]
mod integration_tests;
