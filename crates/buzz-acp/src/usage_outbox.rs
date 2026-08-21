//! Durable delivery for encrypted Spend records.
//!
//! A signed event is persisted before the first relay attempt. The exact same
//! event is retried until the relay acknowledges it, preserving its event id
//! so relay and ledger deduplication remain deterministic.

use std::path::{Path, PathBuf};
use std::time::Duration;

use nostr::{Event, Kind, PublicKey};
use sha2::{Digest, Sha256};

const MAX_EVENT_BYTES: u64 = 256 * 1024;
const MAX_PENDING_EVENTS: usize = 10_000;
const MAX_REPLAY_BATCH: usize = 8;
const SUBMIT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone)]
pub(crate) struct UsageOutbox {
    root: PathBuf,
    agent_pubkey: PublicKey,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct ReplayOutcome {
    pub delivered: usize,
    pub remaining: usize,
}

impl UsageOutbox {
    pub(crate) fn open(relay_url: &str, agent_pubkey: PublicKey) -> Result<Self, String> {
        let base = dirs::data_dir().ok_or_else(|| {
            "Spend outbox unavailable: application data directory is unknown".to_string()
        })?;
        let scope = format!(
            "{}\n{}",
            relay_url.trim_end_matches('/'),
            agent_pubkey.to_hex()
        );
        let digest = hex::encode(Sha256::digest(scope.as_bytes()));
        Self::open_at(
            base.join("Buzz").join("spend-outbox").join(digest),
            agent_pubkey,
        )
    }

    pub(crate) fn open_at(root: PathBuf, agent_pubkey: PublicKey) -> Result<Self, String> {
        std::fs::create_dir_all(&root)
            .map_err(|error| format!("create Spend outbox {}: {error}", root.display()))?;
        let metadata = std::fs::symlink_metadata(&root)
            .map_err(|error| format!("inspect Spend outbox {}: {error}", root.display()))?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(format!(
                "Spend outbox {} is not a safe directory",
                root.display()
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))
                .map_err(|error| format!("protect Spend outbox {}: {error}", root.display()))?;
        }

        let outbox = Self { root, agent_pubkey };
        outbox.recover_temporary_files()?;
        outbox.pending_events()?;
        Ok(outbox)
    }

    pub(crate) fn persist(&self, event: &Event) -> Result<(), String> {
        self.validate_event(event)?;
        let bytes =
            serde_json::to_vec(event).map_err(|error| format!("serialize Spend event: {error}"))?;
        if bytes.len() as u64 > MAX_EVENT_BYTES {
            return Err(format!(
                "Spend event {} exceeds the {} byte outbox limit",
                event.id, MAX_EVENT_BYTES
            ));
        }
        let target = self.event_path(event);
        if target.exists() {
            return self.verify_existing(&target, event);
        }
        if self.pending_paths()?.len() >= MAX_PENDING_EVENTS {
            return Err(format!(
                "Spend outbox reached its {} event safety limit",
                MAX_PENDING_EVENTS
            ));
        }

        let temporary = self.root.join(format!(
            "{}.{}.tmp",
            event.id.to_hex(),
            uuid::Uuid::new_v4()
        ));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        let mut file = options.open(&temporary).map_err(|error| {
            format!("create Spend outbox entry {}: {error}", temporary.display())
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            file.set_permissions(std::fs::Permissions::from_mode(0o600))
                .map_err(|error| format!("protect Spend outbox entry: {error}"))?;
        }
        use std::io::Write as _;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("write Spend outbox entry: {error}"))?;
        drop(file);

        match std::fs::hard_link(&temporary, &target) {
            Ok(()) => {}
            Err(_error) if target.exists() => self.verify_existing(&target, event)?,
            Err(error) => {
                return Err(format!(
                    "commit Spend outbox entry {}: {error}",
                    target.display()
                ));
            }
        }
        std::fs::remove_file(&temporary)
            .map_err(|error| format!("finish Spend outbox entry: {error}"))?;
        self.sync_root()?;
        Ok(())
    }

    pub(crate) async fn enqueue_and_submit(
        &self,
        rest: &crate::relay::RestClient,
        event: Event,
    ) -> Result<(), String> {
        let delivery = Self::submit_to_relay(rest, &event);
        self.enqueue_and_deliver(&event, delivery).await
    }

    pub(crate) async fn retry_pending(
        &self,
        rest: &crate::relay::RestClient,
    ) -> Result<ReplayOutcome, String> {
        let events = self.pending_events()?;
        let mut outcome = ReplayOutcome {
            delivered: 0,
            remaining: events.len(),
        };
        for event in events.into_iter().take(MAX_REPLAY_BATCH) {
            if self.submit_pending(rest, &event).await.is_ok() {
                outcome.delivered += 1;
                outcome.remaining -= 1;
            }
        }
        Ok(outcome)
    }

