//! Headless launcher for a managed agent: the local half of
//! `buzz agents run | status | stop`.
//!
//! Buzz Desktop supervises `buzz-acp` but is not required by it. This module
//! reproduces the environment the desktop's `spawn_agent_child`
//! (`desktop/src-tauri/src/managed_agents/runtime.rs`) injects, so an agent
//! minted by `buzz agents create` answers mentions with the desktop closed.
//!
//! Two things are deliberately NOT reproduced:
//!
//! - The `BUZZ_MANAGED_AGENT` ownership stamp. The desktop stamps every agent
//!   it spawns with its own bundle id and its orphan sweep reaps, adopts, and
//!   force-restarts any live process carrying that exact entry
//!   (`runtime/orphan_sweep.rs` gates on `process_has_buzz_marker` alone). A
//!   CLI-run agent has no desktop supervising it, so wearing that stamp would
//!   let a desktop launched later kill it or claim it as its own. It is
//!   stamped with [`CLI_OWNER_ENV`] instead, which the sweep's exact-entry
//!   match can never mistake for its own, and any inherited
//!   `BUZZ_MANAGED_AGENT` is scrubbed so an ambient value cannot leak in.
//! - `runtime_pid` on the stored record. That field is how the desktop
//!   re-attaches to a process across a restart; writing it would hand a
//!   CLI-run process to the desktop's lifecycle. This module keeps its own
//!   pidfiles under `{app_data}/agents/cli-runs/` and never rewrites the
//!   managed-agent store.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::CliError;
use crate::identity;
use crate::managed_agents::{self, HarnessSpec};

/// Env var overriding the `buzz-acp` binary the launcher spawns.
///
/// Production resolution (next to `buzz`, then `PATH`) needs a real harness
/// installed, which makes the spawn contract untestable. Pointing this at a
/// script that dumps its environment is how the injected env is asserted.
pub const ACP_BIN_ENV: &str = "BUZZ_ACP_BIN";

/// Ownership stamp written on every CLI-run agent, replacing the desktop's
/// `BUZZ_MANAGED_AGENT`. See the module doc comment for why it must differ.
pub const CLI_OWNER_ENV: &str = "BUZZ_MANAGED_AGENT_CLI";

/// Value of [`CLI_OWNER_ENV`]. Constant rather than a pid or a nonce so a
/// human reading `ps -E` can tell at a glance who started the process.
pub const CLI_OWNER_VALUE: &str = "buzz-cli";

/// Env vars stripped from every spawn.
///
/// The first three are the desktop's own scrub list: legacy aliases that
/// `buzz-acp` still promotes to the canonical key, so an ambient value would
/// silently replace the agent identity this command resolved.
/// `BUZZ_ACP_SETUP_PAYLOAD` puts the harness into setup-listener mode instead
/// of running the agent pool, and only the desktop is entitled to compute it.
/// The last two are the desktop ownership stamp: inheriting them from a
/// desktop-spawned parent shell would make a CLI-run agent look like the
/// desktop's own to its sweep.
pub const SCRUBBED_ENV: &[&str] = &[
    "BUZZ_ACP_PRIVATE_KEY",
    "BUZZ_ACP_API_TOKEN",
    "BUZZ_API_TOKEN",
    "BUZZ_ACP_SETUP_PAYLOAD",
    "BUZZ_MANAGED_AGENT",
    "BUZZ_MANAGED_AGENT_START_NONCE",
];

/// Harnesses `run` falls back to when neither `--harness` nor the record names
/// one, in the order they are tried. Every entry is login-based, which is why
/// the fallback still prints the consent line before spawning.
pub const HARNESS_FALLBACK_ORDER: &[&str] = &["claude", "codex", "opencode", "goose"];

// ── Command resolution ─────────────────────────────────────────────────────

/// Whether `path` is a file this user can execute.
fn is_executable_file(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// First entry of `PATH` holding an executable named `command`.
///
/// A `command` that already contains a path separator is taken literally, so
/// `--harness`-adjacent absolute paths and `./script` both resolve.
pub fn find_on_path(command: &str) -> Option<PathBuf> {
    if command.is_empty() {
        return None;
    }
    if command.contains(std::path::MAIN_SEPARATOR) || command.contains('/') {
        let direct = PathBuf::from(command);
        return is_executable_file(&direct).then_some(direct);
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(command))
        .find(|candidate| is_executable_file(candidate))
}

/// Resolve the `buzz-acp` binary: [`ACP_BIN_ENV`], then the directory holding
/// the running `buzz` binary, then `PATH`.
///
/// The sibling lookup comes before `PATH` because the release tarball ships
/// `buzz` and `buzz-acp` together: a founder who unpacked it into a directory
/// that is not on `PATH` must still be able to run an agent.
pub fn resolve_acp_binary() -> Result<PathBuf, CliError> {
    if let Some(raw) = std::env::var_os(ACP_BIN_ENV) {
        let candidate = PathBuf::from(&raw);
        if candidate.as_os_str().is_empty() {
            // An exported-but-blank override is an unset one, not a request to
            // spawn the empty string.
        } else if is_executable_file(&candidate) {
            return Ok(candidate);
        } else {
            return Err(CliError::Usage(format!(
                "{ACP_BIN_ENV} points at {}, which is not an executable file",
                candidate.display()
            )));
        }
    }
    if let Some(sibling) = std::env::current_exe().ok().and_then(|exe| {
        exe.parent()
            .map(|dir| dir.join(managed_agents::DEFAULT_ACP_COMMAND))
    }) {
        if is_executable_file(&sibling) {
            return Ok(sibling);
        }
    }
    find_on_path(managed_agents::DEFAULT_ACP_COMMAND).ok_or_else(|| {
        CliError::NotFound(format!(
            "`{}` not found next to the buzz binary or on PATH; install it \
             alongside buzz or set {ACP_BIN_ENV}",
            managed_agents::DEFAULT_ACP_COMMAND
        ))
    })
}

/// Decide which harness an agent runs on.
///
/// Order, as the ticket specifies: the explicit `--harness` flag, then the
/// harness pinned on the stored record, then the first of
/// [`HARNESS_FALLBACK_ORDER`] whose binary `available` reports as present.
///
/// `available` is injected rather than called directly so the decision can be
/// tested without depending on what happens to be installed on the machine
/// running the tests.
///
/// # Errors
///
/// [`CliError::Usage`] for an unknown `--harness` id, and [`CliError::NotFound`]
/// when the fallback finds nothing: an agent that cannot start is worth
/// refusing before a process exists.
pub fn resolve_harness(
    explicit: Option<&str>,
    record: &Value,
    available: &dyn Fn(&str) -> bool,
) -> Result<&'static HarnessSpec, CliError> {
    if let Some(id) = explicit {
        return managed_agents::harness_spec(id);
    }
    if let Some(spec) = managed_agents::harness_for_record(record) {
        return Ok(spec);
    }
    for id in HARNESS_FALLBACK_ORDER {
        if let Ok(spec) = managed_agents::harness_spec(id) {
            if available(spec.agent_command) {
                return Ok(spec);
            }
        }
    }
    Err(CliError::NotFound(format!(
        "no harness: the record pins none and none of {} is installed; pass --harness",
        HARNESS_FALLBACK_ORDER.join(", ")
    )))
}

