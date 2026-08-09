//! Live proof that a running ACP harness receives an Ask, renders the
//! `<colony-ask>` block, and answers it using the command and id in that block.
//!
//! This is intentionally ignored by default: it needs a live relay, fresh
//! Postgres/Redis state, and the built `buzz`, `buzz-acp`, and scripted ACP
//! agent binaries. The CI job gives it an isolated relay and database.

mod common;

use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use buzz_sdk::nip_oa;
use buzz_test_client::{BuzzTestClient, TestClientError};
use nostr::{Keys, Tag};
use serde_json::Value;
use tokio::process::{Child, Command};
use uuid::Uuid;

use common::ask::{
    asks_addressed_to, closures_naming, create_chat_task, employ_ladder, ensure_test_community,
    publish_role_head, raise_with_window, relay_host, relay_url, wait_for_successor, workspace,
};
use common::{query, seed_relay_owner, tag_value};

/// Build an owner-signed, unrestricted NIP-OA credential for `agent`.
///
/// The credential is attached to the agent's kind:0 profile so the shipped
/// `respond_to=owner-only` author gate can verify a same-owner sibling. Empty
/// conditions are deliberate: this live fixture needs the agent to publish its
/// profile, ask, and (for the harness) answer event with the same credential.
fn owner_auth_tag(owner: &Keys, agent: &Keys) -> Tag {
    let json = nip_oa::compute_auth_tag(owner, &agent.public_key(), "")
        .expect("owner signs the agent's NIP-OA credential");
    nip_oa::parse_auth_tag(&json).expect("NIP-OA credential parses")
}

/// Connect an agent with the same NIP-OA path used by a managed launch.
async fn connect_agent_with_owner(
    agent: &Keys,
    owner: &Keys,
) -> Result<BuzzTestClient, TestClientError> {
    let mut client = BuzzTestClient::connect_unauthenticated(&relay_url()).await?;
    let auth_tag = owner_auth_tag(owner, agent);
    client.authenticate_with_nip_oa(agent, &auth_tag).await?;
    Ok(client)
}

/// Publish the worker's owner-attested kind:0 profile.
async fn publish_agent_auth_profile(worker_ws: &mut BuzzTestClient, owner: &Keys, worker: &Keys) {
    let event = buzz_sdk::build_profile(Some("E2E worker"), None, None, None, None)
        .expect("build worker profile")
        .tags([owner_auth_tag(owner, worker)])
        .sign_with_keys(worker)
        .expect("sign worker profile");
    let ok = worker_ws
        .send_event(event)
        .await
        .expect("publish worker profile");
    assert!(ok.accepted, "worker profile rejected: {}", ok.message);
}

/// Query the profile back before filing. This distinguishes an unpropagated
/// fixture from a real author-gate failure in the harness.
async fn await_auth_profile_visible(owner: &Keys, worker: &Keys) {
    let filter = serde_json::json!({
        "kinds": [0],
        "authors": [worker.public_key().to_hex()],
        "limit": 1,
    });
    for attempt in 0..40 {
        let profiles = query(owner, filter.clone()).await;
        if profiles.iter().any(|event| {
            event["pubkey"] == serde_json::json!(worker.public_key().to_hex())
                && event["kind"] == serde_json::json!(0)
        }) {
            return;
        }
        if attempt < 39 {
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }
    panic!(
        "worker kind:0 NIP-OA profile was not visible before filing; \
         the author gate would correctly drop this fixture"
    );
}

fn target_bin(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/debug")
        .join(name)
}

fn stub_log_path() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "buzz-agent-answers-ask-stub-{}-{}.log",
        std::process::id(),
        Uuid::new_v4().simple()
    ));
    OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)
        .unwrap_or_else(|e| panic!("create stub log {}: {e}", path.display()));
    path
}

fn prepend_target_to_path() -> OsString {
    let target = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/debug");
    let mut paths = vec![target];
    if let Some(existing) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&existing));
    }
    std::env::join_paths(paths).expect("target/debug and PATH form a valid PATH")
}

struct HarnessProcess {
    child: Child,
    output_path: PathBuf,
}

