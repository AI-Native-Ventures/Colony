//! Chrome discovery, launch, and shutdown.

use std::path::PathBuf;
use std::time::Duration;

use tokio::net::TcpListener;
use tokio::process::{Child, Command};

use crate::contracts::BrowserError;

/// How to launch the browser for a spike run.
#[derive(Debug, Clone)]
pub struct HostConfig {
    pub binary: Option<PathBuf>,
    pub profile_dir: PathBuf,
    pub headless: bool,
}

impl Default for HostConfig {
    fn default() -> Self {
        Self {
            binary: None,
            profile_dir: std::env::temp_dir()
                .join(format!("buzz-browser-profile-{}", uuid::Uuid::new_v4())),
            headless: true,
        }
    }
}

/// A browser the daemon drives: either one it launched, or one it attached to.
///
/// The daemon owns the process only in the launch case. When a shell already
/// owns the tab strip (an Electron `WebContentsView`, or any Chromium started
/// with `--remote-debugging-port`), it hands over the DevTools endpoint and the
/// daemon drives the tab the human is already watching.
#[derive(Debug)]
pub struct BrowserHost {
    base_url: String,
    profile_dir: Option<PathBuf>,
    child: Option<Child>,
}

pub async fn pick_free_port() -> Result<u16, BrowserError> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    Ok(listener.local_addr()?.port())
}

/// Normalize a DevTools endpoint into an `http(s)://host:port` base URL.
///
/// Accepts a bare port (`9222`), a `host:port`, or a full http(s) URL, because
/// every one of those is what a shell realistically has on hand.
pub fn parse_endpoint(raw: &str) -> Result<String, BrowserError> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(BrowserError::Host("empty DevTools endpoint".into()));
    }
    if let Some(rest) = raw
        .strip_prefix("http://")
        .or_else(|| raw.strip_prefix("https://"))
    {
        let scheme = if raw.starts_with("https://") {
            "https"
        } else {
            "http"
        };
        let authority = rest.split('/').next().unwrap_or_default();
        if authority.is_empty() {
            return Err(BrowserError::Host(format!(
                "DevTools endpoint has no host: {raw}"
            )));
        }
        return Ok(format!("{scheme}://{authority}"));
    }
    if raw.contains("://") {
        return Err(BrowserError::Host(format!(
            "DevTools endpoint must be http(s), not: {raw}"
        )));
    }
    if let Ok(port) = raw.parse::<u16>() {
        return Ok(format!("http://127.0.0.1:{port}"));
    }
    if let Some((host, port)) = raw.rsplit_once(':') {
        if !host.is_empty() && !host.contains(char::is_whitespace) && port.parse::<u16>().is_ok() {
            return Ok(format!("http://{host}:{port}"));
        }
    }
    Err(BrowserError::Host(format!(
        "not a DevTools http endpoint: {raw}"
    )))
}

/// Attach to a browser that is already running, without launching or owning it.
pub async fn attach(endpoint: &str) -> Result<BrowserHost, BrowserError> {
    let base_url = parse_endpoint(endpoint)?;
    let resp = reqwest::get(format!("{base_url}/json/version"))
        .await
        .map_err(|e| BrowserError::Host(format!("no DevTools endpoint at {base_url}: {e}")))?;
    if !resp.status().is_success() {
        return Err(BrowserError::Host(format!(
            "no DevTools endpoint at {base_url}: HTTP {}",
            resp.status()
        )));
    }
    Ok(BrowserHost {
        base_url,
        profile_dir: None,
        child: None,
    })
}

