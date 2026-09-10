//! Strict wire contract for Website Manager actions and receipts.
//!
//! A website action (`KIND_WEBSITE_ACTION`, 40027) is a client-signed,
//! channel-scoped command. The signed event carries the job coordinates in
//! tags (`h`, `task`, `thread`, `request`, optional `generation`) and the
//! operation payload in a bounded JSON content object. Parsing answers only
//! whether the event has a well-formed wire shape; every authority decision
//! (who may run which operation against which job) belongs to the relay
//! broker, against the canonical `website_jobs` row.
//!
//! Owner approve/request-changes decisions deliberately do not parse here:
//! they arrive as reserved signed Block actions (`website.approve` /
//! `website.requestChanges`) and are parsed by
//! [`parse_website_decision_action`] so that the Blocks validation and receipt
//! pipeline remains the only decision path.
//!
//! The implementation is split by concern: `error` holds the stable-code
//! error type, `types` holds the wire types and canonical identity, and
//! `parse` holds the strict parser and its bounded validators.

mod error;
mod parse;
mod types;

pub use error::WebsiteCommandError;
pub use parse::{parse_website_action, parse_website_decision_action};
pub use types::{
    is_reserved_website_action_id, WebsiteAction, WebsiteActionOp, WebsiteDecisionAction,
    WebsiteReceipt, MAX_PERSONAS_PER_ROLE, MAX_PERSONA_ID_CHARS, MAX_TASK_ID_CHARS,
    MAX_WEBSITE_ACTION_CONTENT_BYTES, WEBSITE_ACTION_SCHEMA, WEBSITE_APPROVE_ACTION_ID,
    WEBSITE_JOB_BLOCK_HANDLE, WEBSITE_JOB_NAMESPACE, WEBSITE_RECEIPT_SCHEMA,
    WEBSITE_REQUEST_CHANGES_ACTION_ID,
};
