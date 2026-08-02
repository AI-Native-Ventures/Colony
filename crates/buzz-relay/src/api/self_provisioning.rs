//! Member self-serve community provisioning.
//!
//! The operator API (`/operator/communities`) is deployment-root authority:
//! its NIP-98 signers come from `RELAY_OPERATOR_PUBKEYS` and it can create
//! arbitrary hosts and rotate owners. This surface is the member-facing
//! counterpart for deployments that let their existing users create
//! communities directly, without a separate provisioning service holding an
//! operator key:
//!
//! - `GET /api/communities/availability?name=<slug>` — name check, no auth.
//! - `POST /api/communities` `{ "name": "<slug>" }` — NIP-98 signed by the
//!   requester's own key; the requester must already be a relay member of
//!   the tenant community the request arrives on, and becomes the owner of
//!   the created community.
//! - `GET /api/communities/mine` — NIP-98; lists communities the requester
//!   owns on this deployment.
//!
//! Scope is deliberately narrower than the operator surface:
//!
//! - Hosts are always `<slug>.<BUZZ_SELF_PROVISION_DOMAIN>` — a member can
//!   never create an arbitrary host.
//! - Creation is create-only ([`create_community_for_owner`]): an existing
//!   community's owner can never be rotated from here.
//! - The per-owner cap (`BUZZ_MAX_COMMUNITIES_PER_OWNER`) is enforced
//!   atomically in the database.
//! - `BUZZ_SELF_PROVISION_DOMAIN` unset (the default) disables every route
//!   here — fail closed, matching the operator allowlist default.

use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::Json,
};
use serde::Deserialize;
use serde_json::Value;

use crate::handlers::community_provisioning::create_community_for_owner;
use crate::state::AppState;

use super::{api_error, bridge, internal_error};

/// Maximum slug length. DNS caps labels at 63 octets; the full host must
/// also fit `communities.host VARCHAR(255)`, which every slug under this cap
/// does for any sane provisioning domain.
const MAX_SLUG_LEN: usize = 63;

/// Names that would collide with or impersonate infrastructure under the
/// provisioning domain. The relay's own primary host is protected by the
/// create-only conflict check; these are denied even while unclaimed.
const RESERVED_SLUGS: &[&str] = &[
    "admin", "api", "app", "assets", "help", "imap", "mail", "media", "mx", "ns1", "ns2", "relay",
    "smtp", "static", "status", "support", "www",
];

/// Query parameters for `GET /api/communities/availability`.
#[derive(Debug, Deserialize)]
pub struct AvailabilityQuery {
    name: String,
}

/// JSON body for `POST /api/communities`.
#[derive(Debug, Deserialize)]
pub struct CreateCommunityRequest {
    name: String,
}

/// Validate a community slug: lowercase letters, digits, and single hyphens
/// between alphanumeric runs (`acme`, `acme-labs`); never leading, trailing,
/// or consecutive hyphens. Matches the desktop client's name rule.
fn validate_slug(raw: &str) -> Result<String, String> {
    let slug = raw.trim().to_lowercase();
    if slug.is_empty() {
        return Err("name is empty".to_string());
    }
    if slug.len() > MAX_SLUG_LEN {
        return Err(format!(
            "name too long: {} chars (max {MAX_SLUG_LEN})",
            slug.len()
        ));
    }
    let valid = slug
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !slug.starts_with('-')
        && !slug.ends_with('-')
        && !slug.contains("--");
    if !valid {
        return Err(
            "name must use lowercase letters, numbers, and single hyphens (e.g. acme-labs)"
                .to_string(),
        );
    }
    if RESERVED_SLUGS.contains(&slug.as_str()) {
        return Err(format!("name {slug:?} is reserved"));
    }
    Ok(slug)
}

/// The configured provisioning domain, or the fail-closed disabled error.
fn provisioning_domain(state: &AppState) -> Result<&str, (StatusCode, Json<Value>)> {
    state
        .config
        .self_provision_domain
        .as_deref()
        .ok_or_else(|| {
            api_error(
                StatusCode::NOT_FOUND,
                "self-serve community creation is not enabled on this relay",
            )
        })
}

fn slug_host(slug: &str, domain: &str) -> String {
    format!("{slug}.{domain}")
}

