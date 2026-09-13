//! Domain-owned persistence implementations.

/// Explicit deployment-global admin report reads.
pub mod admin_moderation;
/// Community-scoped authentication allowlist persistence.
pub mod allowlist;
/// API token storage and lookup.
pub mod api_token;
/// Relay-scoped archived identity persistence (NIP-IA).
pub mod archived_identities;
/// Interrupt Asks projection: open-need dedupe and due-deadline sweep.
pub mod asks;
/// Channel lifecycle and metadata persistence.
pub mod channel;
/// Channel membership and roster persistence.
pub mod channel_members;
/// Community lifecycle and host-map persistence.
pub mod community;
/// Colony Credits: accounts, the append-only credit ledger, and the
/// atomic debit/credit API.
pub mod credits;
/// Durable whole-community deletion lifecycle and PostgreSQL adapter.
pub mod deletion;
/// Private entitlement, authorization, and durable run persistence for Discovery.
pub mod discovery;
/// Private Discovery campaign and Lead workspace projections.
pub mod discovery_workspace;
/// Direct message channel persistence.
pub mod dm;
/// Email and password account persistence (zero-knowledge key escrow).
pub mod email_accounts;
/// Managed employee definitions, instances, and their heads.
pub mod employees;
/// Event storage and retrieval.
pub mod event;
/// Home feed queries.
pub mod feed;
/// Colony Credits gateway: provisioned-mode tokens and the model allowlist.
pub mod gateway;
/// Git repository name registry (NIP-34 kind:30617).
pub mod git_repo;
/// The job queue: work employees owe, and the leases that arbitrate it.
pub mod jobs;
/// Community moderation: reports, bans/timeouts, audit actions.
pub mod moderation;
/// Deployment-wide operator analytics taxonomy, rollups, and metadata reads.
pub mod operator_analytics;
/// Monthly table partition management.
pub mod partition;
/// Payment top-up intents: pending checkout records keyed by reference.
pub mod payment_intents;
/// Buzz product-feedback sidecar persistence.
pub mod product_feedback;
/// Community-scoped push lease and durable wake-outbox persistence.
pub mod push;
/// Reaction persistence.
pub mod reaction;
/// Use-limited relay invite persistence (v2 opaque tokens).
pub mod relay_invite;
/// Relay-level membership persistence (NIP-43).
pub mod relay_members;
/// Event-reminder delivery query, claim, and release persistence.
pub mod reminder;
/// Replaceable-event persistence and coordinate locking.
pub mod replaceable;
/// Thread metadata persistence.
pub mod thread;
/// One open task per thread: the claim rows that arbitrate it.
pub mod thread_tasks;
/// Per-community usage rollup queries for Prometheus gauges.
pub mod usage;
/// User profile persistence.
pub mod user;
/// Workflow, run, and approval persistence.
pub mod workflow;
/// Relay-owned channel workspace tab state and driver compare-and-swap.
pub mod workspace_tabs;
