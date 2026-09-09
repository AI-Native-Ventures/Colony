//! Compatibility metadata only. Never execute a prompt or read account credentials.
use super::config::Config;
use anyhow::{bail, Context, Result};
use serde_json::json;
use std::{path::PathBuf, process::Stdio, time::Duration};

pub(super) fn run() -> Result<()> {
    let args: Vec<_> = std::env::args_os().skip(2).collect();
    if args.len() != 3 {
        bail!("A provider, executable and private probe directory are required");
    }
    let runtime = args[0].to_str().context("Invalid provider")?.to_owned();
    let profile = PathBuf::from(&args[2]);
    let config = Config {
        runtime: runtime.clone(),
        vendor_binary: PathBuf::from(&args[1]),
        workspace: profile.clone(),
        profile,
        model: String::new(),
        mcp_servers: json!({}),
    };
    let result = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(async {
            match runtime.as_str() {
                "codex" => super::codex::check_capability(&config).await,
                "claude" => claude(&config).await,
                _ => bail!("Unsupported subscription provider"),
            }
        });
    let response = match result {
        Ok(()) => json!({"supported":true}),
        Err(error) => json!({"supported":false,"reason":error.to_string()}),
    };
    println!("{response}");
    Ok(())
}

pub(super) async fn claude(config: &Config) -> Result<()> {
    use tokio::io::AsyncReadExt;
    let mut command = config.vendor_command();
    let mut child = command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .context("Claude compatibility check could not start")?;
    let output = child
        .stdout
        .take()
        .context("Claude compatibility response is unavailable")?;
    let result = tokio::time::timeout(Duration::from_secs(15), async {
        let mut bytes = Vec::new();
        output.take(8193).read_to_end(&mut bytes).await?;
        if bytes.len() > 8192 { bail!("Unsupported Claude compatibility response"); }
        let status = child.wait().await?;
        let text = std::str::from_utf8(&bytes).context("Unsupported Claude version response")?;
        if !status.success() || !restricted_version(text) {
            bail!("Update Claude Code to version 2.1.248 or newer to use isolated subscription teammates");
        }
        Ok::<_, anyhow::Error>(())
    }).await.context("Claude compatibility check timed out")?;
    let _ = child.kill().await;
    let _ = child.wait().await;
    result
}

fn restricted_version(text: &str) -> bool {
    let Some(version) = text.split_whitespace().next() else {
        return false;
    };
    let numbers: Vec<_> = version
        .trim_start_matches('v')
        .split('.')
        .map(str::parse::<u32>)
        .collect();
    matches!(numbers.as_slice(), [Ok(major), Ok(minor), Ok(patch)] if (*major, *minor, *patch) >= (2, 1, 248))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restricted_flag_requires_a_known_supporting_version() {
        assert!(restricted_version("2.1.248 (Claude Code)"));
        assert!(restricted_version("2.2.1 (Claude Code)"));
        for value in ["2.1.247", "unknown", "2.1.248-beta", "1.99.999", ""] {
            assert!(!restricted_version(value));
        }
    }
}
