//! Bounded JSON-line transport; never include vendor stderr in errors.

use anyhow::{bail, Context, Result};
use futures_util::StreamExt;
use serde_json::Value;
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt},
    process::{Child, ChildStdin, ChildStdout, Command},
};
use tokio_util::codec::{FramedRead, LinesCodec};

pub(crate) struct Wire {
    child: Child,
    input: ChildStdin,
    output: FramedRead<ChildStdout, LinesCodec>,
}

impl Wire {
    pub(crate) fn spawn(mut command: Command) -> Result<Self> {
        use std::process::Stdio;
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .context("The subscription runtime could not start")?;
        let input = child
            .stdin
            .take()
            .context("Subscription input is unavailable")?;
        let output = FramedRead::new(
            child
                .stdout
                .take()
                .context("Subscription output is unavailable")?,
            LinesCodec::new_with_max_length(4 * 1024 * 1024),
        );
        Ok(Self {
            child,
            input,
            output,
        })
    }

    pub(crate) async fn send(&mut self, value: Value) -> Result<()> {
        let mut encoded = serde_json::to_vec(&value)?;
        encoded.push(b'\n');
        tokio::time::timeout(std::time::Duration::from_secs(30), async {
            self.input.write_all(&encoded).await?;
            self.input.flush().await
        })
        .await
        .context("Subscription request timed out")?
        .context("Subscription connection ended")
    }

    pub(crate) async fn read(&mut self) -> Result<Value> {
        let frame = self
            .output
            .next()
            .await
            .context("Subscription connection ended")?
            .map_err(|_| anyhow::anyhow!("Invalid subscription response frame"))?;
        serde_json::from_str(&frame)
            .map_err(|_| anyhow::anyhow!("Unsupported subscription message"))
    }

    pub(crate) async fn close(&mut self) {
        let _ = self.child.start_kill();
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), self.child.wait()).await;
    }
}

pub(super) async fn read_frame(reader: &mut (impl AsyncBufRead + Unpin)) -> Result<Value> {
    let mut frame = Vec::new();
    loop {
        let available = reader
            .fill_buf()
            .await
            .context("Subscription connection ended")?;
        if available.is_empty() {
            bail!("Subscription connection ended");
        }
        let take = available
            .iter()
            .position(|b| *b == b'\n')
            .map(|index| index + 1)
            .unwrap_or(available.len());
        if frame.len() + take > 4 * 1024 * 1024 {
            bail!("Subscription message is too large");
        }
        frame.extend_from_slice(&available[..take]);
        reader.consume(take);
        if frame.last() == Some(&b'\n') {
            break;
        }
    }
    serde_json::from_slice(&frame).map_err(|_| anyhow::anyhow!("Unsupported subscription message"))
}
