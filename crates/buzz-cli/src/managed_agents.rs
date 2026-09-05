//! Managed agents: the local half of `buzz agents create`.
//!
//! A managed agent is the desktop app's model of an agent: it holds its own
//! Nostr key locally, is attested to the relay by an owner-signed NIP-OA auth
//! tag in its kind:0 profile, and is run by `buzz-acp` against a harness the
//! founder is already logged in to (Claude Code, Codex, opencode, goose, or
//! the bundled `buzz-agent`). It is not a relay-held employee key.
//!
//! This module reproduces exactly the two durable side effects the desktop's
//! `create_managed_agent` has, so an agent minted by the CLI is adopted by Buzz
//! Desktop on its next launch:
//!
//! - The agent nsec goes into the same OS keyring blob the founder identity
//!   uses (service `buzz-desktop`, account `secrets`), under the key
//!   `agent:<pubkey>`. See `desktop/src-tauri/src/managed_agents/storage.rs`.
//!   When the keyring is unreachable the desktop keeps the key inline in the
//!   `0o600` JSON store instead, and so does this module.
//! - A record is appended to `{app_data}/agents/managed-agents.json`, whose
//!   shape matches the desktop's `ManagedAgentRecord`
//!   (`desktop/src-tauri/src/managed_agents/types.rs`).
//!
//! Records the CLI did not write (including the key-less *definition* records
//! that share the file) round-trip untouched: the store is loaded as raw JSON
//! values and only the new record is constructed.

use std::path::PathBuf;

use serde_json::{json, Map, Value};

use crate::error::CliError;
use crate::identity::{self, BlobStore, KeyringBlobStore};

/// Prefix of the keyring blob key holding an agent's nsec, namespaced away
/// from the founder's `identity` key which shares the blob. Matches
/// `agent_keyring_name` in the desktop's `managed_agents/storage.rs`.
pub const AGENT_SECRET_PREFIX: &str = "agent:";

/// The ACP harness binary every managed agent is launched through. Matches
/// `DEFAULT_ACP_COMMAND` in the desktop's `managed_agents/types.rs`.
pub const DEFAULT_ACP_COMMAND: &str = "buzz-acp";

/// Harness a `create` with no `--harness` gets: the bundled agent, which
/// resolves on every platform and needs no separate login. Matches the
/// desktop's `default_agent_command`.
pub const DEFAULT_HARNESS: &str = "buzz-agent";

/// Schema default for the deprecated `turn_timeout_seconds` field. The harness
/// ignores it; it is written only so the record parses. Matches
/// `DEFAULT_AGENT_TURN_TIMEOUT_SECONDS`.
pub const DEFAULT_TURN_TIMEOUT_SECONDS: u64 = 320;

/// Concurrent turns a new agent accepts. Matches `DEFAULT_AGENT_PARALLELISM`.
pub const DEFAULT_PARALLELISM: u32 = 10;

/// Default inbound author gate: only the owner can address the agent. Matches
/// `RespondTo::default()` and the harness's own default.
pub const DEFAULT_RESPOND_TO: &str = "owner-only";

/// Keyring blob key holding `pubkey`'s nsec.
pub fn agent_secret_key(pubkey: &str) -> String {
    format!("{AGENT_SECRET_PREFIX}{pubkey}")
}

/// Where an agent's nsec ended up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretLocation {
    /// The OS keyring blob, write-verified by read-back.
    Keyring,
    /// Inline in the `0o600` `managed-agents.json`, because the keyring was
    /// unreachable. This is the desktop's own fallback, and the desktop lifts
    /// the key into the keyring on the first launch that can reach it.
    File,
}

impl SecretLocation {
    /// Stable machine-readable name, used as the `stored_in` field of
    /// `buzz agents create`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Keyring => "keyring",
            Self::File => "file",
        }
    }
}

/// The command line a harness id resolves to.
///
/// Mirrors the entries of `KNOWN_ACP_RUNTIMES` in the desktop's
/// `managed_agents/discovery.rs` together with `default_agent_args`: the
/// desktop derives `mcp_command` from the same catalog at create time and
/// never reads a user-supplied value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HarnessSpec {
    /// Catalog id, as accepted by `--harness`.
    pub id: &'static str,
    /// Binary the harness launches (the record's `agent_command`).
    pub agent_command: &'static str,
    /// Catalog MCP command, empty when the runtime has none.
    pub mcp_command: &'static str,
    /// Args the runtime needs to speak ACP on stdio.
    pub agent_args: &'static [&'static str],
    /// Which of the founder's existing logins the runtime bills to, or `None`
    /// when it needs no login of its own.
    ///
    /// `buzz agents run` prints this before spawning. Binding a founder's
    /// Claude or Codex subscription to an agent is a consent decision that
    /// belongs to a human (company-employees law 3), and the calling agent is
    /// the one that has to ask; the CLI's job is only to make the choice
    /// visible rather than silent.
    pub login: Option<&'static str>,
}

