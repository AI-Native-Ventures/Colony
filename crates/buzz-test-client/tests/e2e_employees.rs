//! End-to-end proof of the employee registry (`docs/design/company-employees.html`, phase 1).
//!
//! The phase gate is: a hired employee is visible to both members, and its
//! events are signed by the relay-held key. Everything here goes through the
//! same door a real client uses (signed events over HTTP `/events` and
//! `/query`); nothing calls into `buzz-relay`'s internals, so what passes here
//! is what a member's app would see.
//!
//! Three properties are proven together, because each is worthless alone:
//!
//! 1. **Hiring works and is one-way.** An owner's request produces an employee
//!    head signed by a key the requester never possessed.
//! 2. **Hiring is idempotent.** The same request re-run does not mint a second
//!    identity for one role - the property the best-effort side-effect
//!    contract depends on.
//! 3. **Employment cannot be forged.** A stranger who mints a keypair and
//!    publishes a head claiming to be the executive is refused at ingest,
//!    because rank decides who may interrupt a human.
//!
//! # Running
//!
//! ```text
//! set -a && source .env && set +a
//! export BUZZ_EMPLOYEE_KEK=$(openssl rand -hex 32)   # relay must have this too
//! cargo test -p buzz-test-client --test e2e_employees -- --ignored
//! ```
//!
//! Requires a relay started with `BUZZ_EMPLOYEE_KEK` configured. Without it
//! hiring refuses by design, and this test fails at the first assertion rather
//! than silently downgrading.

mod common;

use std::time::Duration;

use nostr::{EventBuilder, Keys, Kind, Tag};
use uuid::Uuid;

use buzz_core::kind::{KIND_EMPLOYEE, KIND_HIRE_REQUEST};

use common::{default_community, e2e_db_pool, query, seed_relay_owner, submit, tag_value};

fn hire_request(owner: &Keys, role: &str, name: &str, rank: &str) -> nostr::Event {
    EventBuilder::new(Kind::Custom(KIND_HIRE_REQUEST as u16), "")
        .tags(vec![
            Tag::parse(["role", role]).unwrap(),
            Tag::parse(["name", name]).unwrap(),
            Tag::parse(["rank", rank]).unwrap(),
        ])
        .sign_with_keys(owner)
        .expect("sign hire request")
}