// ── Claude adapter freshness ───────────────────────────────────────────────

/// Lowest `@anthropic-ai/claude-agent-sdk` the Anthropic API still accepts.
///
/// Below it every turn fails with `400 Claude Code <x> does not support this
/// model; version <y> or newer is required`, which reads like a model problem
/// while the agent simply never answers. The bound moves, so it lives here as
/// one constant rather than being spelled out at each call site.
pub const MIN_CLAUDE_AGENT_SDK: &str = "0.3.251";

/// The one command that fixes a stale adapter.
pub const CLAUDE_ADAPTER_INSTALL_COMMAND: &str =
    "npm install -g @agentclientprotocol/claude-agent-acp@latest";

/// Relative path of the bundled SDK manifest, under a package root.
const CLAUDE_SDK_MANIFEST: &str = "node_modules/@anthropic-ai/claude-agent-sdk/package.json";

/// How many ancestors of the resolved adapter are searched for the manifest.
///
/// The npm layout puts the binary at `<pkg>/dist/index.js` (two levels), and a
/// hoisted install moves the SDK up to the shared `node_modules` a couple of
/// levels above that. Six covers both without walking to the filesystem root.
const CLAUDE_SDK_SEARCH_DEPTH: usize = 6;

/// Version of the `@anthropic-ai/claude-agent-sdk` bundled with the
/// `claude-agent-acp` adapter at `adapter_bin`.
///
/// The global npm bin entry is a symlink into the package tree, so the link is
/// followed first and the manifest is then looked for under each ancestor of
/// the real file. Every failure (a missing binary, an unreadable manifest, a
/// package.json without a version) is `None`: a freshness check that cannot
/// read the version has nothing to say, and guessing would warn founders whose
/// adapter is fine.
pub fn claude_agent_sdk_version(adapter_bin: &Path) -> Option<String> {
    let resolved = std::fs::canonicalize(adapter_bin).ok()?;
    let mut dir = resolved.parent();
    for _ in 0..CLAUDE_SDK_SEARCH_DEPTH {
        let current = dir?;
        let manifest = current.join(CLAUDE_SDK_MANIFEST);
        if let Ok(raw) = std::fs::read_to_string(&manifest) {
            if let Ok(parsed) = serde_json::from_str::<Value>(&raw) {
                if let Some(version) = record_str(&parsed, "version") {
                    return Some(version.to_string());
                }
            }
        }
        dir = current.parent();
    }
    None
}

/// Dotted numeric components of `raw`, ignoring any `-prerelease` or `+build`
/// suffix. `None` when there is no leading number to compare.
fn version_parts(raw: &str) -> Option<Vec<u64>> {
    let core = raw
        .trim()
        .trim_start_matches('v')
        .split(['-', '+'])
        .next()?;
    let parts: Vec<u64> = core
        .split('.')
        .map(|part| part.parse::<u64>())
        .collect::<Result<_, _>>()
        .ok()?;
    (!parts.is_empty()).then_some(parts)
}

/// Whether `found` orders below `minimum`, comparing component by component
/// and treating a missing component as zero. `None` when either side does not
/// parse, which is reported as "nothing to say" rather than as stale.
pub fn version_is_below(found: &str, minimum: &str) -> Option<bool> {
    let found = version_parts(found)?;
    let minimum = version_parts(minimum)?;
    let width = found.len().max(minimum.len());
    for index in 0..width {
        let a = found.get(index).copied().unwrap_or(0);
        let b = minimum.get(index).copied().unwrap_or(0);
        if a != b {
            return Some(a < b);
        }
    }
    Some(false)
}

/// One warning line for a `claude-agent-acp` older than
/// [`MIN_CLAUDE_AGENT_SDK`], or `None` when it is current or unreadable.
///
/// The caller prints this and spawns anyway. A stale adapter still starts, and
/// a founder whose bound moved between releases must not be locked out of
/// running an agent by a check the CLI cannot re-verify against the live API.
pub fn stale_claude_adapter_warning(adapter_bin: &Path) -> Option<String> {
    let found = claude_agent_sdk_version(adapter_bin)?;
    if !version_is_below(&found, MIN_CLAUDE_AGENT_SDK)? {
        return None;
    }
    Some(format!(
        "warning: {} bundles @anthropic-ai/claude-agent-sdk {found}, below the {MIN_CLAUDE_AGENT_SDK} \
         the Anthropic API requires, so every turn will fail with a 400 and the agent will look \
         silent. Fix it with: {CLAUDE_ADAPTER_INSTALL_COMMAND}",
        adapter_bin.display()
    ))
}

// ── Environment ────────────────────────────────────────────────────────────

/// Everything the launcher needs to build one agent's environment.
///
/// Every field is resolved by the caller, which is what keeps [`plan_env`]
/// pure: it reads no env var, no keyring, and no file.
#[derive(Debug, Clone)]
pub struct RunInputs<'a> {
    /// The stored managed-agent record, as raw JSON.
    pub record: &'a Value,
    /// The agent's own nsec, from the keyring or the record fallback.
    pub agent_nsec: &'a str,
    /// The NIP-OA attestation JSON, stored or recomputed.
    pub auth_tag: &'a str,
    /// Hex pubkey of the owner that signed the attestation.
    pub owner_hex: &'a str,
    /// WebSocket relay URL the agent connects to.
    pub relay_url: &'a str,
    /// Harness the agent runs on.
    pub harness: &'static HarnessSpec,
    /// Absolute path of the harness binary, or its bare name when it could not
    /// be resolved. Matches the desktop, which passes the name through rather
    /// than refusing, so the harness reports the miss with its own message.
    pub agent_command: &'a str,
    /// Absolute path of the dev-MCP binary, or `None` when the harness has
    /// none or it is not installed.
    pub mcp_command: Option<&'a str>,
    /// Absolute path of `git-credential-nostr`, or `None` when it is not
    /// installed. Its absence only costs the agent automatic git auth against
    /// the relay, so it is never fatal.
    pub git_credential_helper: Option<&'a str>,
}