impl Drop for HarnessProcess {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}

impl HarnessProcess {
    async fn kill(&mut self) {
        let _ = self.child.kill().await;
        let _ = self.child.wait().await;
    }
}

/// Spawn the shipped harness with the leader's credentials and redirect all
/// output to a file. `buzz-acp` is long-lived, so a pipe would eventually fill
/// and stall the harness before the ask arrives.
async fn spawn_harness_as(leader: &Keys, owner: &Keys, stub_log: &Path) -> HarnessProcess {
    let output_path = std::env::temp_dir().join(format!(
        "buzz-agent-answers-ask-harness-{}-{}.log",
        std::process::id(),
        Uuid::new_v4().simple()
    ));
    let output = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&output_path)
        .unwrap_or_else(|e| panic!("create harness log {}: {e}", output_path.display()));
    let stderr = output.try_clone().expect("clone harness log for stderr");

    let harness_bin = target_bin("buzz-acp");
    let stub_bin = target_bin("ask_stub_agent");
    assert!(
        harness_bin.is_file(),
        "built buzz-acp not found at {}; build it before running this ignored test",
        harness_bin.display()
    );
    assert!(
        stub_bin.is_file(),
        "built ask_stub_agent not found at {}; build it before running this ignored test",
        stub_bin.display()
    );

    let auth_tag = nip_oa::compute_auth_tag(owner, &leader.public_key(), "")
        .expect("owner signs the leader's NIP-OA credential");
    let relay = relay_url();
    let mut command = Command::new(&harness_bin);
    command
        .env("BUZZ_RELAY_URL", &relay)
        .env("BUZZ_PRIVATE_KEY", leader.secret_key().to_secret_hex())
        .env("BUZZ_AUTH_TAG", auth_tag)
        .env("BUZZ_ACP_AGENT_COMMAND", &stub_bin)
        .env("BUZZ_STUB_LOG", stub_log)
        .env("RUST_LOG", "debug")
        .env("PATH", prepend_target_to_path())
        // Keep the shipped owner-only default. Removing an ambient override is
        // not configuring a test mode; it makes this child resolve its own
        // default even when a developer shell exported the variable.
        .env_remove("BUZZ_ACP_RESPOND_TO")
        .env_remove("BUZZ_ACP_AGENT_OWNER")
        .env("BUZZ_ACP_NO_METER", "true")
        .env("BUZZ_ACP_NO_PRESENCE", "true")
        .env("BUZZ_ACP_TURN_LIVENESS_SECS", "0")
        .stdout(Stdio::from(output))
        .stderr(Stdio::from(stderr));
    let child = command
        .spawn()
        .unwrap_or_else(|e| panic!("spawn buzz-acp {}: {e}", harness_bin.display()));

    HarnessProcess { child, output_path }
}

fn output_text(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_default()
}