/// Every harness `--harness` accepts, in the order they are listed in help.
pub const HARNESSES: &[HarnessSpec] = &[
    HarnessSpec {
        id: "claude",
        agent_command: "claude-agent-acp",
        mcp_command: "",
        agent_args: &[],
        login: Some("your Claude Code login on this machine"),
    },
    HarnessSpec {
        id: "codex",
        agent_command: "codex-acp",
        mcp_command: "buzz-dev-mcp",
        agent_args: &[],
        login: Some("your Codex login on this machine"),
    },
    HarnessSpec {
        id: "opencode",
        agent_command: "opencode",
        mcp_command: "",
        agent_args: &["acp"],
        login: Some("your opencode configuration on this machine"),
    },
    HarnessSpec {
        id: "goose",
        agent_command: "goose",
        mcp_command: "",
        agent_args: &[],
        login: Some("your goose configuration on this machine"),
    },
    HarnessSpec {
        id: "buzz-agent",
        agent_command: "buzz-agent",
        mcp_command: "buzz-dev-mcp",
        agent_args: &[],
        login: None,
    },
];

/// Resolve a `--harness` value to its catalog entry.
///
/// # Errors
///
/// [`CliError::Usage`] for an id outside the catalog: an unknown harness would
/// mint an agent that cannot start, and the failure is far cheaper here.
pub fn harness_spec(id: &str) -> Result<&'static HarnessSpec, CliError> {
    HARNESSES.iter().find(|h| h.id == id).ok_or_else(|| {
        let known = HARNESSES
            .iter()
            .map(|h| h.id)
            .collect::<Vec<_>>()
            .join(", ");
        CliError::Usage(format!("unknown harness '{id}' (expected one of: {known})"))
    })
}

/// Reverse-lookup: the catalog entry whose binary is `command`.
pub fn harness_for_command(command: &str) -> Option<&'static HarnessSpec> {
    HARNESSES.iter().find(|h| h.agent_command == command)
}

/// The harness a stored record pins, if any.
///
/// `agent_command_override` is read first because that is where
/// [`build_record`] writes the `--harness` choice and where the desktop's
/// `effective_agent_command` reads it from; `agent_command` is the fallback
/// for records written before the override existed. A record naming a binary
/// outside the catalog (a custom harness configured in the desktop) yields
/// `None`, which sends the caller to its own fallback rather than guessing at
/// args the CLI does not know.
pub fn harness_for_record(record: &Value) -> Option<&'static HarnessSpec> {
    ["agent_command_override", "agent_command"]
        .iter()
        .filter_map(|key| record.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|command| !command.is_empty())
        .find_map(harness_for_command)
}

// ── Store file ─────────────────────────────────────────────────────────────

/// Path of the desktop's managed-agent store,
/// `{app_data}/agents/managed-agents.json`.
pub fn store_path() -> Result<PathBuf, CliError> {
    Ok(identity::app_data_dir()?
        .join("agents")
        .join("managed-agents.json"))
}

/// Read the store as raw JSON values.
///
/// A missing file is an empty store. A file that is not a JSON array is an
/// error rather than a silent reset: the desktop keeps its agent definitions
/// in the same file, and overwriting an unrecognised store would destroy them.
pub fn load_store() -> Result<Vec<Value>, CliError> {
    load_store_at(&store_path()?)
}

/// [`load_store`] against an explicit path, so the parse contract is testable
/// without pointing the process at a different app-data directory.
pub fn load_store_at(path: &std::path::Path) -> Result<Vec<Value>, CliError> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(CliError::Other(format!("read {}: {e}", path.display()))),
    };
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str::<Vec<Value>>(&raw).map_err(|e| {
        CliError::Other(format!(
            "{} is not a JSON array of agent records: {e}",
            path.display()
        ))
    })
}

/// Write the store back, pretty-printed and owner-only (`0o600` on Unix).
///
/// The mode is set on the temp file before any bytes are written, so the
/// plaintext-key fallback never passes through a world-readable window, and the
/// rename makes the replacement atomic. This is what the desktop's
/// `atomic_write_json_restricted` does.
pub fn write_store(records: &[Value]) -> Result<(), CliError> {
    write_store_at(&store_path()?, records)
}