/// Build the environment for one agent, as ordered key/value pairs.
///
/// Reproduces `spawn_agent_child`'s writes for every variable that is load
/// bearing without a desktop: identity, relay, attestation, harness wiring,
/// prompt/model/provider, the inbound author gate, and the git credential
/// helper. Desktop-only concerns (provisioned gateway leases, relay-ranked
/// model chains, personas, teams, readiness setup payloads) have no CLI
/// equivalent and are left out rather than faked.
///
/// The returned pairs are applied in order, so a later entry wins.
pub fn plan_env(inputs: &RunInputs<'_>) -> Vec<(String, String)> {
    let record = inputs.record;
    let mut env: Vec<(String, String)> = Vec::new();
    let mut set = |key: &str, value: &str| env.push((key.to_string(), value.to_string()));

    set("BUZZ_PRIVATE_KEY", inputs.agent_nsec);
    set("BUZZ_RELAY_URL", inputs.relay_url);
    set("BUZZ_AUTH_TAG", inputs.auth_tag);

    set("BUZZ_ACP_AGENT_COMMAND", inputs.agent_command);
    set("BUZZ_ACP_AGENT_ARGS", &inputs.harness.agent_args.join(","));
    // Written even when empty: the harness's own default is `goose`'s MCP
    // command, so leaving the key unset would attach an MCP server the record
    // never asked for.
    set("BUZZ_ACP_MCP_COMMAND", inputs.mcp_command.unwrap_or(""));

    if let Some(prompt) = record_str(record, "system_prompt") {
        set("BUZZ_ACP_SYSTEM_PROMPT", prompt);
    }
    if let Some(model) = record_str(record, "model") {
        set("BUZZ_ACP_MODEL", model);
    }
    if let Some(provider) = record_str(record, "provider") {
        set("BUZZ_ACP_PROVIDER", provider);
    }

    let parallelism = record
        .get("parallelism")
        .and_then(Value::as_u64)
        .unwrap_or(u64::from(managed_agents::DEFAULT_PARALLELISM));
    set("BUZZ_ACP_AGENTS", &parallelism.to_string());
    if let Some(idle) = record.get("idle_timeout_seconds").and_then(Value::as_u64) {
        set("BUZZ_ACP_IDLE_TIMEOUT", &idle.to_string());
    }
    if let Some(max) = record
        .get("max_turn_duration_seconds")
        .and_then(Value::as_u64)
    {
        set("BUZZ_ACP_MAX_TURN_DURATION", &max.to_string());
    }
    set("BUZZ_ACP_MULTIPLE_EVENT_HANDLING", "steer");
    set("BUZZ_ACP_DEDUP", "queue");
    set("BUZZ_ACP_RELAY_OBSERVER", "true");

    // Inbound author gate. `owner-only` is the record default and the harness
    // resolves the owner from BUZZ_AUTH_TAG, which is always set above, so
    // BUZZ_ACP_AGENT_OWNER is never needed here.
    let respond_to = record_str(record, "respond_to").unwrap_or(managed_agents::DEFAULT_RESPOND_TO);
    set("BUZZ_ACP_RESPOND_TO", respond_to);
    if respond_to == "allowlist" {
        let allowlist: Vec<&str> = record
            .get("respond_to_allowlist")
            .and_then(Value::as_array)
            .map(|entries| entries.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        set("BUZZ_ACP_RESPOND_TO_ALLOWLIST", &allowlist.join(","));
    }

    if let Some(title) = record_str(record, "display_name").or_else(|| record_str(record, "name")) {
        set("BUZZ_ACP_SESSION_TITLE", title);
    }

    // Git over the relay's smart-HTTP endpoint authenticates with NIP-98, so
    // the helper signs with the agent's own key. Configured through
    // GIT_CONFIG_* rather than a file so nothing is written to ~/.gitconfig,
    // and scoped to the relay's git URL so other remotes are untouched.
    if let Some(helper) = inputs.git_credential_helper {
        let http = relay_http_base_url(inputs.relay_url);
        set("NOSTR_PRIVATE_KEY", inputs.agent_nsec);
        set("GIT_TERMINAL_PROMPT", "0");
        set("GIT_CONFIG_COUNT", "2");
        set("GIT_CONFIG_KEY_0", &format!("credential.{http}/git.helper"));
        set("GIT_CONFIG_VALUE_0", &helper.replace('\\', "/"));
        set(
            "GIT_CONFIG_KEY_1",
            &format!("credential.{http}/git.useHttpPath"),
        );
        set("GIT_CONFIG_VALUE_1", "true");
    }

    // Per-agent env from the record, applied last so a founder's own value
    // wins, except over the keys that carry identity: those are scrubbed from
    // the overrides rather than trusted.
    if let Some(overrides) = record.get("env_vars").and_then(Value::as_object) {
        for (key, value) in overrides {
            let Some(value) = value.as_str() else {
                continue;
            };
            if RESERVED_ENV.contains(&key.as_str()) || SCRUBBED_ENV.contains(&key.as_str()) {
                continue;
            }
            set(key, value);
        }
    }

    set(CLI_OWNER_ENV, CLI_OWNER_VALUE);
    env
}

/// Env keys a record's `env_vars` may never set, because each one decides
/// which identity the agent speaks as or which relay it speaks to.
const RESERVED_ENV: &[&str] = &[
    "BUZZ_PRIVATE_KEY",
    "NOSTR_PRIVATE_KEY",
    "BUZZ_AUTH_TAG",
    "BUZZ_RELAY_URL",
    CLI_OWNER_ENV,
];

/// A record's string field, or `None` when it is absent, null, or blank.
fn record_str<'a>(record: &'a Value, key: &str) -> Option<&'a str> {
    record
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

/// The HTTP form of a relay URL, matching the desktop's
/// `relay::relay_http_base_url`.
pub fn relay_http_base_url(relay_url: &str) -> String {
    let trimmed = relay_url.trim().trim_end_matches('/');
    if let Some(rest) = trimmed.strip_prefix("wss://") {
        return format!("https://{rest}");
    }
    if let Some(rest) = trimmed.strip_prefix("ws://") {
        return format!("http://{rest}");
    }
    trimmed.to_string()
}

/// Working directory for a spawned agent: `~/.buzz` when it is a real
/// directory, otherwise `$HOME`. Mirrors the desktop's
/// `default_agent_workdir`, including its refusal to follow a symlink into a
/// directory the founder did not choose.
pub fn default_agent_workdir() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let nest = home.join(".buzz");
    let is_real_dir = |path: &Path| {
        std::fs::symlink_metadata(path)
            .map(|meta| meta.is_dir())
            .unwrap_or(false)
    };
    if is_real_dir(&nest) {
        return Some(nest);
    }
    is_real_dir(&home).then_some(home)
}

