//! OS process boundary for Electron-managed local workers and descendants.
mod host_login;
pub(crate) mod launch;
pub(crate) mod network;
pub(crate) mod subscriptions;

use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
    process::Command,
};

/// Host-owned permissions for one worker and all of its descendants.
/// Do not construct permissions from model output or agent-controlled settings.
pub(super) struct WorkerPolicy {
    workspace: PathBuf,
    reads: Vec<(PathBuf, bool)>,
    sockets: Vec<PathBuf>,
    ports: Vec<u16>,
    listen_port: Option<u16>,
    metadata: Vec<PathBuf>,
}

impl WorkerPolicy {
    /// Require an existing, dedicated worker directory. This grants its entire tree.
    pub(super) fn new(workspace: &Path) -> Result<Self, String> {
        let workspace = workspace.canonicalize().map_err(|e| e.to_string())?;
        if !workspace.is_dir() || broad_root(&workspace) {
            return Err("A dedicated worker directory is required".into());
        }
        Ok(Self {
            workspace,
            reads: vec![],
            sockets: vec![],
            ports: vec![],
            listen_port: None,
            metadata: vec![],
        })
    }

    /// Add one existing runtime file or directory selected by the trusted host.
    pub(super) fn allow_runtime(&mut self, path: &Path) -> Result<(), String> {
        let path = path.canonicalize().map_err(|e| e.to_string())?;
        if broad_root(&path) {
            return Err("Runtime permission is too broad".into());
        }
        let tree = path.is_dir();
        self.reads.push((path, tree));
        Ok(())
    }

    /// Permit fstat on a host-opened worker log without granting file contents.
    pub(super) fn allow_log_metadata(&mut self, path: &Path) -> Result<(), String> {
        self.metadata.push(host_leaf(path)?);
        Ok(())
    }

    /// Permit a single host-managed file, including an atomically replaced grant.
    /// Its parent must exist and remain under trusted host control.
    pub(super) fn allow_host_file(&mut self, path: &Path) -> Result<(), String> {
        self.reads.push((host_leaf(path)?, false));
        Ok(())
    }

    /// Permit connecting to one Unix socket. This does not permit sibling sockets.
    pub(super) fn allow_socket(&mut self, path: &Path) -> Result<(), String> {
        self.sockets.push(host_leaf(path)?);
        Ok(())
    }

    /// Permit one loopback TCP port for a host-owned gateway. DNS and external
    /// connections remain denied. Seatbelt supports localhost, not arbitrary IPs.
    pub(super) fn allow_loopback_port(&mut self, port: u16) -> Result<(), String> {
        if port == 0 {
            return Err("A concrete loopback TCP port is required".into());
        }
        self.ports.push(port);
        Ok(())
    }

    /// Permit the ACP spending checkpoint to bind only its assigned loopback port.
    pub(super) fn allow_meter_listener(&mut self, port: u16) -> Result<(), String> {
        if port == 0 {
            return Err("A concrete metering port is required".into());
        }
        self.listen_port = Some(port);
        Ok(())
    }

    /// Start with an empty environment and a private cwd/HOME/temp tree.
    /// Unsupported operating systems fail closed; there is no plain-command fallback.
    pub(super) fn command(&self, executable: &OsStr) -> Result<Command, String> {
        if !cfg!(target_os = "macos") {
            return Err("Local worker isolation is not supported on this platform".into());
        }
        let temp = self.workspace.join("tmp");
        launch::private_directory(&temp)?;
        let mut command = Command::new("/usr/bin/sandbox-exec");
        let mut policy = String::from(include_str!("isolation/base.sbpl"));
        let mut parameter = |name: String, value: &OsStr| {
            let mut arg = std::ffi::OsString::from(name);
            arg.push("=");
            arg.push(value);
            command.arg("-D").arg(arg);
        };
        parameter("WORKSPACE".into(), self.workspace.as_os_str());
        for (index, (path, tree)) in self.reads.iter().enumerate() {
            let name = format!("READ{index}");
            parameter(name.clone(), path.as_os_str());
            let filter = if *tree { "subpath" } else { "literal" };
            policy.push_str(&format!("\n(allow file-read* ({filter} (param \"{name}\")))\n(allow file-read-metadata (path-ancestors (param \"{name}\")))"));
        }
        for (index, path) in self.metadata.iter().enumerate() {
            let name = format!("LOG{index}");
            parameter(name.clone(), path.as_os_str());
            policy.push_str(&format!(
                "\n(allow file-read-metadata (literal (param \"{name}\")))"
            ));
        }
        if !self.sockets.is_empty() {
            policy.push_str("\n(allow system-socket (socket-domain AF_UNIX))");
        }
        for (index, path) in self.sockets.iter().enumerate() {
            let name = format!("SOCKET{index}");
            parameter(name.clone(), path.as_os_str());
            policy.push_str(&format!("\n(allow network-outbound (remote unix-socket (path (param \"{name}\"))))\n(allow file-read-metadata (literal (param \"{name}\")) (path-ancestors (param \"{name}\")))"));
        }
        for (index, port) in self.ports.iter().enumerate() {
            let name = format!("TCP{index}");
            parameter(name.clone(), OsStr::new(&format!("localhost:{port}")));
            policy.push_str(&format!(
                "\n(allow network-outbound (remote tcp (param \"{name}\")))"
            ));
        }
        if let Some(port) = self.listen_port {
            parameter("METER".into(), OsStr::new(&format!("localhost:{port}")));
            policy.push_str("\n(allow network-bind network-inbound (local tcp (param \"METER\")))");
        }
        command.arg("-p").arg(policy).arg(executable);
        command
            .env_clear()
            .env("HOME", &self.workspace)
            .env("TMPDIR", &temp)
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .current_dir(&self.workspace);
        Ok(command)
    }
}

fn broad_root(path: &Path) -> bool {
    path.parent().is_none()
        || [
            "/Users",
            "/private",
            "/private/tmp",
            "/private/var",
            "/System",
            "/usr",
            "/tmp",
            "/Applications",
        ]
        .iter()
        .any(|root| path == Path::new(root))
        || dirs::home_dir().is_some_and(|home| home.starts_with(path))
}

fn host_leaf(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("Host permission must be absolute".into());
    }
    let parent = path
        .parent()
        .ok_or("Missing host directory")?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let name = path.file_name().ok_or("Missing host filename")?;
    if path
        .components()
        .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err("Host permission must not contain parent traversal".into());
    }
    Ok(parent.join(name))
}

#[cfg(test)]
#[path = "isolation/tests.rs"]
mod tests;

#[cfg(all(test, target_os = "macos"))]
#[path = "isolation/runtime_tests.rs"]
mod runtime_tests;

#[cfg(all(test, target_os = "macos"))]
#[path = "isolation/agent_tests.rs"]
mod agent_tests;