/// [`write_store`] against an explicit path, so the permissions and atomicity
/// contract is testable against a scratch directory.
pub fn write_store_at(path: &std::path::Path, records: &[Value]) -> Result<(), CliError> {
    use std::io::Write;

    let parent = path
        .parent()
        .ok_or_else(|| CliError::Other(format!("no parent directory for {}", path.display())))?;
    std::fs::create_dir_all(parent)
        .map_err(|e| CliError::Other(format!("create {}: {e}", parent.display())))?;

    let payload = serde_json::to_vec_pretty(records)
        .map_err(|e| CliError::Other(format!("serialize agent store: {e}")))?;

    let tmp = path.with_extension("json.tmp");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&tmp)
        .map_err(|e| CliError::Other(format!("open {}: {e}", tmp.display())))?;
    file.write_all(&payload)
        .map_err(|e| CliError::Other(format!("write {}: {e}", tmp.display())))?;
    file.sync_all()
        .map_err(|e| CliError::Other(format!("sync {}: {e}", tmp.display())))?;
    drop(file);
    std::fs::rename(&tmp, path)
        .map_err(|e| CliError::Other(format!("rename {}: {e}", tmp.display())))
}

/// The keyed agent *instances* in a store, skipping the key-less definition
/// records that share the file. Mirrors the desktop's `load_managed_agents`.
pub fn instances(records: &[Value]) -> Vec<&Value> {
    records
        .iter()
        .filter(|record| !record_pubkey(record).is_empty())
        .collect()
}

/// An instance's `pubkey`, or `""` for a definition record.
pub fn record_pubkey(record: &Value) -> &str {
    record.get("pubkey").and_then(Value::as_str).unwrap_or("")
}

/// An instance's `name`, or `""` when it has none.
pub fn record_name(record: &Value) -> &str {
    record.get("name").and_then(Value::as_str).unwrap_or("")
}

/// Find one instance by exact pubkey or case-insensitive name.
///
/// Pubkey is matched first so a name that happens to look like a pubkey can
/// never shadow the real key.
pub fn find_instance<'a>(records: &'a [Value], needle: &str) -> Option<&'a Value> {
    let instances = instances(records);
    instances
        .iter()
        .find(|record| record_pubkey(record) == needle)
        .or_else(|| {
            instances
                .iter()
                .find(|record| record_name(record).eq_ignore_ascii_case(needle))
        })
        .copied()
}

/// The fields `buzz agents list` and `buzz agents show` report.
///
/// Deliberately a projection rather than the raw record: the record carries
/// `private_key_nsec` in the keyringless fallback, and neither command has any
/// reason to print a secret.
pub fn summarize(record: &Value) -> Value {
    let field = |key: &str| record.get(key).cloned().unwrap_or(Value::Null);
    json!({
        "pubkey": record_pubkey(record),
        "name": record_name(record),
        "relay_url": field("relay_url"),
        "agent_command": field("agent_command"),
        "model": field("model"),
        "provider": field("provider"),
        "system_prompt": field("system_prompt"),
        "owner_pubkey": field("owner_pubkey"),
        "created_at": field("created_at"),
        "updated_at": field("updated_at"),
        "last_started_at": field("last_started_at"),
        "last_error": field("last_error"),
    })
}

// ── Keyring ────────────────────────────────────────────────────────────────

/// Store `nsec` under `agent:<pubkey>` in the desktop's secret blob.
///
/// Returns [`SecretLocation::File`] when the keyring cannot be read, written,
/// or read back, which tells the caller to keep the key inline in the `0o600`
/// store. The read-back is not ceremony: a write that silently did not land
/// would leave an agent whose key exists nowhere at all.
///
/// Every other key in the blob is preserved, so the founder identity and any
/// sibling agent keys survive.
pub fn store_agent_secret(pubkey: &str, nsec: &str) -> Result<SecretLocation, CliError> {
    store_agent_secret_in(&KeyringBlobStore::for_default_service(), pubkey, nsec)
}

/// [`store_agent_secret`] against an explicit blob store, so the merge and
/// read-back contract can be exercised against a throwaway keyring service
/// instead of the founder's real `buzz-desktop` item.
pub fn store_agent_secret_in(
    store: &impl BlobStore,
    pubkey: &str,
    nsec: &str,
) -> Result<SecretLocation, CliError> {
    let key = agent_secret_key(pubkey);
    let Ok(existing) = store.read_blob() else {
        return Ok(SecretLocation::File);
    };
    let merged = identity::merge_secret(existing.as_deref(), &key, nsec)?;
    if store.write_blob(&merged).is_err() {
        return Ok(SecretLocation::File);
    }
    match store.read_blob() {
        Ok(raw) => match identity::secret_from_blob(raw.as_deref(), &key)? {
            Some(stored) if stored == nsec => Ok(SecretLocation::Keyring),
            _ => Ok(SecretLocation::File),
        },
        Err(_) => Ok(SecretLocation::File),
    }
}