// ── Spawning ───────────────────────────────────────────────────────────────

/// A fully resolved launch, ready to spawn.
#[derive(Debug, Clone)]
pub struct RunPlan {
    /// The `buzz-acp` binary to execute.
    pub acp_bin: PathBuf,
    /// Working directory, or `None` to inherit the caller's.
    pub workdir: Option<PathBuf>,
    /// Environment to set, applied in order.
    pub env: Vec<(String, String)>,
}

/// Spawn `plan`'s process.
///
/// `log` redirects stdout and stderr to a file (the detached form); `None`
/// inherits the caller's, so a foreground run streams to the terminal.
///
/// On Unix the child leads its own process group. That is what makes a
/// detached agent survive the CLI exiting, and it is what lets `stop` signal
/// the whole tree (harness, MCP servers, the agent subprocess) with one call
/// instead of orphaning the children.
///
/// # Errors
///
/// [`CliError::Other`] when the log file cannot be opened or the binary cannot
/// be executed.
pub fn spawn(plan: &RunPlan, log: Option<&Path>) -> Result<std::process::Child, CliError> {
    let mut command = std::process::Command::new(&plan.acp_bin);
    if let Some(dir) = &plan.workdir {
        command.current_dir(dir);
    }
    command.stdin(std::process::Stdio::null());
    if let Some(path) = log {
        let file = open_append(path)?;
        let stderr = file
            .try_clone()
            .map_err(|e| CliError::Other(format!("clone log handle: {e}")))?;
        command.stdout(std::process::Stdio::from(file));
        command.stderr(std::process::Stdio::from(stderr));
    }
    for (key, value) in &plan.env {
        command.env(key, value);
    }
    // Scrubbed last so the removal is unconditional: an inherited value and a
    // planned one both lose. Removing first would leave a plan free to
    // reinstate the desktop ownership stamp, which is the one variable whose
    // absence this module exists to guarantee.
    for key in SCRUBBED_ENV {
        command.env_remove(key);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command
        .spawn()
        .map_err(|e| CliError::Other(format!("failed to spawn {}: {e}", plan.acp_bin.display())))
}

/// Open `path` for appending, creating it and its parent directory.
fn open_append(path: &Path) -> Result<std::fs::File, CliError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| CliError::Other(format!("create {}: {e}", parent.display())))?;
    }
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| CliError::Other(format!("open {}: {e}", path.display())))
}

// ── Pidfiles ───────────────────────────────────────────────────────────────

/// What `status` reports and `stop` acts on, one file per running agent.
///
/// The file carries JSON rather than a bare pid because `status` has to name
/// the harness and the start time, and re-deriving either from the store would
/// report the record's current values rather than the ones the live process
/// was actually started with.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RunRecord {
    /// Hex pubkey of the agent.
    pub pubkey: String,
    /// Agent name at launch.
    pub name: String,
    /// Harness catalog id the process was started on.
    pub harness: String,
    /// Process id of `buzz-acp`, which also leads its process group.
    pub pid: u32,
    /// RFC3339 launch time.
    pub started_at: String,
    /// Log file, absent for a foreground run that streamed to the terminal.
    pub log: Option<String>,
    /// Whether the launch detached; a foreground run removes its own pidfile
    /// when the child exits.
    pub detached: bool,
}

/// Directory holding one pidfile per CLI-run agent.
pub fn run_dir() -> Result<PathBuf, CliError> {
    Ok(identity::app_data_dir()?.join("agents").join("cli-runs"))
}

/// Pidfile path for one agent.
pub fn pidfile_path(pubkey: &str) -> Result<PathBuf, CliError> {
    Ok(run_dir()?.join(format!("{pubkey}.pid")))
}

/// Log path for one agent, written next to its pidfile.
pub fn log_path(pubkey: &str) -> Result<PathBuf, CliError> {
    Ok(run_dir()?.join(format!("{pubkey}.log")))
}

/// Write `record` to `path` atomically, so `status` never reads a half-written
/// pidfile from a launch that is still in progress.
///
/// # Errors
///
/// [`CliError::Other`] on any filesystem failure.
pub fn write_run_record(path: &Path, record: &RunRecord) -> Result<(), CliError> {
    use std::io::Write;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| CliError::Other(format!("create {}: {e}", parent.display())))?;
    }
    let payload = serde_json::to_vec_pretty(record)
        .map_err(|e| CliError::Other(format!("serialize run record: {e}")))?;
    let tmp = path.with_extension("pid.tmp");
    let mut file = std::fs::File::create(&tmp)
        .map_err(|e| CliError::Other(format!("open {}: {e}", tmp.display())))?;
    file.write_all(&payload)
        .map_err(|e| CliError::Other(format!("write {}: {e}", tmp.display())))?;
    file.sync_all()
        .map_err(|e| CliError::Other(format!("sync {}: {e}", tmp.display())))?;
    drop(file);
    std::fs::rename(&tmp, path)
        .map_err(|e| CliError::Other(format!("rename {}: {e}", tmp.display())))
}

/// Read one pidfile.
///
/// # Errors
///
/// [`CliError::Other`] when the file cannot be read or does not parse. A
/// pidfile this command did not write is reported rather than deleted: it may
/// belong to a newer `buzz`.
pub fn read_run_record(path: &Path) -> Result<RunRecord, CliError> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| CliError::Other(format!("read {}: {e}", path.display())))?;
    serde_json::from_str(&raw)
        .map_err(|e| CliError::Other(format!("{} is not a run record: {e}", path.display())))
}

/// Every readable pidfile in [`run_dir`], sorted by agent name then pubkey so
/// `status` output is stable between calls.
///
/// A missing directory is an empty list, not an error: nothing has been run
/// yet. An unreadable individual file is skipped rather than failing the whole
/// listing, so one bad file cannot hide every healthy agent.
///
/// # Errors
///
/// [`CliError::Other`] when the app-data directory cannot be resolved or the
/// run directory cannot be listed.
pub fn list_run_records() -> Result<Vec<RunRecord>, CliError> {
    let dir = run_dir()?;
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(CliError::Other(format!("read {}: {e}", dir.display()))),
    };
    let mut records: Vec<RunRecord> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("pid") {
            continue;
        }
        if let Ok(record) = read_run_record(&path) {
            records.push(record);
        }
    }
    records.sort_by(|a, b| (&a.name, &a.pubkey).cmp(&(&b.name, &b.pubkey)));
    Ok(records)
}

