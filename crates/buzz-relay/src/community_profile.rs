//! Every community has an operating profile, from the moment it exists.
//!
//! The profile carries the business details work records need: a trading
//! name, services, customer segments, and the cost centres a Task charges
//! against. `validate_task` refuses a Task whose `costCentreId` is not on
//! the profile, so without one no work can be created at all.
//!
//! It used to be created by an agent interview and nothing else. That
//! interview is injected into an agent's system prompt as one section among
//! several, with no trigger and no first-run gate, so it only ran if a model
//! spontaneously set aside what the owner had actually asked for. On the
//! Colony workspace it never ran once in weeks of daily use: the owner saw
//! "No company record exists on this community yet" on every Work surface,
//! naming a record they had never heard of, with no way to create one from
//! inside the app.
//!
//! So the profile is no longer something to obtain. It exists, with honest
//! defaults, and the interview's job becomes filling it in rather than
//! bringing it into being.
//!
//! This sweep is the mechanism, and it is deliberately idempotent and
//! self-healing rather than a hook on community creation: it repairs the
//! communities that already exist and predate this, and it covers any future
//! path that creates a community without knowing it owes one a profile.

use std::sync::Arc;

use buzz_core::company::{
    CompanyProfile, CostCentre, CostCentreKind, COMMUNITY_PROFILE_ID, COMPANY_SCHEMA,
};
use buzz_core::kind::KIND_COMPANY_PROFILE;
use buzz_core::tenant::TenantContext;
use nostr::Keys;
use tracing::{info, warn};

use crate::state::AppState;

/// The cost centre every community starts with.
///
/// One internal bucket, not a guess at the owner's accounting. Work has to
/// charge somewhere and an empty list would leave Tasks uncreatable, which
/// is the exact failure this module exists to end.
const DEFAULT_COST_CENTRE_ID: &str = "general";

/// A readable trading name derived from the community's own host.
///
/// `acme.colony.example` becomes `Acme`. The owner renames it in Settings;
/// this only has to be a name rather than a placeholder like "Untitled",
/// which would read as broken rather than unconfigured.
fn trading_name_from_host(host: &str) -> String {
    let label = host.split('.').next().unwrap_or(host);
    let mut chars = label.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => "Workspace".to_string(),
    }
}

/// The profile a community starts life with.
pub fn default_profile(host: &str, now: i64) -> CompanyProfile {
    CompanyProfile {
        schema: COMPANY_SCHEMA.to_string(),
        trading_name: trading_name_from_host(host),
        legal_name: None,
        website: None,
        // Blank rather than invented: an owner editing a real summary is a
        // better outcome than one deleting a sentence a machine made up.
        summary: String::new(),
        business_type: "unspecified".to_string(),
        services: Vec::new(),
        customer_segments: Vec::new(),
        cost_centres: vec![CostCentre {
            id: DEFAULT_COST_CENTRE_ID.to_string(),
            name: "General".to_string(),
            kind: CostCentreKind::Internal,
            service_id: None,
        }],
        source_report_event_id: None,
        created_at: now,
        updated_at: now,
    }
}

/// Write this community's profile if it does not have one. Returns whether
/// a head was written.
///
/// Never overwrites: a community that already has a profile is left exactly
/// as its owner left it, including one the onboarding interview produced.
pub async fn ensure_profile(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    host: &str,
) -> Result<bool, String> {
    let relay: &Keys = &state.relay_keypair;
    let existing =
        crate::company_broker::load_head(tenant, state, KIND_COMPANY_PROFILE, COMMUNITY_PROFILE_ID)
            .await?;
    if existing.is_some() {
        return Ok(false);
    }

    let now = chrono::Utc::now().timestamp();
    let payload = buzz_sdk::company::CompanyActionPayload::Company(default_profile(host, now));
    let head = crate::company_broker::build_head(relay, &payload, None)?;
    let (stored, inserted) = state
        .db
        .insert_event(tenant.community(), &head, None)
        .await
        .map_err(|error| format!("could not store the community profile: {error}"))?;
    // Not inserted means another relay in this deployment won the race and
    // wrote the same profile first, which is the outcome either way.
    if inserted {
        crate::handlers::event::dispatch_persistent_event(
            tenant,
            state,
            &stored,
            KIND_COMPANY_PROFILE,
            &state.relay_keypair.public_key().to_hex(),
            None,
        )
        .await;
    }
    Ok(inserted)
}

