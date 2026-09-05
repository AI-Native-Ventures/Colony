use buzz_core::kind::KIND_IA_ARCHIVED_LIST;
use buzz_sdk::builders::{build_archive_identity_request, build_unarchive_identity_request};
use nostr::{EventBuilder, Keys, Kind, PublicKey};
use serde_json::json;

use crate::agent_management::{build_create, build_update, CreateAgentDraft, UpdateAgentDraft};
use crate::agent_run;
use crate::client::BuzzClient;
use crate::commands::blocks::resolve_active_manifest;
use crate::error::CliError;
use crate::identity;
use crate::managed_agents::{self, NewAgent, SecretLocation};
use crate::validate::{read_or_stdin, validate_hex64};
use crate::{AgentsCmd, RespondToArg};

/// Read a `--prompt` value: `-` is stdin, a leading `@` names a file, and
/// anything else is the literal instructions.
///
/// The `@` form matters because a system prompt is usually a paragraph or
/// more, and shell quoting mangles it. A bare path is deliberately NOT treated
/// as a file: silently sending the string "./prompt.md" as an agent's
/// instructions is the failure mode this distinction exists to prevent, and it
/// is invisible until the agent behaves oddly.
fn read_prompt_arg(value: &str) -> Result<String, CliError> {
    match value.strip_prefix('@') {
        Some(path) => std::fs::read_to_string(path)
            .map_err(|e| CliError::Usage(format!("read prompt file {path}: {e}"))),
        None => read_or_stdin(value),
    }
}

pub async fn dispatch(command: AgentsCmd, client: &BuzzClient) -> Result<(), CliError> {
    match command {
        AgentsCmd::Create {
            name,
            prompt,
            harness,
            model,
            provider,
        } => cmd_create(client, &name, prompt.as_deref(), &harness, model, provider).await,

        AgentsCmd::Run {
            name_or_pubkey,
            harness,
            detach,
        } => cmd_run(client, &name_or_pubkey, harness.as_deref(), detach),

        AgentsCmd::Status => cmd_status(),

        AgentsCmd::Stop { name_or_pubkey } => cmd_stop(&name_or_pubkey),

        AgentsCmd::List => {
            let records = managed_agents::load_store()?;
            let listed: Vec<serde_json::Value> = managed_agents::instances(&records)
                .into_iter()
                .map(managed_agents::summarize)
                .collect();
            println!("{}", serde_json::Value::Array(listed));
            Ok(())
        }

        AgentsCmd::Show { name_or_pubkey } => {
            let records = managed_agents::load_store()?;
            let record =
                managed_agents::find_instance(&records, &name_or_pubkey).ok_or_else(|| {
                    CliError::NotFound(format!(
                        "no managed agent named '{name_or_pubkey}' on this machine \
                         (run `buzz agents list`)"
                    ))
                })?;
            println!("{}", managed_agents::summarize(record));
            Ok(())
        }

        AgentsCmd::DraftCreate {
            channel,
            display_name,
            system_prompt,
            reply_to,
        } => {
            let owner = require_owner(client)?;
            let (manifest_id, manifest) = resolve_active_manifest(client, "agent-proposal").await?;
            let built = build_create(
                &owner,
                manifest_id,
                &manifest,
                CreateAgentDraft {
                    channel_id: channel,
                    display_name,
                    system_prompt: read_or_stdin(&system_prompt)?,
                    reply_to,
                },
            )?;
            let event = client.sign_event(built.builder)?;
            let event_id = event.id.to_hex();
            let response = client.submit_event(event).await?;
            let mut output: serde_json::Value = serde_json::from_str(&response)
                .map_err(|e| CliError::Other(format!("invalid relay response: {e}")))?;
            if let Some(obj) = output.as_object_mut() {
                obj.insert("request_id".into(), built.request_id.to_string().into());
                obj.insert("instance_event_id".into(), event_id.into());
                obj.insert("action".into(), built.action.into());
                obj.insert("proposal_saved".into(), true.into());
                obj.insert("agent_changed".into(), false.into());
                obj.insert(
                    "message".into(),
                    "Agent Proposal saved in the conversation for owner review. Nothing changes until the owner explicitly resolves it."
                        .into(),
                );
            }
            println!("{output}");
            Ok(())
        }

        AgentsCmd::DraftUpdate {
            channel,
            agent_name,
            display_name,
            system_prompt,
            runtime,
            provider,
            model,
            respond_to,
            reply_to,
        } => {
            let owner = require_owner(client)?;
            let (manifest_id, manifest) = resolve_active_manifest(client, "agent-proposal").await?;
            let built = build_update(
                &owner,
                manifest_id,
                &manifest,
                UpdateAgentDraft {
                    channel_id: channel,
                    agent_name,
                    display_name,
                    system_prompt: system_prompt.map(|v| read_or_stdin(&v)).transpose()?,
                    runtime,
                    provider,
                    model,
                    respond_to: respond_to.map(RespondToArg::to_wire),
                    reply_to,
                },
            )?;
            let event = client.sign_event(built.builder)?;
            let event_id = event.id.to_hex();
            let response = client.submit_event(event).await?;
            let mut output: serde_json::Value = serde_json::from_str(&response)
                .map_err(|e| CliError::Other(format!("invalid relay response: {e}")))?;
            if let Some(obj) = output.as_object_mut() {
                obj.insert("request_id".into(), built.request_id.to_string().into());
                obj.insert("instance_event_id".into(), event_id.into());
                obj.insert("action".into(), built.action.into());
                obj.insert("proposal_saved".into(), true.into());
                obj.insert("agent_changed".into(), false.into());
                obj.insert(
                    "message".into(),
                    "Agent Proposal saved in the conversation for owner review. Nothing changes until the owner explicitly resolves it."
                        .into(),
                );
            }
            println!("{output}");
            Ok(())
        }

        AgentsCmd::Archive {
            target_pubkey,
            reason,
            replaced_by,
            content,
            admin,
        } => {
            validate_hex64(&target_pubkey)?;
            let signer_hex = client.keys().public_key().to_hex();
            let auth = resolve_auth(
                client,
                &target_pubkey,
                &signer_hex,
                admin,
                &mut std::io::stderr(),
            )
            .await?;
            let builder = build_archive_identity_request(
                &target_pubkey,
                &content,
                reason.as_deref(),
                replaced_by.as_deref(),
                auth.as_ref(),
            )
            .map_err(|e| CliError::Usage(format!("invalid archive request: {e}")))?;
            let event = client.sign_event_unchecked(builder)?;
            let event_id = event.id.to_hex();
            client.submit_event(event).await?;
            println!(
                "{}",
                json!({
                    "ok": true,
                    "event_id": event_id,
                    "action": "archive",
                    "target": target_pubkey,
                })
            );
            Ok(())
        }

        AgentsCmd::Unarchive {
            target_pubkey,
            reason,
            content,
            admin,
        } => {
            validate_hex64(&target_pubkey)?;
            let signer_hex = client.keys().public_key().to_hex();
            let auth = resolve_auth(
                client,
                &target_pubkey,
                &signer_hex,
                admin,
                &mut std::io::stderr(),
            )
            .await?;
            let builder = build_unarchive_identity_request(
                &target_pubkey,
                &content,
                reason.as_deref(),
                auth.as_ref(),
            )
            .map_err(|e| CliError::Usage(format!("invalid unarchive request: {e}")))?;
            let event = client.sign_event_unchecked(builder)?;
            let event_id = event.id.to_hex();
            client.submit_event(event).await?;
            println!(
                "{}",
                json!({
                    "ok": true,
                    "event_id": event_id,
                    "action": "unarchive",
                    "target": target_pubkey,
                })
            );
            Ok(())
        }

        AgentsCmd::Archived => cmd_archived(client).await,
    }
}

/// A fresh agent's announcement: the owner-signed NIP-OA attestation, the
/// agent-signed kind:0 profile that carries it, and the agent-scoped client
/// that publishes it.
struct AttestedProfile {
    /// The `["auth", owner, conditions, sig]` tag, as JSON. Kept as a string
    /// because that is the form the store record and `x-auth-tag` both take.
    auth_tag_json: String,
    /// The kind:0 profile, signed by the agent, carrying the auth tag.
    event: nostr::Event,
    /// Signs NIP-98 for `POST /events` as the agent and sets `x-auth-tag`.
    client: BuzzClient,
}