// ── Signals ────────────────────────────────────────────────────────────────

/// Whether a process with this pid exists.
///
/// `EPERM` counts as alive: the process is there, this user simply may not
/// signal it. Treating it as dead would make `status` report a running agent
/// as stopped.
///
/// One caveat that never applies to a real agent: an exited child of the
/// CALLING process reads as running until it is waited on, because a zombie
/// still has a pid. `status` and `stop` always run in a different process from
/// the one that spawned the agent, and a detached agent is reaped by init, so
/// neither can see a zombie.
#[cfg(unix)]
pub fn process_is_running(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    // SAFETY: `kill` with signal 0 performs the permission and existence check
    // without delivering a signal. No memory is touched.
    if unsafe { libc::kill(pid as libc::pid_t, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(not(unix))]
pub fn process_is_running(_pid: u32) -> bool {
    false
}

/// Send `signal` to the process group `pid` leads, falling back to the leader
/// alone when the group is gone.
///
/// The group is signalled first because the harness spawns the agent and its
/// MCP servers as children: signalling only the leader leaves them orphaned
/// and still holding the relay subscription.
#[cfg(unix)]
fn signal_group(pid: u32, signal: libc::c_int) -> Result<(), CliError> {
    // SAFETY: a negative pid addresses the process group; no memory is touched.
    if unsafe { libc::kill(-(pid as libc::pid_t), signal) } == 0 {
        return Ok(());
    }
    let group_err = std::io::Error::last_os_error();
    if !process_is_running(pid) {
        return Ok(());
    }
    // SAFETY: same call, addressing the single process.
    if unsafe { libc::kill(pid as libc::pid_t, signal) } == 0 {
        return Ok(());
    }
    let leader_err = std::io::Error::last_os_error();
    if leader_err.raw_os_error() == Some(libc::ESRCH) {
        return Ok(());
    }
    Err(CliError::Other(format!(
        "failed to signal process group {pid}: {group_err}; and process {pid}: {leader_err}"
    )))
}

/// Outcome of stopping one agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopOutcome {
    /// The process exited after SIGTERM.
    Terminated,
    /// The process ignored SIGTERM for the whole grace period and was killed.
    Killed,
    /// No process was running; only the stale pidfile was removed.
    AlreadyStopped,
}

impl StopOutcome {
    /// Stable machine-readable name, used as the `outcome` field of
    /// `buzz agents stop`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Terminated => "terminated",
            Self::Killed => "killed",
            Self::AlreadyStopped => "already-stopped",
        }
    }
}

/// How long SIGTERM is given before SIGKILL.
const STOP_GRACE: std::time::Duration = std::time::Duration::from_secs(10);

/// Poll interval while waiting for a signalled process to exit.
const STOP_POLL: std::time::Duration = std::time::Duration::from_millis(100);

/// SIGTERM the agent's process group, wait up to [`STOP_GRACE`], then SIGKILL.
///
/// # Errors
///
/// [`CliError::Other`] when a signal fails for a reason other than the process
/// having already exited.
#[cfg(unix)]
pub fn stop_process(pid: u32) -> Result<StopOutcome, CliError> {
    if !process_is_running(pid) {
        return Ok(StopOutcome::AlreadyStopped);
    }
    signal_group(pid, libc::SIGTERM)?;
    let deadline = std::time::Instant::now() + STOP_GRACE;
    while std::time::Instant::now() < deadline {
        if !process_is_running(pid) {
            return Ok(StopOutcome::Terminated);
        }
        std::thread::sleep(STOP_POLL);
    }
    signal_group(pid, libc::SIGKILL)?;
    Ok(StopOutcome::Killed)
}