/// Read an agent's nsec back: the keyring blob first, then the inline
/// `private_key_nsec` the keyringless fallback leaves in the `0o600` store.
///
/// The order matches [`store_agent_secret`]'s: the keyring is the durable home
/// and the file is the fallback, so a key that has since been lifted into the
/// keyring wins over a stale inline copy.
///
/// # Errors
///
/// [`CliError::NotFound`] when the key exists in neither place. That is a real
/// state, not a bug: the desktop can create an agent whose key lives in a
/// keyring this process cannot unlock, and running it would otherwise fail far
/// later with an opaque signature error.
pub fn read_agent_secret(pubkey: &str, record: &Value) -> Result<String, CliError> {
    read_agent_secret_in(&KeyringBlobStore::for_default_service(), pubkey, record)
}

/// [`read_agent_secret`] against an explicit blob store, so the precedence can
/// be exercised without the founder's real keyring.
pub fn read_agent_secret_in(
    store: &impl BlobStore,
    pubkey: &str,
    record: &Value,
) -> Result<String, CliError> {
    if let Ok(raw) = store.read_blob() {
        if let Some(nsec) = identity::secret_from_blob(raw.as_deref(), &agent_secret_key(pubkey))? {
            if !nsec.trim().is_empty() {
                return Ok(nsec);
            }
        }
    }
    record
        .get("private_key_nsec")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|nsec| !nsec.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            CliError::NotFound(format!(
                "no private key for agent {pubkey}: it is neither in the keyring under \
                 `{}` nor inline in the agent store",
                agent_secret_key(pubkey)
            ))
        })
}

// ── Record construction ────────────────────────────────────────────────────

/// Everything `buzz agents create` needs to describe the agent it minted.
#[derive(Debug, Clone)]
pub struct NewAgent<'a> {
    /// Agent handle, already trimmed and checked non-empty.
    pub name: &'a str,
    /// Hex pubkey of the freshly minted agent key.
    pub pubkey: &'a str,
    /// Hex pubkey of the owner identity that signed the auth tag.
    pub owner_pubkey: &'a str,
    /// NIP-OA auth tag JSON, as produced by `buzz_sdk::nip_oa::compute_auth_tag`.
    pub auth_tag: &'a str,
    /// WebSocket relay URL the agent is pinned to.
    pub relay_url: &'a str,
    /// Harness the agent runs on.
    pub harness: &'static HarnessSpec,
    /// Instructions, or `None` to inherit the harness default.
    pub system_prompt: Option<&'a str>,
    /// Desired model id, or `None` for the harness default.
    pub model: Option<&'a str>,
    /// Inference provider id, or `None` for the harness default.
    pub provider: Option<&'a str>,
    /// The nsec, present only when the keyring was unreachable and the key must
    /// stay inline in the `0o600` store.
    pub inline_nsec: Option<&'a str>,
}

