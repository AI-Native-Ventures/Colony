//! Runtime-owned PTY sessions for channel workspace terminal tabs.
//!
//! A tab payload contains only a stable UI session key.  The PTY, process
//! group, reader, and writer live here and are deliberately never serialized
//! into workspace state.  Keeping this boundary in the native shell also
//! keeps the browser and any future shell implementation from gaining direct
//! process access.

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

pub const TERMINAL_OUTPUT_EVENT: &str = "workspace-terminal-output";
pub const TERMINAL_EXIT_EVENT: &str = "workspace-terminal-exit";

const MAX_OUTPUT_BYTES: usize = 256 * 1024;
const TERM: &str = "xterm-256color";
const SHUTDOWN_GRACE: Duration = Duration::from_millis(500);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStartResult {
    pub session_id: String,
    pub cwd: String,
    pub pid: Option<u32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutputEvent {
    session_id: String,
    data: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExitEvent {
    session_id: String,
    code: Option<u32>,
    signal: Option<String>,
}

/// The native manager owns every live terminal session in this process.
#[derive(Default)]
pub struct TerminalManager {
    sessions: Mutex<HashMap<String, Arc<TerminalSession>>>,
}

struct TerminalSession {
    session_id: String,
    app: Option<AppHandle>,
    leader_pid: Option<u32>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    descendants: Mutex<Vec<u32>>,
    output: Mutex<Vec<u8>>,
    shutdown_requested: AtomicBool,
    finished: AtomicBool,
}

impl TerminalManager {
    /// Spawn an interactive shell attached to a real PTY.
    pub fn start(
        &self,
        app: Option<AppHandle>,
        cwd: PathBuf,
        size: PtySize,
    ) -> Result<TerminalStartResult, String> {
        if !cwd.is_dir() {
            return Err(format!(
                "terminal cwd is not a directory: {}",
                cwd.display()
            ));
        }

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(size)
            .map_err(|error| format!("failed to open terminal PTY: {error}"))?;
        let shell = shell_path();
        let mut command = CommandBuilder::new(shell);
        command.arg("-i");
        command.cwd(&cwd);
        command.env("TERM", TERM);
        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| format!("failed to spawn terminal shell: {error}"))?;
        #[cfg(unix)]
        let pty_group_leader = pair.master.process_group_leader().map(|pid| pid as u32);
        #[cfg(not(unix))]
        let pty_group_leader = None;
        let leader_pid = child.process_id().or(pty_group_leader);
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| format!("failed to open terminal writer: {error}"))?;
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| format!("failed to open terminal reader: {error}"))?;
        let session_id = uuid::Uuid::new_v4().to_string();
        let session = Arc::new(TerminalSession {
            session_id: session_id.clone(),
            app,
            leader_pid,
            master: Mutex::new(Some(pair.master)),
            writer: Mutex::new(Some(writer)),
            child: Mutex::new(child),
            descendants: Mutex::new(Vec::new()),
            output: Mutex::new(Vec::new()),
            shutdown_requested: AtomicBool::new(false),
            finished: AtomicBool::new(false),
        });

        self.sessions
            .lock()
            .map_err(|error| format!("terminal session store is poisoned: {error}"))?
            .insert(session_id.clone(), Arc::clone(&session));
        spawn_reader(Arc::clone(&session), reader);
        spawn_tree_watcher(Arc::clone(&session));
        spawn_reaper(session);

        Ok(TerminalStartResult {
            session_id,
            cwd: cwd.display().to_string(),
            pid: leader_pid,
        })
    }

    /// Write bytes received from xterm.js into the PTY.
    pub fn write(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        let session = self.session(session_id)?;
        let mut writer = session
            .writer
            .lock()
            .map_err(|error| format!("terminal writer is poisoned: {error}"))?;
        let writer = writer
            .as_mut()
            .ok_or_else(|| "terminal session has exited".to_string())?;
        writer
            .write_all(data)
            .map_err(|error| format!("failed to write terminal input: {error}"))?;
        writer
            .flush()
            .map_err(|error| format!("failed to flush terminal input: {error}"))
    }

    /// Resize the native PTY to match xterm.js.
    pub fn resize(&self, session_id: &str, size: PtySize) -> Result<(), String> {
        let session = self.session(session_id)?;
        let master = session
            .master
            .lock()
            .map_err(|error| format!("terminal master is poisoned: {error}"))?;
        let master = master
            .as_ref()
            .ok_or_else(|| "terminal session has exited".to_string())?;
        master
            .resize(size)
            .map_err(|error| format!("failed to resize terminal PTY: {error}"))
    }

    /// Stop one session, including all descendants in its process group.
    pub fn close(&self, session_id: &str) -> Result<(), String> {
        let session = self
            .sessions
            .lock()
            .map_err(|error| format!("terminal session store is poisoned: {error}"))?
            .remove(session_id);
        if let Some(session) = session {
            session.stop();
        }
        Ok(())
    }

    /// Stop every session. This is used before a community is applied and at
    /// every app exit path, so no PTY can outlive its relay or process.
    pub fn close_all(&self) {
        let sessions = self
            .sessions
            .lock()
            .map(|mut sessions| sessions.drain().map(|(_, session)| session).collect())
            .unwrap_or_else(|error| {
                eprintln!("buzz-desktop: terminal session store is poisoned: {error}");
                Vec::new()
            });
        for session in sessions {
            session.stop();
        }
    }

    fn session(&self, session_id: &str) -> Result<Arc<TerminalSession>, String> {
        self.sessions
            .lock()
            .map_err(|error| format!("terminal session store is poisoned: {error}"))?
            .get(session_id)
            .cloned()
            .ok_or_else(|| "terminal session was not found".to_string())
    }

    #[cfg(test)]
    fn output(&self, session_id: &str) -> Result<String, String> {
        let session = self.session(session_id)?;
        let output = session
            .output
            .lock()
            .map_err(|error| format!("terminal output is poisoned: {error}"))?;
        Ok(String::from_utf8_lossy(&output).into_owned())
    }
}