#[cfg(not(unix))]
pub fn stop_process(_pid: u32) -> Result<StopOutcome, CliError> {
    Err(CliError::Usage(
        "`buzz agents stop` needs Unix signals and is not supported on this platform".into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn record() -> Value {
        json!({
            "pubkey": "aa",
            "name": "scout",
            "relay_url": "wss://relay.example",
            "agent_command": "codex-acp",
            "agent_command_override": "codex-acp",
            "system_prompt": "Find prospects.",
            "model": "gpt-5",
            "provider": "openai",
            "parallelism": 4,
            "respond_to": "owner-only",
        })
    }

    fn inputs<'a>(record: &'a Value, harness: &'static HarnessSpec) -> RunInputs<'a> {
        RunInputs {
            record,
            agent_nsec: "nsec1agent",
            auth_tag: r#"["auth","bb","","sig"]"#,
            owner_hex: "bb",
            relay_url: "wss://relay.example",
            harness,
            agent_command: "/opt/bin/codex-acp",
            mcp_command: Some("/opt/bin/buzz-dev-mcp"),
            git_credential_helper: None,
        }
    }

    fn lookup(env: &[(String, String)], key: &str) -> Option<String> {
        env.iter().rfind(|(k, _)| k == key).map(|(_, v)| v.clone())
    }

    // ---- environment ----

    #[test]
    fn the_load_bearing_variables_are_all_written() {
        let record = record();
        let harness = managed_agents::harness_spec("codex").unwrap();
        let env = plan_env(&inputs(&record, harness));

        assert_eq!(
            lookup(&env, "BUZZ_PRIVATE_KEY").as_deref(),
            Some("nsec1agent")
        );
        assert_eq!(
            lookup(&env, "BUZZ_RELAY_URL").as_deref(),
            Some("wss://relay.example")
        );
        assert_eq!(
            lookup(&env, "BUZZ_AUTH_TAG").as_deref(),
            Some(r#"["auth","bb","","sig"]"#)
        );
        assert_eq!(
            lookup(&env, "BUZZ_ACP_AGENT_COMMAND").as_deref(),
            Some("/opt/bin/codex-acp")
        );
        assert_eq!(
            lookup(&env, "BUZZ_ACP_MCP_COMMAND").as_deref(),
            Some("/opt/bin/buzz-dev-mcp")
        );
        assert_eq!(
            lookup(&env, "BUZZ_ACP_SYSTEM_PROMPT").as_deref(),
            Some("Find prospects.")
        );
        assert_eq!(lookup(&env, "BUZZ_ACP_MODEL").as_deref(), Some("gpt-5"));
        assert_eq!(lookup(&env, "BUZZ_ACP_PROVIDER").as_deref(), Some("openai"));
        assert_eq!(lookup(&env, "BUZZ_ACP_AGENTS").as_deref(), Some("4"));
        assert_eq!(
            lookup(&env, "BUZZ_ACP_RESPOND_TO").as_deref(),
            Some("owner-only")
        );
        assert_eq!(
            lookup(&env, "BUZZ_ACP_RELAY_OBSERVER").as_deref(),
            Some("true")
        );
    }

    #[test]
    fn the_ownership_stamp_is_the_cli_one_and_never_the_desktops() {
        let record = record();
        let harness = managed_agents::harness_spec("codex").unwrap();
        let env = plan_env(&inputs(&record, harness));

        assert_eq!(
            lookup(&env, CLI_OWNER_ENV).as_deref(),
            Some(CLI_OWNER_VALUE)
        );
        assert!(
            lookup(&env, "BUZZ_MANAGED_AGENT").is_none(),
            "the desktop stamp would let its orphan sweep reap this process"
        );
        assert!(
            SCRUBBED_ENV.contains(&"BUZZ_MANAGED_AGENT"),
            "an inherited desktop stamp must be scrubbed, not merely left unset"
        );
    }

    #[test]
    fn absent_optional_fields_leave_their_variables_unset() {
        let mut record = record();
        record["system_prompt"] = Value::Null;
        record["model"] = Value::Null;
        record["provider"] = Value::Null;
        let harness = managed_agents::harness_spec("buzz-agent").unwrap();
        let env = plan_env(&inputs(&record, harness));

        assert!(lookup(&env, "BUZZ_ACP_SYSTEM_PROMPT").is_none());
        assert!(lookup(&env, "BUZZ_ACP_MODEL").is_none());
        assert!(lookup(&env, "BUZZ_ACP_PROVIDER").is_none());
    }

    #[test]
    fn a_harness_without_an_mcp_command_still_writes_the_key_empty() {
        let record = record();
        let harness = managed_agents::harness_spec("claude").unwrap();
        let mut inputs = inputs(&record, harness);
        inputs.mcp_command = None;
        let env = plan_env(&inputs);

        assert_eq!(lookup(&env, "BUZZ_ACP_MCP_COMMAND").as_deref(), Some(""));
    }

    #[test]
    fn the_git_helper_is_wired_only_when_it_resolves() {
        let record = record();
        let harness = managed_agents::harness_spec("codex").unwrap();

        let without = plan_env(&inputs(&record, harness));
        assert!(lookup(&without, "NOSTR_PRIVATE_KEY").is_none());
        assert!(lookup(&without, "GIT_CONFIG_COUNT").is_none());

        let mut with_helper = inputs(&record, harness);
        with_helper.git_credential_helper = Some("/opt/bin/git-credential-nostr");
        let env = plan_env(&with_helper);
        assert_eq!(
            lookup(&env, "NOSTR_PRIVATE_KEY").as_deref(),
            Some("nsec1agent"),
            "the helper signs as the agent, so the keys must match"
        );
        assert_eq!(
            lookup(&env, "GIT_CONFIG_KEY_0").as_deref(),
            Some("credential.https://relay.example/git.helper"),
            "the helper must be scoped to the relay, not to every remote"
        );
        assert_eq!(lookup(&env, "GIT_CONFIG_COUNT").as_deref(), Some("2"));
    }

    #[test]
    fn record_env_overrides_cannot_replace_the_agent_identity() {
        let mut record = record();
        record["env_vars"] = json!({
            "BUZZ_PRIVATE_KEY": "nsec1impostor",
            "BUZZ_RELAY_URL": "wss://elsewhere.example",
            "BUZZ_AUTH_TAG": "forged",
            "BUZZ_MANAGED_AGENT": "xyz.block.buzz.app",
            "RUST_LOG": "debug",
        });
        let harness = managed_agents::harness_spec("codex").unwrap();
        let env = plan_env(&inputs(&record, harness));

        assert_eq!(
            lookup(&env, "BUZZ_PRIVATE_KEY").as_deref(),
            Some("nsec1agent")
        );
        assert_eq!(
            lookup(&env, "BUZZ_RELAY_URL").as_deref(),
            Some("wss://relay.example")
        );
        assert_eq!(
            lookup(&env, "BUZZ_AUTH_TAG").as_deref(),
            Some(r#"["auth","bb","","sig"]"#)
        );
        assert!(lookup(&env, "BUZZ_MANAGED_AGENT").is_none());
        assert_eq!(
            lookup(&env, "RUST_LOG").as_deref(),
            Some("debug"),
            "an unreserved override must still apply"
        );
    }

    #[test]
    fn an_allowlist_agent_carries_its_allowlist() {
        let mut record = record();
        record["respond_to"] = json!("allowlist");
        record["respond_to_allowlist"] = json!(["aa", "bb"]);
        let harness = managed_agents::harness_spec("codex").unwrap();
        let env = plan_env(&inputs(&record, harness));

        assert_eq!(
            lookup(&env, "BUZZ_ACP_RESPOND_TO").as_deref(),
            Some("allowlist")
        );
        assert_eq!(
            lookup(&env, "BUZZ_ACP_RESPOND_TO_ALLOWLIST").as_deref(),
            Some("aa,bb")
        );
    }

    #[test]
    fn the_scrub_list_covers_every_legacy_identity_alias() {
        for key in [
            "BUZZ_ACP_PRIVATE_KEY",
            "BUZZ_API_TOKEN",
            "BUZZ_ACP_SETUP_PAYLOAD",
        ] {
            assert!(SCRUBBED_ENV.contains(&key), "{key} must be scrubbed");
        }
    }

    // ---- claude adapter freshness ----

    /// Build the npm layout the global adapter really has: a `bin` symlink
    /// pointing at `<pkg>/dist/index.js`, with the SDK manifest under the
    /// package's own `node_modules`.
    #[cfg(unix)]
    fn fake_adapter(root: &Path, sdk_version: Option<&str>) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;

        let pkg = root.join("lib/node_modules/@agentclientprotocol/claude-agent-acp");
        std::fs::create_dir_all(pkg.join("dist")).unwrap();
        let entry = pkg.join("dist/index.js");
        std::fs::write(&entry, "#!/usr/bin/env node\n").unwrap();
        std::fs::set_permissions(&entry, std::fs::Permissions::from_mode(0o755)).unwrap();

        if let Some(version) = sdk_version {
            let sdk = pkg.join("node_modules/@anthropic-ai/claude-agent-sdk");
            std::fs::create_dir_all(&sdk).unwrap();
            std::fs::write(
                sdk.join("package.json"),
                format!(r#"{{"name":"@anthropic-ai/claude-agent-sdk","version":"{version}"}}"#),
            )
            .unwrap();
        }

        let bin = root.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let link = bin.join("claude-agent-acp");
        std::os::unix::fs::symlink(&entry, &link).unwrap();
        link
    }

    #[test]
    #[cfg(unix)]
    fn the_sdk_version_is_read_through_the_bin_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let link = fake_adapter(dir.path(), Some("0.3.257"));
        assert_eq!(claude_agent_sdk_version(&link).as_deref(), Some("0.3.257"));
    }

    #[test]
    #[cfg(unix)]
    fn an_adapter_without_a_bundled_sdk_reports_no_version() {
        let dir = tempfile::tempdir().unwrap();
        let link = fake_adapter(dir.path(), None);
        assert!(claude_agent_sdk_version(&link).is_none());
        assert!(
            stale_claude_adapter_warning(&link).is_none(),
            "an unreadable version must say nothing, not warn"
        );
    }

    #[test]
    fn a_missing_adapter_reports_no_version() {
        assert!(
            claude_agent_sdk_version(Path::new("/definitely/not/here/claude-agent-acp")).is_none()
        );
    }

    #[test]
    #[cfg(unix)]
    fn a_stale_adapter_warns_with_the_versions_and_the_install_command() {
        let dir = tempfile::tempdir().unwrap();
        let link = fake_adapter(dir.path(), Some("0.3.220"));
        let warning = stale_claude_adapter_warning(&link).expect("0.3.220 is below the minimum");
        assert_eq!(warning.lines().count(), 1, "the warning must be one line");
        assert!(warning.contains("0.3.220"), "got: {warning}");
        assert!(warning.contains(MIN_CLAUDE_AGENT_SDK), "got: {warning}");
        assert!(
            warning.contains(CLAUDE_ADAPTER_INSTALL_COMMAND),
            "got: {warning}"
        );
    }

    #[test]
    #[cfg(unix)]
    fn a_current_adapter_warns_about_nothing() {
        let dir = tempfile::tempdir().unwrap();
        for version in [MIN_CLAUDE_AGENT_SDK, "0.3.257", "0.4.0", "1.0.0"] {
            let root = dir.path().join(version);
            let link = fake_adapter(&root, Some(version));
            assert!(
                stale_claude_adapter_warning(&link).is_none(),
                "{version} must not warn"
            );
        }
    }

    #[test]
    fn version_comparison_is_numeric_and_not_lexicographic() {
        assert_eq!(version_is_below("0.3.220", "0.3.251"), Some(true));
        assert_eq!(version_is_below("0.3.9", "0.3.251"), Some(true));
        assert_eq!(version_is_below("0.3.251", "0.3.251"), Some(false));
        assert_eq!(version_is_below("0.3.257", "0.3.251"), Some(false));
        assert_eq!(version_is_below("0.10.0", "0.9.99"), Some(false));
        assert_eq!(version_is_below("1.0", "0.3.251"), Some(false));
        assert_eq!(version_is_below("0.3", "0.3.251"), Some(true));
        assert_eq!(version_is_below("v0.3.257", "0.3.251"), Some(false));
        assert_eq!(version_is_below("0.3.251-beta.1", "0.3.251"), Some(false));
    }

    #[test]
    fn an_unparseable_version_is_never_called_stale() {
        assert_eq!(version_is_below("unknown", MIN_CLAUDE_AGENT_SDK), None);
        assert_eq!(version_is_below("", MIN_CLAUDE_AGENT_SDK), None);
        assert_eq!(version_is_below("0.3.251", "latest"), None);
    }

    // ---- harness resolution ----

    #[test]
    fn an_explicit_harness_wins_over_the_record() {
        let record = record();
        let spec = resolve_harness(Some("goose"), &record, &|_| false).unwrap();
        assert_eq!(spec.id, "goose");
    }

    #[test]
    fn the_record_harness_is_used_when_no_flag_is_given() {
        let record = record();
        let spec = resolve_harness(None, &record, &|_| false).unwrap();
        assert_eq!(spec.id, "codex");
    }

    #[test]
    fn a_recordless_harness_falls_back_to_the_first_installed() {
        let record = json!({ "pubkey": "aa", "name": "scout" });
        let spec = resolve_harness(None, &record, &|cmd| cmd == "opencode").unwrap();
        assert_eq!(spec.id, "opencode");
    }

    #[test]
    fn the_fallback_order_is_claude_then_codex_then_opencode_then_goose() {
        let record = json!({ "pubkey": "aa", "name": "scout" });
        let spec = resolve_harness(None, &record, &|_| true).unwrap();
        assert_eq!(spec.id, "claude");
        assert_eq!(
            HARNESS_FALLBACK_ORDER,
            ["claude", "codex", "opencode", "goose"]
        );
    }

    #[test]
    fn nothing_installed_and_nothing_pinned_is_an_error_naming_the_flag() {
        let record = json!({ "pubkey": "aa", "name": "scout" });
        let err = resolve_harness(None, &record, &|_| false).unwrap_err();
        assert!(err.to_string().contains("--harness"), "got: {err}");
    }

    #[test]
    fn an_unknown_explicit_harness_is_refused() {
        let record = record();
        assert!(resolve_harness(Some("gemini"), &record, &|_| true).is_err());
    }

    // ---- url + workdir helpers ----

    #[test]
    fn relay_urls_convert_to_their_http_form() {
        assert_eq!(
            relay_http_base_url("wss://relay.example/"),
            "https://relay.example"
        );
        assert_eq!(
            relay_http_base_url("ws://localhost:3000"),
            "http://localhost:3000"
        );
        assert_eq!(
            relay_http_base_url("https://relay.example"),
            "https://relay.example"
        );
    }

    // ---- pidfiles ----

    fn run_record() -> RunRecord {
        RunRecord {
            pubkey: "aa".into(),
            name: "scout".into(),
            harness: "codex".into(),
            pid: 4242,
            started_at: "2026-09-05T00:00:00+00:00".into(),
            log: Some("/tmp/aa.log".into()),
            detached: true,
        }
    }

    #[test]
    fn a_run_record_round_trips_through_its_pidfile() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("aa.pid");
        let record = run_record();
        write_run_record(&path, &record).unwrap();
        assert_eq!(read_run_record(&path).unwrap(), record);
    }

    #[test]
    fn a_pidfile_that_is_not_a_run_record_is_reported_not_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("aa.pid");
        std::fs::write(&path, "4242").unwrap();
        let err = read_run_record(&path).unwrap_err().to_string();
        assert!(err.contains("not a run record"), "got: {err}");
    }

    #[test]
    fn the_pidfile_never_carries_the_agent_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("aa.pid");
        write_run_record(&path, &run_record()).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("nsec"), "pidfile leaked a key: {raw}");
    }

    // ---- liveness and stop ----

    #[test]
    #[cfg(unix)]
    fn this_process_reads_as_running_and_pid_zero_does_not() {
        assert!(process_is_running(std::process::id()));
        assert!(!process_is_running(0));
    }

    #[test]
    fn stop_outcome_names_are_stable() {
        assert_eq!(StopOutcome::Terminated.as_str(), "terminated");
        assert_eq!(StopOutcome::Killed.as_str(), "killed");
        assert_eq!(StopOutcome::AlreadyStopped.as_str(), "already-stopped");
    }

    #[test]
    #[cfg(unix)]
    fn stopping_a_pid_that_is_already_gone_is_not_an_error() {
        // A pid that cannot exist: reaped long ago, never reassigned within
        // this test's lifetime.
        assert_eq!(stop_process(0).unwrap(), StopOutcome::AlreadyStopped);
    }

    // ---- the real spawn, through a stand-in harness ----

    /// Write an executable script that dumps its environment and its process
    /// group to `out`, then exits.
    #[cfg(unix)]
    fn dump_env_script(dir: &Path, out: &Path) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let script = dir.join("fake-buzz-acp");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\n\
                 env > '{out}'\n\
                 echo \"PGID=$(ps -o pgid= -p $$ | tr -d ' ')\" >> '{out}'\n\
                 echo \"PWD_AT_START=$(pwd)\" >> '{out}'\n",
                out = out.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        script
    }

    #[cfg(unix)]
    fn dumped(text: &str, key: &str) -> Option<String> {
        text.lines()
            .find_map(|line| line.strip_prefix(&format!("{key}=")))
            .map(str::to_string)
    }

    #[test]
    #[cfg(unix)]
    fn the_spawned_process_gets_the_planned_env_and_its_own_process_group() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("env.txt");
        let script = dump_env_script(dir.path(), &out);

        let record = record();
        let harness = managed_agents::harness_spec("codex").unwrap();
        let plan = RunPlan {
            acp_bin: script,
            workdir: Some(dir.path().to_path_buf()),
            env: plan_env(&inputs(&record, harness)),
        };
        let mut child = spawn(&plan, None).unwrap();
        let status = child.wait().unwrap();
        assert!(status.success(), "the stand-in harness failed: {status:?}");

        let text = std::fs::read_to_string(&out).unwrap();
        assert_eq!(
            dumped(&text, "BUZZ_PRIVATE_KEY").as_deref(),
            Some("nsec1agent")
        );
        assert_eq!(
            dumped(&text, "BUZZ_RELAY_URL").as_deref(),
            Some("wss://relay.example")
        );
        assert_eq!(
            dumped(&text, "BUZZ_ACP_AGENT_COMMAND").as_deref(),
            Some("/opt/bin/codex-acp")
        );
        assert_eq!(
            dumped(&text, CLI_OWNER_ENV).as_deref(),
            Some(CLI_OWNER_VALUE)
        );
        assert!(
            dumped(&text, "BUZZ_MANAGED_AGENT").is_none(),
            "the desktop stamp reached the child: {text}"
        );

        let pgid: u32 = dumped(&text, "PGID")
            .expect("the stand-in harness must report its process group")
            .trim()
            .parse()
            .expect("pgid must be numeric");
        // SAFETY: `getpgrp` takes no arguments and touches no memory.
        let ours = unsafe { libc::getpgrp() } as u32;
        assert_ne!(
            pgid, ours,
            "the agent must lead its own group so stop can signal its whole tree"
        );
    }

    #[test]
    #[cfg(unix)]
    fn an_inherited_desktop_stamp_is_scrubbed_from_the_child() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("env.txt");
        let script = dump_env_script(dir.path(), &out);

        // Simulate an ambient desktop stamp by planning it explicitly: `spawn`
        // scrubs the key before applying the plan, so even a planned value is
        // removed. This is the same code path an inherited value takes.
        let plan = RunPlan {
            acp_bin: script,
            workdir: Some(dir.path().to_path_buf()),
            env: vec![(
                "BUZZ_MANAGED_AGENT".to_string(),
                "xyz.block.buzz.app".to_string(),
            )],
        };
        let mut child = spawn(&plan, None).unwrap();
        assert!(child.wait().unwrap().success());

        let text = std::fs::read_to_string(&out).unwrap();
        assert!(
            dumped(&text, "BUZZ_MANAGED_AGENT").is_none(),
            "scrub failed: {text}"
        );
    }

    #[test]
    #[cfg(unix)]
    fn a_detached_spawn_writes_its_output_to_the_log_file() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("env.txt");
        let script = dump_env_script(dir.path(), &out);
        let log = dir.path().join("nested").join("aa.log");

        let plan = RunPlan {
            acp_bin: script,
            workdir: Some(dir.path().to_path_buf()),
            env: vec![("BUZZ_PRIVATE_KEY".to_string(), "nsec1agent".to_string())],
        };
        let mut child = spawn(&plan, Some(&log)).unwrap();
        assert!(child.wait().unwrap().success());
        assert!(log.is_file(), "the log file and its parent must be created");
    }

    #[test]
    #[cfg(unix)]
    fn stop_ends_a_live_process_group() {
        let dir = tempfile::tempdir().unwrap();
        use std::os::unix::fs::PermissionsExt;
        let script = dir.path().join("sleeper");
        std::fs::write(&script, "#!/bin/sh\nsleep 120\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        let plan = RunPlan {
            acp_bin: script,
            workdir: None,
            env: Vec::new(),
        };
        let mut child = spawn(&plan, Some(&dir.path().join("sleeper.log"))).unwrap();
        let pid = child.id();
        assert!(process_is_running(pid));

        // Reap concurrently. A signalled child of THIS process stays a zombie
        // until it is waited on, and `kill(pid, 0)` succeeds against a zombie,
        // so without a reaper the poll never observes the exit and SIGTERM
        // looks like it was ignored. Production never hits this: `stop` runs
        // in a different process from the one that spawned the agent, and a
        // detached agent is reaped by init.
        let reaper = std::thread::spawn(move || child.wait());
        let outcome = stop_process(pid).unwrap();
        let _ = reaper.join();
        assert_eq!(outcome, StopOutcome::Terminated);
    }

    // ---- binary resolution ----

    #[test]
    fn a_command_with_a_separator_resolves_directly_or_not_at_all() {
        assert!(find_on_path("/definitely/not/here/buzz-acp").is_none());
        assert!(find_on_path("").is_none());
    }

    #[test]
    #[cfg(unix)]
    fn a_non_executable_file_on_path_is_not_a_command() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("not-executable");
        std::fs::write(&path, "").unwrap();
        assert!(
            find_on_path(&path.display().to_string()).is_none(),
            "a readable but non-executable file must not resolve"
        );
    }
}
