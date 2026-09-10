//! `buzz website`: create, inspect, and advance Website Manager jobs.
//!
//! Every mutation signs one `KIND_WEBSITE_ACTION` event against the current
//! head generation. Owner approve/request-changes decisions do not appear here
//! as approvals: an owner decides through the signed Blocks surface. A
//! coordinator (or owner) requests changes through `request-changes`, which is
//! the ordinary action path.

use buzz_core::kind::{KIND_TASK_REPORT, KIND_WEBSITE_ACTION, KIND_WEBSITE_HEAD};
use buzz_core::website::{
    sha256_hex, HandoverAccessRequest, HandoverAsset, PreviewArtifactRef, Stage,
    StageEvidenceKind, WebsiteAction, WebsiteActionOp, WebsiteCaptures, MAX_ACCESS_REQUEST_CHARS,
};
use nostr::EventBuilder;
use serde_json::Value;
use uuid::Uuid;

use crate::client::{normalize_events, normalize_write_response, BuzzClient};
use crate::error::CliError;
use crate::WebsiteCmd;

fn parse_uuid(value: &str, field: &str) -> Result<Uuid, CliError> {
    Uuid::parse_str(value)
        .map_err(|_| CliError::Usage(format!("--{field} must be a UUID: {value}")))
}

fn read_json_file(path: &str) -> Result<Value, CliError> {
    let text = std::fs::read_to_string(path)
        .map_err(|error| CliError::Usage(format!("could not read {path}: {error}")))?;
    serde_json::from_str(&text)
        .map_err(|error| CliError::Usage(format!("{path} is not valid JSON: {error}")))
}

fn read_file_bytes(path: &str) -> Result<Vec<u8>, CliError> {
    std::fs::read(path).map_err(|error| CliError::Usage(format!("could not read {path}: {error}")))
}

fn stage_from_str(value: &str) -> Result<Stage, CliError> {
    match value {
        "brief" => Ok(Stage::Brief),
        "research" => Ok(Stage::Research),
        "designBuild" | "design-build" => Ok(Stage::DesignBuild),
        "review" => Ok(Stage::Review),
        "revision" => Ok(Stage::Revision),
        "approval" => Ok(Stage::Approval),
        "handover" => Ok(Stage::Handover),
        other => Err(CliError::Usage(format!("unknown stage: {other}"))),
    }
}

fn evidence_kind_from_str(value: &str) -> Result<StageEvidenceKind, CliError> {
    match value {
        "jobOutcome" | "job-outcome" => Ok(StageEvidenceKind::JobOutcome),
        "jobCheckpoint" | "job-checkpoint" => Ok(StageEvidenceKind::JobCheckpoint),
        "taskReport" | "task-report" => Ok(StageEvidenceKind::TaskReport),
        "workEvent" | "work-event" => Ok(StageEvidenceKind::WorkEvent),
        other => Err(CliError::Usage(format!("unknown evidence kind: {other}"))),
    }
}

async fn submit(client: &BuzzClient, builder: EventBuilder) -> Result<(), CliError> {
    let event = client.sign_event(builder)?;
    // Fail closed on a builder/parser drift before the relay sees the event.
    buzz_core::website::parse_website_action(&event)
        .map_err(|error| CliError::Usage(format!("constructed action is invalid: {error}")))?;
    match client.submit_event(event).await {
        Ok(response) => {
            println!("{}", normalize_write_response(&response));
            Ok(())
        }
        Err(error) => Err(error),
    }
}

fn action_builder(action: &WebsiteAction) -> Result<EventBuilder, CliError> {
    buzz_sdk::website::build_website_action(action)
        .map_err(|error| CliError::Other(error.to_string()))
}

/// The newest head for a task in a channel, with its identity tags.
async fn latest_head(
    client: &BuzzClient,
    channel: &str,
    task: &str,
) -> Result<Option<(Value, buzz_sdk::website::WebsiteHeadIdentity)>, CliError> {
    let heads = client
        .query_all(serde_json::json!({
            "kinds": [KIND_WEBSITE_HEAD],
            "#h": [channel],
        }))
        .await?;
    let mut newest: Option<(Value, buzz_sdk::website::WebsiteHeadIdentity)> = None;
    for head in heads {
        let Ok(event) = serde_json::from_value::<nostr::Event>(head.clone()) else {
            continue;
        };
        let Ok(identity) = buzz_sdk::website::parse_website_head_identity(&event) else {
            continue;
        };
        if identity.task_id != task {
            continue;
        }
        if newest
            .as_ref()
            .is_none_or(|(current, _)| head_is_newer(&head, current))
        {
            newest = Some((head, identity));
        }
    }
    Ok(newest)
}

