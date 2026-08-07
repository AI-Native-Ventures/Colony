//! End-to-end proof of the job queue (`docs/design/company-employees.html`,
//! phases 2 and 3). Phase 2 is the queue itself; phase 3 is the execution
//! stamp on a finished head and the usage record a seat posts to the ledger.
//!
//! The phase 2 gate is: a job filed by one member, claimed and completed by a
//! worker, survives a mid-job worker kill by being re-leased. The phase 3
//! gate is: the same employee completes jobs for both founders on different
//! bindings, stamps and ledger correct. Most tests here sign the events a
//! worker would sign directly; the last one drives the real worker loop
//! (`buzz_cli::worker::run_worker_once`) against a real seat config on disk
//! and a local provider stub, so binding selection is proven, not assumed.
//! Everything goes through the door a real client uses (signed events over
//! HTTP `/events` and `/query`); nothing calls into `buzz-relay`'s internals,
//! so what passes here is what a worker on a founder's laptop would see.
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

use nostr::{Event, EventBuilder, JsonUtil, Keys, Kind, Tag, Timestamp};
use uuid::Uuid;

use buzz_core::job::MAX_JOB_ATTEMPTS;
use buzz_core::kind::{
    KIND_EMPLOYEE, KIND_HIRE_REQUEST, KIND_JOB_CLAIM, KIND_JOB_FILING, KIND_JOB_HEAD,
    KIND_JOB_HEARTBEAT, KIND_JOB_OUTCOME, KIND_USAGE_RECORD,
};
use buzz_core::usage_record::{
    decrypt_usage_record, encrypt_usage_record, PaymentMode, UsageBreakdown, UsageRecordPayload,
    UsageSource,
};

use common::{default_community, e2e_db_pool, query, seed_relay_owner, submit, tag_value};

use buzz_cli::seat::load_seat_config;
use buzz_cli::worker::run_worker_once;
use buzz_cli::BuzzClient;

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

/// Finish a job with the execution stamp a worker's seat puts on it.
fn finish_job_stamped(
    worker: &Keys,
    job: &str,
    attempt: i32,
    status: &str,
    detail: &str,
    provider: &str,
    model: &str,
) -> nostr::Event {
    EventBuilder::new(Kind::Custom(KIND_JOB_OUTCOME as u16), detail)
        .tags(vec![
            Tag::parse(["job", job]).unwrap(),
            Tag::parse(["attempt", &attempt.to_string()]).unwrap(),
            Tag::parse(["status", status]).unwrap(),
            Tag::parse(["provider", provider]).unwrap(),
            Tag::parse(["model", model]).unwrap(),
        ])
        .sign_with_keys(worker)
        .expect("sign stamped job outcome")
}