    async fn submit_pending(
        &self,
        rest: &crate::relay::RestClient,
        event: &Event,
    ) -> Result<(), String> {
        let delivery = Self::submit_to_relay(rest, event);
        self.finish_delivery(event, delivery).await
    }

    async fn submit_to_relay(rest: &crate::relay::RestClient, event: &Event) -> Result<(), String> {
        match tokio::time::timeout(SUBMIT_TIMEOUT, rest.submit_event(event)).await {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(error)) => Err(format!("Spend relay submit failed: {error}")),
            Err(_) => Err("Spend relay submit timed out".to_string()),
        }
    }

    async fn enqueue_and_deliver<F>(&self, event: &Event, delivery: F) -> Result<(), String>
    where
        F: std::future::Future<Output = Result<(), String>>,
    {
        self.persist(event)?;
        self.finish_delivery(event, delivery).await
    }

    async fn finish_delivery<F>(&self, event: &Event, delivery: F) -> Result<(), String>
    where
        F: std::future::Future<Output = Result<(), String>>,
    {
        delivery.await?;
        self.acknowledge(event)
    }

    fn acknowledge(&self, event: &Event) -> Result<(), String> {
        match std::fs::remove_file(self.event_path(event)) {
            Ok(()) => self.sync_root(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("acknowledge Spend outbox entry: {error}")),
        }
    }

    fn pending_events(&self) -> Result<Vec<Event>, String> {
        let mut events = Vec::new();
        for path in self.pending_paths()? {
            let event = self.read_event(&path)?;
            let expected_name = format!("{}.json", event.id.to_hex());
            if path.file_name().and_then(|name| name.to_str()) != Some(expected_name.as_str()) {
                return Err(format!(
                    "Spend outbox entry {} does not match its signed event id",
                    path.display()
                ));
            }
            events.push(event);
        }
        events.sort_by_key(|event| event.created_at);
        Ok(events)
    }

    fn pending_paths(&self) -> Result<Vec<PathBuf>, String> {
        let mut paths = Vec::new();
        for entry in std::fs::read_dir(&self.root)
            .map_err(|error| format!("read Spend outbox {}: {error}", self.root.display()))?
        {
            let entry = entry.map_err(|error| format!("read Spend outbox entry: {error}"))?;
            let path = entry.path();
            if path.extension().and_then(|extension| extension.to_str()) == Some("json") {
                let metadata = std::fs::symlink_metadata(&path)
                    .map_err(|error| format!("inspect Spend outbox entry: {error}"))?;
                if !metadata.is_file() || metadata.file_type().is_symlink() {
                    return Err(format!(
                        "Spend outbox entry {} is not a safe file",
                        path.display()
                    ));
                }
                if metadata.len() > MAX_EVENT_BYTES {
                    return Err(format!(
                        "Spend outbox entry {} is oversized",
                        path.display()
                    ));
                }
                paths.push(path);
            }
        }
        paths.sort();
        Ok(paths)
    }

    fn recover_temporary_files(&self) -> Result<(), String> {
        let entries = std::fs::read_dir(&self.root)
            .map_err(|error| format!("read Spend outbox {}: {error}", self.root.display()))?;
        for entry in entries {
            let path = entry
                .map_err(|error| format!("read Spend outbox entry: {error}"))?
                .path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("tmp") {
                continue;
            }
            let event = match self.read_event(&path) {
                Ok(event) => event,
                Err(_) => {
                    std::fs::remove_file(&path)
                        .map_err(|error| format!("discard partial Spend outbox entry: {error}"))?;
                    continue;
                }
            };
            let target = self.event_path(&event);
            match std::fs::hard_link(&path, &target) {
                Ok(()) => {}
                Err(_error) if target.exists() => self.verify_existing(&target, &event)?,
                Err(error) => return Err(format!("recover Spend outbox entry: {error}")),
            }
            std::fs::remove_file(&path)
                .map_err(|error| format!("finish Spend outbox recovery: {error}"))?;
        }
        self.sync_root()
    }

    fn read_event(&self, path: &Path) -> Result<Event, String> {
        let bytes = std::fs::read(path)
            .map_err(|error| format!("read Spend outbox entry {}: {error}", path.display()))?;
        if bytes.len() as u64 > MAX_EVENT_BYTES {
            return Err(format!(
                "Spend outbox entry {} is oversized",
                path.display()
            ));
        }
        let event: Event = serde_json::from_slice(&bytes)
            .map_err(|error| format!("parse Spend outbox entry {}: {error}", path.display()))?;
        self.validate_event(&event)?;
        Ok(event)
    }

    fn validate_event(&self, event: &Event) -> Result<(), String> {
        if event.kind != Kind::Custom(buzz_core::kind::KIND_USAGE_RECORD as u16) {
            return Err("Spend outbox accepts only usage record events".to_string());
        }
        if event.pubkey != self.agent_pubkey {
            return Err("Spend outbox event author does not match this agent".to_string());
        }
        event
            .verify()
            .map_err(|error| format!("Spend outbox event signature is invalid: {error}"))
    }

    fn verify_existing(&self, path: &Path, expected: &Event) -> Result<(), String> {
        let existing = self.read_event(path)?;
        if &existing == expected {
            Ok(())
        } else {
            Err(format!(
                "Spend outbox entry {} conflicts with the same event id",
                path.display()
            ))
        }
    }

    fn event_path(&self, event: &Event) -> PathBuf {
        self.root.join(format!("{}.json", event.id.to_hex()))
    }

    fn sync_root(&self) -> Result<(), String> {
        #[cfg(unix)]
        {
            std::fs::File::open(&self.root)
                .and_then(|directory| directory.sync_all())
                .map_err(|error| format!("sync Spend outbox directory: {error}"))?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Tag};

    fn event(keys: &Keys, owner: &PublicKey) -> Event {
        EventBuilder::new(
            Kind::Custom(buzz_core::kind::KIND_USAGE_RECORD as u16),
            "encrypted",
        )
        .tags([Tag::parse(["p", &owner.to_hex()]).expect("owner tag")])
        .sign_with_keys(keys)
        .expect("signed event")
    }

    #[test]
    fn failed_delivery_survives_restart_with_the_same_event_id() {
        let directory = tempfile::tempdir().expect("outbox directory");
        let agent = Keys::generate();
        let owner = Keys::generate();
        let first = UsageOutbox::open_at(directory.path().join("outbox"), agent.public_key())
            .expect("open");
        let expected = event(&agent, &owner.public_key());
        first.persist(&expected).expect("persist before submit");
        drop(first);

        let reopened = UsageOutbox::open_at(directory.path().join("outbox"), agent.public_key())
            .expect("reopen");
        let pending = reopened.pending_events().expect("pending");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, expected.id);
        assert_eq!(pending[0], expected);
    }

    #[test]
    fn repeated_persist_is_idempotent_and_ack_removes_the_entry() {
        let directory = tempfile::tempdir().expect("outbox directory");
        let agent = Keys::generate();
        let owner = Keys::generate();
        let outbox = UsageOutbox::open_at(directory.path().join("outbox"), agent.public_key())
            .expect("open");
        let expected = event(&agent, &owner.public_key());
        outbox.persist(&expected).expect("first persist");
        outbox.persist(&expected).expect("repeated persist");
        assert_eq!(outbox.pending_events().expect("pending").len(), 1);
        outbox.acknowledge(&expected).expect("acknowledge");
        assert!(outbox.pending_events().expect("empty").is_empty());
    }

    #[test]
    fn corrupt_or_wrong_author_entries_fail_closed_on_reopen() {
        let directory = tempfile::tempdir().expect("outbox directory");
        let agent = Keys::generate();
        let wrong = Keys::generate();
        let owner = Keys::generate();
        let root = directory.path().join("outbox");
        let outbox = UsageOutbox::open_at(root.clone(), agent.public_key()).expect("open");
        let invalid = event(&wrong, &owner.public_key());
        std::fs::write(
            root.join(format!("{}.json", invalid.id)),
            serde_json::to_vec(&invalid).unwrap(),
        )
        .expect("write wrong author");
        drop(outbox);

        assert!(UsageOutbox::open_at(root, agent.public_key()).is_err());
    }

    #[test]
    fn partial_temporary_entry_is_discarded_on_reopen() {
        let directory = tempfile::tempdir().expect("outbox directory");
        let agent = Keys::generate();
        let root = directory.path().join("outbox");
        std::fs::create_dir_all(&root).expect("create outbox");
        let partial = root.join("interrupted.tmp");
        std::fs::write(&partial, b"{\"incomplete\":").expect("write partial event");

        let outbox = UsageOutbox::open_at(root, agent.public_key()).expect("recover outbox");

        assert!(!partial.exists());
        assert!(outbox.pending_events().expect("pending").is_empty());
    }

    #[tokio::test]
    async fn relay_outage_retains_then_replays_the_identical_signed_event() {
        let directory = tempfile::tempdir().expect("outbox directory");
        let agent = Keys::generate();
        let owner = Keys::generate();
        let outbox = UsageOutbox::open_at(directory.path().join("outbox"), agent.public_key())
            .expect("open");
        let expected = event(&agent, &owner.public_key());
        assert!(outbox
            .enqueue_and_deliver(&expected, async { Err("relay outage".to_string()) })
            .await
            .is_err());
        let retained = outbox.pending_events().expect("retained event");
        assert_eq!(retained.as_slice(), std::slice::from_ref(&expected));

        outbox
            .finish_delivery(&expected, async { Ok(()) })
            .await
            .expect("relay recovery");
        assert!(outbox.pending_events().expect("empty").is_empty());
    }
}
