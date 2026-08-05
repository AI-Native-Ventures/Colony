//! End-to-end proof of the job queue (`docs/design/company-employees.html`, phase 2).
//!
//! The phase gate is: a job filed by one member, claimed and completed by a
//! worker, survives a mid-job worker kill by being re-leased. Everything here
//! goes through the door a real client uses (signed events over HTTP `/events`
//! and `/query`); nothing calls into `buzz-relay`'s internals, so what passes
//! here is what a worker on a founder's laptop would see.
//!
//! Five properties, each of which the queue is worthless without:
//!
//! 1. **A job runs end to end.** Filed, claimed, heartbeat, finished, with the
//!    result readable off the head.
//! 2. **A dead worker's job comes back.** This is the gate. A worker that
//!    stops heartbeating loses its lease, and the next claim takes the job
//!    over rather than the work being lost.
//! 3. **A stale worker cannot overwrite the live one.** One founder's laptop
//!    and desktop share an identity, so the pubkey alone cannot tell them
//!    apart; the attempt count is the fencing token that can.
//! 4. **Only the job's own human may claim it.** One seat running another
//!    member's work would be account sharing however it were dressed up, and
//!    is the design's one hard prohibition.
//! 5. **A job that keeps killing workers stops being offered.** Without a cap,
//!    a poison job takes every seat in the company down in turn.
//! 6. **A job head cannot be forged.** Workers decide whether to keep going by
//!    reading the head, so a forged one could stop a worker dead or invent
//!    work that was never done.
//!
//! One path here is deliberately not covered: a job filed *by an employee* on
//! a human's behalf. Only the relay can sign as an employee and nothing does
//! until worker mode exists, so there is no way to reach it from a client
//! today. See `job_broker::resolve_originator`.
//!
//! # Running
//!
//! ```text
//! set -a && source .env && set +a
//! export BUZZ_EMPLOYEE_KEK=$(openssl rand -hex 32)   # relay must have this too
//! cargo test -p buzz-test-client --test e2e_jobs -- --ignored
//! ```
//!
//! Requires a relay started with `BUZZ_EMPLOYEE_KEK` configured. Without it
//! there are no employees to file jobs against, and these tests fail at the
//! first assertion rather than silently downgrading.

mod common;

use std::time::Duration;

use nostr::{EventBuilder, Keys, Kind, Tag};
use uuid::Uuid;

use buzz_core::job::MAX_JOB_ATTEMPTS;
use buzz_core::kind::{
    KIND_EMPLOYEE, KIND_HIRE_REQUEST, KIND_JOB_CLAIM, KIND_JOB_FILING, KIND_JOB_HEAD,
    KIND_JOB_HEARTBEAT, KIND_JOB_OUTCOME,
};

use common::{default_community, e2e_db_pool, query, seed_relay_owner, submit, tag_value};

