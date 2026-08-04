//! DM channel decoding: identities are not display names.
//!
//! Lives here rather than in `nostr_convert.rs`'s own test module because that
//! file sits at the repo's size ratchet and may not grow.

use buzz_lib::nostr_convert::channel_info_from_event;
use nostr::{Event, EventBuilder, Keys, Kind, Tag};

fn channel_event(tags: Vec<Vec<&str>>) -> Event {
    let keys = Keys::generate();
    let parsed: Vec<Tag> = tags
        .into_iter()
        .map(|t| Tag::parse(t).expect("parse tag"))
        .collect();
    EventBuilder::new(Kind::from_u16(39000), "")
        .tags(parsed)
        .sign_with_keys(&keys)
        .expect("sign")
}

#[test]
fn dm_participants_are_names_not_keys() {
    // A p-tag is an identity, not a name. Cloning the pubkeys into
    // `participants` made every display fallback in the app render a
    // 64-character key where a person's name belongs.
    let peer = "0e74f2eaeb629ba93662e2b22550989cd2e8d88d6fde5c4d632ff2db79931058";
    let me = "8bb22f166ef1afa540434470bdafed7185b36c755189d7775246caa97c76baca";
    let event = channel_event(vec![
        vec!["d", "dm-uuid-1"],
        vec!["name", peer],
        vec!["t", "dm"],
        vec!["p", peer],
        vec!["p", me],
    ]);

    let info = channel_info_from_event(&event, None, None).expect("decode");

    assert_eq!(
        info.participant_pubkeys,
        vec![peer.to_string(), me.to_string()],
        "identities still come through"
    );
    assert!(
        info.participants.is_empty(),
        "a channel event carries no display names, and an empty list says so; got {:?}",
        info.participants
    );
}