impl TerminalSession {
    fn record_output(&self, bytes: &[u8]) {
        if let Ok(mut output) = self.output.lock() {
            output.extend_from_slice(bytes);
            if output.len() > MAX_OUTPUT_BYTES {
                let trim = output.len() - MAX_OUTPUT_BYTES;
                output.drain(..trim);
            }
        }
        if let Ok(data) = String::from_utf8(bytes.to_vec()) {
            self.emit_output(data);
        } else {
            self.emit_output(String::from_utf8_lossy(bytes).into_owned());
        }
    }

    fn emit_output(&self, data: String) {
        let Some(app) = &self.app else {
            return;
        };
        if let Err(error) = app.emit(
            TERMINAL_OUTPUT_EVENT,
            TerminalOutputEvent {
                session_id: self.session_id.clone(),
                data,
            },
        ) {
            eprintln!("buzz-desktop: failed to emit terminal output: {error}");
        }
    }

    fn finish(&self, status: Option<portable_pty::ExitStatus>) {
        if self.finished.swap(true, Ordering::SeqCst) {
            return;
        }
        let Some(app) = &self.app else {
            return;
        };
        let event = TerminalExitEvent {
            session_id: self.session_id.clone(),
            code: status.as_ref().map(portable_pty::ExitStatus::exit_code),
            signal: status.and_then(|status| status.signal().map(str::to_string)),
        };
        if let Err(error) = app.emit(TERMINAL_EXIT_EVENT, event) {
            eprintln!("buzz-desktop: failed to emit terminal exit: {error}");
        }
    }

    fn stop(&self) {
        if self.shutdown_requested.swap(true, Ordering::SeqCst) {
            return;
        }

        if let Some(pid) = self.leader_pid {
            let descendants = self
                .descendants
                .lock()
                .map(|pids| pids.clone())
                .unwrap_or_default();
            terminate_process_tree(pid, &descendants, false);
            let deadline = Instant::now() + SHUTDOWN_GRACE;
            while process_is_running(pid) && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(25));
            }
            if process_is_running(pid) {
                terminate_process_tree(pid, &descendants, true);
            }
        }

        if let Ok(mut child) = self.child.lock() {
            if child.try_wait().ok().flatten().is_none() {
                let _ = child.kill();
                let _ = child.try_wait();
            }
        }
        if let Ok(mut writer) = self.writer.lock() {
            writer.take();
        }
        if let Ok(mut master) = self.master.lock() {
            master.take();
        }
        self.finish(None);
    }
}