/// Attest `agent_keys` with `owner_keys` and build the agent's kind:0 profile.
///
/// The event is signed by the AGENT and carries the OWNER's attestation: that
/// pairing is the whole mechanism, and it is why a second client is built here
/// rather than reusing the caller's. No network call happens; publishing is the
/// caller's step, which is what makes the wire shape testable.
fn build_attested_profile(
    relay_url: &str,
    owner_keys: &Keys,
    agent_keys: &Keys,
    name: &str,
) -> Result<AttestedProfile, CliError> {
    let agent_pubkey = agent_keys.public_key();
    let auth_tag_json = buzz_sdk::nip_oa::compute_auth_tag(owner_keys, &agent_pubkey, "")
        .map_err(|e| CliError::Other(format!("failed to compute NIP-OA auth tag: {e}")))?;
    let auth_tag = buzz_sdk::nip_oa::parse_auth_tag(&auth_tag_json)
        .map_err(|e| CliError::Other(format!("failed to parse the auth tag just computed: {e}")))?;

    let client = BuzzClient::new(
        relay_url.to_string(),
        agent_keys.clone(),
        Some(auth_tag),
        Some(auth_tag_json.clone()),
    )?;
    let content = json!({ "display_name": name }).to_string();
    let event = client.sign_event(EventBuilder::new(Kind::Custom(0), content))?;

    Ok(AttestedProfile {
        auth_tag_json,
        event,
        client,
    })
}

/// Mint a managed agent: a fresh key, an owner-signed NIP-OA attestation, a
/// published kind:0 profile, and a local record Buzz Desktop adopts.
///
/// Reproduces `create_managed_agent` in
/// `desktop/src-tauri/src/commands/agents.rs`. The ordering is deliberate: the
/// profile is published BEFORE anything durable is written locally, so a relay
/// rejection leaves nothing behind and the command can simply be re-run. The
/// reverse order would leave a half-created agent that no command can finish.
async fn cmd_create(
    client: &BuzzClient,
    name: &str,
    prompt: Option<&str>,
    harness: &str,
    model: Option<String>,
    provider: Option<String>,
) -> Result<(), CliError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(CliError::Usage("agent name is required".into()));
    }
    let harness = managed_agents::harness_spec(harness)?;

    let prompt = prompt.map(read_prompt_arg).transpose()?;
    let system_prompt = prompt
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let model = model.as_deref().map(str::trim).filter(|v| !v.is_empty());
    let provider = provider.as_deref().map(str::trim).filter(|v| !v.is_empty());

    let mut records = managed_agents::load_store()?;
    if let Some(existing) = managed_agents::find_instance(&records, name) {
        return Err(CliError::Usage(format!(
            "a managed agent named '{name}' already exists ({})",
            managed_agents::record_pubkey(existing)
        )));
    }

    // 1. Mint the agent's own keypair.
    let agent_keys = Keys::generate();
    let agent_pubkey = agent_keys.public_key();
    let pubkey_hex = agent_pubkey.to_hex();
    let npub = identity::npub_of(&agent_keys)?;

    // 2 + 3. Attest the agent with the owner key the CLI signs as, and publish
    //    the agent-signed kind:0 profile that carries the attestation.
    let profile = build_attested_profile(client.relay_url(), client.keys(), &agent_keys, name)?;
    let auth_tag_json = profile.auth_tag_json;
    profile.client.submit_event(profile.event).await?;

    // 4. Store the nsec where the desktop reads it from.
    let nsec = identity::nsec_of(&agent_keys)?;
    let stored_in = managed_agents::store_agent_secret(&pubkey_hex, &nsec)?;

    // 5. Append the record the desktop lists the agent from.
    let relay_url = client.relay_ws_url();
    let owner_hex = client.keys().public_key().to_hex();
    let now = chrono::Utc::now().to_rfc3339();
    let record = managed_agents::build_record(
        &NewAgent {
            name,
            pubkey: &pubkey_hex,
            owner_pubkey: &owner_hex,
            auth_tag: &auth_tag_json,
            relay_url: &relay_url,
            harness,
            system_prompt,
            model,
            provider,
            // Only the keyringless fallback keeps the key on disk.
            inline_nsec: (stored_in == SecretLocation::File).then_some(nsec.as_str()),
        },
        &now,
    );
    records.push(record);
    managed_agents::write_store(&records)?;

    println!(
        "{}",
        json!({
            "pubkey": pubkey_hex,
            "npub": npub,
            "name": name,
            "stored_in": stored_in.as_str(),
        })
    );
    Ok(())
}

// ── run | status | stop ────────────────────────────────────────────────────

/// Resolve the NIP-OA attestation the agent authenticates with.
///
/// The stored one is used verbatim whenever it is present, because it is the
/// tag already published in the agent's kind:0 profile. Recomputing is the
/// path for a record written without one, and it is only possible when the
/// signing key IS the owner the record names: an attestation is a signature
/// over the agent pubkey by the owner key, so another founder's key cannot
/// produce it, and shipping a tag signed by the wrong key would fail at the
/// relay with a message that looks like a relay fault.
fn resolve_agent_auth_tag(
    record: &serde_json::Value,
    agent_pubkey_hex: &str,
    owner_keys: &Keys,
) -> Result<String, CliError> {
    if let Some(stored) = record
        .get("auth_tag")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Ok(stored.to_string());
    }
    let signer_hex = owner_keys.public_key().to_hex();
    if let Some(owner) = record
        .get("owner_pubkey")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if !owner.eq_ignore_ascii_case(&signer_hex) {
            return Err(CliError::Auth(format!(
                "agent {agent_pubkey_hex} has no stored attestation and is owned by {owner}, \
                 not by your key {signer_hex}; run it as its owner"
            )));
        }
    }
    let agent_pubkey = PublicKey::parse(agent_pubkey_hex)
        .map_err(|e| CliError::Other(format!("agent pubkey {agent_pubkey_hex} is invalid: {e}")))?;
    buzz_sdk::nip_oa::compute_auth_tag(owner_keys, &agent_pubkey, "")
        .map_err(|e| CliError::Other(format!("failed to compute NIP-OA auth tag: {e}")))
}