/// Hire an employee and return its pubkey.
///
/// A fixture for these tests, and itself proven by `e2e_employees.rs`: the
/// relay mints the keypair, so the pubkey is only knowable by reading back
/// what it published.
async fn hire_an_employee(owner: &Keys) -> String {
    let role = format!("e2e-job-role-{}", Uuid::new_v4().simple());
    let request = EventBuilder::new(Kind::Custom(KIND_HIRE_REQUEST as u16), "")
        .tags(vec![
            Tag::parse(["role", &role]).unwrap(),
            Tag::parse(["name", "Sift"]).unwrap(),
            Tag::parse(["rank", "worker"]).unwrap(),
        ])
        .sign_with_keys(owner)
        .expect("sign hire request");
    let (accepted, body) = submit(&request).await;
    assert!(accepted, "hire request not accepted: {body}");

    let hire_id = request.id.to_hex();
    for _ in 0..40 {
        let heads = query(owner, serde_json::json!({ "kinds": [KIND_EMPLOYEE] })).await;
        if let Some(head) = heads.iter().find(|head| tag_value(head, "e") == hire_id) {
            return head["pubkey"].as_str().expect("head author").to_string();
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    panic!("no employee appeared for hire request {hire_id}");
}

fn file_job(filer: &Keys, employee: &str, instruction: &str) -> nostr::Event {
    EventBuilder::new(Kind::Custom(KIND_JOB_FILING as u16), instruction)
        .tags(vec![Tag::parse(["p", employee]).unwrap()])
        .sign_with_keys(filer)
        .expect("sign job filing")
}

fn claim_job(worker: &Keys, job: &str) -> nostr::Event {
    // A fresh nonce per claim, exactly as a real worker does. Without it a
    // second claim in the same second is byte-identical to the first, and the
    // relay correctly discards it as a duplicate event -- which is how the
    // first run of this suite reported "the lease was not re-taken" when in
    // truth the second claim never reached the relay at all.
    EventBuilder::new(Kind::Custom(KIND_JOB_CLAIM as u16), "")
        .tags(vec![
            Tag::parse(["job", job]).unwrap(),
            Tag::parse(["nonce", &Uuid::new_v4().to_string()]).unwrap(),
        ])
        .sign_with_keys(worker)
        .expect("sign job claim")
}

fn heartbeat_job(worker: &Keys, job: &str, attempt: i32) -> nostr::Event {
    EventBuilder::new(Kind::Custom(KIND_JOB_HEARTBEAT as u16), "")
        .tags(vec![
            Tag::parse(["job", job]).unwrap(),
            Tag::parse(["attempt", &attempt.to_string()]).unwrap(),
        ])
        .sign_with_keys(worker)
        .expect("sign job heartbeat")
}

fn finish_job(worker: &Keys, job: &str, attempt: i32, status: &str, detail: &str) -> nostr::Event {
    EventBuilder::new(Kind::Custom(KIND_JOB_OUTCOME as u16), detail)
        .tags(vec![
            Tag::parse(["job", job]).unwrap(),
            Tag::parse(["attempt", &attempt.to_string()]).unwrap(),
            Tag::parse(["status", status]).unwrap(),
        ])
        .sign_with_keys(worker)
        .expect("sign job outcome")
}

/// Poll for the job head in a given state.
///
/// Every job request is answered by republishing the head, and that republish
/// happens in a side effect after the request is stored, so the head is
/// legitimately not yet updated the instant a write is accepted.
async fn await_job_state(reader: &Keys, job: &str, wanted: &str) -> serde_json::Value {
    let mut last = String::new();
    for _ in 0..40 {
        if let Some(head) = current_head(reader, job).await {
            last = tag_value(&head, "status");
            if last == wanted {
                return head;
            }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    panic!("job {job} never reached {wanted}; last seen {last:?}");
}

/// Poll until the job head satisfies `wanted`.
///
/// Waiting on a status alone is not enough once a job has been through a state
/// before: after a lapsed lease is re-claimed, the head is `leased` both
/// before and after, so a status wait returns the stale head instantly and the
/// test measures nothing. Waiting on a predicate lets each test say what it is
/// actually waiting for.
async fn await_head(
    reader: &Keys,
    job: &str,
    describe: &str,
    wanted: impl Fn(&serde_json::Value) -> bool,
) -> serde_json::Value {
    let mut last = serde_json::Value::Null;
    for _ in 0..40 {
        if let Some(head) = current_head(reader, job).await {
            if wanted(&head) {
                return head;
            }
            last = head;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    panic!("job {job} never became {describe}; last head was {last}");
}

/// The newest head for a job.
///
/// Heads are replaceable, so the current one is the one with the highest
/// `created_at`. Taking whichever the relay happens to return first would make
/// this suite pass or fail on row order rather than on behaviour.
async fn current_head(reader: &Keys, job: &str) -> Option<serde_json::Value> {
    query(
        reader,
        serde_json::json!({ "kinds": [KIND_JOB_HEAD], "#d": [job] }),
    )
    .await
    .into_iter()
    .max_by_key(|head| head["created_at"].as_i64().unwrap_or(0))
}

fn attempt_of(head: &serde_json::Value) -> i32 {
    tag_value(head, "attempts")
        .parse()
        .expect("head carries an attempt count")
}

fn head_content(head: &serde_json::Value) -> serde_json::Value {
    head["content"]
        .as_str()
        .and_then(|raw| serde_json::from_str(raw).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

/// Rewind a lease's deadline into the past.
///
/// This is the fixture that stands in for time passing. A real worker dies by
/// simply not heartbeating, and two minutes later its lease lapses; waiting
/// two minutes in a test proves nothing extra, so the clock is moved instead.
/// Nothing else about the failure is simulated: the takeover under test is the
/// relay's own compare-and-set, reached through the same claim event a second
/// worker would send.
async fn lapse_the_lease(community: Uuid, job: &str) {
    let pool = e2e_db_pool().await;
    let updated =
        sqlx::query("UPDATE jobs SET lease_expires_at = 1 WHERE community_id = $1 AND job_id = $2")
            .bind(community)
            .bind(hex::decode(job).expect("job id is hex"))
            .execute(&pool)
            .await
            .expect("rewind the lease deadline");
    assert_eq!(
        updated.rows_affected(),
        1,
        "expected exactly one job row to rewind"
    );
}

#[tokio::test]
#[ignore = "requires a running relay with BUZZ_EMPLOYEE_KEK and Postgres"]
async fn a_job_runs_from_filing_to_result() {
    let community = default_community().await;
    let founder = Keys::generate();
    seed_relay_owner(community, &founder).await;
    let employee = hire_an_employee(&founder).await;

    let filing = file_job(&founder, &employee, "Draft the investor update");
    let (accepted, body) = submit(&filing).await;
    assert!(accepted, "job filing not accepted: {body}");
    let job = filing.id.to_hex();

    // Filed work waits for somebody to pick it up, and says whose it is.
    let open = await_job_state(&founder, &job, "open").await;
    assert_eq!(tag_value(&open, "employee"), employee);
    assert_eq!(
        tag_value(&open, "originator"),
        founder.public_key().to_hex(),
        "a job filed by a human belongs to that human"
    );
    assert_eq!(
        tag_value(&open, "lease-holder"),
        "",
        "nothing is holding an open job"
    );

    let (accepted, body) = submit(&claim_job(&founder, &job)).await;
    assert!(accepted, "claim not accepted: {body}");
    let leased = await_job_state(&founder, &job, "leased").await;
    assert_eq!(
        tag_value(&leased, "lease-holder"),
        founder.public_key().to_hex()
    );
    let attempt = attempt_of(&leased);
    assert_eq!(attempt, 1, "the first claim is attempt 1");

    let expires_after_claim: i64 = tag_value(&leased, "lease-expires")
        .parse()
        .expect("a leased job has a deadline");

    // A heartbeat holds the lease open. Sleeping a second guarantees the new
    // deadline is measurably later rather than the same second.
    tokio::time::sleep(Duration::from_secs(1)).await;
    let (accepted, body) = submit(&heartbeat_job(&founder, &job, attempt)).await;
    assert!(accepted, "heartbeat not accepted: {body}");
    for _ in 0..40 {
        let head = await_job_state(&founder, &job, "leased").await;
        let expires: i64 = tag_value(&head, "lease-expires").parse().unwrap_or(0);
        if expires > expires_after_claim {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }

    let (accepted, body) = submit(&finish_job(
        &founder,
        &job,
        attempt,
        "done",
        "Here is the draft",
    ))
    .await;
    assert!(accepted, "outcome not accepted: {body}");

    let done = await_job_state(&founder, &job, "done").await;
    assert_eq!(
        head_content(&done)["result"],
        serde_json::json!("Here is the draft"),
        "the head carries what the worker reported"
    );
}

#[tokio::test]
#[ignore = "requires a running relay with BUZZ_EMPLOYEE_KEK and Postgres"]
async fn a_killed_worker_loses_its_lease_and_the_job_is_re_leased() {
    // The phase gate. A worker that dies mid-job announces nothing, so the
    // only thing that can save the work is the lease lapsing and somebody
    // else being able to take it.
    let community = default_community().await;
    let founder = Keys::generate();
    seed_relay_owner(community, &founder).await;
    let employee = hire_an_employee(&founder).await;

    let filing = file_job(&founder, &employee, "Reconcile the ledger");
    assert!(submit(&filing).await.0, "job filing not accepted");
    let job = filing.id.to_hex();
    await_job_state(&founder, &job, "open").await;

    assert!(submit(&claim_job(&founder, &job)).await.0, "first claim");
    let first_lease = await_job_state(&founder, &job, "leased").await;
    let first_attempt = attempt_of(&first_lease);
    assert_eq!(first_attempt, 1);

    // The worker dies here: no heartbeat ever comes, and the deadline passes.
    lapse_the_lease(community, &job).await;

    // A second worker asks for the job. Nothing has told it the first one
    // died; it simply claims, and the relay decides.
    let (accepted, body) = submit(&claim_job(&founder, &job)).await;
    assert!(accepted, "second claim not accepted: {body}");

    let second_lease = await_head(&founder, &job, "leased on a later attempt", |head| {
        tag_value(head, "status") == "leased" && attempt_of(head) > first_attempt
    })
    .await;
    let second_attempt = attempt_of(&second_lease);
    assert_eq!(
        second_attempt,
        first_attempt + 1,
        "a lapsed lease must be taken over as a new attempt, not silently reused"
    );

    // And the re-leased job finishes normally, which is the part that makes
    // this a recovery rather than merely a status change.
    let (accepted, body) = submit(&finish_job(
        &founder,
        &job,
        second_attempt,
        "done",
        "Ledger reconciled on the second machine",
    ))
    .await;
    assert!(accepted, "second worker's outcome not accepted: {body}");

    let done = await_job_state(&founder, &job, "done").await;
    assert_eq!(
        head_content(&done)["result"],
        serde_json::json!("Ledger reconciled on the second machine")
    );
}

#[tokio::test]
#[ignore = "requires a running relay with BUZZ_EMPLOYEE_KEK and Postgres"]
async fn a_stale_worker_cannot_overwrite_the_live_one() {
    // Both workers are the same founder, because that is the real case: a
    // laptop and a desktop signed in as one person hold the same key. Without
    // the attempt fence the relay could not tell them apart, and the worker
    // that hung would be allowed to answer over the one still working.
    let community = default_community().await;
    let founder = Keys::generate();
    seed_relay_owner(community, &founder).await;
    let employee = hire_an_employee(&founder).await;

    let filing = file_job(&founder, &employee, "Summarize the pipeline");
    assert!(submit(&filing).await.0, "job filing not accepted");
    let job = filing.id.to_hex();
    await_job_state(&founder, &job, "open").await;

    assert!(submit(&claim_job(&founder, &job)).await.0, "first claim");
    let stale_attempt = attempt_of(&await_job_state(&founder, &job, "leased").await);

    lapse_the_lease(community, &job).await;
    assert!(submit(&claim_job(&founder, &job)).await.0, "second claim");
    let live_attempt = attempt_of(
        &await_head(&founder, &job, "leased on a later attempt", |head| {
            tag_value(head, "status") == "leased" && attempt_of(head) > stale_attempt
        })
        .await,
    );
    assert_ne!(stale_attempt, live_attempt);

    // The hung worker wakes up and reports the answer it computed before it
    // lost the job. Its event is well-formed and correctly signed; the only
    // thing wrong with it is that it belongs to a lease that is over.
    let (_, body) = submit(&finish_job(
        &founder,
        &job,
        stale_attempt,
        "done",
        "stale answer from the machine that hung",
    ))
    .await;

    // The event may be stored (it is an ordinary signed event); what must not
    // happen is the job ending on it.
    tokio::time::sleep(Duration::from_secs(1)).await;
    let head = current_head(&founder, &job).await.expect("job head exists");
    assert_eq!(
        tag_value(&head, "status"),
        "leased",
        "a superseded lease must not be able to finish the job: {body}"
    );

    // The worker that actually holds the lease still can.
    assert!(
        submit(&finish_job(
            &founder,
            &job,
            live_attempt,
            "done",
            "the real answer",
        ))
        .await
        .0,
        "the current lease holder must still be able to finish"
    );
    let done = await_job_state(&founder, &job, "done").await;
    assert_eq!(
        head_content(&done)["result"],
        serde_json::json!("the real answer"),
        "the live worker's answer is the one that stands"
    );
}

#[tokio::test]
#[ignore = "requires a running relay with BUZZ_EMPLOYEE_KEK and Postgres"]
async fn only_the_jobs_own_human_may_claim_it() {
    // A worker runs on its member's machine, on that member's subscription,
    // under that member's vendor account. One seat picking up another
    // member's work is account sharing whatever it is called, so the relay
    // refuses it rather than helpfully rerouting.
    let community = default_community().await;
    let founder = Keys::generate();
    seed_relay_owner(community, &founder).await;
    let cofounder = Keys::generate();
    seed_relay_owner(community, &cofounder).await;
    let employee = hire_an_employee(&founder).await;

    let filing = file_job(&founder, &employee, "Call the bank");
    assert!(submit(&filing).await.0, "job filing not accepted");
    let job = filing.id.to_hex();
    await_job_state(&founder, &job, "open").await;

    // The co-founder's worker tries to help. It is a real member of the same
    // community and its event is perfectly valid.
    let _ = submit(&claim_job(&cofounder, &job)).await;
    tokio::time::sleep(Duration::from_secs(1)).await;

    let head = current_head(&founder, &job).await.expect("job head exists");
    assert_eq!(
        tag_value(&head, "status"),
        "open",
        "another member's seat must not be able to take this job"
    );
    assert_eq!(
        tag_value(&head, "lease-holder"),
        "",
        "and must not appear as its holder"
    );

    // Positive control. Without it this test passes just as happily when
    // claiming is broken for everybody, which is exactly what happened on the
    // first run of this suite: every claim was being dropped and this test
    // reported the refusal as a security guarantee.
    assert!(
        submit(&claim_job(&founder, &job)).await.0,
        "the job's own human must still be able to claim it"
    );
    let leased = await_job_state(&founder, &job, "leased").await;
    assert_eq!(
        tag_value(&leased, "lease-holder"),
        founder.public_key().to_hex()
    );
}

#[tokio::test]
#[ignore = "requires a running relay with BUZZ_EMPLOYEE_KEK and Postgres"]
async fn a_job_that_keeps_killing_workers_stops_being_offered() {
    // Re-leasing is what saves work from a dead machine. Without a bound it
    // is also how one bad job takes down every machine in the company, one
    // after another, each of them looking like an unrelated crash.
    let community = default_community().await;
    let founder = Keys::generate();
    seed_relay_owner(community, &founder).await;
    let employee = hire_an_employee(&founder).await;

    let filing = file_job(&founder, &employee, "Run the job that kills workers");
    assert!(submit(&filing).await.0, "job filing not accepted");
    let job = filing.id.to_hex();
    await_job_state(&founder, &job, "open").await;

    // Every worker that takes it dies without reporting anything.
    for attempt in 1..=MAX_JOB_ATTEMPTS {
        assert!(
            submit(&claim_job(&founder, &job)).await.0,
            "claim {attempt} not accepted"
        );
        await_head(
            &founder,
            &job,
            &format!("leased on attempt {attempt}"),
            |head| tag_value(head, "status") == "leased" && attempt_of(head) == attempt,
        )
        .await;
        lapse_the_lease(community, &job).await;
    }

    // The next machine to ask is turned away rather than handed the same job.
    let _ = submit(&claim_job(&founder, &job)).await;
    tokio::time::sleep(Duration::from_secs(1)).await;
    let head = current_head(&founder, &job).await.expect("job head exists");
    assert_eq!(
        attempt_of(&head),
        MAX_JOB_ATTEMPTS,
        "a job at the attempt cap must not be leased again"
    );
    // The status is deliberately not asserted here. Moving the row to
    // `abandoned` and raising it with its owner is the sweep's work, on the
    // relay's own timer, and this test does not wait on a timer it does not
    // control. What it proves is the part that has to hold instantly: the next
    // machine to ask was not handed the job.
}

#[tokio::test]
#[ignore = "requires a running relay with BUZZ_EMPLOYEE_KEK and Postgres"]
async fn a_stranger_cannot_publish_a_job_head() {
    // A worker reads the head to decide whether it still holds its lease, so
    // a forged head is a way to stop somebody else's work, or to report a
    // result nobody produced.
    let impostor = Keys::generate();
    let forged = EventBuilder::new(
        Kind::Custom(KIND_JOB_HEAD as u16),
        "{\"instruction\":\"x\"}",
    )
    .tags(vec![
        Tag::parse(["d", &"22".repeat(32)]).unwrap(),
        Tag::parse(["employee", &impostor.public_key().to_hex()]).unwrap(),
        Tag::parse(["originator", &impostor.public_key().to_hex()]).unwrap(),
        Tag::parse(["filed-by", &impostor.public_key().to_hex()]).unwrap(),
        Tag::parse(["status", "done"]).unwrap(),
        Tag::parse(["attempts", "1"]).unwrap(),
    ])
    .sign_with_keys(&impostor)
    .expect("sign forged head");

    let (accepted, body) = submit(&forged).await;
    assert!(!accepted, "a forged job head must be refused: {body}");
    // And refused *because* the author is not an employee. Asserting the
    // reason keeps this honest: an unregistered kind would be refused as
    // "unknown event kind" without the employment gate ever running, which is
    // a vacuous pass dressed up as a security guarantee. That is exactly how
    // phase 1 shipped unreachable.
    let error = body["error"].as_str().unwrap_or_default();
    assert!(
        error.contains("not an employee"),
        "expected the employment gate to refuse this, got: {error}"
    );
}