fn head_rank(head: &Value) -> (i64, String) {
    let created = head.get("created_at").and_then(Value::as_i64).unwrap_or(0);
    let id = head
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    (created, id)
}

/// Whether `candidate` should replace `current` under NIP-33 ordering.
fn head_is_newer(candidate: &Value, current: &Value) -> bool {
    let (candidate_at, candidate_id) = head_rank(candidate);
    let (current_at, current_id) = head_rank(current);
    candidate_at > current_at || (candidate_at == current_at && candidate_id < current_id)
}

#[allow(clippy::too_many_arguments)]
fn build_action(
    channel_id: Uuid,
    task: String,
    thread: String,
    generation: Option<u64>,
    op: WebsiteActionOp,
    actor: nostr::PublicKey,
) -> WebsiteAction {
    WebsiteAction {
        channel_id,
        task_id: task,
        thread_root: thread,
        instance_event_id: None,
        manifest_event_id: None,
        request_id: Uuid::new_v4(),
        generation,
        actor,
        op,
    }
}

async fn cmd_create(
    client: &BuzzClient,
    channel: &str,
    task: &str,
    thread: &str,
    instance: &str,
    manifest: &str,
    coordinator: &str,
    source_url: &str,
    research: &[String],
    build: &[String],
    review: &[String],
) -> Result<(), CliError> {
    let channel_id = parse_uuid(channel, "channel")?;
    let action = WebsiteAction {
        channel_id,
        task_id: task.to_owned(),
        thread_root: thread.to_owned(),
        instance_event_id: Some(instance.to_owned()),
        manifest_event_id: Some(manifest.to_owned()),
        request_id: Uuid::new_v4(),
        generation: None,
        actor: client.keys().public_key(),
        op: WebsiteActionOp::Create {
            coordinator: coordinator.to_owned(),
            source_url: source_url.to_owned(),
            research_personas: research.to_vec(),
            build_personas: build.to_vec(),
            review_personas: review.to_vec(),
        },
    };
    submit(client, action_builder(&action)?).await
}

async fn cmd_mutation(
    client: &BuzzClient,
    cmd: &WebsiteCmd,
    op: WebsiteActionOp,
) -> Result<(), CliError> {
    let (channel, task, thread, generation) = match cmd {
        WebsiteCmd::BeginWork {
            channel,
            task,
            thread,
            generation,
        }
        | WebsiteCmd::Revision {
            channel,
            task,
            thread,
            generation,
            ..
        }
        | WebsiteCmd::Qa {
            channel,
            task,
            thread,
            generation,
            ..
        }
        | WebsiteCmd::Evidence {
            channel,
            task,
            thread,
            generation,
            ..
        }
        | WebsiteCmd::Ready {
            channel,
            task,
            thread,
            generation,
        }
        | WebsiteCmd::RequestChanges {
            channel,
            task,
            thread,
            generation,
            ..
        }
        | WebsiteCmd::Handover {
            channel,
            task,
            thread,
            generation,
            ..
        } => (channel, task, thread, *generation),
        _ => return Err(CliError::Usage("not a website mutation".into())),
    };
    let channel_id = parse_uuid(channel, "channel")?;
    let generation = match generation {
        Some(generation) => generation,
        None => {
            let (_, identity) = latest_head(client, channel, task)
                .await?
                .ok_or_else(|| CliError::Usage("no website head exists for this task".into()))?;
            identity.generation
        }
    };
    let action = build_action(
        channel_id,
        task.clone(),
        thread.clone(),
        Some(generation),
        op,
        client.keys().public_key(),
    );
    submit(client, action_builder(&action)?).await
}