/// Publish the usage record a worker's seat posts after one LLM call.
async fn publish_usage_record(
    founder: &Keys,
    employee: &str,
    provider: &str,
    model: &str,
    job: &str,
) -> String {
    let payload = UsageRecordPayload {
        source: UsageSource::Wire,
        provider: provider.to_string(),
        request_id: format!("req-{job}"),
        model: Some(model.to_string()),
        timestamp: Timestamp::now().to_human_datetime(),
        payment_mode: PaymentMode::Metered,
        tokens: Some(UsageBreakdown {
            input_uncached_tokens: 100,
            cache_read_tokens: 0,
            cache_write_5m_tokens: 0,
            cache_write_1h_tokens: 0,
            output_tokens: 40,
        }),
        amount_nanousd: None,
        observed_cost_nanousd: None,
        harness: Some("buzz-worker".to_string()),
        session_id: None,
        turn_id: Some(job.to_string()),
        http_status: Some(200),
        description: None,
        agent_pubkey: Some(employee.to_string()),
        channel_id: None,
        work_context: None,
    };
    let founder_hex = founder.public_key().to_hex();
    let ciphertext =
        encrypt_usage_record(founder, &founder.public_key(), &payload).expect("record encrypts");
    let event = EventBuilder::new(Kind::Custom(KIND_USAGE_RECORD as u16), ciphertext)
        .tags(vec![
            Tag::parse(["p", &founder_hex]).unwrap(),
            Tag::parse(["agent", &founder_hex]).unwrap(),
        ])
        .sign_with_keys(founder)
        .expect("record signs");

    let (accepted, body) = submit(&event).await;
    assert!(accepted, "usage record not accepted: {body}");
    event.id.to_hex()
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

    // The two subscriptions everything downstream is built on. A worker finds
    // its own work by `#p` on its own pubkey; an employee's queue is the heads
    // it authored. Asserted here because the failure mode is silence: a filter
    // that matches nothing looks exactly like having no work, and an earlier
    // version of this queue tagged the employee in a way nostr drops, so
    // `#p` on an employee matched nothing and nothing noticed.
    let mine = query(
        &founder,
        serde_json::json!({ "kinds": [KIND_JOB_HEAD], "#p": [founder.public_key().to_hex()] }),
    )
    .await;
    assert!(
        mine.iter().any(|head| tag_value(head, "d") == job),
        "a worker must find its own job by p tag"
    );
    let theirs = query(
        &founder,
        serde_json::json!({ "kinds": [KIND_JOB_HEAD], "authors": [employee] }),
    )
    .await;
    assert!(
        theirs.iter().any(|head| tag_value(head, "d") == job),
        "an employee's queue must be the heads it authored"
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
    // Wait for the deadline to actually move, and fail if it never does. A
    // loop that only breaks on success passes just as happily when heartbeats
    // do nothing at all, which would leave every long job in the company
    // losing its lease mid-run.
    await_head(&founder, &job, "held open by a heartbeat", |head| {
        tag_value(head, "lease-expires")
            .parse::<i64>()
            .is_ok_and(|expires| expires > expires_after_claim)
    })
    .await;

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

#[tokio::test]
#[ignore = "requires a running relay with BUZZ_EMPLOYEE_KEK and Postgres"]
async fn the_same_employee_completes_both_founders_jobs_with_distinct_stamps() {
    // Phase 3 gate: the same employee completes jobs for both founders on
    // different bindings, and each finished head carries that seat's stamp
    // (lease holder, provider, model) plus the ledger record for the call.
    let community = default_community().await;
    let founder_a = Keys::generate();
    let founder_b = Keys::generate();
    seed_relay_owner(community, &founder_a).await;
    seed_relay_owner(community, &founder_b).await;
    let employee = hire_an_employee(&founder_a).await;

    let filing_a = file_job(&founder_a, &employee, "Draft the investor update");
    let filing_b = file_job(&founder_b, &employee, "Summarize the pipeline");
    assert!(
        submit(&filing_a).await.0,
        "founder A's filing was not accepted"
    );
    assert!(
        submit(&filing_b).await.0,
        "founder B's filing was not accepted"
    );
    let job_a = filing_a.id.to_hex();
    let job_b = filing_b.id.to_hex();
    await_job_state(&founder_a, &job_a, "open").await;
    await_job_state(&founder_b, &job_b, "open").await;

    for (founder, job, provider, model, result) in [
        (
            &founder_a,
            job_a.as_str(),
            "deepseek",
            "deepseek-chat",
            "draft ready",
        ),
        (
            &founder_b,
            job_b.as_str(),
            "openrouter",
            "anthropic/claude-sonnet-4",
            "pipeline summary",
        ),
    ] {
        assert!(
            submit(&claim_job(founder, job)).await.0,
            "{provider} seat could not claim its own job"
        );
        let leased = await_job_state(founder, job, "leased").await;
        assert_eq!(
            tag_value(&leased, "lease-holder"),
            founder.public_key().to_hex(),
            "the claiming founder must hold the lease"
        );
        let attempt = attempt_of(&leased);

        assert!(
            submit(&finish_job_stamped(
                founder, job, attempt, "done", result, provider, model,
            ))
            .await
            .0,
            "{provider} seat could not finish its job"
        );

        let done = await_job_state(founder, job, "done").await;
        assert_eq!(
            tag_value(&done, "employee"),
            employee,
            "both jobs must be owed by the same employee"
        );
        assert_eq!(
            tag_value(&done, "lease-holder"),
            founder.public_key().to_hex(),
            "the head must name the founder whose seat executed it"
        );
        assert_eq!(tag_value(&done, "attempts"), "1");
        assert_eq!(tag_value(&done, "provider"), provider);
        assert_eq!(tag_value(&done, "model"), model);
        assert_eq!(
            head_content(&done)["result"],
            serde_json::json!(result),
            "the finished head must carry the seat's result"
        );

        let record_id = publish_usage_record(founder, &employee, provider, model, job).await;
        assert!(!record_id.is_empty(), "usage record id must be present");

        // The seat authored the record itself, so the relay drops the
        // self-referential `p` tag; the ledger still has to be able to read
        // it back by author. This is the read shape the CLI report uses.
        let readback = query(
            founder,
            serde_json::json!({
                "kinds": [KIND_USAGE_RECORD],
                "authors": [founder.public_key().to_hex()]
            }),
        )
        .await;
        let record = readback.iter().find_map(|value| {
            let Ok(event) = Event::from_json(value.to_string()) else {
                return None;
            };
            decrypt_usage_record(founder, &event).ok()
        });
        let record = record.expect("the founder must be able to read its usage record");
        assert_eq!(record.provider, provider);
        assert_eq!(record.model.as_deref(), Some(model));
        assert_eq!(record.agent_pubkey.as_deref(), Some(employee.as_str()));
    }
}

/// Write a real seat config for `employee` into a fresh temp dir and load it
/// back through `load_seat_config`, the loader a real seat uses.
///
/// The `BUZZ_SEAT_CONFIG` env var redirects the loader to the file, exactly
/// as it would for a seat pointing at a shared or per-worktree config. The
/// returned config is what the worker runs on; nothing here builds a
/// `SeatConfig` in memory.
fn write_seat_config(
    employee: &str,
    provider: &str,
    model: &str,
    endpoint: &str,
    key_var: &str,
) -> (buzz_cli::seat::SeatConfig, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("buzz-e2e-seat-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("seat.toml");
    let toml = format!(
        "[employees.{employee}]\n\
         bindings = [\n\
         \x20 {{ provider = \"{provider}\", model = \"{model}\", endpoint = \"{endpoint}\", key_var = \"{key_var}\" }},\n\
         ]\n"
    );
    std::fs::write(&path, toml).unwrap();
    std::env::set_var("BUZZ_SEAT_CONFIG", &path);
    let config = load_seat_config()
        .unwrap_or_else(|e| panic!("load seat config from {}: {e}", path.display()));
    (config, path)
}

/// Spawn a tiny OpenAI-compatible provider stub on an ephemeral port.
///
/// `POST /v1/seat-a` answers 200 with an `id` (the dedupe-key passthrough
/// case); `POST /v1/seat-b` answers 201 without one (the deterministic
/// `local:{job}:{attempt}` fallback case). The statuses differ on purpose so
/// the ledger's `http_status` is provably the wire value, not a hardcoded
/// 200.
async fn spawn_provider_stub() -> String {
    use axum::routing::post;
    use axum::Router;

    async fn seat_a() -> (axum::http::StatusCode, axum::Json<serde_json::Value>) {
        (
            axum::http::StatusCode::OK,
            axum::Json(serde_json::json!({
                "id": "stub-a-req-1",
                "choices": [{ "message": { "content": "draft ready on seat A" } }],
                "usage": { "prompt_tokens": 12, "completion_tokens": 34 },
            })),
        )
    }

    async fn seat_b() -> (axum::http::StatusCode, axum::Json<serde_json::Value>) {
        (
            axum::http::StatusCode::CREATED,
            axum::Json(serde_json::json!({
                "choices": [{ "message": { "content": "pipeline summary on seat B" } }],
                "usage": { "prompt_tokens": 5, "completion_tokens": 9 },
            })),
        )
    }

    let app = Router::new()
        .route("/v1/seat-a", post(seat_a))
        .route("/v1/seat-b", post(seat_b));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}")
}

/// Read back and decrypt the ledger record a seat posted for its own call.
async fn read_usage_record(owner: &Keys) -> UsageRecordPayload {
    let readback = query(
        owner,
        serde_json::json!({
            "kinds": [KIND_USAGE_RECORD],
            "authors": [owner.public_key().to_hex()]
        }),
    )
    .await;
    let record = readback.iter().find_map(|value| {
        let Ok(event) = Event::from_json(value.to_string()) else {
            return None;
        };
        decrypt_usage_record(owner, &event).ok()
    });
    record.expect("the seat must be able to read back its own usage record")
}

#[tokio::test]
#[ignore = "requires a running relay with BUZZ_EMPLOYEE_KEK and Postgres"]
async fn the_worker_executes_jobs_on_bindings_from_the_seat_config() {
    // The phase 3 gate through the real worker path: a seat config on disk,
    // the worker's job loop, and a real HTTP call to a provider stub. The
    // stamps and ledger records below must come from the config each seat
    // loaded, never from literals this test signs itself.
    let community = default_community().await;
    let founder_a = Keys::generate();
    let founder_b = Keys::generate();
    seed_relay_owner(community, &founder_a).await;
    seed_relay_owner(community, &founder_b).await;
    let employee = hire_an_employee(&founder_a).await;

    let stub = spawn_provider_stub().await;
    let previous_config = std::env::var_os("BUZZ_SEAT_CONFIG");

    // Seat A: the same employee maps to openai on stub A, with the key in a
    // custom env var so `key_var` is exercised too.
    let (config_a, path_a) = write_seat_config(
        &employee,
        "openai",
        "stub-model-a",
        &format!("{stub}/v1/seat-a"),
        "STUB_KEY_A",
    );
    std::env::set_var("STUB_KEY_A", "test-key-a");
    assert_eq!(
        buzz_cli::seat::seat_config_path(),
        path_a,
        "the loader must read exactly the file this test wrote"
    );
    let binding_a = &config_a.bindings_for(&employee)[0];

    let filing_a = file_job(&founder_a, &employee, "Draft the investor update");
    assert!(submit(&filing_a).await.0, "founder A's filing not accepted");
    let job_a = filing_a.id.to_hex();
    await_job_state(&founder_a, &job_a, "open").await;

    let client_a = BuzzClient::new(common::relay_http_url(), founder_a.clone(), None, None)
        .expect("client for founder A");
    assert!(
        run_worker_once(&client_a, &config_a)
            .await
            .expect("worker pass A"),
        "seat A must find and work its job"
    );

    let done_a = await_job_state(&founder_a, &job_a, "done").await;
    assert_eq!(
        tag_value(&done_a, "provider"),
        binding_a.provider,
        "the head's provider stamp must be the seat config's binding"
    );
    assert_eq!(
        tag_value(&done_a, "model"),
        binding_a.model,
        "the head's model stamp must be the seat config's binding"
    );
    assert_eq!(
        tag_value(&done_a, "lease-holder"),
        founder_a.public_key().to_hex()
    );
    assert_eq!(
        head_content(&done_a)["result"],
        serde_json::json!("draft ready on seat A")
    );

    let record_a = read_usage_record(&founder_a).await;
    assert_eq!(record_a.provider, binding_a.provider);
    assert_eq!(record_a.model.as_deref(), Some(binding_a.model.as_str()));
    assert_eq!(
        record_a.http_status,
        Some(200),
        "the ledger must carry the stub's real HTTP status"
    );
    assert_eq!(
        record_a.request_id, "stub-a-req-1",
        "a provider request id passes through to the ledger as the dedupe key"
    );
    assert_eq!(record_a.agent_pubkey.as_deref(), Some(employee.as_str()));

    // Seat B: the same employee, a different config, a different binding.
    let (config_b, path_b) = write_seat_config(
        &employee,
        "deepseek",
        "stub-model-b",
        &format!("{stub}/v1/seat-b"),
        "STUB_KEY_B",
    );
    std::env::set_var("STUB_KEY_B", "test-key-b");
    assert_eq!(buzz_cli::seat::seat_config_path(), path_b);
    let binding_b = &config_b.bindings_for(&employee)[0];
    assert_ne!(
        binding_a.provider, binding_b.provider,
        "the two seats must run on different bindings by design"
    );

    let filing_b = file_job(&founder_b, &employee, "Summarize the pipeline");
    assert!(submit(&filing_b).await.0, "founder B's filing not accepted");
    let job_b = filing_b.id.to_hex();
    await_job_state(&founder_b, &job_b, "open").await;

    let client_b = BuzzClient::new(common::relay_http_url(), founder_b.clone(), None, None)
        .expect("client for founder B");
    assert!(
        run_worker_once(&client_b, &config_b)
            .await
            .expect("worker pass B"),
        "seat B must find and work its job"
    );

    let done_b = await_job_state(&founder_b, &job_b, "done").await;
    assert_eq!(
        tag_value(&done_b, "provider"),
        binding_b.provider,
        "the head's provider stamp must be seat B's binding, not seat A's"
    );
    assert_eq!(tag_value(&done_b, "model"), binding_b.model);
    assert_ne!(
        tag_value(&done_b, "provider"),
        tag_value(&done_a, "provider"),
        "two seats on different bindings must stamp the same employee differently"
    );

    let record_b = read_usage_record(&founder_b).await;
    assert_eq!(record_b.provider, binding_b.provider);
    assert_eq!(record_b.model.as_deref(), Some(binding_b.model.as_str()));
    assert_eq!(
        record_b.http_status,
        Some(201),
        "the ledger must carry stub B's real status, not a hardcoded 200"
    );
    assert_eq!(
        record_b.request_id,
        format!("local:{job_b}:1"),
        "without a provider request id, the deterministic local fallback is the dedupe key"
    );
    assert_eq!(record_b.agent_pubkey.as_deref(), Some(employee.as_str()));

    // Leave the environment as we found it.
    std::env::remove_var("STUB_KEY_A");
    std::env::remove_var("STUB_KEY_B");
    match previous_config {
        Some(value) => std::env::set_var("BUZZ_SEAT_CONFIG", value),
        None => std::env::remove_var("BUZZ_SEAT_CONFIG"),
    }
}