/// Tenant-bound NIP-98 authentication, mirroring the invite API: the signed
/// `u` tag must name the tenant host the request arrived on, and the event id
/// is burned in the tenant replay scope.
async fn authenticate(
    state: &Arc<AppState>,
    headers: &HeaderMap,
    method: &str,
    path: &str,
    body: Option<&[u8]>,
) -> Result<(buzz_core::TenantContext, nostr::PublicKey), (StatusCode, Json<Value>)> {
    let raw_host = headers
        .get(axum::http::header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let tenant = crate::tenant::bind_community(&state.db, raw_host)
        .await
        .map_err(|_| {
            api_error(
                StatusCode::NOT_FOUND,
                "relay: no community is configured for this host",
            )
        })?;

    let url = bridge::nip98_expected_url(&state.config.relay_url, &tenant, path);
    let (pubkey, event_id_bytes) = bridge::verify_bridge_auth_with_options(
        headers,
        method,
        &url,
        body,
        true, // always NIP-98; no X-Pubkey dev fallback
        body.is_some(),
    )?;
    bridge::check_nip98_replay(state, &tenant, event_id_bytes).await?;

    Ok((tenant, pubkey))
}

/// The requester must already be a relay member of the tenant community the
/// request arrived on. Any role qualifies: membership is the customer gate,
/// ownership of the new community is what the request grants.
async fn require_tenant_membership(
    state: &AppState,
    tenant: &buzz_core::TenantContext,
    pubkey_hex: &str,
) -> Result<(), (StatusCode, Json<Value>)> {
    let member = state
        .db
        .get_relay_member(tenant.community(), pubkey_hex)
        .await
        .map_err(|e| internal_error(&format!("self-provision membership lookup: {e}")))?;
    if member.is_none() {
        return Err(api_error(
            StatusCode::FORBIDDEN,
            "only members of this community can create new communities",
        ));
    }
    Ok(())
}

/// `GET /api/communities/availability?name=<slug>` — public name check.
///
/// Unauthenticated by design (it reveals only whether a host row exists,
/// the same signal as connecting to the host), so the create dialog can
/// check as the user types without a signing round-trip per keystroke.
pub async fn community_availability(
    State(state): State<Arc<AppState>>,
    Query(query): Query<AvailabilityQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let domain = provisioning_domain(&state)?;

    let slug = match validate_slug(&query.name) {
        Ok(slug) => slug,
        Err(message) => {
            return Ok(Json(serde_json::json!({
                "name": query.name,
                "available": false,
                "reason": message,
            })));
        }
    };
    let host = slug_host(&slug, domain);

    let existing = state
        .db
        .lookup_community_by_host_for_management(&host)
        .await
        .map_err(|e| internal_error(&format!("self-provision availability: {e}")))?;

    Ok(Json(serde_json::json!({
        "name": slug,
        "normalized_host": host,
        "available": existing.is_none(),
    })))
}

/// `POST /api/communities` — create `<name>.<domain>` owned by the signer.
pub async fn create_community(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let domain = provisioning_domain(&state)?.to_string();

    let (tenant, pubkey) =
        authenticate(&state, &headers, "POST", "/api/communities", Some(&body)).await?;
    let pubkey_hex = pubkey.to_hex();
    require_tenant_membership(&state, &tenant, &pubkey_hex).await?;

    let request: CreateCommunityRequest = serde_json::from_slice(&body).map_err(|e| {
        api_error(
            StatusCode::BAD_REQUEST,
            &format!("invalid create-community JSON: {e}"),
        )
    })?;
    let slug =
        validate_slug(&request.name).map_err(|msg| api_error(StatusCode::BAD_REQUEST, &msg))?;
    let host = slug_host(&slug, &domain);

    match create_community_for_owner(&state, &host, &pubkey_hex, &pubkey_hex).await {
        Ok(response) => Ok(Json(serde_json::json!({
            "community": {
                "id": response.community_id,
                "name": slug,
                "slug": slug,
                "normalized_host": response.host,
                "owner_pubkey": response.owner_pubkey,
            },
            "warning": response.warning,
        }))),
        Err(msg) if msg == "community already exists" => Err(api_error(
            StatusCode::CONFLICT,
            "taken: that community name is already in use",
        )),
        Err(msg) if msg.starts_with("limit_reached:") => Err(api_error(StatusCode::CONFLICT, &msg)),
        Err(msg) if msg.starts_with("failed to create community:") => {
            tracing::error!(error = %msg, "self-serve community persistence failed");
            Err(internal_error("community persistence failed"))
        }
        Err(msg) => Err(api_error(StatusCode::BAD_REQUEST, &msg)),
    }
}

/// `GET /api/communities/mine` — communities the signer owns here.
pub async fn list_my_communities(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let domain = provisioning_domain(&state)?.to_string();

    let (_tenant, pubkey) =
        authenticate(&state, &headers, "GET", "/api/communities/mine", None).await?;
    let pubkey_hex = pubkey.to_hex();

    let rows = state
        .db
        .list_communities_owned_by(&pubkey_hex)
        .await
        .map_err(|e| internal_error(&format!("self-provision list: {e}")))?;

    let suffix = format!(".{domain}");
    Ok(Json(serde_json::json!({
        "owner_pubkey": pubkey_hex,
        "communities": rows
            .into_iter()
            .map(|row| {
                let slug = row
                    .host
                    .strip_suffix(&suffix)
                    .unwrap_or(&row.host)
                    .to_string();
                serde_json::json!({
                    "id": row.id.to_string(),
                    "name": slug,
                    "slug": slug,
                    "normalized_host": row.host,
                    "owner_pubkey": pubkey_hex,
                    "created_at": row.created_at,
                    "archived_at": row.archived_at,
                })
            })
            .collect::<Vec<_>>(),
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_simple_and_hyphenated_slugs() {
        assert_eq!(validate_slug("acme").unwrap(), "acme");
        assert_eq!(validate_slug("acme-labs-2").unwrap(), "acme-labs-2");
        assert_eq!(validate_slug("  Acme  ").unwrap(), "acme");
    }

    #[test]
    fn rejects_malformed_slugs() {
        for bad in [
            "",
            "-acme",
            "acme-",
            "ac--me",
            "ac me",
            "acme.example",
            "ACME!",
            "acme_labs",
            "café",
        ] {
            assert!(validate_slug(bad).is_err(), "expected rejection: {bad:?}");
        }
        let too_long = "a".repeat(MAX_SLUG_LEN + 1);
        assert!(validate_slug(&too_long).is_err());
    }

    #[test]
    fn rejects_reserved_slugs() {
        for reserved in ["relay", "www", "admin", "api"] {
            assert!(
                validate_slug(reserved).is_err(),
                "expected reserved rejection: {reserved:?}"
            );
        }
    }

    #[test]
    fn slug_host_joins_with_domain() {
        assert_eq!(
            slug_host("acme", "colony.example.com"),
            "acme.colony.example.com"
        );
    }
}
