//! End-to-end proof that an agent can raise an Ask against real work and that
//! it reaches the intended audience through the documented Needs-Me surface.
//!
//! The reusable company, payroll, role-head, task, and ask fixtures live in
//! `tests/common/ask.rs`. Keeping them shared means the live ACP harness gate
//! exercises the exact same records as these direct relay gates.

mod common;

use buzz_core::interrupt::NO_INITIATIVE;
use buzz_core::kind::KIND_STREAM_MESSAGE;
use buzz_test_client::BuzzTestClient;
use nostr::{EventBuilder, Keys, Kind, Tag};
use uuid::Uuid;

use common::ask::*;
use common::{seed_relay_owner, tag_value};

/// The absorption gate: the worker's ask is addressed to its leader, the
/// leader answers it, and the deadline sweep creates no successor ask for the
/// executive or owner.
///
/// This drives the relay protocol directly (publish/query), not the ACP
/// harness. It proves that an answered ask is not promoted by the deadline
/// sweep, so it never reaches the founder; ACP prompt delivery itself is
/// covered by the live harness test and the `buzz-acp` unit tests.
#[tokio::test]
#[ignore = "requires a running relay and Postgres"]
async fn a_leader_answers_a_workers_ask_and_the_owner_never_sees_it() {
    let community_id = ensure_test_community(&relay_host()).await;

    let owner = Keys::generate();
    seed_relay_owner(community_id, &owner).await;

    let mut owner_ws = BuzzTestClient::connect(&relay_url(), &owner)
        .await
        .expect("owner connect");
    let ws = workspace(&mut owner_ws, owner.clone()).await;
    let task_id = create_chat_task(&mut owner_ws, &ws).await;

    let worker = Keys::generate();
    let leader = Keys::generate();
    let executive = Keys::generate();
    let (worker_role, leader_role, executive_role) =
        employ_ladder(community_id, &owner, &worker, &leader, &executive).await;
    publish_role_head(&mut owner_ws, &owner, &worker, &worker_role).await;
    publish_role_head(&mut owner_ws, &owner, &leader, &leader_role).await;
    publish_role_head(&mut owner_ws, &owner, &executive, &executive_role).await;

    let mut worker_ws = BuzzTestClient::connect(&relay_url(), &worker)
        .await
        .expect("worker connect");
    let mut leader_ws = BuzzTestClient::connect(&relay_url(), &leader)
        .await
        .expect("leader connect");

    let before = asks_addressed_to(&owner).await.len();
    let ask_id = raise_with_window(
        &mut worker_ws,
        &worker,
        &leader.public_key().to_hex(),
        None,
        &task_id,
        &format!("sms-vendor-{}", Uuid::new_v4().simple()),
        "Which vendor should we use for SMS?",
        None,
        Some(1),
    )
    .await;

    // An unanswered sibling is the positive control: it must be promoted by
    // the same sweep that must leave the answered ask alone. Its distinct
    // need key keeps this from exercising the filing dedupe slot instead.
    let control_ask_id = raise_with_window(
        &mut worker_ws,
        &worker,
        &leader.public_key().to_hex(),
        None,
        &task_id,
        &format!("sms-vendor-control-{}", Uuid::new_v4().simple()),
        "Control ask left unanswered for the sweep",
        None,
        Some(1),
    )
    .await;

    let addressed_to_leader = asks_addressed_to(&leader).await;
    assert!(
        addressed_to_leader
            .iter()
            .any(|ask| ask["id"] == serde_json::json!(ask_id))
            && addressed_to_leader
                .iter()
                .any(|ask| ask["id"] == serde_json::json!(control_ask_id)),
        "the leader must be able to see both asks addressed to it"
    );

    answer_ask(
        &mut leader_ws,
        &leader,
        &ask_id,
        "Use Twilio; we already hold the account",
    )
    .await;

    // The control's successor is the positive signal that the deadline sweep
    // actually ran in this test, rather than an absence that passes
    // vacuously when the sweep is dead.
    let control_successors = wait_for_successor(&executive, &control_ask_id).await;
    let successors = asks_addressed_to(&executive)
        .await
        .into_iter()
        .chain(asks_addressed_to(&owner).await)
        .filter(|ask| tag_value(ask, "prior") == ask_id)
        .collect::<Vec<_>>();
    assert!(
        successors.is_empty(),
        "an answered ask must not be promoted to the executive or owner; successors: {successors:#?}; positive control: {control_successors:#?}"
    );

    let closures = closures_naming(&owner, std::slice::from_ref(&ask_id)).await;
    assert_eq!(
        closures.len(),
        1,
        "answering must produce exactly one closure event for the ask"
    );

    let after = asks_addressed_to(&owner).await;
    assert_eq!(
        after.len(),
        before,
        "the owner's Needs-Me surface must be unchanged: an ask a leader \
         answered must never appear in front of the founder. Got {} asks, \
         expected {before}",
        after.len()
    );

    owner_ws.disconnect().await.ok();
    worker_ws.disconnect().await.ok();
    leader_ws.disconnect().await.ok();
}