fn spawn_reader(session: Arc<TerminalSession>, mut reader: Box<dyn Read + Send>) {
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(bytes) => session.record_output(&buffer[..bytes]),
                Err(error) => {
                    if !session.shutdown_requested.load(Ordering::SeqCst) {
                        eprintln!("buzz-desktop: terminal reader stopped: {error}");
                    }
                    break;
                }
            }
        }
    });
}

fn spawn_reaper(session: Arc<TerminalSession>) {
    thread::spawn(move || {
        let status = session
            .child
            .lock()
            .ok()
            .and_then(|mut child| child.wait().ok());
        if !session.shutdown_requested.load(Ordering::SeqCst) {
            if let Some(pid) = session.leader_pid {
                // A shell can exit while a background child is still in the
                // PTY's process group. Drain that group on natural exit too,
                // otherwise an `exit` command would orphan the child.
                let descendants = session
                    .descendants
                    .lock()
                    .map(|pids| pids.clone())
                    .unwrap_or_default();
                terminate_process_tree(pid, &descendants, false);
                thread::sleep(Duration::from_millis(50));
                terminate_process_tree(pid, &descendants, true);
            }
        }
        session.finish(status);
    });
}

fn spawn_tree_watcher(session: Arc<TerminalSession>) {
    thread::spawn(move || {
        while !session.finished.load(Ordering::SeqCst) {
            if let Some(pid) = session.leader_pid {
                let descendants = collect_process_tree(pid);
                if let Ok(mut known) = session.descendants.lock() {
                    for descendant in descendants {
                        if descendant != pid && !known.contains(&descendant) {
                            known.push(descendant);
                        }
                    }
                }
            }
            thread::sleep(Duration::from_millis(50));
        }
    });
}

fn shell_path() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|shell| !shell.trim().is_empty())
        .unwrap_or_else(|| {
            if cfg!(windows) {
                "cmd.exe".to_string()
            } else {
                "/bin/sh".to_string()
            }
        })
}

#[cfg(unix)]
fn terminate_process_group(pid: u32, force: bool) {
    use nix::sys::signal::{killpg, Signal};
    use nix::unistd::Pid;

    let signal = if force {
        Signal::SIGKILL
    } else {
        Signal::SIGTERM
    };
    if let Err(error) = killpg(Pid::from_raw(pid as i32), signal) {
        let not_running = matches!(error, nix::errno::Errno::ESRCH);
        if !not_running {
            eprintln!("buzz-desktop: failed to signal terminal process group {pid}: {error}");
        }
    }
}

#[cfg(not(unix))]
fn terminate_process_group(_pid: u32, _force: bool) {}

#[cfg(unix)]
fn terminate_process_tree(pid: u32, descendants: &[u32], force: bool) {
    let mut pids = collect_process_tree(pid);
    pids.extend(descendants.iter().copied());
    pids.sort_unstable();
    pids.dedup();
    for descendant in pids.into_iter().rev() {
        signal_pid(descendant, force);
    }
    terminate_process_group(pid, force);
}

#[cfg(not(unix))]
fn terminate_process_tree(_pid: u32, _descendants: &[u32], _force: bool) {}

#[cfg(unix)]
fn signal_pid(pid: u32, force: bool) {
    use nix::sys::signal::{kill, Signal};
    use nix::unistd::Pid;

    let signal = if force {
        Signal::SIGKILL
    } else {
        Signal::SIGTERM
    };
    if let Err(error) = kill(Pid::from_raw(pid as i32), signal) {
        if !matches!(error, nix::errno::Errno::ESRCH) {
            eprintln!("buzz-desktop: failed to signal terminal PID {pid}: {error}");
        }
    }
}

#[cfg(unix)]
fn collect_process_tree(root: u32) -> Vec<u32> {
    let Ok(output) = std::process::Command::new("ps")
        .args(["-axo", "pid=,ppid="])
        .output()
    else {
        return Vec::new();
    };
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let mut fields = line.split_whitespace();
        let Some(pid) = fields.next().and_then(|value| value.parse::<u32>().ok()) else {
            continue;
        };
        let Some(ppid) = fields.next().and_then(|value| value.parse::<u32>().ok()) else {
            continue;
        };
        children.entry(ppid).or_default().push(pid);
    }
    let mut result = Vec::new();
    let mut pending = vec![root];
    while let Some(parent) = pending.pop() {
        for child in children.get(&parent).into_iter().flatten() {
            if !result.contains(child) {
                result.push(*child);
                pending.push(*child);
            }
        }
    }
    result
}