/// `buzz agents run`: spawn `buzz-acp` for one managed agent.
///
/// Everything that can be refused is refused before a process exists: a
/// missing agent, an agent already running under this CLI, an unknown or
/// uninstalled harness, an unreadable key, and an attestation this key cannot
/// produce. A half-started agent is worse than a refused one, because the
/// relay-side symptom (silence in the channel) looks identical to a healthy
/// agent nobody has mentioned yet.
fn cmd_run(
    client: &BuzzClient,
    name_or_pubkey: &str,
    harness: Option<&str>,
    detach: bool,
) -> Result<(), CliError> {
    let records = managed_agents::load_store()?;
    let record = managed_agents::find_instance(&records, name_or_pubkey).ok_or_else(|| {
        CliError::NotFound(format!(
            "no managed agent named '{name_or_pubkey}' on this machine (run `buzz agents list`)"
        ))
    })?;
    let pubkey = managed_agents::record_pubkey(record).to_string();
    let name = managed_agents::record_name(record).to_string();

    let pidfile = agent_run::pidfile_path(&pubkey)?;
    if let Ok(running) = agent_run::read_run_record(&pidfile) {
        if agent_run::process_is_running(running.pid) {
            return Err(CliError::Usage(format!(
                "agent '{name}' is already running as pid {} (stop it first with \
                 `buzz agents stop {name}`)",
                running.pid
            )));
        }
    }

    let harness = agent_run::resolve_harness(harness, record, &|command| {
        agent_run::find_on_path(command).is_some()
    })?;
    let nsec = managed_agents::read_agent_secret(&pubkey, record)?;
    let auth_tag = resolve_agent_auth_tag(record, &pubkey, client.keys())?;
    let relay_url = record
        .get("relay_url")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| client.relay_ws_url());

    let acp_bin = agent_run::resolve_acp_binary()?;
    // A harness that does not resolve is passed through by name rather than
    // refused, exactly as the desktop does: the harness reports the miss with
    // its own message, which names the binary it looked for.
    let agent_command = agent_run::find_on_path(harness.agent_command)
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| harness.agent_command.to_string());
    let mcp_command = (!harness.mcp_command.is_empty())
        .then(|| agent_run::find_on_path(harness.mcp_command))
        .flatten()
        .map(|path| path.display().to_string());
    let git_helper =
        agent_run::find_on_path("git-credential-nostr").map(|path| path.display().to_string());

    // Consent is the calling agent's question to ask; making the choice
    // visible is this command's job. See `HarnessSpec::login`.
    if let Some(login) = harness.login {
        eprintln!(
            "note: agent '{name}' runs on the '{}' harness, which uses {login}.",
            harness.id
        );
    }

    let env = agent_run::plan_env(&agent_run::RunInputs {
        record,
        agent_nsec: &nsec,
        auth_tag: &auth_tag,
        owner_hex: &client.keys().public_key().to_hex(),
        relay_url: &relay_url,
        harness,
        agent_command: &agent_command,
        mcp_command: mcp_command.as_deref(),
        git_credential_helper: git_helper.as_deref(),
    });
    let plan = agent_run::RunPlan {
        acp_bin,
        workdir: agent_run::default_agent_workdir(),
        env,
    };

    let log = detach.then(|| agent_run::log_path(&pubkey)).transpose()?;
    let mut child = agent_run::spawn(&plan, log.as_deref())?;
    let run_record = agent_run::RunRecord {
        pubkey: pubkey.clone(),
        name: name.clone(),
        harness: harness.id.to_string(),
        pid: child.id(),
        started_at: chrono::Utc::now().to_rfc3339(),
        log: log.as_ref().map(|path| path.display().to_string()),
        detached: detach,
    };
    agent_run::write_run_record(&pidfile, &run_record)?;

    println!(
        "{}",
        json!({
            "pubkey": pubkey,
            "name": name,
            "harness": harness.id,
            "pid": run_record.pid,
            "detached": detach,
            "relay_url": relay_url,
            "log": run_record.log,
            "pidfile": pidfile.display().to_string(),
        })
    );

    if detach {
        return Ok(());
    }

    // Foreground. The child leads its own process group, so a Ctrl-C in the
    // terminal reaches this process and not the agent: the pidfile is left in
    // place on that path deliberately, and `buzz agents stop` is what ends the
    // agent. A child that exits on its own is cleaned up here.
    let status = child
        .wait()
        .map_err(|e| CliError::Other(format!("waiting for buzz-acp: {e}")))?;
    let _ = std::fs::remove_file(&pidfile);
    if status.success() {
        return Ok(());
    }
    Err(CliError::Other(format!(
        "buzz-acp exited with {status} (log streamed above)"
    )))
}

/// `buzz agents status`: every CLI-run agent and whether it is still alive.
fn cmd_status() -> Result<(), CliError> {
    let listed: Vec<serde_json::Value> = agent_run::list_run_records()?
        .into_iter()
        .map(|record| {
            json!({
                "pubkey": record.pubkey,
                "name": record.name,
                "harness": record.harness,
                "pid": record.pid,
                "alive": agent_run::process_is_running(record.pid),
                "started_at": record.started_at,
                "detached": record.detached,
                "log": record.log,
            })
        })
        .collect();
    println!("{}", serde_json::Value::Array(listed));
    Ok(())
}

/// `buzz agents stop`: end one CLI-run agent and clear its pidfile.
fn cmd_stop(name_or_pubkey: &str) -> Result<(), CliError> {
    let records = agent_run::list_run_records()?;
    // Pubkey first, so a name that happens to look like a pubkey can never
    // shadow the real key. Same rule as `managed_agents::find_instance`.
    let record = records
        .iter()
        .find(|record| record.pubkey == name_or_pubkey)
        .or_else(|| {
            records
                .iter()
                .find(|record| record.name.eq_ignore_ascii_case(name_or_pubkey))
        })
        .ok_or_else(|| {
            CliError::NotFound(format!(
                "no agent named '{name_or_pubkey}' was started by this CLI \
                 (run `buzz agents status`)"
            ))
        })?;

    let outcome = agent_run::stop_process(record.pid)?;
    let pidfile = agent_run::pidfile_path(&record.pubkey)?;
    if let Err(e) = std::fs::remove_file(&pidfile) {
        if e.kind() != std::io::ErrorKind::NotFound {
            return Err(CliError::Other(format!(
                "stopped {} but could not remove {}: {e}",
                record.pid,
                pidfile.display()
            )));
        }
    }
    println!(
        "{}",
        json!({
            "pubkey": record.pubkey,
            "name": record.name,
            "pid": record.pid,
            "outcome": outcome.as_str(),
        })
    );
    Ok(())
}

/// Require `BUZZ_AUTH_TAG` and parse the owner pubkey from it. Used only by
/// the `draft-create` and `draft-update` paths.
fn require_owner(client: &BuzzClient) -> Result<PublicKey, CliError> {
    let hex = client
        .auth_tag_owner_hex()
        .ok_or_else(|| CliError::Auth("agent draft requests require BUZZ_AUTH_TAG".into()))?;
    PublicKey::parse(&hex).map_err(|e| CliError::Auth(format!("invalid owner attestation: {e}")))
}

/// Typed reason why NIP-OA owner-auth could not be extracted.
///
/// Covers all distinguishable failure causes from profile fetch through tag
/// validation so the diagnostic in [`resolve_auth`] is always precise and
/// never duplicates classification logic.
#[derive(Debug, PartialEq)]
enum AuthFailure {
    /// No kind:0 profile was found for the target; target pubkey included.
    NoProfile(String),
    /// kind:0 was found but has no `tags` array; target pubkey included.
    NoTagsArray(String),
    /// `tags` array has no `auth`-labelled entries.
    NoAuthTag,
    /// `tags` array has more than one `auth`-labelled entry; count included.
    AmbiguousAuthTag(usize),
    /// Sole `auth` tag has wrong element count; actual count included.
    WrongArity(usize),
    /// Sole `auth` tag contains a non-string element.
    NonStringElement,
    /// Sole `auth` tag owner field is not a valid 64-hex pubkey; value included.
    InvalidOwnerHex(String),
    /// Sole `auth` tag sig field is not a valid 128-hex signature.
    InvalidSigHex,
    /// Tag is structurally valid but names a different owner; actual owner included.
    OwnerMismatch(String),
}

impl AuthFailure {
    /// Human-readable description suitable for the `"warning"` JSON field.
    fn message(&self) -> String {
        match self {
            AuthFailure::NoProfile(target) => {
                format!("no kind:0 profile found for target {target}")
            }
            AuthFailure::NoTagsArray(target) => {
                format!("target {target} kind:0 has no tags array")
            }
            AuthFailure::NoAuthTag => "target kind:0 has no \"auth\" tag".to_owned(),
            AuthFailure::AmbiguousAuthTag(n) => format!(
                "target kind:0 has {n} \"auth\" tags (expected exactly 1) — ambiguous ownership"
            ),
            AuthFailure::WrongArity(n) => format!(
                "sole \"auth\" tag has {n} element(s) (expected 4: label, owner, conditions, sig)"
            ),
            AuthFailure::NonStringElement => {
                "sole \"auth\" tag contains a non-string element".to_owned()
            }
            AuthFailure::InvalidOwnerHex(v) => {
                format!("sole \"auth\" tag owner field is not a valid 64-hex pubkey: {v}")
            }
            AuthFailure::InvalidSigHex => {
                "sole \"auth\" tag sig field is not a valid 128-hex signature".to_owned()
            }
            AuthFailure::OwnerMismatch(actual) => {
                format!("sole \"auth\" tag names owner {actual} which does not match your key")
            }
        }
    }
}

