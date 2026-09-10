//! Agent-facing Block command arguments.
use crate::BlockReceiptStatusArg;
use clap::Subcommand;

/// Catalog discovery, bounded instance invocation and signed action commands.
#[derive(Subcommand)]
pub enum BlocksCmd {
    /// List relay-authored Block catalog heads
    List,
    /// Get one catalog head by stable handle
    Get {
        #[arg(long)]
        handle: String,
        #[arg(long)]
        author: Option<String>,
    },
    /// Describe a resolved block: fields, examples, actions and safe invocation
    Describe {
        /// Stable catalog handle
        #[arg(long)]
        handle: String,
        /// Inspect an exact pinned definition instead of the active catalog head
        #[arg(long)]
        manifest: Option<String>,
    },
    /// Publish an immutable draft manifest
    Draft {
        #[arg(long)]
        manifest: String,
    },
    /// Validate a manifest and its examples locally
    Test {
        #[arg(long)]
        manifest: String,
        #[arg(long)]
        data: Option<String>,
    },
    /// Ask the relay catalog broker to activate a tested manifest
    Activate {
        #[arg(long)]
        handle: String,
        #[arg(long)]
        manifest: String,
    },
    /// Ask the relay catalog broker to roll back to a tested manifest
    Rollback {
        #[arg(long)]
        handle: String,
        #[arg(long)]
        manifest: String,
    },
    /// Ask the relay catalog broker to deprecate a handle
    Deprecate {
        #[arg(long)]
        handle: String,
        #[arg(long)]
        manifest: String,
    },
    /// Publish a Block instance as an ordinary kind 9 message
    Invoke {
        #[arg(long)]
        channel: String,
        #[arg(long)]
        handle: String,
        #[arg(long)]
        data: String,
        #[arg(long)]
        fallback: Option<String>,
        #[arg(long)]
        manifest: Option<String>,
        /// Pubkey responsible for processing signed actions declared by this Block
        #[arg(long)]
        processor: Option<String>,
        #[arg(long)]
        reply_to: Option<String>,
    },
    /// Read accepted Block actions
    Actions {
        #[arg(long)]
        channel: String,
        #[arg(long)]
        instance: Option<String>,
        #[arg(long)]
        since: Option<u64>,
    },
    /// Submit one declared Block action
    Act {
        #[arg(long)]
        channel: String,
        #[arg(long)]
        instance: String,
        #[arg(long)]
        action: String,
        #[arg(long)]
        input: String,
        #[arg(long)]
        idempotency_key: Option<String>,
    },
    /// Publish a safe action receipt
    Receipt {
        #[arg(long)]
        channel: String,
        #[arg(long)]
        action: String,
        #[arg(long)]
        instance: String,
        #[arg(long, value_enum)]
        status: BlockReceiptStatusArg,
        #[arg(long)]
        result: String,
    },
}