async fn cmd_qa(
    client: &BuzzClient,
    channel: &str,
    task: &str,
    thread: &str,
    generation: Option<u64>,
    revision: u32,
    passed: bool,
    report_url: &str,
    report_file: &str,
    report_event: Option<&str>,
) -> Result<(), CliError> {
    let channel_id = parse_uuid(channel, "channel")?;
    let (head, identity) = latest_head(client, channel, task)
        .await?
        .ok_or_else(|| CliError::Usage("no website head exists for this task".into()))?;
    let generation = generation.unwrap_or(identity.generation);
    let head_event = serde_json::from_value::<nostr::Event>(head)
        .map_err(|error| CliError::Other(error.to_string()))?;
    let review = buzz_sdk::website::parse_website_head(&head_event)
        .map_err(|error| CliError::Other(error.to_string()))?;
    let bytes = read_file_bytes(report_file)?;
    let report_sha256 = sha256_hex(&bytes);
    let manifest_sha256 = review
        .revisions
        .iter()
        .find(|candidate| candidate.revision == revision)
        .map(|candidate| candidate.preview.sha256.clone())
        .ok_or_else(|| CliError::Usage(format!("revision {revision} is not recorded")))?;
    let report_event_id = match report_event {
        Some(event_id) => event_id.to_owned(),
        None => {
            let builder = buzz_sdk::website::build_website_qa_task_report(
                task,
                revision,
                &manifest_sha256,
                report_url,
                &report_sha256,
                "website QA report",
            )
            .map_err(|error| CliError::Other(error.to_string()))?;
            let event = client.sign_event(builder)?;
            let event_id = event.id.to_hex();
            let response = client.submit_event(event).await?;
            println!("{}", normalize_write_response(&response));
            event_id
        }
    };
    let op = WebsiteActionOp::RecordQa {
        revision,
        passed,
        report_event_id,
        report: PreviewArtifactRef {
            url: report_url.to_owned(),
            sha256: report_sha256,
        },
    };
    let action = build_action(
        channel_id,
        task.to_owned(),
        thread.to_owned(),
        Some(generation),
        op,
        client.keys().public_key(),
    );
    submit(client, action_builder(&action)?).await
}

async fn cmd_revision(
    client: &BuzzClient,
    channel: &str,
    task: &str,
    thread: &str,
    generation: Option<u64>,
    file: &str,
) -> Result<(), CliError> {
    let value = read_json_file(file)?;
    let wire: RevisionWire = serde_json::from_value(value)
        .map_err(|error| CliError::Usage(format!("invalid revision file: {error}")))?;
    let default_revision = match wire.revision {
        Some(revision) => revision,
        None => {
            let (head, _) = latest_head(client, channel, task)
                .await?
                .ok_or_else(|| CliError::Usage("no website head exists for this task".into()))?;
            let head_event = serde_json::from_value::<nostr::Event>(head)
                .map_err(|error| CliError::Other(error.to_string()))?;
            let review = buzz_sdk::website::parse_website_head(&head_event)
                .map_err(|error| CliError::Other(error.to_string()))?;
            review.current_revision.saturating_add(1)
        }
    };
    let op = wire.into_op(default_revision)?;
    cmd_mutation(client, &WebsiteCmd::Revision {
        channel: channel.to_owned(),
        task: task.to_owned(),
        thread: thread.to_owned(),
        generation,
        file: file.to_owned(),
    }, op)
    .await
}