/// Single classifier: either extract the auth tag or return the typed reason
/// for failure. [`extract_owner_auth_tag`] is a thin `.ok()` wrapper kept for
/// the existing tests that assert on `Option`.
fn classify_owner_auth_tag(
    tags: &[serde_json::Value],
    signer_hex: &str,
) -> Result<[String; 4], AuthFailure> {
    let auth_tags: Vec<&serde_json::Value> = tags
        .iter()
        .filter(|tag| {
            tag.as_array()
                .and_then(|elems| elems.first())
                .and_then(|v| v.as_str())
                == Some("auth")
        })
        .collect();
    match auth_tags.len() {
        0 => return Err(AuthFailure::NoAuthTag),
        n if n > 1 => return Err(AuthFailure::AmbiguousAuthTag(n)),
        _ => {}
    }

    // Exactly one auth tag.
    let elems = auth_tags[0]
        .as_array()
        .ok_or(AuthFailure::NonStringElement)?;
    if elems.len() != 4 {
        return Err(AuthFailure::WrongArity(elems.len()));
    }
    let label = elems[0].as_str().ok_or(AuthFailure::NonStringElement)?;
    let owner = elems[1].as_str().ok_or(AuthFailure::NonStringElement)?;
    let conditions = elems[2].as_str().ok_or(AuthFailure::NonStringElement)?;
    let sig = elems[3].as_str().ok_or(AuthFailure::NonStringElement)?;
    if owner.len() != 64 || !owner.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(AuthFailure::InvalidOwnerHex(owner.to_owned()));
    }
    if sig.len() != 128 || !sig.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(AuthFailure::InvalidSigHex);
    }
    if !owner.eq_ignore_ascii_case(signer_hex) {
        return Err(AuthFailure::OwnerMismatch(owner.to_owned()));
    }
    Ok([
        label.to_owned(),
        owner.to_owned(),
        conditions.to_owned(),
        sig.to_owned(),
    ])
}

/// Pure typed extractor: given a fetched kind:0 profile (or `None` when no
/// event was found), return the auth tag or the typed failure reason.
///
/// Separated from [`resolve_auth`] so pure-unit tests can exercise all
/// failure cases without a live `BuzzClient` or async runtime.
fn extract_auth(
    profile: Option<&serde_json::Value>,
    target_hex: &str,
    signer_hex: &str,
) -> Result<[String; 4], AuthFailure> {
    let event = profile.ok_or_else(|| AuthFailure::NoProfile(target_hex.to_owned()))?;
    let tags = event
        .get("tags")
        .and_then(|v| v.as_array())
        .ok_or_else(|| AuthFailure::NoTagsArray(target_hex.to_owned()))?;
    classify_owner_auth_tag(tags, signer_hex)
}

/// Resolve the optional NIP-OA `auth` tag for archive/unarchive requests,
/// with one automatic retry on extraction failure.
///
/// Resolution logic (linear state machine):
/// - `target == signer`: self path — no auth needed → `Ok(None)`, silent, zero fetches.
/// - Otherwise: fetch target's kind:0 and attempt extraction.
///   - Success (attempt 1) → `Ok(Some(tag))`, one fetch.
///   - Failure (attempt 1) → fetch again once (transient republish is the
///     dominant cause), then attempt extraction again.
///     - Success (attempt 2) → `Ok(Some(tag))`, two fetches.
///     - Failure (attempt 2), `allow_bare == false` → `Err(CliError::Usage)`
///       with an actionable message naming the reason. Request is NOT sent.
///     - Failure (attempt 2), `allow_bare == true` → emit one
///       `{"warning":"..."}` line to `warn_sink`, return `Ok(None)` (bare
///       send) for relay-admin callers.
/// - Network/parse failures surface as `Err` regardless of `allow_bare`.
async fn resolve_auth(
    client: &BuzzClient,
    target_hex: &str,
    signer_hex: &str,
    allow_bare: bool,
    warn_sink: &mut dyn std::io::Write,
) -> Result<Option<[String; 4]>, CliError> {
    if target_hex.eq_ignore_ascii_case(signer_hex) {
        return Ok(None);
    }

    // Attempt 1.
    let profile = fetch_kind0(client, target_hex).await?;
    if let Ok(tag) = extract_auth(profile.as_ref(), target_hex, signer_hex) {
        return Ok(Some(tag));
    }

    // Attempt 2 — one retry for transient republish churn.
    let profile = fetch_kind0(client, target_hex).await?;
    match extract_auth(profile.as_ref(), target_hex, signer_hex) {
        Ok(tag) => Ok(Some(tag)),
        Err(failure) => {
            let detail = failure.message();
            if allow_bare {
                let msg = format!(
                    "{detail}; proceeding without owner attestation (--admin) — \
                     this succeeds only if your key is a relay admin"
                );
                let _ = writeln!(warn_sink, "{}", serde_json::json!({"warning": msg}));
                Ok(None)
            } else {
                Err(CliError::Usage(format!(
                    "{detail}; refusing to send a bare request that the relay will reject — \
                     re-run once the target's profile has finished publishing, or pass --admin \
                     if your key is a relay admin"
                )))
            }
        }
    }
}

/// Fetch the most-recent kind:0 for `target_hex` from the relay.
/// Returns `None` when no event was found, `Err` on network/parse failure.
async fn fetch_kind0(
    client: &BuzzClient,
    target_hex: &str,
) -> Result<Option<serde_json::Value>, CliError> {
    let filter = json!({"kinds": [0], "authors": [target_hex], "limit": 1});
    let raw = client
        .query(&filter)
        .await
        .map_err(|e| CliError::Other(format!("failed to fetch target kind:0: {e}")))?;
    let events: Vec<serde_json::Value> = serde_json::from_str(&raw)
        .map_err(|e| CliError::Other(format!("invalid kind:0 query response: {e}")))?;
    Ok(events.into_iter().next())
}

/// Pure extraction helper: require exactly one kind:0 tag whose first
/// element is `"auth"` (a set-level rule — a valid tag alongside a second
/// malformed or duplicate `auth`-labeled tag is bare, not the valid one),
/// then structurally validate that sole tag as
/// `["auth", owner, conditions, sig]` matching `signer_hex`.
///
/// Thin wrapper around [`classify_owner_auth_tag`] that collapses the typed
/// failure reason to `None`. Malformed tags → `None`; valid tag → `Some`.
#[cfg(test)]
fn extract_owner_auth_tag(tags: &[serde_json::Value], signer_hex: &str) -> Option<[String; 4]> {
    classify_owner_auth_tag(tags, signer_hex).ok()
}

/// Validate the NIP-11 relay-info `self` field is a 64-hex pubkey and
/// normalize it to lowercase, so the archived-identities query filter and
/// the author comparison in [`verify_archived_event`] agree regardless of
/// the case the relay published `self` in.
fn normalize_relay_self_hex(self_hex: &str) -> Result<String, CliError> {
    if self_hex.len() != 64 || !self_hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(CliError::Other(format!(
            "relay 'self' field is not a valid 64-hex pubkey: {self_hex}"
        )));
    }
    Ok(self_hex.to_ascii_lowercase())
}

/// Fetch and verify the relay's NIP-IA archived-identities snapshot (kind
/// 13535). Shared by `cmd_archived` (trust failures are fatal — verifying
/// repair state is the command's whole purpose) and the `--template`
/// resolver's archive filter, which fails open on a trust failure instead
/// (see `channels::resolve_roster_with_archive_filter`'s doc comment for
/// why).
///
/// Three trust states:
/// - State 1: no events — `Ok(vec![])`
/// - State 2: event passes all checks — `Ok(<pubkeys>)`
/// - State 3: trust failure — `Err`, naming the specific failure
pub(crate) async fn fetch_archived_snapshot(client: &BuzzClient) -> Result<Vec<String>, CliError> {
    // Fetch NIP-11 info to get the relay's self pubkey.
    let nip11_raw = client
        .get_public("/")
        .await
        .map_err(|e| CliError::Other(format!("failed to fetch relay info document: {e}")))?;
    let nip11: serde_json::Value = serde_json::from_str(&nip11_raw)
        .map_err(|e| CliError::Other(format!("relay info document is not valid JSON: {e}")))?;
    let self_hex = nip11
        .get("self")
        .and_then(|v| v.as_str())
        .ok_or_else(|| CliError::Other("relay info document missing 'self' field".into()))?;
    let self_hex = normalize_relay_self_hex(self_hex)?;

    // Query for the archived-identities list.
    let filter = json!({"kinds": [KIND_IA_ARCHIVED_LIST], "authors": [self_hex], "limit": 1});
    let raw = client
        .query(&filter)
        .await
        .map_err(|e| CliError::Other(format!("failed to query archived-identities list: {e}")))?;
    let events: Vec<serde_json::Value> = serde_json::from_str(&raw)
        .map_err(|e| CliError::Other(format!("invalid query response: {e}")))?;

    // State 1: no events.
    if events.is_empty() {
        return Ok(Vec::new());
    }

    // State 2 or 3: verify then collect.
    let raw_event = events.into_iter().next().unwrap();
    let event: nostr::Event = serde_json::from_value(raw_event)
        .map_err(|e| CliError::Other(format!("archived-identities event is malformed: {e}")))?;
    let archived = verify_archived_event(&event, &self_hex)?;

    Ok(archived.into_iter().map(str::to_string).collect())
}