/// Wait for the relay's server-acknowledged EOSE for the global ask inbox.
///
/// This polls the redirected file only to observe the existing `EOSE for
/// subscription ask-inbox` log line; it does not use an arbitrary startup
/// sleep. The first ask REQ uses a startup watermark, and filing before EOSE
/// would otherwise create a real delivery race.
async fn await_ask_inbox_ready(harness_log: &Path) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        let output = output_text(harness_log);
        if output
            .lines()
            .any(|line| line.contains("EOSE for subscription ask-inbox"))
        {
            return;
        }
        if output.contains("relay connect error") || output.contains("configuration error") {
            panic!("buzz-acp failed before ask inbox EOSE:\n{output}");
        }
        if tokio::time::Instant::now() >= deadline {
            panic!(
                "timed out waiting for ask inbox EOSE in {}; harness output:\n{}",
                harness_log.display(),
                output
            );
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn await_stub_entry(stub_log: &Path, timeout: Duration) -> Value {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if let Ok(content) = fs::read_to_string(stub_log) {
            if let Some(line) = content.lines().find(|line| !line.trim().is_empty()) {
                return serde_json::from_str(line)
                    .unwrap_or_else(|e| panic!("stub log line is not JSON: {e}; line={line:?}"));
            }
        }
        if tokio::time::Instant::now() >= deadline {
            panic!(
                "timed out waiting for scripted agent entry in {}; harness may have dropped the ask",
                stub_log.display()
            );
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// The gate this whole line of work exists for: a live ACP harness, not a
/// direct relay publish, receives an ask, renders the block, and the agent
/// answers using the id and command the block gave it.
///
/// The unanswered sibling is an explicit positive control. It is expected to
/// climb from the leader to the executive and then to the owner; the answered
/// ask is checked by lineage so that expected control traffic cannot mask a
/// regression in absorption.
#[tokio::test]
#[ignore = "requires a running relay, Postgres, and built ACP binaries"]
async fn a_live_harness_reads_the_ask_block_and_answers_it() {
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

    let mut worker_ws = connect_agent_with_owner(&worker, &owner)
        .await
        .expect("worker NIP-OA connect");
    publish_agent_auth_profile(&mut worker_ws, &owner, &worker).await;
    await_auth_profile_visible(&owner, &worker).await;

    let stub_log = stub_log_path();
    let mut harness = spawn_harness_as(&leader, &owner, &stub_log).await;
    await_ask_inbox_ready(&harness.output_path).await;

    // This deadline deliberately outlasts delivery, prompt assembly, the
    // scripted agent turn, and the `buzz asks answer` subprocess. The CI
    // sweep runs every second; a short window would race promotion.
    let ask_id = raise_with_window(
        &mut worker_ws,
        &worker,
        &leader.public_key().to_hex(),
        None,
        &task_id,
        &format!("sms-vendor-{}", Uuid::new_v4().simple()),
        "Which vendor should we use for SMS?",
        None,
        Some(600),
    )
    .await;

    let entry = await_stub_entry(&stub_log, Duration::from_secs(90)).await;
    assert_eq!(
        entry["saw_block"],
        serde_json::json!(true),
        "the live harness must deliver the ask and render the block"
    );
    assert_eq!(
        entry["ask_id"],
        serde_json::json!(ask_id),
        "the block must carry the real ask id"
    );
    assert_eq!(
        entry["exit_code"],
        serde_json::json!(0),
        "the command the block prints must actually run: got stderr {}",
        entry["stderr"]
    );
    assert!(
        entry["argv"]
            .as_array()
            .is_some_and(|argv| argv.iter().any(|arg| arg == &serde_json::json!(ask_id))),
        "the executed command must contain the ask id parsed from the block"
    );

    // Stop the harness before filing the unanswered control, otherwise the
    // stub would correctly answer the control too and the sweep would have no
    // positive signal.
    harness.kill().await;

    let control_ask_id = raise_with_window(
        &mut worker_ws,
        &worker,
        &leader.public_key().to_hex(),
        None,
        &task_id,
        &format!("sms-vendor-control-{}", Uuid::new_v4().simple()),
        "Control ask intentionally left unanswered",
        None,
        Some(1),
    )
    .await;
    let control_successors = wait_for_successor(&executive, &control_ask_id).await;
    assert!(
        control_successors
            .iter()
            .any(|ask| tag_value(ask, "prior") == control_ask_id),
        "the unanswered control must climb to the executive"
    );

    let answered_lineage = asks_addressed_to(&executive)
        .await
        .into_iter()
        .chain(asks_addressed_to(&owner).await)
        .filter(|ask| tag_value(ask, "prior") == ask_id)
        .collect::<Vec<_>>();
    assert!(
        answered_lineage.is_empty(),
        "the answered ask must have no successor anywhere in the ladder; got {answered_lineage:#?}"
    );

    let closures = closures_naming(&owner, std::slice::from_ref(&ask_id)).await;
    assert_eq!(
        closures.len(),
        1,
        "answering must close the ask exactly once"
    );
    assert_eq!(tag_value(&closures[0], "e"), ask_id);
    assert_eq!(
        closures[0]["pubkey"],
        serde_json::json!(leader.public_key().to_hex()),
        "the closure must be signed by the asked agent"
    );

    owner_ws.disconnect().await.ok();
    worker_ws.disconnect().await.ok();
}