fn find_browser_binary() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("BUZZ_BROWSER_BINARY") {
        let p = PathBuf::from(path);
        if p.exists() {
            return Some(p);
        }
    }
    for candidate in [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
    ] {
        let p = PathBuf::from(candidate);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

pub async fn launch(cfg: &HostConfig) -> Result<BrowserHost, BrowserError> {
    let binary = match &cfg.binary {
        Some(b) => b.clone(),
        None => find_browser_binary().ok_or_else(|| {
            BrowserError::Host("no Chrome/Chromium found; set BUZZ_BROWSER_BINARY".into())
        })?,
    };
    let port = pick_free_port().await?;
    std::fs::create_dir_all(&cfg.profile_dir).map_err(|error| {
        BrowserError::Host(format!(
            "failed to create browser profile {}: {error}",
            cfg.profile_dir.display()
        ))
    })?;
    let mut cmd = Command::new(&binary);
    cmd.kill_on_drop(true);
    cmd.arg(format!("--remote-debugging-port={port}"))
        .arg(format!("--user-data-dir={}", cfg.profile_dir.display()))
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--disable-backgrounding-occluded-windows")
        .arg("--disable-renderer-backgrounding")
        .arg("about:blank")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    if cfg.headless {
        cmd.arg("--headless=new");
    }
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&cfg.profile_dir);
            return Err(BrowserError::Host(error.to_string()));
        }
    };
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        if let Ok(resp) = reqwest::get(format!("http://127.0.0.1:{port}/json/version")).await {
            if resp.status().is_success() {
                return Ok(BrowserHost {
                    base_url: format!("http://127.0.0.1:{port}"),
                    profile_dir: Some(cfg.profile_dir.clone()),
                    child: Some(child),
                });
            }
        }
        if tokio::time::Instant::now() > deadline {
            let _ = child.start_kill();
            let _ = std::fs::remove_dir_all(&cfg.profile_dir);
            return Err(BrowserError::Host(
                "browser did not open CDP port in time".into(),
            ));
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

impl BrowserHost {
    /// The DevTools base URL this host talks to.
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// The profile directory, when this host launched the browser itself.
    pub fn profile_dir(&self) -> Option<&std::path::Path> {
        self.profile_dir.as_deref()
    }

    /// Whether dropping this host tears the browser down. False when attached:
    /// the shell that started the browser keeps owning it.
    pub fn owns_browser_process(&self) -> bool {
        self.child.is_some()
    }

    /// Process identifier for a browser launched and owned by this host.
    ///
    /// Attached browsers return `None` because their process is externally
    /// owned and must never be treated as Colony teardown evidence.
    pub fn process_id(&self) -> Option<u32> {
        self.child.as_ref().and_then(|child| child.id())
    }

    /// `{base_url}/json/list` page targets.
    pub async fn list_targets(&self) -> Result<Vec<TargetInfo>, BrowserError> {
        let resp = reqwest::get(format!("{}/json/list", self.base_url))
            .await?
            .json::<Vec<serde_json::Value>>()
            .await?;
        Ok(resp
            .into_iter()
            .filter_map(|v| {
                if v["type"].as_str() != Some("page") {
                    return None;
                }
                Some(TargetInfo {
                    id: v["id"].as_str().unwrap_or_default().to_string(),
                    url: v["url"].as_str().unwrap_or_default().to_string(),
                    title: v["title"].as_str().unwrap_or_default().to_string(),
                    ws_url: v["webSocketDebuggerUrl"]
                        .as_str()
                        .unwrap_or_default()
                        .to_string(),
                })
            })
            .collect())
    }
}

impl Drop for BrowserHost {
    fn drop(&mut self) {
        // Only kill what we launched. An attached browser belongs to the shell.
        if let Some(child) = self.child.as_mut() {
            let _ = child.start_kill();
        }
        if let Some(profile_dir) = self.profile_dir.take() {
            let _ = std::fs::remove_dir_all(profile_dir);
        }
    }
}

/// A page target from Chrome's `/json/list` endpoint.
#[derive(Debug, Clone, PartialEq)]
pub struct TargetInfo {
    pub id: String,
    pub url: String,
    pub title: String,
    pub ws_url: String,
}

/// A stand-in DevTools HTTP endpoint for tests: answers `/json/version` and
/// `/json/list` with a fixed target set, and outlives any `BrowserHost` that
/// attaches to it.
#[cfg(test)]
pub(crate) async fn spawn_fake_devtools() -> (String, tokio::task::JoinHandle<()>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    let handle = tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            tokio::spawn(async move {
                let mut buf = [0u8; 2048];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).into_owned();
                let body = if req.contains("/json/version") {
                    serde_json::json!({ "Browser": "fake/1.0" }).to_string()
                } else {
                    serde_json::json!([
                        {
                            "type": "background_page",
                            "id": "bg",
                            "url": "chrome://background",
                            "title": "background",
                            "webSocketDebuggerUrl": "ws://127.0.0.1/devtools/page/bg"
                        },
                        {
                            "type": "page",
                            "id": "tab-a",
                            "url": "https://a.test/",
                            "title": "A",
                            "webSocketDebuggerUrl": "ws://127.0.0.1/devtools/page/tab-a"
                        },
                        {
                            "type": "page",
                            "id": "tab-b",
                            "url": "https://b.test/",
                            "title": "B",
                            "webSocketDebuggerUrl": "ws://127.0.0.1/devtools/page/tab-b"
                        }
                    ])
                    .to_string()
                };
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(resp.as_bytes()).await;
                let _ = stream.flush().await;
            });
        }
    });
    (format!("127.0.0.1:{}", addr.port()), handle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_accepts_a_port_a_hostport_and_a_url() {
        assert_eq!(parse_endpoint("9222").unwrap(), "http://127.0.0.1:9222");
        assert_eq!(
            parse_endpoint("127.0.0.1:9222").unwrap(),
            "http://127.0.0.1:9222"
        );
        assert_eq!(
            parse_endpoint("http://127.0.0.1:9222/").unwrap(),
            "http://127.0.0.1:9222"
        );
    }

    #[test]
    fn endpoint_rejects_values_that_are_not_a_devtools_http_endpoint() {
        assert!(parse_endpoint("").is_err());
        assert!(parse_endpoint("ws://127.0.0.1:9222").is_err());
        assert!(parse_endpoint("not a port").is_err());
    }

    #[tokio::test]
    async fn attach_lists_page_targets_without_launching_a_browser() {
        let (endpoint, server) = spawn_fake_devtools().await;
        let host = attach(&endpoint).await.unwrap();
        assert!(
            !host.owns_browser_process(),
            "an attached host must not claim ownership of the browser process"
        );
        assert_eq!(host.process_id(), None);
        let targets = host.list_targets().await.unwrap();
        assert_eq!(targets.len(), 2, "non-page targets must be filtered out");
        assert_eq!(targets[0].id, "tab-a");
        assert!(targets[0].ws_url.starts_with("ws://"));
        server.abort();
    }

    #[tokio::test]
    async fn dropping_an_attached_host_leaves_the_endpoint_usable() {
        let (endpoint, server) = spawn_fake_devtools().await;
        {
            let host = attach(&endpoint).await.unwrap();
            assert!(!host.list_targets().await.unwrap().is_empty());
        }
        let reattached = attach(&endpoint).await.unwrap();
        assert_eq!(reattached.list_targets().await.unwrap().len(), 2);
        server.abort();
    }

    #[tokio::test]
    async fn attach_fails_when_nothing_is_listening() {
        let port = pick_free_port().await.unwrap();
        let err = attach(&port.to_string()).await.unwrap_err();
        assert!(
            err.to_string().contains("no DevTools endpoint"),
            "unexpected error: {err}"
        );
    }

    #[tokio::test]
    async fn free_port_is_a_tcp_port() {
        let port = pick_free_port().await.unwrap();
        assert!(port > 0);
        assert!(port < u16::MAX);
    }

    #[test]
    fn browser_binary_override_wins() {
        let cfg = HostConfig {
            binary: Some("/nonexistent/browser".into()),
            ..HostConfig::default()
        };
        assert_eq!(
            cfg.binary.as_deref(),
            Some(std::path::Path::new("/nonexistent/browser"))
        );
    }

    #[tokio::test]
    #[ignore = "requires a real browser; run with BUZZ_BROWSER_REAL=1"]
    async fn real_attach_drives_a_browser_it_did_not_launch() {
        if std::env::var("BUZZ_BROWSER_REAL").is_err() {
            return;
        }
        let launched = launch(&HostConfig::default()).await.unwrap();
        let endpoint = launched.base_url().to_string();
        {
            let attached = attach(&endpoint).await.unwrap();
            assert!(!attached.owns_browser_process());
            assert!(!attached.list_targets().await.unwrap().is_empty());
        }
        // The attached host has been dropped. The browser belongs to whoever
        // launched it, so it must still be serving targets.
        assert!(
            !launched.list_targets().await.unwrap().is_empty(),
            "dropping an attached host killed a browser it did not own"
        );
    }

    #[tokio::test]
    #[ignore = "requires a real browser; run with BUZZ_BROWSER_REAL=1"]
    async fn real_launch_lists_a_page_target() {
        if std::env::var("BUZZ_BROWSER_REAL").is_err() {
            return;
        }
        let cfg = HostConfig::default();
        let host = launch(&cfg).await.unwrap();
        let targets = host.list_targets().await.unwrap();
        assert!(!targets.is_empty(), "expected at least one page target");
    }

    /// `ps -p` rather than a raw `kill(pid, 0)`: this crate forbids `unsafe`,
    /// and a reaped-but-unwaited zombie must still read as gone.
    fn process_is_alive(pid: u32) -> bool {
        std::process::Command::new("/bin/ps")
            .args(["-p", &pid.to_string(), "-o", "stat="])
            .output()
            .map(|out| {
                let stat = String::from_utf8_lossy(&out.stdout);
                let stat = stat.trim();
                !stat.is_empty() && !stat.starts_with('Z')
            })
            .unwrap_or(false)
    }

    async fn wait_for_pid_gone(pid: u32, timeout: std::time::Duration) -> bool {
        let deadline = tokio::time::Instant::now() + timeout;
        while tokio::time::Instant::now() < deadline {
            if !process_is_alive(pid) {
                return true;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        false
    }

    // `Drop for BrowserHost` and `Command::kill_on_drop(true)` (line 142) each
    // reap the child independently, so this test cannot catch a regression in
    // one of them alone: it went red only when both were disabled. It guards
    // the combined contract, which is the one callers depend on.
    #[tokio::test]
    #[ignore = "requires a real browser; run with BUZZ_BROWSER_REAL=1"]
    async fn real_owned_launch_exposes_a_pid_and_reaps_it_on_drop() {
        if std::env::var("BUZZ_BROWSER_REAL").is_err() {
            return;
        }
        let (pid, profile_dir) = {
            let host = launch(&HostConfig::default()).await.unwrap();
            let profile_dir = host
                .profile_dir()
                .expect("an owned launch must expose a profile directory")
                .to_path_buf();
            assert!(
                host.owns_browser_process(),
                "a launched host must own its browser process"
            );
            let pid = host
                .process_id()
                .expect("an owned launch must expose a browser PID");
            assert!(
                process_is_alive(pid),
                "the launched browser {pid} was not running"
            );
            (pid, profile_dir)
        };

        assert!(
            wait_for_pid_gone(pid, std::time::Duration::from_secs(30)).await,
            "owned browser {pid} survived the host drop"
        );
        assert!(
            !profile_dir.exists(),
            "owned browser profile survived the host drop: {}",
            profile_dir.display()
        );
    }
}
