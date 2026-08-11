//! Strict wire contract for channel workspace tab ownership actions.

use serde::Deserialize;
use thiserror::Error;
use uuid::Uuid;

use crate::event_tags::{optional_tag, single_tag, TagLookupError};
use crate::kind::KIND_WORKSPACE_TAB_ACTION;
use nostr::{Event, PublicKey};

/// Maximum number of Unicode scalar values in a client-chosen tab coordinate.
const MAX_TAB_ID_CHARS: usize = 128;
/// Maximum number of Unicode scalar values in a registered tab kind.
const MAX_TAB_KIND_CHARS: usize = 64;
/// Maximum number of Unicode scalar values in a tab title.
pub const MAX_TITLE_CHARS: usize = 200;

/// Why a workspace tab action could not be read from its signed event.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum WorkspaceTabError {
    /// The event is not a workspace tab action event.
    #[error("unexpected workspace tab action kind")]
    InvalidKind,
    /// A required tag was absent or had no value.
    #[error("missing required tag: {0}")]
    MissingTag(&'static str),
    /// A single-valued tag appeared more than once.
    #[error("duplicate tag: {0}")]
    DuplicateTag(&'static str),
    /// The channel tag was not a UUID.
    #[error("invalid channel UUID")]
    InvalidChannelId,
    /// The tab coordinate was empty, untrimmed, had controls, or exceeded its bound.
    #[error("invalid tab id")]
    InvalidTabId,
    /// The optional revision tag was not a non-negative integer.
    #[error("invalid expected revision")]
    InvalidRevision,
    /// The content was not a strict workspace action object.
    #[error("invalid workspace tab action content")]
    InvalidContent,
    /// The content's operation discriminator was not in the wire vocabulary.
    #[error("unknown workspace tab operation: {0}")]
    UnknownOperation(String),
    /// The `tab_kind` field was empty, untrimmed, had controls, or exceeded its bound.
    #[error("invalid tab kind")]
    InvalidTabKind,
    /// The `title` field was empty, untrimmed, had controls, or exceeded its bound.
    #[error("invalid tab title")]
    InvalidTitle,
    /// The grant target was not a valid Nostr public key.
    #[error("invalid grant target public key")]
    InvalidGrantee,
    /// An actor may not grant a tab to itself.
    #[error("a grant may not name its actor")]
    GrantToActor,
}

fn map_tag_error(name: &'static str, error: TagLookupError) -> WorkspaceTabError {
    match error {
        TagLookupError::Missing => WorkspaceTabError::MissingTag(name),
        TagLookupError::Duplicate => WorkspaceTabError::DuplicateTag(name),
    }
}

fn required_tag(event: &Event, name: &'static str) -> Result<String, WorkspaceTabError> {
    single_tag(event, name).map_err(|error| map_tag_error(name, error))
}

fn valid_text(value: &str, max_chars: usize) -> bool {
    !value.is_empty()
        && value == value.trim()
        && value.chars().count() <= max_chars
        && !value.chars().any(char::is_control)
}

/// JSON body carried by a workspace tab action.
///
/// The wire shape is deliberately closed and payload-free. The four valid
/// objects are:
///
/// ```json
/// {"op":"open","tab_kind":"scratchpad","title":"Notes"}
/// {"op":"take"}
/// {"op":"grant","grantee":"<64 lowercase hex public key>"}
/// {"op":"release"}
/// ```
///
/// Tab contents never cross the relay. Channel and tab coordinates are tags;
/// an optional decimal `revision` tag carries the expected CAS revision, and
/// the signed event pubkey is the actor.
#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum WorkspaceTabWireOp {
    /// Create a tab with its registry kind and display title.
    Open { tab_kind: String, title: String },
    /// Ask the relay to move the driver seat to the actor.
    Take,
    /// Give the tab to another public key.
    Grant { grantee: String },
    /// Release the actor's current driver seat.
    Release,
}

/// Operation requested by a workspace tab action.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkspaceTabOp {
    /// Open a tab with its kind and title.
    Open {
        /// Registry kind string for the tab body.
        tab_kind: String,
        /// Human-readable title shown in the tab strip.
        title: String,
    },
    /// Take the driver seat for an existing tab.
    Take,
    /// Grant the tab to another public key.
    Grant {
        /// Public key receiving the tab grant.
        grantee: PublicKey,
    },
    /// Release the actor's current driver seat.
    Release,
}