/// Build the JSON record the desktop's `ManagedAgentRecord` deserializes.
///
/// Every field the desktop struct declares WITHOUT a serde default is written,
/// including the ones whose value is `null` (`system_prompt`, `last_started_at`,
/// `last_stopped_at`, `last_exit_code`, `last_error`) - serde requires the key
/// to be present, so omitting them would make the record unreadable by the
/// desktop. Fields that do carry a serde default are written only when the CLI
/// has something to say about them, so the desktop's own defaults keep owning
/// the rest.
pub fn build_record(agent: &NewAgent<'_>, now: &str) -> Value {
    let mut map = Map::new();
    let mut set = |key: &str, value: Value| {
        map.insert(key.to_string(), value);
    };

    set("pubkey", json!(agent.pubkey));
    set("name", json!(agent.name));
    set("auth_tag", json!(agent.auth_tag));
    set("relay_url", json!(agent.relay_url));
    set("owner_pubkey", json!(agent.owner_pubkey));
    set("acp_command", json!(DEFAULT_ACP_COMMAND));
    set("agent_command", json!(agent.harness.agent_command));
    set("agent_args", json!(agent.harness.agent_args));
    set("mcp_command", json!(agent.harness.mcp_command));
    set("turn_timeout_seconds", json!(DEFAULT_TURN_TIMEOUT_SECONDS));
    set("parallelism", json!(DEFAULT_PARALLELISM));
    set("system_prompt", json!(agent.system_prompt));
    set("model", json!(agent.model));
    set("provider", json!(agent.provider));
    set("respond_to", json!(DEFAULT_RESPOND_TO));
    // The harness pin has to go in `agent_command_override`, not in
    // `agent_command`. The desktop resolves the binary it spawns through
    // `effective_agent_command`, which reads the override first and otherwise
    // falls back to the linked persona's runtime; a CLI-minted agent has no
    // persona, so without the override `--harness` would be silently ignored at
    // spawn and every agent would start on the desktop's default binary.
    set("agent_command_override", json!(agent.harness.agent_command));
    set("start_on_app_launch", json!(false));
    set("created_at", json!(now));
    set("updated_at", json!(now));
    set("last_started_at", Value::Null);
    set("last_stopped_at", Value::Null);
    set("last_exit_code", Value::Null);
    set("last_error", Value::Null);
    if let Some(nsec) = agent.inline_nsec {
        set("private_key_nsec", json!(nsec));
    }

    Value::Object(map)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample<'a>(inline: Option<&'a str>) -> NewAgent<'a> {
        NewAgent {
            name: "scout",
            pubkey: "aa",
            owner_pubkey: "bb",
            auth_tag: r#"["auth","bb","","sig"]"#,
            relay_url: "wss://relay.example",
            harness: harness_spec("codex").unwrap(),
            system_prompt: Some("Find prospects."),
            model: Some("gpt-5"),
            provider: Some("openai"),
            inline_nsec: inline,
        }
    }

    // ---- harness catalog ----

    #[test]
    fn every_documented_harness_resolves() {
        for id in ["claude", "codex", "opencode", "goose", "buzz-agent"] {
            assert_eq!(harness_spec(id).unwrap().id, id);
        }
    }

    #[test]
    fn harness_commands_match_the_desktop_catalog() {
        assert_eq!(
            harness_spec("claude").unwrap().agent_command,
            "claude-agent-acp"
        );
        assert_eq!(harness_spec("codex").unwrap().agent_command, "codex-acp");
        assert_eq!(harness_spec("opencode").unwrap().agent_args, &["acp"]);
        assert_eq!(harness_spec("goose").unwrap().mcp_command, "");
        assert_eq!(
            harness_spec("buzz-agent").unwrap().mcp_command,
            "buzz-dev-mcp"
        );
    }

    #[test]
    fn only_login_based_harnesses_declare_a_login() {
        for id in ["claude", "codex", "opencode", "goose"] {
            assert!(
                harness_spec(id).unwrap().login.is_some(),
                "{id} runs on the founder's login and must say so"
            );
        }
        assert!(
            harness_spec("buzz-agent").unwrap().login.is_none(),
            "the bundled agent needs no login of its own"
        );
    }

    #[test]
    fn a_record_resolves_back_to_the_harness_it_was_created_with() {
        for harness in HARNESSES {
            let mut agent = sample(None);
            agent.harness = harness;
            let record = build_record(&agent, "now");
            assert_eq!(
                harness_for_record(&record).map(|h| h.id),
                Some(harness.id),
                "harness '{}' did not round-trip through its record",
                harness.id
            );
        }
    }

    #[test]
    fn the_override_wins_over_a_stale_agent_command() {
        let record = json!({
            "agent_command": "goose",
            "agent_command_override": "codex-acp",
        });
        assert_eq!(harness_for_record(&record).map(|h| h.id), Some("codex"));
    }

    #[test]
    fn a_custom_harness_binary_pins_nothing() {
        let record = json!({ "agent_command": "my-own-acp-adapter" });
        assert!(harness_for_record(&record).is_none());
        assert!(harness_for_record(&json!({})).is_none());
    }

    #[test]
    fn an_unknown_harness_is_an_input_error_listing_the_known_ones() {
        let err = harness_spec("gemini").unwrap_err();
        let message = err.to_string();
        assert!(message.contains("gemini"), "unexpected error: {message}");
        assert!(
            message.contains("buzz-agent"),
            "unexpected error: {message}"
        );
    }

    // ---- record shape, pinned field by field against the desktop struct ----

    #[test]
    fn record_carries_every_field_the_desktop_struct_requires() {
        let record = build_record(&sample(None), "2026-09-04T00:00:00+00:00");
        let object = record.as_object().expect("record must be a JSON object");

        // Fields declared WITHOUT `#[serde(default)]` in the desktop's
        // `ManagedAgentRecord`: absent means the desktop cannot parse the store.
        for key in [
            "pubkey",
            "name",
            "relay_url",
            "acp_command",
            "agent_command",
            "agent_args",
            "mcp_command",
            "turn_timeout_seconds",
            "system_prompt",
            "created_at",
            "updated_at",
            "last_started_at",
            "last_stopped_at",
            "last_exit_code",
            "last_error",
        ] {
            assert!(
                object.contains_key(key),
                "record is missing required key {key}"
            );
        }
    }

    /// Every key `ManagedAgentRecord` declares, as of
    /// `desktop/src-tauri/src/managed_agents/types.rs`. A key outside this set
    /// is dropped the first time the desktop rewrites the store, so it looks
    /// like a setting that silently stopped applying.
    const DESKTOP_RECORD_KEYS: &[&str] = &[
        "pubkey",
        "name",
        "persona_id",
        "creation_request_id",
        "team_id",
        "private_key_nsec",
        "auth_tag",
        "relay_url",
        "owner_pubkey",
        "avatar_url",
        "acp_command",
        "agent_command",
        "agent_command_override",
        "agent_args",
        "mcp_command",
        "turn_timeout_seconds",
        "idle_timeout_seconds",
        "max_turn_duration_seconds",
        "parallelism",
        "system_prompt",
        "model",
        "provider",
        "persona_source_version",
        "env_vars",
        "start_on_app_launch",
        "auto_restart_on_config_change",
        "runtime_pid",
        "backend",
        "backend_agent_id",
        "provider_binary_path",
        "persona_team_dir",
        "persona_name_in_team",
        "created_at",
        "updated_at",
        "last_started_at",
        "last_stopped_at",
        "last_exit_code",
        "last_error",
        "last_error_code",
        "respond_to",
        "respond_to_allowlist",
        "display_name",
        "slug",
        "role_id",
        "role_title",
        "tier",
    ];

    #[test]
    fn the_record_writes_no_key_the_desktop_struct_does_not_declare() {
        let mut agent = sample(None);
        agent.inline_nsec = Some("nsec1test");
        let record = build_record(&agent, "2026-09-04T00:00:00+00:00");

        for key in record.as_object().unwrap().keys() {
            assert!(
                DESKTOP_RECORD_KEYS.contains(&key.as_str()),
                "`{key}` is not a ManagedAgentRecord field; the desktop drops it \
                 on its next write"
            );
        }
    }

    #[test]
    fn the_harness_choice_is_pinned_where_the_desktop_reads_it() {
        // `effective_agent_command` reads `agent_command_override` first and
        // otherwise falls back to the persona runtime. A CLI-minted agent has
        // no persona, so the override is the only thing that makes `--harness`
        // survive to spawn.
        for harness in HARNESSES {
            let mut agent = sample(None);
            agent.harness = harness;
            let record = build_record(&agent, "now");
            assert_eq!(
                record["agent_command_override"],
                json!(harness.agent_command),
                "harness '{}' must pin its command as an override",
                harness.id
            );
        }
    }

    #[test]
    fn record_field_types_match_the_desktop_struct() {
        let record = build_record(&sample(None), "2026-09-04T00:00:00+00:00");

        assert_eq!(record["pubkey"], json!("aa"));
        assert_eq!(record["name"], json!("scout"));
        assert_eq!(record["relay_url"], json!("wss://relay.example"));
        assert_eq!(record["owner_pubkey"], json!("bb"));
        assert_eq!(record["auth_tag"], json!(r#"["auth","bb","","sig"]"#));
        assert_eq!(record["acp_command"], json!("buzz-acp"));
        assert_eq!(record["agent_command"], json!("codex-acp"));
        assert_eq!(record["agent_args"], json!([]));
        assert_eq!(record["mcp_command"], json!("buzz-dev-mcp"));
        assert_eq!(record["turn_timeout_seconds"], json!(320));
        assert_eq!(record["parallelism"], json!(10));
        assert_eq!(record["respond_to"], json!("owner-only"));
        assert_eq!(record["agent_command_override"], json!("codex-acp"));
        assert_eq!(record["model"], json!("gpt-5"));
        assert_eq!(record["provider"], json!("openai"));
        assert_eq!(record["system_prompt"], json!("Find prospects."));
        assert_eq!(record["start_on_app_launch"], json!(false));
        assert!(record["last_started_at"].is_null());
        assert!(record["last_stopped_at"].is_null());
        assert!(record["last_exit_code"].is_null());
        assert!(record["last_error"].is_null());
    }

    #[test]
    fn optional_text_fields_serialize_as_null_not_absent() {
        let mut agent = sample(None);
        agent.system_prompt = None;
        agent.model = None;
        agent.provider = None;
        let record = build_record(&agent, "2026-09-04T00:00:00+00:00");
        let object = record.as_object().unwrap();

        assert!(object.contains_key("system_prompt"));
        assert!(record["system_prompt"].is_null());
        assert!(record["model"].is_null());
        assert!(record["provider"].is_null());
    }

    #[test]
    fn the_inline_key_is_written_only_in_the_keyringless_fallback() {
        let without = build_record(&sample(None), "now");
        assert!(
            !without
                .as_object()
                .unwrap()
                .contains_key("private_key_nsec"),
            "a keyring-backed record must not carry a plaintext key"
        );

        let with = build_record(&sample(Some("nsec1fallback")), "now");
        assert_eq!(with["private_key_nsec"], json!("nsec1fallback"));
    }

    // ---- store filtering and lookup ----

    #[test]
    fn definitions_are_not_listed_as_instances() {
        let records = vec![
            json!({ "pubkey": "", "name": "researcher", "slug": "researcher" }),
            json!({ "pubkey": "abc", "name": "scout" }),
        ];
        let listed = instances(&records);
        assert_eq!(listed.len(), 1);
        assert_eq!(record_name(listed[0]), "scout");
    }

    #[test]
    fn lookup_matches_pubkey_then_name_case_insensitively() {
        let records = vec![
            json!({ "pubkey": "", "name": "scout" }),
            json!({ "pubkey": "abc", "name": "Scout" }),
            json!({ "pubkey": "def", "name": "runner" }),
        ];

        assert_eq!(
            record_pubkey(find_instance(&records, "abc").unwrap()),
            "abc"
        );
        assert_eq!(
            record_pubkey(find_instance(&records, "scout").unwrap()),
            "abc"
        );
        assert_eq!(
            record_pubkey(find_instance(&records, "SCOUT").unwrap()),
            "abc"
        );
        assert!(find_instance(&records, "missing").is_none());
    }

    #[test]
    fn a_definition_is_never_returned_by_lookup() {
        let records = vec![json!({ "pubkey": "", "name": "researcher" })];
        assert!(find_instance(&records, "researcher").is_none());
    }

    #[test]
    fn the_summary_never_carries_the_private_key() {
        let record = build_record(&sample(Some("nsec1leak")), "now");
        let summary = summarize(&record).to_string();
        assert!(
            !summary.contains("nsec1leak"),
            "summary leaked the key: {summary}"
        );
        assert!(!summary.contains("private_key_nsec"));
    }

    // ---- store IO ----

    #[test]
    fn secret_location_names_are_stable() {
        assert_eq!(SecretLocation::Keyring.as_str(), "keyring");
        assert_eq!(SecretLocation::File.as_str(), "file");
    }

    #[test]
    fn the_keyring_blob_key_is_namespaced_like_the_desktops() {
        assert_eq!(agent_secret_key("abc"), "agent:abc");
    }

    #[test]
    fn an_absent_or_empty_store_reads_as_no_agents() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("managed-agents.json");
        assert!(load_store_at(&path).unwrap().is_empty());

        std::fs::write(&path, "   ").unwrap();
        assert!(load_store_at(&path).unwrap().is_empty());
    }

    #[test]
    fn a_store_that_is_not_an_array_is_refused_rather_than_reset() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("managed-agents.json");
        std::fs::write(&path, r#"{"agents": []}"#).unwrap();

        let err = load_store_at(&path).unwrap_err().to_string();
        assert!(err.contains("not a JSON array"), "unexpected error: {err}");
    }

    #[test]
    fn appending_preserves_every_pre_existing_record_verbatim() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agents").join("managed-agents.json");

        let definition = json!({
            "pubkey": "",
            "name": "researcher",
            "slug": "researcher",
            "a_field_this_cli_knows_nothing_about": 7,
        });
        let existing_instance = json!({ "pubkey": "beef", "name": "runner" });
        write_store_at(&path, &[definition.clone(), existing_instance.clone()]).unwrap();

        let mut records = load_store_at(&path).unwrap();
        records.push(build_record(&sample(None), "2026-09-04T00:00:00+00:00"));
        write_store_at(&path, &records).unwrap();

        let reread = load_store_at(&path).unwrap();
        assert_eq!(reread.len(), 3);
        assert_eq!(reread[0], definition, "definition record was rewritten");
        assert_eq!(reread[1], existing_instance, "sibling agent was rewritten");
        assert_eq!(record_name(&reread[2]), "scout");
        assert_eq!(
            instances(&reread).len(),
            2,
            "the definition must not count as an agent"
        );
    }

    #[test]
    #[cfg(unix)]
    fn the_store_is_written_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agents").join("managed-agents.json");
        write_store_at(&path, &[build_record(&sample(Some("nsec1secret")), "now")]).unwrap();

        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(
            mode & 0o777,
            0o600,
            "managed-agents.json may carry a plaintext key"
        );
    }

    // ---- keyring merge ----

    /// An in-memory [`BlobStore`] standing in for the OS keyring.
    struct FakeBlob {
        blob: std::cell::RefCell<Option<String>>,
        writes_fail: bool,
    }

    impl FakeBlob {
        fn seeded(raw: Option<&str>) -> Self {
            Self {
                blob: std::cell::RefCell::new(raw.map(str::to_string)),
                writes_fail: false,
            }
        }
    }

    impl BlobStore for FakeBlob {
        fn read_blob(&self) -> Result<Option<String>, CliError> {
            Ok(self.blob.borrow().clone())
        }
        fn write_blob(&self, json: &str) -> Result<(), CliError> {
            if self.writes_fail {
                return Err(CliError::Other("keyring write: unavailable".into()));
            }
            *self.blob.borrow_mut() = Some(json.to_string());
            Ok(())
        }
    }

    #[test]
    fn storing_an_agent_key_keeps_the_identity_and_sibling_agents() {
        let seed = json!({
            "identity": "nsec-founder",
            "agent:sibling": "nsec-sibling",
        })
        .to_string();
        let store = FakeBlob::seeded(Some(&seed));

        let location = store_agent_secret_in(&store, "abc", "nsec-new").unwrap();
        assert_eq!(location, SecretLocation::Keyring);

        let raw = store.read_blob().unwrap();
        let map = identity::parse_blob(raw.as_deref()).unwrap();
        assert_eq!(
            map.get("identity").map(String::as_str),
            Some("nsec-founder")
        );
        assert_eq!(
            map.get("agent:sibling").map(String::as_str),
            Some("nsec-sibling")
        );
        assert_eq!(map.get("agent:abc").map(String::as_str), Some("nsec-new"));
        assert_eq!(map.len(), 3);
    }

    #[test]
    fn the_key_is_read_back_from_the_keyring_before_the_inline_copy() {
        let seed = json!({ "agent:abc": "nsec-keyring" }).to_string();
        let store = FakeBlob::seeded(Some(&seed));
        let record = json!({ "private_key_nsec": "nsec-stale-inline" });

        assert_eq!(
            read_agent_secret_in(&store, "abc", &record).unwrap(),
            "nsec-keyring"
        );
    }

    #[test]
    fn the_inline_key_is_used_when_the_keyring_has_none() {
        let store = FakeBlob::seeded(None);
        let record = json!({ "private_key_nsec": "nsec-inline" });
        assert_eq!(
            read_agent_secret_in(&store, "abc", &record).unwrap(),
            "nsec-inline"
        );
    }

    #[test]
    fn a_key_stored_nowhere_is_a_named_error_not_an_empty_string() {
        let store = FakeBlob::seeded(None);
        let err = read_agent_secret_in(&store, "abc", &json!({}))
            .unwrap_err()
            .to_string();
        assert!(err.contains("agent:abc"), "unexpected error: {err}");
    }

    #[test]
    fn a_failed_keyring_write_falls_back_to_the_file_instead_of_erroring() {
        let store = FakeBlob {
            blob: std::cell::RefCell::new(None),
            writes_fail: true,
        };
        assert_eq!(
            store_agent_secret_in(&store, "abc", "nsec-new").unwrap(),
            SecretLocation::File
        );
    }

    /// Round-trips a real OS keyring entry under a throwaway service name and
    /// proves an agent key merges in without disturbing the founder identity.
    ///
    /// Ignored by default for the same reason as the identity module's live
    /// test: it needs a real keyring, which CI does not have. Run it with
    /// `cargo test -p buzz-cli -- --ignored live_keyring_agent_key`.
    #[test]
    #[ignore = "touches the OS keyring; run manually"]
    fn live_keyring_agent_key_merges_beside_the_identity() {
        let service = format!("buzz-cli-agents-test-{}", std::process::id());
        let store = KeyringBlobStore::new(service.clone());

        let seed = json!({ "identity": "nsec-founder" }).to_string();
        store.write_blob(&seed).expect("seed the throwaway blob");

        let location =
            store_agent_secret_in(&store, "deadbeef", "nsec-agent").expect("store the agent key");

        let raw = store.read_blob().expect("re-read the throwaway blob");
        let map = identity::parse_blob(raw.as_deref()).expect("parse");

        // Clean up before asserting so a failure never leaks a keychain item.
        if let Ok(entry) = keyring::Entry::new(&service, identity::BLOB_ACCOUNT) {
            let _ = entry.delete_credential();
        }

        assert_eq!(location, SecretLocation::Keyring);
        assert_eq!(
            map.get("identity").map(String::as_str),
            Some("nsec-founder")
        );
        assert_eq!(
            map.get("agent:deadbeef").map(String::as_str),
            Some("nsec-agent")
        );
        assert_eq!(map.len(), 2, "the merge must not drop the identity");
    }
}