#[cfg(not(unix))]
fn collect_process_tree(_root: u32) -> Vec<u32> {
    Vec::new()
}

#[cfg(unix)]
fn process_is_running(pid: u32) -> bool {
    use nix::sys::signal::kill;
    use nix::unistd::Pid;

    match kill(Pid::from_raw(pid as i32), None) {
        Ok(()) => true,
        Err(error) => !matches!(error, nix::errno::Errno::ESRCH),
    }
}

#[cfg(not(unix))]
fn process_is_running(_pid: u32) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::Duration;

    fn wait_for_output(manager: &TerminalManager, session_id: &str, needle: &str) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if manager
                .output(session_id)
                .is_ok_and(|output| output.contains(needle))
            {
                return;
            }
            thread::sleep(Duration::from_millis(25));
        }
        panic!("terminal output did not contain {needle:?}");
    }

    fn wait_for_descendants(pid: u32) -> Vec<u32> {
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut observed = Vec::new();
        loop {
            let descendants = collect_process_tree(pid);
            for descendant in descendants {
                if !observed.contains(&descendant) {
                    observed.push(descendant);
                }
            }
            if !observed.is_empty() {
                let settle_deadline = Instant::now() + Duration::from_millis(250);
                while Instant::now() < settle_deadline {
                    for descendant in collect_process_tree(pid) {
                        if !observed.contains(&descendant) {
                            observed.push(descendant);
                        }
                    }
                    thread::sleep(Duration::from_millis(25));
                }
                println!("terminal process tree observed: leader={pid}, descendants={observed:?}");
                return observed;
            }
            if Instant::now() >= deadline {
                panic!("terminal leader PID {pid} had no observable descendants");
            }
            thread::sleep(Duration::from_millis(25));
        }
    }

    fn wait_for_processes(pids: &[u32]) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while pids.iter().copied().any(process_is_running) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(25));
        }
        let remaining: Vec<u32> = pids
            .iter()
            .copied()
            .filter(|pid| process_is_running(*pid))
            .collect();
        if !remaining.is_empty() {
            let details = std::process::Command::new("ps")
                .args([
                    "-o",
                    "pid,ppid,pgid,state,command",
                    "-p",
                    &remaining
                        .iter()
                        .map(u32::to_string)
                        .collect::<Vec<_>>()
                        .join(","),
                ])
                .output()
                .ok()
                .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
                .unwrap_or_else(|| "ps unavailable".to_string());
            eprintln!("terminal PID details for {remaining:?}: {details}");
        }
        assert!(
            remaining.is_empty(),
            "terminal PIDs are still live: {remaining:?}"
        );
    }

    fn fixture_manager() -> (TerminalManager, PathBuf) {
        let manager = TerminalManager::default();
        let cwd = std::env::current_dir().expect("current directory");
        (manager, cwd)
    }

    #[test]
    fn terminal_pty_start_writes_and_reads_real_output() {
        let (manager, cwd) = fixture_manager();
        let result = manager
            .start(None, cwd, PtySize::default())
            .expect("PTY start");
        println!("terminal leader pid: {:?}", result.pid);
        manager
            .write(&result.session_id, b"printf 'terminal-proof\\n'; exit\n")
            .expect("write to PTY");
        wait_for_output(&manager, &result.session_id, "terminal-proof");
        if let Some(pid) = result.pid {
            wait_for_processes(&[pid]);
        }
        manager.close(&result.session_id).expect("close PTY");
    }

    #[test]
    fn terminal_pty_resize_updates_size() {
        let (manager, cwd) = fixture_manager();
        let result = manager
            .start(
                None,
                cwd,
                PtySize {
                    rows: 24,
                    cols: 80,
                    pixel_width: 0,
                    pixel_height: 0,
                },
            )
            .expect("PTY start");
        manager
            .resize(
                &result.session_id,
                PtySize {
                    rows: 41,
                    cols: 121,
                    pixel_width: 0,
                    pixel_height: 0,
                },
            )
            .expect("PTY resize");
        manager
            .write(&result.session_id, b"stty size; exit\n")
            .expect("write size command");
        wait_for_output(&manager, &result.session_id, "41 121");
        manager.close(&result.session_id).expect("close PTY");
    }

    #[test]
    fn terminal_close_reaps_process_tree() {
        let (manager, cwd) = fixture_manager();
        let result = manager
            .start(None, cwd, PtySize::default())
            .expect("PTY start");
        println!("terminal close leader pid: {:?}", result.pid);
        manager
            .write(&result.session_id, b"sleep 30 & wait\n")
            .expect("write child command");
        let descendants = result.pid.map(wait_for_descendants).unwrap_or_default();
        manager.close(&result.session_id).expect("close PTY");
        let mut pids = descendants;
        if let Some(pid) = result.pid {
            pids.push(pid);
        }
        wait_for_processes(&pids);
    }

    #[test]
    fn terminal_exit_reaps_process_tree() {
        let (manager, cwd) = fixture_manager();
        let result = manager
            .start(None, cwd, PtySize::default())
            .expect("PTY start");
        manager
            .write(&result.session_id, b"sleep 30 &\n")
            .expect("write child command");
        let descendants = result.pid.map(wait_for_descendants).unwrap_or_default();
        manager
            .write(&result.session_id, b"kill -KILL $$\n")
            .expect("write exit command");
        let mut pids = descendants;
        if let Some(pid) = result.pid {
            pids.push(pid);
        }
        wait_for_processes(&pids);
        manager.close(&result.session_id).expect("close exited PTY");
    }

    #[test]
    fn terminal_signal_reaps_process_tree() {
        let (manager, cwd) = fixture_manager();
        let result = manager
            .start(None, cwd, PtySize::default())
            .expect("PTY start");
        println!("terminal signal leader pid: {:?}", result.pid);
        manager
            .write(&result.session_id, b"sleep 30 & wait\n")
            .expect("write child command");
        let descendants = result.pid.map(wait_for_descendants).unwrap_or_default();
        manager.close_all();
        let mut pids = descendants;
        if let Some(pid) = result.pid {
            pids.push(pid);
        }
        wait_for_processes(&pids);
    }

    #[test]
    fn terminal_reset_reaps_all_process_trees_before_apply() {
        let (manager, cwd) = fixture_manager();
        let first = manager
            .start(None, cwd.clone(), PtySize::default())
            .expect("first PTY");
        let second = manager
            .start(None, cwd, PtySize::default())
            .expect("second PTY");
        println!(
            "terminal reset leader pids: {:?}, {:?}",
            first.pid, second.pid
        );
        manager
            .write(&first.session_id, b"sleep 30 & wait\n")
            .expect("first child");
        manager
            .write(&second.session_id, b"sleep 30 & wait\n")
            .expect("second child");
        let first_descendants = first.pid.map(wait_for_descendants).unwrap_or_default();
        let second_descendants = second.pid.map(wait_for_descendants).unwrap_or_default();
        manager.close_all();
        let mut pids = first_descendants;
        pids.extend(second_descendants);
        if let Some(pid) = first.pid {
            pids.push(pid);
        }
        if let Some(pid) = second.pid {
            pids.push(pid);
        }
        wait_for_processes(&pids);
        assert!(manager.sessions.lock().expect("session store").is_empty());
    }

    #[test]
    fn terminal_test_output_is_bounded() {
        let (manager, cwd) = fixture_manager();
        let result = manager
            .start(None, cwd, PtySize::default())
            .expect("PTY start");
        let output = vec![b'x'; MAX_OUTPUT_BYTES + 100];
        manager
            .session(&result.session_id)
            .expect("session")
            .record_output(&output);
        let size = manager
            .session(&result.session_id)
            .expect("session")
            .output
            .lock()
            .expect("output")
            .len();
        assert_eq!(size, MAX_OUTPUT_BYTES);
        manager.close(&result.session_id).expect("close PTY");
    }

    #[test]
    fn terminal_fixture_uses_real_checkout_cwd_when_present() {
        let root = tempfile::tempdir().expect("tempdir");
        let checkout = root.path().join("owner--terminal-fixture");
        fs::create_dir_all(checkout.join(".git")).expect("checkout");
        fs::write(
            checkout.join(".git/config"),
            "[remote \"origin\"]\n\turl = https://example.test/owner/terminal-fixture.git\n",
        )
        .expect("origin config");
        let resolved = crate::resolve_terminal_cwd(
            Some(root.path().to_string_lossy().as_ref()),
            Some("terminal-fixture"),
            Some("https://example.test/owner/terminal-fixture.git"),
        )
        .expect("cwd resolution");
        assert_eq!(
            resolved,
            checkout.canonicalize().expect("canonical checkout")
        );
    }
}
