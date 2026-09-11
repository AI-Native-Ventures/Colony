//! Agent-facing outreach command arguments.
use clap::{Subcommand, ValueEnum};
use uuid::Uuid;

/// Status of one outreach email card, as the `outreach-email` manifest
/// enumerates it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub enum OutreachStatusArg {
    /// Written, waiting on the owner's decision.
    Pending,
    /// Approved, not yet reported as sent.
    Approved,
    /// Sent from the owner's mailbox.
    Sent,
    /// Declined by the owner.
    Skipped,
    /// Sending was attempted and failed.
    Failed,
    /// Replaced by a newer draft for the same lead.
    Superseded,
}

impl OutreachStatusArg {
    /// Return the exact manifest enum value for this status.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Approved => "approved",
            Self::Sent => "sent",
            Self::Skipped => "skipped",
            Self::Failed => "failed",
            Self::Superseded => "superseded",
        }
    }
}

/// Draft and track the one-email-per-lead outreach cards the owner approves.
#[derive(Subcommand)]
pub enum OutreachCmd {
    /// Draft one outreach email card for one Discovery Lead
    #[command(
        long_about = "Write one outreach email for one Discovery Lead and post it \
into a channel as an `@outreach-email` card the owner approves or skips.\n\n\
The Lead is read through the entitled Discovery `get_lead` path: its name \
becomes the card's business name, its campaign becomes the campaign id, and \
its email becomes the recipient unless `--to` names another mailbox. `--from` \
is the owner's own mailbox the email leaves from; Colony never holds its \
credentials. The card expires after `--expires-in`, and silence never sends.\n\n\
The data is validated against the active `outreach-email` manifest before \
anything reaches the relay, so a bad field fails loudly and posts nothing.",
        after_help = "Example:\n  buzz outreach draft --channel 7f2b1d0e-3c4a-4f6b-9a81-2d5e7c9b0a14 \\\n    --lead 3f2a91c4-6d18-4a7b-9e02-5c81b7d4a610 \\\n    --from basheer@horizonlabs.co.za \\\n    --subject \"Winter boiler special for Sea Point homes\" \\\n    --body - --reply-to <event-id> < email.txt"
    )]
    Draft {
        /// Channel UUID the card is posted into.
        #[arg(long)]
        channel: String,
        /// Discovery Lead UUID this email is written for.
        #[arg(long)]
        lead: Uuid,
        /// Exact subject line the owner will see and send.
        #[arg(long)]
        subject: String,
        /// Exact body text, or `-` to read it from stdin.
        #[arg(long)]
        body: String,
        /// Owner mailbox the email leaves from.
        #[arg(long)]
        from: String,
        /// Recipient mailbox. Defaults to the Lead's email.
        #[arg(long)]
        to: Option<String>,
        /// How long the decision stays open, such as `72h`, `30m` or `3d`.
        #[arg(long, default_value = "72h")]
        expires_in: String,
        /// Event ID to thread the card under.
        #[arg(long)]
        reply_to: Option<String>,
        /// Pubkey that answers the card's buttons. Defaults to your own.
        #[arg(long)]
        processor: Option<String>,
    },
    /// List outreach email cards in one channel with their current status
    List {
        /// Channel UUID to read.
        #[arg(long)]
        channel: String,
        /// Return only cards in this status.
        #[arg(long, value_enum)]
        status: Option<OutreachStatusArg>,
        /// Maximum cards to return, newest first.
        #[arg(long)]
        limit: Option<usize>,
    },
}
