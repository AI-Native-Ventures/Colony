//! Reading single-valued tags off an event.
//!
//! Several Colony wire formats share one rule: a tag carrying a decision must
//! appear exactly once. Two `role` tags on a hire request, or two `job` tags
//! on a claim, would let a filer show a reader one value and the relay
//! another, so a duplicate is refused rather than resolved by taking the
//! first or the last. This module holds that rule once; callers map the two
//! failures into whatever error type their own wire format speaks.
//!
//! A tag matches on its name alone, and its value is the second element.
//! Extra elements are ignored rather than disqualifying, because the standard
//! `p` tag legitimately carries a relay hint and a petname after the pubkey.

/// Why a single-valued tag could not be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TagLookupError {
    /// No tag of this name carried a value.
    Missing,
    /// More than one tag of this name carried a value.
    Duplicate,
}

/// The value of a tag that must appear exactly once.
pub fn single_tag(event: &nostr::Event, name: &str) -> Result<String, TagLookupError> {
    optional_tag(event, name)?.ok_or(TagLookupError::Missing)
}

/// The value of a tag that may appear at most once. `Ok(None)` when absent.
pub fn optional_tag(event: &nostr::Event, name: &str) -> Result<Option<String>, TagLookupError> {
    let mut found: Option<String> = None;
    for tag in event.tags.iter() {
        let parts = tag.as_slice();
        if parts.first().map(String::as_str) != Some(name) {
            continue;
        }
        let value = parts.get(1).ok_or(TagLookupError::Missing)?;
        if found.is_some() {
            return Err(TagLookupError::Duplicate);
        }
        found = Some(value.clone());
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind, Tag};

    fn event(tags: Vec<Vec<&str>>) -> nostr::Event {
        EventBuilder::new(Kind::Custom(1), "")
            .tags(tags.into_iter().map(|t| Tag::parse(t).unwrap()))
            .sign_with_keys(&Keys::generate())
            .unwrap()
    }

    #[test]
    fn reads_the_one_value() {
        let event = event(vec![vec!["role", "sales-lead"], vec!["name", "Sift"]]);
        assert_eq!(single_tag(&event, "role").unwrap(), "sales-lead");
        assert_eq!(
            optional_tag(&event, "name").unwrap(),
            Some("Sift".to_string())
        );
    }

    #[test]
    fn an_absent_tag_is_missing_but_an_absent_optional_tag_is_not_an_error() {
        let event = event(vec![vec!["role", "sales-lead"]]);
        assert_eq!(single_tag(&event, "name"), Err(TagLookupError::Missing));
        assert_eq!(optional_tag(&event, "name").unwrap(), None);
    }

    #[test]
    fn a_second_value_is_refused_rather_than_resolved() {
        let event = event(vec![vec!["role", "sales-lead"], vec!["role", "engineer"]]);
        assert_eq!(single_tag(&event, "role"), Err(TagLookupError::Duplicate));
        assert_eq!(optional_tag(&event, "role"), Err(TagLookupError::Duplicate));
    }

    #[test]
    fn a_named_tag_with_no_value_is_missing_not_empty() {
        let event = event(vec![vec!["role"]]);
        assert_eq!(single_tag(&event, "role"), Err(TagLookupError::Missing));
        assert_eq!(optional_tag(&event, "role"), Err(TagLookupError::Missing));
    }

    #[test]
    fn trailing_elements_do_not_disqualify_a_tag() {
        // The standard `p` tag carries a relay hint and a petname after the
        // pubkey; requiring exactly two elements would skip it entirely.
        let event = event(vec![vec!["p", "abc", "wss://relay.example", "sift"]]);
        assert_eq!(single_tag(&event, "p").unwrap(), "abc");
    }
}
