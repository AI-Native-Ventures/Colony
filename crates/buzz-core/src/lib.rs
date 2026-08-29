#![deny(unsafe_code)]
#![warn(missing_docs)]
//! `buzz-core` — zero-I/O foundation types for the Buzz relay.
//!
//! Provides [`StoredEvent`], filter matching, kind constants, and event
//! verification. All other Buzz crates depend on this one.

/// NIP-AM: Agent Turn Metric — payload type and encrypt/decrypt helpers.
pub mod agent_turn_metric;
/// Safe, versioned contracts for chat-native Block manifests and catalogs.
pub mod block;
/// Channel and membership enums shared across crates.
pub mod channel;
/// Company, initiative, task, and agent work-attribution contracts.
pub mod company;
pub mod company_roster;
/// Colony content calendar — campaigns, posts, house style, owner decisions.
pub mod content;
/// Colony content calendar — the brand kit record (kind 30198).
pub mod content_brand_kit;
/// Colony content calendar — the asset library record (kind 30199).
pub mod content_library;
/// Core contracts for Colony business Discovery runs.
pub mod discovery;
/// Canonical Business Discovery taxonomy shared by relay, CLI, and desktop.
pub mod discovery_taxonomy;
/// Core contracts for trusted local Colony Discovery workers.
pub mod discovery_worker;
/// Private workspace records that connect Discovery campaigns and Leads.
pub mod discovery_workspace;
/// Colony company employees — hire requests and employee heads.
pub mod employee;

/// NIP-AE Agent Engrams — slug grammar, conversation key, d-tag derivation,
/// body parse/serialize, envelope build/validate, head selection.
pub mod engram;
/// Relay-side error types.
pub mod error;
/// Relay-side event wrapper with verification tracking.
pub mod event;
/// Reading single-valued tags off an event.
pub mod event_tags;
/// NIP-01 subscription filter matching.
pub mod filter;
/// Git permission types — ref patterns, protection rules, policy evaluation.
pub mod git_perms;
/// Colony interrupt primitives: typed Asks, agent tiers, delegation policy.
pub mod interrupt;
/// Shared invite-link contract constants.
pub mod invite;
/// Colony job queue — filings, claims, heartbeats, outcomes, and job heads.
pub mod job;
/// Buzz kind number registry — custom event type constants.
pub mod kind;
/// Ranking OpenRouter models into an ordered fallback chain.
pub mod model_ranking;
/// Channel workspace tab action parsing and ownership protocol kinds.
pub mod workspace_tab;

/// Colony cost ledger: pricing, attribution, and the deterministic engine.
pub mod ledger;
/// Network utilities — SSRF-safe IP classification.
pub mod network;
/// Agent observer frame helpers.
pub mod observer;
pub mod onboarding_facts;
/// NIP-AB device pairing — crypto primitives, message types, and errors.
pub mod party;

pub mod pairing;
/// Presence status types shared across crates.
pub mod presence;
/// NIP-PMA owner-encrypted private managed-agent wire codec.
pub mod private_managed_agent;
/// Canonical relay runtime identities.
pub mod relay;
/// Tenant identity — the server-resolved community key carried on scoped paths.
pub mod tenant;

/// Colony cost ledger: immutable per-request usage records (kind 44210).
pub mod usage_record;
/// Schnorr signature and event ID verification.
pub mod verification;

pub use error::VerificationError;
pub use event::StoredEvent;
pub use nostr::{Event, EventId, Filter, Keys, Kind, PublicKey};
pub use presence::PresenceStatus;
pub use tenant::{normalize_host, CommunityId, TenantContext};
pub use verification::verify_event;

#[cfg(any(test, feature = "test-utils"))]
/// Test helper utilities for creating events and stored events.
pub mod test_helpers {
    use crate::StoredEvent;
    use chrono::Utc;
    use nostr::{EventBuilder, Keys, Kind};

    /// Create a signed test event with the given kind and random keys.
    pub fn make_event(kind: Kind) -> nostr::Event {
        let keys = Keys::generate();
        EventBuilder::new(kind, "test")
            .tags([])
            .sign_with_keys(&keys)
            .expect("sign")
    }

    /// Create a signed test event with the given keys and kind.
    pub fn make_event_with_keys(keys: &Keys, kind: Kind) -> nostr::Event {
        EventBuilder::new(kind, "test")
            .tags([])
            .sign_with_keys(keys)
            .expect("sign")
    }

    /// Create a [`StoredEvent`] wrapper around a test event.
    pub fn make_stored_event(kind: Kind, channel_id: Option<uuid::Uuid>) -> StoredEvent {
        StoredEvent::with_received_at(make_event(kind), Utc::now(), channel_id, true)
    }
}
