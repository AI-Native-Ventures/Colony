//! Canonical `buzz://` deep links for Buzz entities.
//!
//! Buzz Desktop renders these links as rich preview cards in chat and
//! navigates in-app when they are clicked. The desktop parser lives in
//! `desktop/src/shared/lib/entityLink.ts` for git entities and
//! `desktop/src/features/messages/lib/messageLink.ts` for messages. The
//! implementations must stay format-compatible.
//!
//! Callers are expected to validate inputs first (`validate_hex64`,
//! `validate_repo_id`); the identifier charsets need no URL encoding.

use crate::error::CliError;

/// A validated `buzz://message` deep link.
#[derive(Debug, PartialEq, Eq)]
pub struct MessageLink {
    pub channel_id: String,
    pub message_id: String,
    pub thread_root_id: Option<String>,
}

/// Parse a `buzz://message?channel=<uuid>&id=<event>[&thread=<root>]` link.
///
/// The link chooses only the channel and event within the relay already
/// configured for this CLI process. It cannot override the relay or identity.
pub fn parse_message_link(input: &str) -> Result<MessageLink, CliError> {
    let url = url::Url::parse(input.trim())
        .map_err(|_| CliError::Usage("invalid Buzz message link".into()))?;

    if url.scheme() != "buzz"
        || url.host_str() != Some("message")
        || !matches!(url.path(), "" | "/")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(CliError::Usage(
            "expected a buzz://message link without credentials or a fragment".into(),
        ));
    }

    let mut channel = None;
    let mut message = None;
    let mut thread = None;
    for (key, value) in url.query_pairs() {
        let slot = match key.as_ref() {
            "channel" => &mut channel,
            "id" => &mut message,
            "thread" => &mut thread,
            _ => {
                return Err(CliError::Usage(
                    "Buzz message link contains an unsupported query parameter".into(),
                ))
            }
        };
        if slot.replace(value.into_owned()).is_some() {
            return Err(CliError::Usage(format!(
                "Buzz message link contains more than one {key} parameter"
            )));
        }
    }

    let channel = channel
        .filter(|value| !value.is_empty())
        .ok_or_else(|| CliError::Usage("Buzz message link is missing channel".into()))?;
    let message = message
        .filter(|value| !value.is_empty())
        .ok_or_else(|| CliError::Usage("Buzz message link is missing id".into()))?;
    if thread.as_deref() == Some("") {
        return Err(CliError::Usage(
            "Buzz message link contains an empty thread parameter".into(),
        ));
    }

    let channel_id = uuid::Uuid::parse_str(&channel)
        .map_err(|_| CliError::Usage("Buzz message link contains an invalid channel UUID".into()))?
        .to_string();
    let message_id = canonical_event_id(&message, "id")?;
    let thread_root_id = thread
        .as_deref()
        .map(|value| canonical_event_id(value, "thread"))
        .transpose()?;

    Ok(MessageLink {
        channel_id,
        message_id,
        thread_root_id,
    })
}

fn canonical_event_id(value: &str, parameter: &str) -> Result<String, CliError> {
    if value.len() != 64 || !value.chars().all(|character| character.is_ascii_hexdigit()) {
        return Err(CliError::Usage(format!(
            "Buzz message link contains an invalid {parameter} event ID"
        )));
    }
    Ok(value.to_ascii_lowercase())
}

/// Build a `buzz://repo` link for a repository announcement (kind 30617).
pub fn repo_link(owner: &str, repo_id: &str) -> String {
    format!("buzz://repo?owner={owner}&d={repo_id}")
}

/// Build a `buzz://pr` link for a pull request event (kind 1618).
pub fn pull_request_link(event_id: &str, owner: &str, repo_id: &str) -> String {
    format!("buzz://pr?id={event_id}&owner={owner}&d={repo_id}")
}

/// Build a `buzz://issue` link for an issue event (kind 1621).
pub fn issue_link(event_id: &str, owner: &str, repo_id: &str) -> String {
    format!("buzz://issue?id={event_id}&owner={owner}&d={repo_id}")
}

#[cfg(test)]
mod tests {
    use super::*;

    const OWNER: &str = "71d67180ba17e749ee825fc8819c9c6ee7003617e1c126504f9b658070ab9224";
    const EVENT_ID: &str = "c3b589fa5713ba25bad6dc095e2de00a4ac8f50050fdea00fc6444e603be1dd1";
    const CHANNEL: &str = "123e4567-e89b-12d3-a456-426614174000";
    const MESSAGE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const THREAD: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    // Golden strings shared with desktop/src/shared/lib/entityLink.test.mjs
    // ("builders emit the canonical cross-language link format").
    #[test]
    fn golden_format_matches_desktop() {
        assert_eq!(
            pull_request_link(EVENT_ID, OWNER, "buzz-world"),
            format!("buzz://pr?id={EVENT_ID}&owner={OWNER}&d=buzz-world")
        );
        assert_eq!(
            issue_link(EVENT_ID, OWNER, "buzz-world"),
            format!("buzz://issue?id={EVENT_ID}&owner={OWNER}&d=buzz-world")
        );
        assert_eq!(
            repo_link(OWNER, "buzz-world"),
            format!("buzz://repo?owner={OWNER}&d=buzz-world")
        );
    }

    #[test]
    fn parses_message_link_with_thread_root() {
        let parsed = parse_message_link(&format!(
            "buzz://message?channel={CHANNEL}&id={MESSAGE}&thread={THREAD}"
        ))
        .unwrap();

        assert_eq!(
            parsed,
            MessageLink {
                channel_id: CHANNEL.into(),
                message_id: MESSAGE.into(),
                thread_root_id: Some(THREAD.into()),
            }
        );
    }

    #[test]
    fn parses_message_link_without_thread_root() {
        let parsed =
            parse_message_link(&format!("buzz://message?channel={CHANNEL}&id={MESSAGE}")).unwrap();
        assert_eq!(parsed.thread_root_id, None);
    }

    #[test]
    fn normalizes_message_link_identifiers() {
        let parsed = parse_message_link(&format!(
            "buzz://message?channel={}&id={}",
            CHANNEL.to_ascii_uppercase(),
            MESSAGE.to_ascii_uppercase()
        ))
        .unwrap();

        assert_eq!(parsed.channel_id, CHANNEL);
        assert_eq!(parsed.message_id, MESSAGE);
    }

    #[test]
    fn rejects_message_link_that_could_change_connection_context() {
        for link in [
            format!("buzz://message?channel={CHANNEL}&id={MESSAGE}&relay=other"),
            format!("buzz://user:secret@message?channel={CHANNEL}&id={MESSAGE}"),
            format!("buzz://message?channel={CHANNEL}&id={MESSAGE}#fragment"),
        ] {
            assert!(parse_message_link(&link).is_err(), "accepted {link}");
        }
    }

    #[test]
    fn rejects_duplicate_or_malformed_message_link_identifiers() {
        for link in [
            format!("buzz://message?channel={CHANNEL}&channel={CHANNEL}&id={MESSAGE}"),
            format!("buzz://message?channel=not-a-uuid&id={MESSAGE}"),
            format!("buzz://message?channel={CHANNEL}&id=not-an-event"),
            format!("buzz://message?channel={CHANNEL}&id={MESSAGE}&thread="),
        ] {
            assert!(parse_message_link(&link).is_err(), "accepted {link}");
        }
    }
}