/// Give every community without a profile the default one.
///
/// Best-effort per community: one community's failure must not stop the
/// rest, because the alternative is a single bad tenant leaving every other
/// workspace unable to create work.
pub async fn run_profile_backfill(state: Arc<AppState>) {
    let communities = match state.db.usage_community_hosts().await {
        Ok(rows) => rows,
        Err(error) => {
            warn!(error = %error, "could not list communities for the profile backfill");
            return;
        }
    };

    let mut written = 0usize;
    for community in &communities {
        let tenant = TenantContext::resolved(
            buzz_core::CommunityId::from_uuid(community.id),
            community.host.clone(),
        );
        match ensure_profile(&state, &tenant, &community.host).await {
            Ok(true) => {
                written += 1;
                info!(
                    community = %community.id,
                    host = %community.host,
                    "wrote the default community profile"
                );
            }
            Ok(false) => {}
            Err(error) => warn!(
                community = %community.id,
                error = %error,
                "could not ensure the community profile"
            ),
        }
    }
    if written > 0 {
        info!(
            written,
            total = communities.len(),
            "community profile backfill complete"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::company::validate_company;

    /// The whole point: a community that never ran an interview still gets a
    /// profile that the Task contract accepts. If this fails, work is
    /// uncreatable on every fresh workspace.
    #[test]
    fn the_default_profile_satisfies_the_company_contract() {
        let profile = default_profile("acme.colony.example", 1_800_000_000);
        validate_company(&profile).expect("the default profile must be a valid company");
    }

    /// A Task charges to a cost centre and `validate_task` refuses one that
    /// is not on the profile, so the default has to carry at least one.
    #[test]
    fn the_default_profile_has_a_cost_centre_to_charge_work_to() {
        let profile = default_profile("acme.colony.example", 1_800_000_000);
        assert_eq!(profile.cost_centres.len(), 1);
        assert_eq!(profile.cost_centres[0].id, DEFAULT_COST_CENTRE_ID);
        assert_eq!(profile.cost_centres[0].kind, CostCentreKind::Internal);
    }

    #[test]
    fn the_trading_name_reads_as_a_name_rather_than_a_placeholder() {
        assert_eq!(trading_name_from_host("acme.colony.example"), "Acme");
        assert_eq!(trading_name_from_host("colony"), "Colony");
    }

    /// A hostname that is not a plausible name still has to produce a
    /// contract-valid profile, because the alternative is a community the
    /// backfill silently skips forever.
    #[test]
    fn an_awkward_host_still_produces_a_valid_profile() {
        for host in ["1.example.com", "-.example.com", "x.example.com"] {
            let profile = default_profile(host, 1_800_000_000);
            validate_company(&profile)
                .unwrap_or_else(|error| panic!("host {host} produced an invalid profile: {error}"));
        }
    }

    /// Nothing here is invented on the owner's behalf. A fabricated summary
    /// or service list reads as real data and would have to be deleted
    /// rather than filled in.
    #[test]
    fn the_default_profile_invents_no_business_detail() {
        let profile = default_profile("acme.colony.example", 1_800_000_000);
        assert!(profile.summary.is_empty());
        assert!(profile.services.is_empty());
        assert!(profile.customer_segments.is_empty());
        assert_eq!(profile.legal_name, None);
        assert_eq!(profile.website, None);
    }
}