async fn cmd_handover(
    client: &BuzzClient,
    channel: &str,
    task: &str,
    thread: &str,
    generation: Option<u64>,
    file: &str,
) -> Result<(), CliError> {
    let value = read_json_file(file)?;
    let op: WebsiteActionOp = serde_json::from_value::<HandoverWire>(value)
        .map_err(|error| CliError::Usage(format!("invalid handover file: {error}")))?
        .into_op()?;
    cmd_mutation(client, &WebsiteCmd::Handover {
        channel: channel.to_owned(),
        task: task.to_owned(),
        thread: thread.to_owned(),
        generation,
        file: file.to_owned(),
    }, op)
    .await
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RevisionWire {
    #[serde(default)]
    revision: Option<u32>,
    manifest: PreviewArtifactRef,
    source_url: String,
    archive: PreviewArtifactRef,
    captures: WebsiteCaptures,
}

impl RevisionWire {
    fn into_op(self, default_revision: u32) -> Result<WebsiteActionOp, CliError> {
        Ok(WebsiteActionOp::AddRevision {
            revision: self.revision.unwrap_or(default_revision),
            manifest: self.manifest,
            source_url: self.source_url,
            archive: self.archive,
            captures: self.captures,
        })
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HandoverWire {
    approved_revision: u32,
    approved_manifest_sha256: String,
    source_url: String,
    source_archive: PreviewArtifactRef,
    assets: Vec<HandoverAsset>,
    #[serde(default)]
    access_request: Option<HandoverAccessRequest>,
}

impl HandoverWire {
    fn into_op(self) -> Result<WebsiteActionOp, CliError> {
        if let Some(access) = &self.access_request {
            if access.text.chars().count() > MAX_ACCESS_REQUEST_CHARS {
                return Err(CliError::Usage("accessRequest.text is too long".into()));
            }
        }
        Ok(WebsiteActionOp::Handover {
            approved_revision: self.approved_revision,
            approved_manifest_sha256: self.approved_manifest_sha256,
            source_url: self.source_url,
            source_archive: self.source_archive,
            assets: self.assets,
            access_request: self.access_request,
        })
    }
}

async fn cmd_get(
    client: &BuzzClient,
    channel: &str,
    task: Option<&str>,
    job: Option<&str>,
) -> Result<(), CliError> {
    let channel_id = parse_uuid(channel, "channel")?;
    let heads = client
        .query_all(serde_json::json!({
            "kinds": [KIND_WEBSITE_HEAD],
            "#h": [channel_id.to_string()],
        }))
        .await?;
    let mut selected = Vec::new();
    for head in heads {
        if let Some(job) = job {
            let is_job = head
                .get("tags")
                .and_then(Value::as_array)
                .is_some_and(|tags| {
                    tags.iter().any(|tag| {
                        tag.as_array().is_some_and(|parts| {
                            parts.len() == 2
                                && parts[0].as_str() == Some("d")
                                && parts[1].as_str() == Some(job)
                        })
                    })
                });
            if !is_job {
                continue;
            }
        }
        if let Some(task) = task {
            let is_task = head
                .get("tags")
                .and_then(Value::as_array)
                .is_some_and(|tags| {
                    tags.iter().any(|tag| {
                        tag.as_array().is_some_and(|parts| {
                            parts.len() == 2
                                && parts[0].as_str() == Some("task")
                                && parts[1].as_str() == Some(task)
                        })
                    })
                });
            if !is_task {
                continue;
            }
        }
        selected.push(head);
    }
    println!("{}", normalize_events(&selected));
    Ok(())
}

async fn cmd_list(client: &BuzzClient, channel: &str, limit: Option<u32>) -> Result<(), CliError> {
    let channel_id = parse_uuid(channel, "channel")?;
    let heads = client
        .query_paginated(
            serde_json::json!({
                "kinds": [KIND_WEBSITE_HEAD],
                "#h": [channel_id.to_string()],
            }),
            limit.unwrap_or(100),
        )
        .await?;
    println!("{}", normalize_events(&heads));
    Ok(())
}

/// Dispatch `buzz website` subcommands.
pub async fn dispatch(cmd: WebsiteCmd, client: &BuzzClient) -> Result<(), CliError> {
    match cmd {
        WebsiteCmd::Get {
            channel,
            task,
            job,
        } => cmd_get(client, &channel, task.as_deref(), job.as_deref()).await,
        WebsiteCmd::List { channel, limit } => cmd_list(client, &channel, limit).await,
        WebsiteCmd::Create {
            channel,
            task,
            thread,
            instance,
            manifest,
            coordinator,
            source_url,
            research,
            build,
            review,
        } => {
            cmd_create(
                client,
                &channel,
                &task,
                &thread,
                &instance,
                &manifest,
                &coordinator,
                &source_url,
                &research,
                &build,
                &review,
            )
            .await
        }
        WebsiteCmd::BeginWork { .. } => {
            cmd_mutation(client, &cmd, WebsiteActionOp::BeginWork).await
        }
        WebsiteCmd::Bundle {
            dir,
            source,
            before,
            desktop,
            mobile,
            entrypoint,
            source_url,
            out,
        } => {
            crate::commands::website_bundle::run(
                client,
                &dir,
                &source,
                &before,
                &desktop,
                &mobile,
                &entrypoint,
                source_url.as_deref(),
                out.as_deref(),
            )
            .await
        }
        WebsiteCmd::Revision { .. } => {
            let (channel, task, thread, generation, file) = match &cmd {
                WebsiteCmd::Revision {
                    channel,
                    task,
                    thread,
                    generation,
                    file,
                } => (channel.clone(), task.clone(), thread.clone(), *generation, file.clone()),
                _ => unreachable!("matched revision"),
            };
            cmd_revision(client, &channel, &task, &thread, generation, &file).await
        }
        WebsiteCmd::Handover { .. } => {
            let (channel, task, thread, generation, file) = match &cmd {
                WebsiteCmd::Handover {
                    channel,
                    task,
                    thread,
                    generation,
                    file,
                } => (channel.clone(), task.clone(), thread.clone(), *generation, file.clone()),
                _ => unreachable!("matched handover"),
            };
            cmd_handover(client, &channel, &task, &thread, generation, &file).await
        }
        WebsiteCmd::Qa {
            channel,
            task,
            thread,
            generation,
            revision,
            passed,
            report_url,
            report_file,
            report_event,
        } => {
            cmd_qa(
                client,
                &channel,
                &task,
                &thread,
                generation,
                revision,
                passed,
                &report_url,
                &report_file,
                report_event.as_deref(),
            )
            .await
        }
        WebsiteCmd::Evidence { .. } => {
            let (stage, revision, kind, event) = match &cmd {
                WebsiteCmd::Evidence {
                    stage,
                    revision,
                    kind,
                    event,
                    ..
                } => (stage.clone(), *revision, kind.clone(), event.clone()),
                _ => unreachable!("matched evidence"),
            };
            let op = WebsiteActionOp::StageEvidence {
                stage: stage_from_str(&stage)?,
                revision,
                kind: evidence_kind_from_str(&kind)?,
                event_id: event,
            };
            cmd_mutation(client, &cmd, op).await
        }
        WebsiteCmd::Ready { .. } => cmd_mutation(client, &cmd, WebsiteActionOp::Ready).await,
        WebsiteCmd::RequestChanges { .. } => {
            let (revision, hash, note) = match &cmd {
                WebsiteCmd::RequestChanges {
                    revision,
                    hash,
                    note,
                    ..
                } => (*revision, hash.clone(), note.clone()),
                _ => unreachable!("matched request changes"),
            };
            let op = WebsiteActionOp::RequestChanges {
                revision,
                manifest_sha256: hash,
                note,
            };
            cmd_mutation(client, &cmd, op).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{Kind, Tag};

    #[test]
    fn stage_and_kind_strings_match_the_wire_vocabulary() {
        assert_eq!(stage_from_str("designBuild").unwrap(), Stage::DesignBuild);
        assert!(stage_from_str("nope").is_err());
        assert_eq!(
            evidence_kind_from_str("taskReport").unwrap(),
            StageEvidenceKind::TaskReport
        );
        assert!(evidence_kind_from_str("timer").is_err());
    }

    #[test]
    fn head_ordering_prefers_newer_then_lower_id() {
        let earlier = serde_json::json!({"created_at": 1, "id": "bb"});
        let later = serde_json::json!({"created_at": 2, "id": "cc"});
        assert!(head_is_newer(&later, &earlier));
        let tie_low = serde_json::json!({"created_at": 2, "id": "aa"});
        assert!(head_is_newer(&tie_low, &later));
    }

    #[test]
    fn handover_wire_requires_known_access_request_shape() {
        let value = serde_json::json!({
            "approvedRevision": 1,
            "approvedManifestSha256": "aa",
            "sourceUrl": "https://source.colony.test",
            "sourceArchive": {"url": "https://cdn.colony.test/a.tgz", "sha256": "bb"},
            "assets": [],
            "accessRequest": {"text": "point DNS", "authoredBy": "cc"},
        });
        let wire: HandoverWire = serde_json::from_value(value).expect("wire parses");
        assert!(wire.access_request.is_some());
    }

    #[test]
    fn task_report_tag_constant_is_stable() {
        assert_eq!(KIND_TASK_REPORT, 40026);
        assert_eq!(KIND_WEBSITE_ACTION, 40027);
        assert!(std::path::Path::new(".").exists());
        let _ = Tag::parse(["a", "b"]);
        let _ = Kind::Custom(KIND_WEBSITE_ACTION as u16);
    }
}
