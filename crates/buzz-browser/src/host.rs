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
            profile_dir: std::env::temp_dir().join("buzz-browser-spike-profile"),
            headless: true,
        }
    }
}

/// A launched browser instance and its CDP debug port.
pub struct BrowserHost {
    pub port: u16,
    pub profile_dir: PathBuf,
    child: Child,
}

pub async fn pick_free_port() -> Result<u16, BrowserError> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    Ok(listener.local_addr()?.port())
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
    let _ = std::fs::create_dir_all(&cfg.profile_dir);
    let mut cmd = Command::new(&binary);
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
    let mut child = cmd.spawn().map_err(|e| BrowserError::Host(e.to_string()))?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        if let Ok(resp) = reqwest::get(format!("http://127.0.0.1:{port}/json/version")).await {
            if resp.status().is_success() {
                return Ok(BrowserHost {
                    port,
                    profile_dir: cfg.profile_dir.clone(),
                    child,
                });
            }
        }
        if tokio::time::Instant::now() > deadline {
            let _ = child.start_kill();
            return Err(BrowserError::Host(
                "browser did not open CDP port in time".into(),
            ));
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

impl BrowserHost {
    /// `http://127.0.0.1:{port}/json/list` page targets.
    pub async fn list_targets(&self) -> Result<Vec<TargetInfo>, BrowserError> {
        let resp = reqwest::get(format!("http://127.0.0.1:{}/json/list", self.port))
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
        let _ = self.child.start_kill();
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

#[cfg(test)]
mod tests {
    use super::*;

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
    async fn real_launch_lists_a_page_target() {
        if std::env::var("BUZZ_BROWSER_REAL").is_err() {
            return;
        }
        let cfg = HostConfig::default();
        let host = launch(&cfg).await.unwrap();
        let targets = host.list_targets().await.unwrap();
        assert!(!targets.is_empty(), "expected at least one page target");
    }
}