/// `buzz agents archived`: read path over [`fetch_archived_snapshot`] for
/// direct invocation — a trust failure (state 3) is fatal here so a
/// verification command can never look like success.
async fn cmd_archived(client: &BuzzClient) -> Result<(), CliError> {
    let archived = fetch_archived_snapshot(client).await?;
    println!("{}", json!({"archived": archived}));
    Ok(())
}

/// Pure verification of a kind:13535 archived-identities event.
///
/// Returns the list of valid hex64 pubkeys from `p` tags on success, or a
/// named trust-failure error (State 3).
fn verify_archived_event<'a>(
    event: &'a nostr::Event,
    relay_self_hex: &str,
) -> Result<Vec<&'a str>, CliError> {
    if event.kind != nostr::Kind::Custom(KIND_IA_ARCHIVED_LIST as u16) {
        return Err(CliError::Other(format!(
            "archived-identities event has wrong kind: {}",
            event.kind.as_u16()
        )));
    }

    if event.pubkey.to_hex() != relay_self_hex {
        return Err(CliError::Other(format!(
            "archived-identities event author {} does not match relay self {}",
            event.pubkey.to_hex(),
            relay_self_hex
        )));
    }

    let mut nip70_count = 0usize;
    for t in event.tags.iter() {
        let s = t.as_slice();
        if s.first().map(String::as_str) != Some("-") {
            continue;
        }
        if s.len() != 1 {
            return Err(CliError::Other(
                "archived-identities event has a malformed NIP-70 '-' tag (expected arity 1)"
                    .into(),
            ));
        }
        nip70_count += 1;
    }
    if nip70_count != 1 {
        return Err(CliError::Other(format!(
            "archived-identities event must have exactly one NIP-70 '-' tag, found {nip70_count}"
        )));
    }

    event.verify().map_err(|e| {
        CliError::Other(format!(
            "archived-identities event failed cryptographic verification: {e}"
        ))
    })?;

    let archived: Vec<&str> = event
        .tags
        .iter()
        .filter_map(|t| {
            let s = t.as_slice();
            if s.first().map(String::as_str) == Some("p") {
                let pk = s.get(1).map(String::as_str)?;
                if pk.len() == 64 && pk.chars().all(|c| c.is_ascii_hexdigit()) {
                    return Some(pk);
                }
            }
            None
        })
        .collect();

    Ok(archived)
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::kind::KIND_IA_ARCHIVED_LIST;
    use nostr::{EventBuilder, Keys, Kind, Tag};
    use serde_json::json;

    fn hex64(c: char) -> String {
        std::iter::repeat_n(c, 64).collect()
    }

    fn hex128(c: char) -> String {
        std::iter::repeat_n(c, 128).collect()
    }

    // --- (a) the wire shape `agents create` puts on the relay ---

    /// Every auth tag on an event, as raw string slices.
    fn auth_tags(event: &nostr::Event) -> Vec<Vec<String>> {
        event
            .tags
            .iter()
            .map(|t| t.clone().to_vec())
            .filter(|t| t.first().map(String::as_str) == Some("auth"))
            .collect()
    }

    #[test]
    fn the_minted_profile_is_one_agent_signed_kind_0() {
        let owner = Keys::generate();
        let agent = Keys::generate();
        let profile =
            build_attested_profile("http://localhost:3000", &owner, &agent, "scout").unwrap();

        assert_eq!(profile.event.kind, Kind::Custom(0));
        assert_eq!(
            profile.event.pubkey,
            agent.public_key(),
            "the profile is signed by the agent, not the owner"
        );
        profile
            .event
            .verify()
            .expect("the kind:0 profile must carry a valid signature");
        let content: serde_json::Value = serde_json::from_str(&profile.event.content).unwrap();
        assert_eq!(content["display_name"], "scout");
    }

    #[test]
    fn the_profiles_auth_tag_verifies_against_the_owner_key() {
        let owner = Keys::generate();
        let agent = Keys::generate();
        let profile =
            build_attested_profile("http://localhost:3000", &owner, &agent, "scout").unwrap();

        let on_event = auth_tags(&profile.event);
        assert_eq!(on_event.len(), 1, "exactly one auth tag: {on_event:?}");
        assert_eq!(
            serde_json::to_value(&on_event[0]).unwrap(),
            serde_json::from_str::<serde_json::Value>(&profile.auth_tag_json).unwrap(),
            "the tag on the wire must be the one recorded in the store"
        );

        // Decode and verify the Schnorr signature over the NIP-OA preimage.
        let attested_owner =
            buzz_sdk::nip_oa::verify_auth_tag(&profile.auth_tag_json, &agent.public_key())
                .expect("the auth tag must verify against the agent it attests");
        assert_eq!(
            attested_owner,
            owner.public_key(),
            "the tag must name the CLI's own identity as owner"
        );
    }

    #[test]
    fn an_auth_tag_minted_for_one_agent_does_not_verify_for_another() {
        let owner = Keys::generate();
        let agent = Keys::generate();
        let impostor = Keys::generate();
        let profile =
            build_attested_profile("http://localhost:3000", &owner, &agent, "scout").unwrap();

        assert!(
            buzz_sdk::nip_oa::verify_auth_tag(&profile.auth_tag_json, &impostor.public_key())
                .is_err(),
            "the attestation is bound to one agent pubkey"
        );
    }

    // --- (b) auth-selection matrix: extract_owner_auth_tag ---

    #[test]
    fn auth_selection_owner_match_returns_tag() {
        let signer = hex64('a');
        let sig = hex128('b');
        let tags = vec![json!(["auth", signer, "conditions", sig])];
        let result = extract_owner_auth_tag(&tags, &signer);
        assert!(result.is_some());
        let tag = result.unwrap();
        assert_eq!(tag[0], "auth");
        assert_eq!(tag[1], signer);
        assert_eq!(tag[2], "conditions");
        assert_eq!(tag[3], sig);
    }

    #[test]
    fn auth_selection_non_owner_returns_none() {
        let signer = hex64('a');
        let other_owner = hex64('b');
        let tags = vec![json!(["auth", other_owner, "", hex128('c')])];
        assert!(extract_owner_auth_tag(&tags, &signer).is_none());
    }

    #[test]
    fn auth_selection_malformed_three_elements_returns_none() {
        let signer = hex64('a');
        let tags = vec![json!(["auth", signer, "conditions"])];
        assert!(extract_owner_auth_tag(&tags, &signer).is_none());
    }

    #[test]
    fn auth_selection_malformed_five_elements_returns_none() {
        let signer = hex64('a');
        let tags = vec![json!(["auth", signer, "conditions", hex128('b'), "extra"])];
        assert!(extract_owner_auth_tag(&tags, &signer).is_none());
    }

    #[test]
    fn auth_selection_malformed_non_hex_owner_returns_none() {
        let signer = "z".repeat(64);
        let tags = vec![json!(["auth", signer, "", hex128('a')])];
        assert!(extract_owner_auth_tag(&tags, &signer).is_none());
    }

    #[test]
    fn auth_selection_malformed_non_hex_sig_returns_none() {
        let signer = hex64('a');
        let bad_sig = "z".repeat(128);
        let tags = vec![json!(["auth", signer, "", bad_sig])];
        assert!(extract_owner_auth_tag(&tags, &signer).is_none());
    }

    #[test]
    fn auth_selection_malformed_short_sig_returns_none() {
        let signer = hex64('a');
        let short_sig = hex128('a')[..64].to_string();
        let tags = vec![json!(["auth", signer, "", short_sig])];
        assert!(extract_owner_auth_tag(&tags, &signer).is_none());
    }

    #[test]
    fn auth_selection_case_insensitive_owner_match() {
        let signer_lower = hex64('a');
        let signer_upper = signer_lower.to_uppercase();
        let sig = hex128('b');
        let tags = vec![json!(["auth", signer_upper, "cond", sig])];
        let result = extract_owner_auth_tag(&tags, &signer_lower);
        assert!(result.is_some());
    }

    #[test]
    fn auth_selection_non_string_elements_returns_none() {
        let signer = hex64('a');
        let tags = vec![json!(["auth", signer, 42, hex128('b')])];
        assert!(extract_owner_auth_tag(&tags, &signer).is_none());
    }

    #[test]
    fn auth_selection_non_array_tag_skipped() {
        let signer = hex64('a');
        let tags = vec![
            json!("not an array"),
            json!(["auth", signer, "", hex128('b')]),
        ];
        let result = extract_owner_auth_tag(&tags, &signer);
        assert!(result.is_some());
    }

    #[test]
    fn auth_selection_no_tags_returns_none() {
        assert!(extract_owner_auth_tag(&[], &hex64('a')).is_none());
    }

    #[test]
    fn auth_selection_wrong_label_returns_none() {
        let signer = hex64('a');
        let tags = vec![json!(["delegation", signer, "", hex128('b')])];
        assert!(extract_owner_auth_tag(&tags, &signer).is_none());
    }

    #[test]
    fn auth_selection_valid_plus_duplicate_auth_tag_returns_none() {
        // Set-level rule (F6): a structurally valid, owner-matching `auth`
        // tag alongside a second `auth`-labeled tag (malformed or a
        // duplicate) must not be selected — the whole kind:0 is bare.
        let signer = hex64('a');
        let sig = hex128('b');
        let tags = vec![
            json!(["auth", signer, "conditions", sig]),
            json!(["auth", signer, "conditions", sig]),
        ];
        assert!(extract_owner_auth_tag(&tags, &signer).is_none());
    }

    #[test]
    fn auth_selection_valid_plus_malformed_second_auth_tag_returns_none() {
        let signer = hex64('a');
        let sig = hex128('b');
        let tags = vec![
            json!(["auth", signer, "conditions", sig]),
            json!(["auth", "not-hex", "conditions"]),
        ];
        assert!(extract_owner_auth_tag(&tags, &signer).is_none());
    }

    // --- (c) auth-failure classifier: classify_owner_auth_tag ---
    //
    // Tests the typed failure taxonomy. Each case asserts the exact
    // AuthFailure variant so a wrong classification causes a compile-time or
    // assertion failure — not just a message-substring miss.

    #[test]
    fn classify_no_auth_tag_returns_no_auth_tag() {
        // Case 3 (zero auth tags): tags array has entries but none labelled "auth".
        let signer = hex64('a');
        let tags = vec![json!(["p", hex64('b')]), json!(["e", hex64('c')])];
        assert_eq!(
            classify_owner_auth_tag(&tags, &signer),
            Err(AuthFailure::NoAuthTag)
        );
    }

    #[test]
    fn classify_empty_tags_returns_no_auth_tag() {
        assert_eq!(
            classify_owner_auth_tag(&[], &hex64('a')),
            Err(AuthFailure::NoAuthTag)
        );
    }

    #[test]
    fn classify_duplicate_auth_tags_returns_ambiguous() {
        let signer = hex64('a');
        let sig = hex128('b');
        let tags = vec![
            json!(["auth", signer, "conditions", sig]),
            json!(["auth", signer, "conditions", sig]),
        ];
        assert_eq!(
            classify_owner_auth_tag(&tags, &signer),
            Err(AuthFailure::AmbiguousAuthTag(2))
        );
    }

    #[test]
    fn classify_wrong_arity_returns_wrong_arity() {
        let signer = hex64('a');
        let tags = vec![json!(["auth", signer, "conditions"])];
        assert_eq!(
            classify_owner_auth_tag(&tags, &signer),
            Err(AuthFailure::WrongArity(3))
        );
    }

    #[test]
    fn classify_non_string_element_returns_non_string() {
        let signer = hex64('a');
        let tags = vec![json!(["auth", signer, 42, hex128('b')])];
        assert_eq!(
            classify_owner_auth_tag(&tags, &signer),
            Err(AuthFailure::NonStringElement)
        );
    }

    #[test]
    fn classify_invalid_owner_hex_returns_invalid_owner_hex() {
        let bad_owner = "z".repeat(64);
        let tags = vec![json!(["auth", bad_owner, "", hex128('a')])];
        assert_eq!(
            classify_owner_auth_tag(&tags, &bad_owner),
            Err(AuthFailure::InvalidOwnerHex(bad_owner))
        );
    }

    #[test]
    fn classify_invalid_sig_hex_returns_invalid_sig_hex() {
        let signer = hex64('a');
        let bad_sig = "z".repeat(128);
        let tags = vec![json!(["auth", signer, "", bad_sig])];
        assert_eq!(
            classify_owner_auth_tag(&tags, &signer),
            Err(AuthFailure::InvalidSigHex)
        );
    }

    #[test]
    fn classify_owner_mismatch_returns_owner_mismatch_with_actual_owner() {
        // Case 4: structurally valid tag but owner ≠ signer. The failure must
        // carry the actual owner so resolve_auth can print it in the warning.
        let actual_owner = hex64('a');
        let signer = hex64('b');
        let sig = hex128('c');
        let tags = vec![json!(["auth", actual_owner, "conditions", sig])];
        assert_eq!(
            classify_owner_auth_tag(&tags, &signer),
            Err(AuthFailure::OwnerMismatch(actual_owner.clone()))
        );
        // Message must include the actual owner for actionability.
        let msg = AuthFailure::OwnerMismatch(actual_owner.clone()).message();
        assert!(
            msg.contains(&actual_owner),
            "OwnerMismatch message must include actual owner, got: {msg}"
        );
    }

    // --- (c2) extract_auth: profile-level failure taxonomy ---
    //
    // Pure-unit tests: exercise `extract_auth` directly with pre-built
    // profiles. No relay, no async runtime. These guard all failure paths
    // that the async production resolver depends on.

    #[test]
    fn extract_auth_no_profile_returns_no_profile_failure() {
        let target = hex64('t');
        let signer = hex64('s');
        assert_eq!(
            extract_auth(None, &target, &signer),
            Err(AuthFailure::NoProfile(target.clone()))
        );
    }

    #[test]
    fn extract_auth_no_tags_array_returns_no_tags_array_failure() {
        let target = hex64('t');
        let signer = hex64('s');
        let profile = json!({"kind": 0, "content": "{}"});
        assert_eq!(
            extract_auth(Some(&profile), &target, &signer),
            Err(AuthFailure::NoTagsArray(target.clone()))
        );
    }

    #[test]
    fn extract_auth_no_auth_tag_returns_no_auth_tag_failure() {
        let target = hex64('t');
        let signer = hex64('s');
        let profile = json!({"tags": [["p", hex64('b')]]});
        assert_eq!(
            extract_auth(Some(&profile), &target, &signer),
            Err(AuthFailure::NoAuthTag)
        );
    }

    #[test]
    fn extract_auth_valid_tag_returns_ok() {
        let signer = hex64('a');
        let sig = hex128('b');
        let profile = json!({"tags": [["auth", signer, "conditions", sig]]});
        let result = extract_auth(Some(&profile), &hex64('t'), &signer);
        assert!(result.is_ok(), "must succeed with a valid tag");
        let tag = result.unwrap();
        assert_eq!(tag[0], "auth");
        assert_eq!(tag[1], signer);
    }

    #[test]
    fn extract_auth_owner_mismatch_returns_owner_mismatch_failure() {
        let actual_owner = hex64('a');
        let signer = hex64('b');
        let sig = hex128('c');
        let profile = json!({"tags": [["auth", actual_owner, "conditions", sig]]});
        assert_eq!(
            extract_auth(Some(&profile), &hex64('t'), &signer),
            Err(AuthFailure::OwnerMismatch(actual_owner.clone()))
        );
        // Message must include the actual owner for actionability.
        let msg = AuthFailure::OwnerMismatch(actual_owner.clone()).message();
        assert!(
            msg.contains(&actual_owner),
            "OwnerMismatch message must include actual owner, got: {msg}"
        );
    }

    // --- (c3) resolve_auth: production async resolver via counted test server ---
    //
    // Each test spins up a local Axum server that handles POST /query, counts
    // calls, and returns a canned kind:0 (or empty array) based on the
    // attempt number. The test drives the production `resolve_auth` function
    // and asserts on both return value and exact fetch count.

    use std::net::SocketAddr;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    use axum::body::Body;
    use axum::extract::State;
    use axum::http::{HeaderMap, Response, StatusCode};
    use axum::Router;
    use tokio::net::TcpListener;

    /// Spin up an Axum server handling POST /query.
    /// `f(n)` is called with the 1-based attempt number and returns the JSON body.
    async fn query_server<F>(f: F) -> (String, Arc<AtomicU32>)
    where
        F: Fn(u32) -> String + Send + Sync + 'static,
    {
        let counter = Arc::new(AtomicU32::new(0));
        let handler: Arc<dyn Fn(u32) -> String + Send + Sync> = Arc::new(f);
        let state = (handler, counter.clone());

        type S = (Arc<dyn Fn(u32) -> String + Send + Sync>, Arc<AtomicU32>);
        let app = Router::new()
            .route(
                "/query",
                axum::routing::post(
                    |State((handler, ctr)): State<S>, _headers: HeaderMap, _body: Body| async move {
                        let n = ctr.fetch_add(1, Ordering::SeqCst) + 1;
                        let body = handler(n);
                        Response::builder()
                            .status(StatusCode::OK)
                            .header("content-type", "application/json")
                            .body(Body::from(body))
                            .unwrap()
                    },
                ),
            )
            .with_state(state);

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr: SocketAddr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{addr}"), counter)
    }

    fn test_client(base_url: &str) -> crate::client::BuzzClient {
        let keys = nostr::Keys::generate();
        crate::client::BuzzClient::new(base_url.to_string(), keys, None, None).unwrap()
    }

    fn kind0_response(signer_hex: &str) -> String {
        let sig = hex128('b');
        serde_json::json!([{
            "kind": 0,
            "tags": [["auth", signer_hex, "conditions", sig]],
            "content": "{}"
        }])
        .to_string()
    }

    fn empty_response() -> String {
        "[]".to_string()
    }

    fn no_auth_response() -> String {
        serde_json::json!([{"kind": 0, "tags": [["p", "xx"]], "content": "{}"}]).to_string()
    }

    /// First attempt succeeds — exactly 1 fetch, Ok(Some(tag)).
    #[tokio::test]
    async fn resolve_auth_first_success_one_fetch() {
        let signer = hex64('a');
        let signer_clone = signer.clone();
        let (url, counter) = query_server(move |_n| kind0_response(&signer_clone)).await;
        let client = test_client(&url);
        let target = hex64('b'); // target ≠ signer
        let mut sink: Vec<u8> = Vec::new();

        let result = resolve_auth(&client, &target, &signer, false, &mut sink).await;

        assert!(result.is_ok(), "first success must return Ok: {result:?}");
        assert!(result.unwrap().is_some(), "must return the extracted tag");
        assert_eq!(
            counter.load(Ordering::SeqCst),
            1,
            "first-success path must issue exactly 1 query"
        );
        assert!(sink.is_empty(), "no warning on success");
    }

    /// First fails (no auth tag), retry succeeds — exactly 2 fetches, Ok(Some(tag)).
    #[tokio::test]
    async fn resolve_auth_retry_success_two_fetches() {
        let signer = hex64('a');
        let signer_clone = signer.clone();
        let (url, counter) = query_server(move |n| {
            if n == 1 {
                no_auth_response()
            } else {
                kind0_response(&signer_clone)
            }
        })
        .await;
        let client = test_client(&url);
        let target = hex64('b');
        let mut sink: Vec<u8> = Vec::new();

        let result = resolve_auth(&client, &target, &signer, false, &mut sink).await;

        assert!(result.is_ok(), "retry success must return Ok: {result:?}");
        assert!(result.unwrap().is_some(), "must return the extracted tag");
        assert_eq!(
            counter.load(Ordering::SeqCst),
            2,
            "retry-success path must issue exactly 2 queries"
        );
        assert!(sink.is_empty(), "no warning on success");
    }

    /// Both attempts fail, allow_bare == false — exactly 2 fetches, Err (fail closed).
    #[tokio::test]
    async fn resolve_auth_double_failure_no_admin_fail_closed() {
        let (url, counter) = query_server(|_n| no_auth_response()).await;
        let client = test_client(&url);
        let signer = hex64('s');
        let target = hex64('t');
        let mut sink: Vec<u8> = Vec::new();

        let result = resolve_auth(&client, &target, &signer, false, &mut sink).await;

        assert!(result.is_err(), "double failure must fail closed");
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("refusing to send"),
            "error must name the refusal: {err}"
        );
        assert!(
            err.contains("--admin"),
            "error must mention --admin escape: {err}"
        );
        assert_eq!(
            counter.load(Ordering::SeqCst),
            2,
            "double-failure path must issue exactly 2 queries"
        );
        assert!(sink.is_empty(), "no warning on fail-closed path");
    }

    /// Both attempts fail, allow_bare == true (--admin) — exactly 2 fetches,
    /// Ok(None) + exactly one warning line.
    #[tokio::test]
    async fn resolve_auth_double_failure_admin_allows_bare_with_warning() {
        let (url, counter) = query_server(|_n| no_auth_response()).await;
        let client = test_client(&url);
        let signer = hex64('s');
        let target = hex64('t');
        let mut sink: Vec<u8> = Vec::new();

        let result = resolve_auth(&client, &target, &signer, true, &mut sink).await;

        assert!(result.is_ok(), "--admin must allow bare send: {result:?}");
        assert!(result.unwrap().is_none(), "bare path returns None");
        assert_eq!(
            counter.load(Ordering::SeqCst),
            2,
            "--admin double-failure path must issue exactly 2 queries"
        );
        // Exactly one warning line.
        let text = std::str::from_utf8(&sink).expect("UTF-8");
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(
            lines.len(),
            1,
            "expected exactly one warning, got: {text:?}"
        );
        let parsed: serde_json::Value = serde_json::from_str(lines[0]).expect("valid JSON warning");
        let warning = parsed["warning"].as_str().expect("string warning field");
        assert!(
            warning.contains("proceeding without owner attestation"),
            "warning must name the bare-send: {warning}"
        );
    }

    /// Self path (target == signer, case-insensitive) — zero fetches, Ok(None).
    #[tokio::test]
    async fn resolve_auth_self_path_zero_fetches() {
        // Server counts every /query call; we assert 0.
        let (url, counter) = query_server(|_n| empty_response()).await;
        let client = test_client(&url);
        let signer = hex64('a');
        let target_upper = signer.to_uppercase(); // case-insensitive self
        let mut sink: Vec<u8> = Vec::new();

        let result = resolve_auth(&client, &target_upper, &signer, false, &mut sink).await;

        assert!(result.is_ok(), "self path must return Ok: {result:?}");
        assert!(result.unwrap().is_none(), "self path returns None");
        assert_eq!(
            counter.load(Ordering::SeqCst),
            0,
            "self path must issue zero queries"
        );
        assert!(sink.is_empty(), "no warning on self path");
    }

    // --- (c4) --admin flag parser: both archive and unarchive ---
    //
    // These tests confirm the flag is declared and parsed on both subcommands
    // so it can't silently disappear from one of them.

    #[test]
    fn archive_admin_flag_is_parsed() {
        use crate::Cli;
        use clap::Parser;
        let cli = Cli::try_parse_from(["buzz", "agents", "archive", &hex64('a'), "--admin"])
            .expect("--admin must be accepted by agents archive");
        match cli.command {
            crate::Cmd::Agents(crate::AgentsCmd::Archive { admin, .. }) => {
                assert!(admin, "--admin must be true when flag is present");
            }
            _ => panic!("unexpected command variant"),
        }
    }

    #[test]
    fn unarchive_admin_flag_is_parsed() {
        use crate::Cli;
        use clap::Parser;
        let cli = Cli::try_parse_from(["buzz", "agents", "unarchive", &hex64('a'), "--admin"])
            .expect("--admin must be accepted by agents unarchive");
        match cli.command {
            crate::Cmd::Agents(crate::AgentsCmd::Unarchive { admin, .. }) => {
                assert!(admin, "--admin must be true when flag is present");
            }
            _ => panic!("unexpected command variant"),
        }
    }

    // --- (d) NIP-11 self normalization: normalize_relay_self_hex ---

    #[test]
    fn normalize_self_lowercases_uppercase_hex() {
        let upper = hex64('A');
        let result = normalize_relay_self_hex(&upper).expect("should pass");
        assert_eq!(result, hex64('a'));
    }

    #[test]
    fn normalize_self_rejects_wrong_length() {
        assert!(normalize_relay_self_hex(&hex64('a')[..63]).is_err());
    }

    #[test]
    fn normalize_self_rejects_non_hex() {
        assert!(normalize_relay_self_hex(&"z".repeat(64)).is_err());
    }

    #[test]
    fn archived_uppercase_self_matches_lowercase_event_author() {
        // F7: an uppercase NIP-11 `self` must still resolve to the same
        // relay identity as the event's (always-lowercase) author hex once
        // normalized — before the fix this was a case-sensitive mismatch.
        let keys = Keys::generate();
        let self_hex_lower = keys.public_key().to_hex();
        let self_hex_upper = self_hex_lower.to_uppercase();
        let normalized = normalize_relay_self_hex(&self_hex_upper).expect("valid hex");
        let event = build_archived_event(&keys, KIND_IA_ARCHIVED_LIST as u16, &[], true);
        let result = verify_archived_event(&event, &normalized).expect("should pass");
        assert!(result.is_empty());
    }

    // --- (c) snapshot tri-state: verify_archived_event ---

    fn build_archived_event(
        keys: &Keys,
        kind: u16,
        p_tags: &[&str],
        include_nip70: bool,
    ) -> nostr::Event {
        let mut tags: Vec<Tag> = Vec::new();
        if include_nip70 {
            tags.push(Tag::parse(["-"]).unwrap());
        }
        for pk in p_tags {
            tags.push(Tag::parse(["p", pk]).unwrap());
        }
        EventBuilder::new(Kind::Custom(kind), "")
            .tags(tags)
            .sign_with_keys(keys)
            .expect("sign")
    }

    #[test]
    fn archived_state2_valid_event_returns_pubkeys() {
        let keys = Keys::generate();
        let self_hex = keys.public_key().to_hex();
        let pk1 = hex64('a');
        let pk2 = hex64('b');
        let event = build_archived_event(&keys, KIND_IA_ARCHIVED_LIST as u16, &[&pk1, &pk2], true);
        let result = verify_archived_event(&event, &self_hex).expect("should pass");
        assert_eq!(result, vec![pk1.as_str(), pk2.as_str()]);
    }

    #[test]
    fn archived_state2_empty_p_tags_returns_empty() {
        let keys = Keys::generate();
        let self_hex = keys.public_key().to_hex();
        let event = build_archived_event(&keys, KIND_IA_ARCHIVED_LIST as u16, &[], true);
        let result = verify_archived_event(&event, &self_hex).expect("should pass");
        assert!(result.is_empty());
    }

    #[test]
    fn archived_state3_wrong_kind_errors() {
        let keys = Keys::generate();
        let self_hex = keys.public_key().to_hex();
        let event = build_archived_event(&keys, 9999, &[], true);
        let err = verify_archived_event(&event, &self_hex).unwrap_err();
        assert!(
            err.to_string().contains("wrong kind"),
            "error should name wrong kind: {err}"
        );
    }

    #[test]
    fn archived_state3_wrong_author_errors() {
        let event_keys = Keys::generate();
        let other_self = hex64('f');
        let event = build_archived_event(&event_keys, KIND_IA_ARCHIVED_LIST as u16, &[], true);
        let err = verify_archived_event(&event, &other_self).unwrap_err();
        assert!(
            err.to_string().contains("does not match relay self"),
            "error should name author mismatch: {err}"
        );
    }

    #[test]
    fn archived_state3_no_nip70_tag_errors() {
        let keys = Keys::generate();
        let self_hex = keys.public_key().to_hex();
        let event = build_archived_event(&keys, KIND_IA_ARCHIVED_LIST as u16, &[], false);
        let err = verify_archived_event(&event, &self_hex).unwrap_err();
        assert!(
            err.to_string().contains("NIP-70"),
            "error should name missing NIP-70 tag: {err}"
        );
    }

    #[test]
    fn archived_state3_duplicate_nip70_tags_errors() {
        let keys = Keys::generate();
        let self_hex = keys.public_key().to_hex();
        let event = EventBuilder::new(Kind::Custom(KIND_IA_ARCHIVED_LIST as u16), "")
            .tags([Tag::parse(["-"]).unwrap(), Tag::parse(["-"]).unwrap()])
            .sign_with_keys(&keys)
            .expect("sign");
        let err = verify_archived_event(&event, &self_hex).unwrap_err();
        assert!(
            err.to_string().contains("found 2"),
            "error should report 2 NIP-70 tags: {err}"
        );
    }

    #[test]
    fn archived_state3_lone_malformed_nip70_tag_errors() {
        let keys = Keys::generate();
        let self_hex = keys.public_key().to_hex();
        let event = EventBuilder::new(Kind::Custom(KIND_IA_ARCHIVED_LIST as u16), "")
            .tags([Tag::parse(["-", "extra"]).unwrap()])
            .sign_with_keys(&keys)
            .expect("sign");
        let err = verify_archived_event(&event, &self_hex).unwrap_err();
        assert!(
            err.to_string().contains("malformed NIP-70"),
            "error should name the malformed NIP-70 tag: {err}"
        );
    }

    #[test]
    fn archived_state3_exact_marker_plus_malformed_marker_errors() {
        // F5 (IMPORTANT, discriminating): a valid `["-"]` alongside a
        // malformed `["-", "extra"]` must still poison the snapshot — the
        // old count-of-exact-shape-only check let this bypass through with
        // nip70_count == 1.
        let keys = Keys::generate();
        let self_hex = keys.public_key().to_hex();
        let event = EventBuilder::new(Kind::Custom(KIND_IA_ARCHIVED_LIST as u16), "")
            .tags([
                Tag::parse(["-"]).unwrap(),
                Tag::parse(["-", "extra"]).unwrap(),
            ])
            .sign_with_keys(&keys)
            .expect("sign");
        let err = verify_archived_event(&event, &self_hex).unwrap_err();
        assert!(
            err.to_string().contains("malformed NIP-70"),
            "error should name the malformed NIP-70 tag: {err}"
        );
    }

    #[test]
    fn archived_non_hex_p_tag_dropped() {
        let keys = Keys::generate();
        let self_hex = keys.public_key().to_hex();
        let valid_pk = hex64('a');
        let event = EventBuilder::new(Kind::Custom(KIND_IA_ARCHIVED_LIST as u16), "")
            .tags([
                Tag::parse(["-"]).unwrap(),
                Tag::parse(["p", &valid_pk]).unwrap(),
                Tag::parse(["p", "not-hex-at-all"]).unwrap(),
                Tag::parse(["p", &"z".repeat(64)]).unwrap(),
            ])
            .sign_with_keys(&keys)
            .expect("sign");
        let result = verify_archived_event(&event, &self_hex).expect("should pass");
        assert_eq!(result, vec![valid_pk.as_str()]);
    }

    #[test]
    fn archived_short_p_tag_dropped() {
        let keys = Keys::generate();
        let self_hex = keys.public_key().to_hex();
        let event = EventBuilder::new(Kind::Custom(KIND_IA_ARCHIVED_LIST as u16), "")
            .tags([
                Tag::parse(["-"]).unwrap(),
                Tag::parse(["p", &hex64('a')[..32]]).unwrap(),
            ])
            .sign_with_keys(&keys)
            .expect("sign");
        let result = verify_archived_event(&event, &self_hex).expect("should pass");
        assert!(result.is_empty());
    }
}