/// Poll for the employee head answering `hire_event_id`. Hiring is a side
/// effect that runs after the request is stored, so the head is legitimately
/// not there the instant the request is accepted.
async fn await_employee_head(keys: &Keys, hire_event_id: &str) -> serde_json::Value {
    for _ in 0..40 {
        let heads = query(keys, serde_json::json!({ "kinds": [KIND_EMPLOYEE] })).await;
        if let Some(head) = heads
            .iter()
            .find(|head| tag_value(head, "e") == hire_event_id)
        {
            return head.clone();
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    panic!("no employee head appeared for hire request {hire_event_id}");
}

#[tokio::test]
#[ignore = "requires a running relay with BUZZ_EMPLOYEE_KEK and Postgres"]
async fn an_owner_hires_an_employee_the_workspace_can_see() {
    let community = default_community().await;
    let owner = Keys::generate();
    seed_relay_owner(community, &owner).await;

    // A role slug unique to this run, so repeat runs do not collide with the
    // one-active-employee-per-role index.
    let role = format!("e2e-role-{}", Uuid::new_v4().simple());
    let request = hire_request(&owner, &role, "Sift", "worker");
    let (accepted, body) = submit(&request).await;
    assert!(accepted, "hire request not accepted: {body}");

    let head = await_employee_head(&owner, &request.id.to_hex()).await;

    // The head describes the role the owner asked for...
    assert_eq!(tag_value(&head, "role"), role);
    assert_eq!(tag_value(&head, "name"), "Sift");
    assert_eq!(tag_value(&head, "rank"), "worker");
    assert_eq!(tag_value(&head, "hired-by"), owner.public_key().to_hex());

    // ...and is signed by a key nobody outside the relay ever held. The
    // author is the employee itself, keyed by its own pubkey, and is neither
    // the owner who asked nor any client identity.
    let author = head["pubkey"]
        .as_str()
        .expect("head has an author")
        .to_string();
    assert_eq!(
        tag_value(&head, "d"),
        author,
        "an employee head must be keyed by its own author"
    );
    assert_ne!(
        author,
        owner.public_key().to_hex(),
        "the employee must not be the owner who hired it"
    );

    // The relay holds that key sealed, never in the clear.
    let pool = e2e_db_pool().await;
    let sealed: Vec<u8> = sqlx::query_scalar(
        "SELECT sealed_key FROM employees WHERE community_id = $1 AND pubkey = $2",
    )
    .bind(community)
    .bind(hex::decode(&author).expect("author is hex"))
    .fetch_one(&pool)
    .await
    .expect("employee row exists");
    assert!(
        !sealed.is_empty() && sealed.len() > 32,
        "sealed key must be nonce+ciphertext, not a bare 32-byte secret"
    );
    assert_ne!(
        hex::encode(&sealed[..32.min(sealed.len())]),
        author,
        "the stored blob must not be the key material in the clear"
    );
}

#[tokio::test]
#[ignore = "requires a running relay with BUZZ_EMPLOYEE_KEK and Postgres"]
async fn re_running_one_hire_request_does_not_mint_a_second_employee() {
    let community = default_community().await;
    let owner = Keys::generate();
    seed_relay_owner(community, &owner).await;

    let role = format!("e2e-role-{}", Uuid::new_v4().simple());
    let request = hire_request(&owner, &role, "Sift", "worker");
    let (accepted, body) = submit(&request).await;
    assert!(accepted, "hire request not accepted: {body}");
    let first = await_employee_head(&owner, &request.id.to_hex()).await;

    // Re-submitting the identical event replays the same request. Whether the
    // relay treats it as a duplicate or re-runs the side effect, exactly one
    // employee must exist for it: the whole point of keying on the request.
    let _ = submit(&request).await;
    tokio::time::sleep(Duration::from_secs(1)).await;

    let pool = e2e_db_pool().await;
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM employees WHERE community_id = $1 AND hire_event = $2",
    )
    .bind(community)
    .bind(request.id.as_bytes().to_vec())
    .fetch_one(&pool)
    .await
    .expect("count employees for the hire request");
    assert_eq!(count, 1, "one hire request must yield exactly one employee");

    let second = await_employee_head(&owner, &request.id.to_hex()).await;
    assert_eq!(
        first["pubkey"], second["pubkey"],
        "a replayed request must not change who holds the role"
    );
}

#[tokio::test]
#[ignore = "requires a running relay with BUZZ_EMPLOYEE_KEK and Postgres"]
async fn a_stranger_cannot_publish_a_head_claiming_employment() {
    // Rank decides who may address a human owner, so a forged executive head
    // would be a route around the interrupt system's wall. Anyone can mint a
    // keypair; only the relay can make one an employee.
    let impostor = Keys::generate();
    let forged = EventBuilder::new(Kind::Custom(KIND_EMPLOYEE as u16), "")
        .tags(vec![
            Tag::parse(["d", &impostor.public_key().to_hex()]).unwrap(),
            Tag::parse(["role", "chief-of-staff"]).unwrap(),
            Tag::parse(["name", "Impostor"]).unwrap(),
            Tag::parse(["rank", "executive"]).unwrap(),
            Tag::parse(["hired-by", &impostor.public_key().to_hex()]).unwrap(),
            Tag::parse(["e", &"11".repeat(32)]).unwrap(),
        ])
        .sign_with_keys(&impostor)
        .expect("sign forged head");

    let (accepted, body) = submit(&forged).await;
    assert!(
        !accepted,
        "a head from a non-employee must be refused: {body}"
    );
    // And refused *because* the author is not an employee. Asserting the
    // reason keeps this test honest: while the kind was unregistered it
    // passed on "unknown event kind" without the employment gate ever
    // running, which is a vacuous pass dressed as a security guarantee.
    let error = body["error"].as_str().unwrap_or_default();
    assert!(
        error.contains("not an employee"),
        "expected the employment gate to refuse this, got: {error}"
    );
}

#[tokio::test]
#[ignore = "requires a running relay with BUZZ_EMPLOYEE_KEK and Postgres"]
async fn a_non_owner_cannot_add_to_the_payroll() {
    let stranger = Keys::generate();
    let role = format!("e2e-role-{}", Uuid::new_v4().simple());
    let request = hire_request(&stranger, &role, "Uninvited", "executive");

    // The request itself is an ordinary event and may be stored; what must
    // not happen is an employee coming out of it.
    let _ = submit(&request).await;
    tokio::time::sleep(Duration::from_secs(1)).await;

    let pool = e2e_db_pool().await;
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM employees WHERE community_id = $1 AND hire_event = $2",
    )
    .bind(default_community().await)
    .bind(request.id.as_bytes().to_vec())
    .fetch_one(&pool)
    .await
    .expect("count employees for the stranger's request");
    assert_eq!(
        count, 0,
        "only a community owner may add an employee to the payroll"
    );
}