/// The whole point: an employed worker, blocked on real work, files an Ask
/// that ends up in front of the human owner and is readable by the exact
/// query the owner's surface runs.
#[tokio::test]
#[ignore = "requires a running relay and Postgres"]
async fn an_employed_worker_raises_an_ask_that_reaches_the_owner() {
    let community_id = ensure_test_community(&relay_host()).await;

    let owner = Keys::generate();
    seed_relay_owner(community_id, &owner).await;

    let mut owner_ws = BuzzTestClient::connect(&relay_url(), &owner)
        .await
        .expect("owner connect");
    let ws = workspace(&mut owner_ws, owner.clone()).await;
    let (initiative_id, task_id) = start_initiative(&mut owner_ws, &ws).await;

    let worker = Keys::generate();
    let leader = Keys::generate();
    let executive = Keys::generate();
    employ_ladder(community_id, &owner, &worker, &leader, &executive).await;

    let mut worker_ws = BuzzTestClient::connect(&relay_url(), &worker)
        .await
        .expect("worker connect");
    let mut leader_ws = BuzzTestClient::connect(&relay_url(), &leader)
        .await
        .expect("leader connect");
    let mut executive_ws = BuzzTestClient::connect(&relay_url(), &executive)
        .await
        .expect("executive connect");

    let need = format!("batch-size-{}", Uuid::new_v4().simple());

    let raised = raise(
        &mut worker_ws,
        &worker,
        &leader.public_key().to_hex(),
        Some(&initiative_id),
        &task_id,
        &need,
        "Choose the outreach batch size",
        None,
    )
    .await;
    let escalated = raise(
        &mut leader_ws,
        &leader,
        &executive.public_key().to_hex(),
        Some(&initiative_id),
        &task_id,
        &format!("{need}-esc"),
        "Leader cannot unblock: choose the outreach batch size",
        Some(&raised),
    )
    .await;
    let filed = raise(
        &mut executive_ws,
        &executive,
        &owner.public_key().to_hex(),
        Some(&initiative_id),
        &task_id,
        &format!("{need}-filed"),
        "Your call: choose the outreach batch size",
        Some(&escalated),
    )
    .await;

    let mine = asks_addressed_to(&owner).await;
    let found = mine
        .iter()
        .find(|event| event["id"].as_str() == Some(filed.as_str()))
        .unwrap_or_else(|| {
            panic!("the ask filed to the owner must come back from {{kinds:[44300], #p:[owner]}}")
        });

    assert_eq!(tag_value(found, "initiative"), initiative_id);
    assert_eq!(tag_value(found, "task"), task_id);
    assert_eq!(tag_value(found, "prior"), escalated);

    let closed = closures_naming(&owner, std::slice::from_ref(&filed)).await;
    assert!(
        closed.is_empty(),
        "an ask nobody has answered must read as open, got {closed:#?}"
    );

    let earlier = closures_naming(&owner, &[raised.clone(), escalated.clone()]).await;
    assert_eq!(
        earlier.len(),
        2,
        "each superseded hop must be closed by its own withdrawal, got {earlier:#?}"
    );

    owner_ws.disconnect().await.ok();
    worker_ws.disconnect().await.ok();
    leader_ws.disconnect().await.ok();
    executive_ws.disconnect().await.ok();
}

/// The ordinary case: the work has no initiative.
#[tokio::test]
#[ignore = "requires a running relay and Postgres"]
async fn an_ask_about_chat_derived_work_with_no_initiative_still_reaches_the_owner() {
    let community_id = ensure_test_community(&relay_host()).await;

    let owner = Keys::generate();
    seed_relay_owner(community_id, &owner).await;

    let mut owner_ws = BuzzTestClient::connect(&relay_url(), &owner)
        .await
        .expect("owner connect");
    let ws = workspace(&mut owner_ws, owner.clone()).await;
    let task_id = create_chat_task(&mut owner_ws, &ws).await;

    let worker = Keys::generate();
    let leader = Keys::generate();
    let executive = Keys::generate();
    employ_ladder(community_id, &owner, &worker, &leader, &executive).await;

    let mut worker_ws = BuzzTestClient::connect(&relay_url(), &worker)
        .await
        .expect("worker connect");
    let mut leader_ws = BuzzTestClient::connect(&relay_url(), &leader)
        .await
        .expect("leader connect");
    let mut executive_ws = BuzzTestClient::connect(&relay_url(), &executive)
        .await
        .expect("executive connect");

    let need = format!("dns-txt-{}", Uuid::new_v4().simple());

    let raised = raise(
        &mut worker_ws,
        &worker,
        &leader.public_key().to_hex(),
        None,
        &task_id,
        &need,
        "DNS needs a TXT record only a human can add",
        None,
    )
    .await;
    let escalated = raise(
        &mut leader_ws,
        &leader,
        &executive.public_key().to_hex(),
        None,
        &task_id,
        &format!("{need}-esc"),
        "Leader cannot add the DNS record either",
        Some(&raised),
    )
    .await;
    let filed = raise(
        &mut executive_ws,
        &executive,
        &owner.public_key().to_hex(),
        None,
        &task_id,
        &format!("{need}-filed"),
        "Only you can add the DNS TXT record",
        Some(&escalated),
    )
    .await;

    let mine = asks_addressed_to(&owner).await;
    let found = mine
        .iter()
        .find(|event| event["id"].as_str() == Some(filed.as_str()))
        .expect("an ask about initiative-less work must reach the owner like any other");

    assert_eq!(tag_value(found, "initiative"), NO_INITIATIVE);
    assert_eq!(tag_value(found, "task"), task_id);

    let closed = closures_naming(&owner, std::slice::from_ref(&filed)).await;
    assert!(
        closed.is_empty(),
        "an unanswered ask must read as open, got {closed:#?}"
    );

    owner_ws.disconnect().await.ok();
    worker_ws.disconnect().await.ok();
    leader_ws.disconnect().await.ok();
    executive_ws.disconnect().await.ok();
}