/// A validated, client-authored workspace tab action.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceTabAction {
    /// UUID of the channel carrying this action.
    pub channel_id: Uuid,
    /// Opaque tab coordinate, unique within the channel.
    pub tab_id: String,
    /// Operation requested by the actor.
    pub op: WorkspaceTabOp,
    /// Revision the actor observed, when supplied by the event.
    pub expected_revision: Option<i64>,
    /// Public key that signed the action.
    pub actor: PublicKey,
}

/// Parse and validate a signed workspace tab action.
///
/// Parsing answers only whether the event has a well-formed wire shape. It
/// does not authorize the actor to open, take, grant, or release a tab; those
/// decisions belong to the relay broker against canonical database state.
pub fn parse_tab_action(event: &Event) -> Result<WorkspaceTabAction, WorkspaceTabError> {
    if event.kind.as_u16() as u32 != KIND_WORKSPACE_TAB_ACTION {
        return Err(WorkspaceTabError::InvalidKind);
    }

    let channel_id = required_tag(event, "h")?
        .parse::<Uuid>()
        .map_err(|_| WorkspaceTabError::InvalidChannelId)?;
    let tab_id = required_tag(event, "tab")?;
    if !valid_text(&tab_id, MAX_TAB_ID_CHARS) {
        return Err(WorkspaceTabError::InvalidTabId);
    }
    let expected_revision = optional_tag(event, "revision")
        .map_err(|error| map_tag_error("revision", error))?
        .map(|value| {
            value
                .parse::<i64>()
                .ok()
                .filter(|revision| *revision >= 0)
                .ok_or(WorkspaceTabError::InvalidRevision)
        })
        .transpose()?;

    let value: serde_json::Value =
        serde_json::from_str(&event.content).map_err(|_| WorkspaceTabError::InvalidContent)?;
    let object = value.as_object().ok_or(WorkspaceTabError::InvalidContent)?;
    let operation = object
        .get("op")
        .and_then(serde_json::Value::as_str)
        .ok_or(WorkspaceTabError::InvalidContent)?;
    if !matches!(operation, "open" | "take" | "grant" | "release") {
        return Err(WorkspaceTabError::UnknownOperation(operation.to_owned()));
    }

    let wire_op: WorkspaceTabWireOp =
        serde_json::from_value(value).map_err(|_| WorkspaceTabError::InvalidContent)?;
    let op = match wire_op {
        WorkspaceTabWireOp::Open { tab_kind, title } => {
            if !valid_text(&tab_kind, MAX_TAB_KIND_CHARS) {
                return Err(WorkspaceTabError::InvalidTabKind);
            }
            if !valid_text(&title, MAX_TITLE_CHARS) {
                return Err(WorkspaceTabError::InvalidTitle);
            }
            WorkspaceTabOp::Open { tab_kind, title }
        }
        WorkspaceTabWireOp::Take => WorkspaceTabOp::Take,
        WorkspaceTabWireOp::Grant { grantee } => {
            let grantee =
                PublicKey::from_hex(&grantee).map_err(|_| WorkspaceTabError::InvalidGrantee)?;
            if grantee == event.pubkey {
                return Err(WorkspaceTabError::GrantToActor);
            }
            WorkspaceTabOp::Grant { grantee }
        }
        WorkspaceTabWireOp::Release => WorkspaceTabOp::Release,
    };

    Ok(WorkspaceTabAction {
        channel_id,
        tab_id,
        op,
        expected_revision,
        actor: event.pubkey,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind, Tag};

    const CHANNEL: &str = "0d1e2f30-0000-4000-8000-000000000001";

    fn event(keys: &Keys, content: &str, tags: &[(&str, &str)]) -> nostr::Event {
        EventBuilder::new(Kind::Custom(KIND_WORKSPACE_TAB_ACTION as u16), content)
            .tags(
                tags.iter()
                    .map(|(name, value)| Tag::parse([*name, *value]).expect("test tag")),
            )
            .sign_with_keys(keys)
            .expect("test event")
    }

    #[test]
    fn parses_a_well_formed_open_action() {
        let keys = Keys::generate();
        let parsed = parse_tab_action(&event(
            &keys,
            r#"{"op":"open","tab_kind":"scratchpad","title":"Notes"}"#,
            &[("h", CHANNEL), ("tab", "notes")],
        ))
        .expect("valid open action");

        assert_eq!(parsed.channel_id, CHANNEL.parse::<Uuid>().unwrap());
        assert_eq!(parsed.tab_id, "notes");
        assert_eq!(parsed.expected_revision, None);
        assert_eq!(parsed.actor, keys.public_key());
        assert_eq!(
            parsed.op,
            WorkspaceTabOp::Open {
                tab_kind: "scratchpad".to_owned(),
                title: "Notes".to_owned(),
            }
        );
    }

    #[test]
    fn refuses_a_non_uuid_channel_tag() {
        let keys = Keys::generate();
        assert_eq!(
            parse_tab_action(&event(
                &keys,
                r#"{"op":"open","tab_kind":"scratchpad","title":"Notes"}"#,
                &[("h", "not-a-uuid"), ("tab", "notes")],
            ))
            .unwrap_err(),
            WorkspaceTabError::InvalidChannelId
        );
    }

    #[test]
    fn refuses_an_unknown_operation() {
        let keys = Keys::generate();
        assert_eq!(
            parse_tab_action(&event(
                &keys,
                r#"{"op":"archive"}"#,
                &[("h", CHANNEL), ("tab", "notes")],
            ))
            .unwrap_err(),
            WorkspaceTabError::UnknownOperation("archive".to_owned())
        );
    }

    #[test]
    fn parses_take_with_its_observed_revision() {
        let keys = Keys::generate();
        let parsed = parse_tab_action(&event(
            &keys,
            r#"{"op":"take"}"#,
            &[("h", CHANNEL), ("tab", "notes"), ("revision", "7")],
        ))
        .expect("valid take action");

        assert_eq!(parsed.op, WorkspaceTabOp::Take);
        assert_eq!(parsed.expected_revision, Some(7));
    }

    #[test]
    fn parses_a_grant_to_another_actor() {
        let keys = Keys::generate();
        let grantee = Keys::generate().public_key();
        let parsed = parse_tab_action(&event(
            &keys,
            &format!(r#"{{"op":"grant","grantee":"{}"}}"#, grantee.to_hex()),
            &[("h", CHANNEL), ("tab", "notes"), ("revision", "1")],
        ))
        .expect("valid grant action");

        assert_eq!(parsed.op, WorkspaceTabOp::Grant { grantee });
    }

    #[test]
    fn parses_release() {
        let keys = Keys::generate();
        let parsed = parse_tab_action(&event(
            &keys,
            r#"{"op":"release"}"#,
            &[("h", CHANNEL), ("tab", "notes"), ("revision", "2")],
        ))
        .expect("valid release action");

        assert_eq!(parsed.op, WorkspaceTabOp::Release);
    }

    #[test]
    fn refuses_a_grant_to_the_actor() {
        let keys = Keys::generate();
        let actor = keys.public_key().to_hex();
        assert_eq!(
            parse_tab_action(&event(
                &keys,
                &format!(r#"{{"op":"grant","grantee":"{actor}"}}"#),
                &[("h", CHANNEL), ("tab", "notes"), ("revision", "1")],
            ))
            .unwrap_err(),
            WorkspaceTabError::GrantToActor
        );
    }

    #[test]
    fn refuses_duplicate_tab_tags_instead_of_first_wins() {
        let keys = Keys::generate();
        assert_eq!(
            parse_tab_action(&event(
                &keys,
                r#"{"op":"open","tab_kind":"scratchpad","title":"Notes"}"#,
                &[("h", CHANNEL), ("tab", "notes"), ("tab", "other")],
            ))
            .unwrap_err(),
            WorkspaceTabError::DuplicateTag("tab")
        );
    }

    #[test]
    fn refuses_an_over_length_title() {
        let keys = Keys::generate();
        let title = "x".repeat(MAX_TITLE_CHARS + 1);
        let content = format!(r#"{{"op":"open","tab_kind":"scratchpad","title":"{title}"}}"#);
        assert_eq!(
            parse_tab_action(&event(&keys, &content, &[("h", CHANNEL), ("tab", "notes")],))
                .unwrap_err(),
            WorkspaceTabError::InvalidTitle
        );
    }
}