/// The shape that actually runs: agents with no `employees` row at all.
#[tokio::test]
#[ignore = "requires a running relay and Postgres"]
async fn a_managed_agent_that_is_not_an_employee_raises_an_ask_to_the_owner() {
    let community_id = ensure_test_community(&relay_host()).await;

    let owner = Keys::generate();
    seed_relay_owner(community_id, &owner).await;

    let mut owner_ws = BuzzTestClient::connect(&relay_url(), &owner)
        .await
        .expect("owner connect");
    let ws = workspace(&mut owner_ws, owner.clone()).await;
    let task_id = create_chat_task(&mut owner_ws, &ws).await;

    let run = Uuid::new_v4().simple().to_string();
    let run = &run[..8];
    let engineer_role = format!("frontend-engineer-{run}");
    let lead_role = format!("cto-{run}");
    let chief_role = format!("chief-of-staff-{run}");
    for (role, rank) in [
        (&engineer_role, "worker"),
        (&lead_role, "leader"),
        (&chief_role, "executive"),
    ] {
        employ(community_id, &owner, &Keys::generate(), role, rank).await;
    }

    let worker_agent = Keys::generate();
    let leader_agent = Keys::generate();
    let executive_agent = Keys::generate();
    publish_role_head(&mut owner_ws, &owner, &worker_agent, &engineer_role).await;
    publish_role_head(&mut owner_ws, &owner, &leader_agent, &lead_role).await;
    publish_role_head(&mut owner_ws, &owner, &executive_agent, &chief_role).await;

    let mut worker_ws = BuzzTestClient::connect(&relay_url(), &worker_agent)
        .await
        .expect("worker connect");
    let mut leader_ws = BuzzTestClient::connect(&relay_url(), &leader_agent)
        .await
        .expect("leader connect");
    let mut executive_ws = BuzzTestClient::connect(&relay_url(), &executive_agent)
        .await
        .expect("executive connect");

    let need = format!("vendor-key-{run}");
    let raised = raise(
        &mut worker_ws,
        &worker_agent,
        &leader_agent.public_key().to_hex(),
        None,
        &task_id,
        &need,
        "Need the vendor API key",
        None,
    )
    .await;
    let escalated = raise(
        &mut leader_ws,
        &leader_agent,
        &executive_agent.public_key().to_hex(),
        None,
        &task_id,
        &format!("{need}-esc"),
        "Lead cannot provision the vendor API key",
        Some(&raised),
    )
    .await;
    let filed = raise(
        &mut executive_ws,
        &executive_agent,
        &owner.public_key().to_hex(),
        None,
        &task_id,
        &format!("{need}-filed"),
        "Only you can provision the vendor API key",
        Some(&escalated),
    )
    .await;

    let mine = asks_addressed_to(&owner).await;
    let found = mine
        .iter()
        .find(|event| event["id"].as_str() == Some(filed.as_str()))
        .expect("an ask raised by the agents the product actually runs must reach the owner");
    assert_eq!(tag_value(found, "task"), task_id);
    assert_eq!(tag_value(found, "prior"), escalated);

    let direct = EventBuilder::new(
        Kind::Custom(KIND_STREAM_MESSAGE as u16),
        "hey owner, got a sec?",
    )
    .tags(vec![
        Tag::parse(["h", &Uuid::new_v4().to_string()]).expect("h tag"),
        Tag::parse(["p", &owner.public_key().to_hex()]).expect("p tag"),
    ])
    .sign_with_keys(&worker_agent)
    .expect("sign direct message");
    let wall = worker_ws
        .send_event(direct)
        .await
        .expect("the relay answers the probe");
    assert!(
        !wall.accepted,
        "a worker-ranked managed agent must not address the owner directly"
    );
    assert!(
        wall.message.contains("cannot address an owner"),
        "unexpected wall-probe rejection: {}",
        wall.message
    );

    owner_ws.disconnect().await.ok();
    worker_ws.disconnect().await.ok();
    leader_ws.disconnect().await.ok();
    executive_ws.disconnect().await.ok();
}
