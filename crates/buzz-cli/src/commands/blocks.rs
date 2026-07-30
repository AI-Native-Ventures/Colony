//! `buzz blocks` — agent-first Block catalog, invocation, and action commands.

use std::fs;

use buzz_core::{
    block::{
        canonical_json, normalize_block_handle, parse_manifest, validate_instance,
        BlockCatalogEntry, BlockCatalogStatus, BlockInteraction, BlockManifest, BlockValidation,
        BlockValidationState,
    },
    kind::{KIND_BLOCK_ACTION, KIND_BLOCK_CATALOG_ENTRY, KIND_BLOCK_MANIFEST},
};
use buzz_sdk::blocks::{
    build_block_action, build_block_instance, build_block_manifest, build_block_receipt,
    BlockActionInput, BlockAttention, BlockInstanceData, BlockInstanceInput, BlockReceiptInput,
    BlockReceiptStatus, BlockThreadRef,
};
use nostr::{Event, EventBuilder, EventId, Kind, PublicKey, Tag};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::client::BuzzClient;
use crate::error::CliError;
use crate::validate::{parse_event_id, parse_uuid};
use crate::{BlockReceiptStatusArg, BlocksCmd};

struct ResolvedManifest {
    event_id: EventId,
    manifest: BlockManifest,
}

struct InstanceCoordinates {
    manifest_id: EventId,
    instance_id: Uuid,
    processor: PublicKey,
}

const CATALOG_ACTION_SCHEMA: &str = "ai-native-office/catalog-action/v1";
const CATALOG_ACTION_TTL_SECONDS: u64 = 300;

struct CatalogActionRequest {
    content: String,
    tags: Vec<Tag>,
    request_id: Uuid,
    idempotency_key: Uuid,
    expires_at: u64,
}

pub async fn dispatch(command: BlocksCmd, client: &BuzzClient) -> Result<(), CliError> {
    match command {
        BlocksCmd::List => list(client).await,
        BlocksCmd::Get { handle, author } => get(client, &handle, author.as_deref()).await,
        BlocksCmd::Draft { manifest } => draft(client, &manifest).await,
        BlocksCmd::Test { manifest, data } => test(&manifest, data.as_deref()),
        BlocksCmd::Activate { handle, manifest } => {
            catalog_action(client, "catalog.activate", &handle, &manifest).await
        }
        BlocksCmd::Rollback { handle, manifest } => {
            catalog_action(client, "catalog.rollback", &handle, &manifest).await
        }
        BlocksCmd::Deprecate { handle, manifest } => {
            catalog_action(client, "catalog.deprecate", &handle, &manifest).await
        }
        BlocksCmd::Invoke {
            channel,
            handle,
            data,
            fallback,
            manifest,
            processor,
            reply_to,
        } => {
            invoke(
                client,
                &channel,
                &handle,
                &data,
                fallback.as_deref(),
                manifest.as_deref(),
                processor.as_deref(),
                reply_to.as_deref(),
            )
            .await
        }
        BlocksCmd::Actions {
            channel,
            instance,
            since,
        } => actions(client, &channel, instance.as_deref(), since).await,
        BlocksCmd::Act {
            channel,
            instance,
            action,
            input,
            idempotency_key,
        } => {
            act(
                client,
                &channel,
                &instance,
                &action,
                &input,
                idempotency_key.as_deref(),
            )
            .await
        }
        BlocksCmd::Receipt {
            channel,
            action,
            instance,
            status,
            result,
        } => receipt(client, &channel, &action, &instance, status, &result).await,
    }
}

async fn list(client: &BuzzClient) -> Result<(), CliError> {
    let events = client
        .query_all(json!({ "kinds": [KIND_BLOCK_CATALOG_ENTRY] }))
        .await?;
    println!("{}", json!({ "blocks": events }));
    Ok(())
}

async fn get(client: &BuzzClient, handle: &str, author: Option<&str>) -> Result<(), CliError> {
    let handle = normalize_block_handle(handle).map_err(block_error)?;
    let mut filter = json!({
        "kinds": [KIND_BLOCK_CATALOG_ENTRY],
        "#d": [handle],
        "limit": 2
    });
    if let Some(author) = author {
        let author = PublicKey::parse(author)
            .map_err(|error| CliError::Usage(format!("invalid --author pubkey: {error}")))?;
        filter["authors"] = json!([author.to_hex()]);
    }
    let events = client.query_paginated(filter, 2).await?;
    match events.as_slice() {
        [] => Err(CliError::NotFound(
            "Block catalog entry not found".to_owned(),
        )),
        [event] => {
            println!("{event}");
            Ok(())
        }
        _ => Err(CliError::Usage(
            "multiple catalog authors matched; pass --author".to_owned(),
        )),
    }
}

async fn draft(client: &BuzzClient, path: &str) -> Result<(), CliError> {
    let manifest = read_manifest(path)?;
    let builder = build_block_manifest(&manifest).map_err(sdk_error)?;
    let event = client.sign_event(builder)?;
    let event_id = event.id.to_hex();
    let response = client.submit_event(event).await?;
    println!(
        "{}",
        merge_write_response(
            &response,
            json!({
                "event_id": event_id,
                "handle": manifest.handle,
                "version": manifest.version.to_string()
            })
        )
    );
    Ok(())
}

fn test(manifest_path: &str, data_path: Option<&str>) -> Result<(), CliError> {
    let manifest = read_manifest(manifest_path)?;
    for example in &manifest.examples {
        validate_instance(&manifest.input_schema, &example.data).map_err(block_error)?;
        render_fallback(&manifest.fallback_template, &example.data)?;
    }
    if let Some(path) = data_path {
        let data = read_json(path)?;
        validate_instance(&manifest.input_schema, &data).map_err(block_error)?;
        render_fallback(&manifest.fallback_template, &data)?;
    }
    let canonical = canonical_serialized(&manifest)?;
    let digest = hex::encode(Sha256::digest(canonical.as_bytes()));
    println!(
        "{}",
        json!({
            "valid": true,
            "handle": manifest.handle,
            "version": manifest.version.to_string(),
            "examples": manifest.examples.len(),
            "digest": digest
        })
    );
    Ok(())
}

async fn catalog_action(
    client: &BuzzClient,
    action_id: &str,
    raw_handle: &str,
    raw_manifest_id: &str,
) -> Result<(), CliError> {
    let handle = normalize_block_handle(raw_handle).map_err(block_error)?;
    let manifest_id = parse_event_id(raw_manifest_id)?;
    let target = fetch_manifest(client, manifest_id).await?;
    if target.manifest.handle != handle {
        return Err(CliError::Usage(format!(
            "manifest handle {} does not match requested handle {handle}",
            target.manifest.handle
        )));
    }
    require_tested_validation(&target.manifest.validation)?;
    let relay_self = relay_self(client).await?;
    let created_at = chrono::Utc::now().timestamp().max(0) as u64;
    let request =
        build_catalog_action_request(action_id, &handle, manifest_id, relay_self, created_at)?;
    let event = client.sign_event(
        EventBuilder::new(Kind::Custom(KIND_BLOCK_ACTION as u16), request.content)
            .tags(request.tags),
    )?;
    let event_id = event.id.to_hex();
    let response = client.submit_event(event).await?;
    let normalized = normalize_action_write_response(&response, &event_id, request.idempotency_key);
    println!(
        "{}",
        merge_write_response(
            &normalized.to_string(),
            json!({
                "action": action_id,
                "handle": handle,
                "manifest_id": manifest_id.to_hex(),
                "request_id": request.request_id,
                "expires_at": request.expires_at
            })
        )
    );
    Ok(())
}

fn build_catalog_action_request(
    action_id: &str,
    handle: &str,
    manifest_id: EventId,
    relay_self: PublicKey,
    created_at: u64,
) -> Result<CatalogActionRequest, CliError> {
    let request_id = Uuid::new_v4();
    let idempotency_key = Uuid::new_v4();
    let expires_at = created_at.saturating_add(CATALOG_ACTION_TTL_SECONDS);
    let content = canonical_json(&json!({
        "schema": CATALOG_ACTION_SCHEMA,
        "expires_at": expires_at,
        "handle": handle,
        "target_manifest_id": manifest_id.to_hex()
    }))
    .map_err(block_error)?;
    let tags = vec![
        tag(&["p", &relay_self.to_hex()])?,
        tag(&["e", &manifest_id.to_hex(), "", "block-manifest"])?,
        tag(&[
            "block-action",
            "1",
            action_id,
            &request_id.to_string(),
            &idempotency_key.to_string(),
        ])?,
    ];
    Ok(CatalogActionRequest {
        content,
        tags,
        request_id,
        idempotency_key,
        expires_at,
    })
}

fn require_tested_validation(validation: &BlockValidation) -> Result<(), CliError> {
    if validation.state == BlockValidationState::Tested {
        Ok(())
    } else {
        Err(CliError::Usage(
            "catalog target manifest validation state must be `tested`".to_owned(),
        ))
    }
}

#[allow(clippy::too_many_arguments)]
async fn invoke(
    client: &BuzzClient,
    raw_channel: &str,
    raw_handle: &str,
    data_path: &str,
    fallback_path: Option<&str>,
    raw_manifest_id: Option<&str>,
    raw_processor: Option<&str>,
    raw_reply_to: Option<&str>,
) -> Result<(), CliError> {
    let channel_id = parse_uuid(raw_channel)?;
    let handle = normalize_block_handle(raw_handle).map_err(block_error)?;
    let resolved = match raw_manifest_id {
        Some(id) => fetch_manifest(client, parse_event_id(id)?).await?,
        None => {
            let (event_id, manifest) = resolve_active_manifest(client, &handle).await?;
            ResolvedManifest { event_id, manifest }
        }
    };
    if resolved.manifest.handle != handle {
        return Err(CliError::Usage(format!(
            "manifest handle {} does not match requested handle {handle}",
            resolved.manifest.handle
        )));
    }
    let data = read_json(data_path)?;
    let fallback = match fallback_path {
        Some(path) => fs::read_to_string(path)
            .map_err(|error| CliError::Usage(format!("could not read fallback {path}: {error}")))?,
        None => render_fallback(&resolved.manifest.fallback_template, &data)?,
    };
    let thread = raw_reply_to
        .map(parse_event_id)
        .transpose()?
        .map(|event_id| BlockThreadRef {
            root_event_id: event_id,
            parent_event_id: event_id,
        });
    let processor = resolve_instance_processor(&resolved.manifest, raw_processor)?;
    let instance_id = Uuid::new_v4();
    let builder = build_block_instance(&BlockInstanceInput {
        channel_id,
        manifest_id: resolved.event_id,
        instance_id,
        manifest: &resolved.manifest,
        fallback,
        data: BlockInstanceData::Inline(data),
        processor,
        thread,
        attention: BlockAttention::None,
    })
    .map_err(sdk_error)?;
    let event = client.sign_event(builder)?;
    let event_id = event.id.to_hex();
    let response = client.submit_event(event).await?;
    println!(
        "{}",
        merge_write_response(
            &response,
            json!({
                "event_id": event_id,
                "instance_id": instance_id,
                "handle": handle,
                "manifest_id": resolved.event_id.to_hex()
            })
        )
    );
    Ok(())
}

fn resolve_instance_processor(
    manifest: &BlockManifest,
    raw_processor: Option<&str>,
) -> Result<Option<PublicKey>, CliError> {
    let has_signed_actions = manifest
        .actions
        .iter()
        .any(|action| matches!(action.interaction, BlockInteraction::Signed { .. }));
    match raw_processor {
        Some(value) => PublicKey::parse(value)
            .map(Some)
            .map_err(|error| CliError::Usage(format!("invalid processor pubkey: {error}"))),
        None if has_signed_actions => Err(CliError::Usage(
            "--processor is required when the Block declares signed actions".to_owned(),
        )),
        None => Ok(None),
    }
}

async fn actions(
    client: &BuzzClient,
    raw_channel: &str,
    raw_instance: Option<&str>,
    since: Option<u64>,
) -> Result<(), CliError> {
    let channel = parse_uuid(raw_channel)?;
    let mut filter = json!({
        "kinds": [KIND_BLOCK_ACTION],
        "#h": [channel.to_string()]
    });
    if let Some(instance) = raw_instance {
        filter["#e"] = json!([parse_event_id(instance)?.to_hex()]);
    }
    if let Some(since) = since {
        filter["since"] = json!(since);
    }
    let events = client.query_all(filter).await?;
    println!("{}", json!({ "actions": events }));
    Ok(())
}

async fn act(
    client: &BuzzClient,
    raw_channel: &str,
    raw_instance: &str,
    action_id: &str,
    input_path: &str,
    raw_idempotency_key: Option<&str>,
) -> Result<(), CliError> {
    let channel_id = parse_uuid(raw_channel)?;
    let instance_event_id = parse_event_id(raw_instance)?;
    let instance = fetch_event(client, instance_event_id, 9).await?;
    let coordinates = instance_coordinates(&instance)?;
    let resolved = fetch_manifest(client, coordinates.manifest_id).await?;
    let data = read_json(input_path)?;
    let built = build_block_action(&BlockActionInput {
        channel_id,
        processor: coordinates.processor,
        instance_event_id,
        manifest_id: coordinates.manifest_id,
        instance_id: coordinates.instance_id,
        manifest: &resolved.manifest,
        action_id: action_id.to_owned(),
        data,
        idempotency_key: raw_idempotency_key.map(parse_uuid).transpose()?,
    })
    .map_err(sdk_error)?;
    let idempotency_key = built.idempotency_key;
    let event = client.sign_event(built.builder)?;
    let event_id = event.id.to_hex();
    let response = client.submit_event(event).await?;
    println!(
        "{}",
        normalize_action_write_response(&response, &event_id, idempotency_key)
    );
    Ok(())
}

async fn receipt(
    client: &BuzzClient,
    raw_channel: &str,
    raw_action: &str,
    raw_instance: &str,
    status: BlockReceiptStatusArg,
    result_path: &str,
) -> Result<(), CliError> {
    let channel_id = parse_uuid(raw_channel)?;
    let action_event_id = parse_event_id(raw_action)?;
    let instance_event_id = parse_event_id(raw_instance)?;
    let action = fetch_event(client, action_event_id, KIND_BLOCK_ACTION).await?;
    let instance = fetch_event(client, instance_event_id, 9).await?;
    let coordinates = instance_coordinates(&instance)?;
    let (action_id, action_instance_id, idempotency_key) = action_coordinates(&action)?;
    if action_instance_id != coordinates.instance_id {
        return Err(CliError::Usage(
            "action and instance identify different Block instances".to_owned(),
        ));
    }
    let resolved = fetch_manifest(client, coordinates.manifest_id).await?;
    let status = receipt_status(status);
    let action_resolves = resolved.manifest.actions.iter().any(|action| {
        action.id == action_id
            && matches!(
                action.interaction,
                BlockInteraction::Signed {
                    resolves_attention: true,
                    ..
                }
            )
    });
    let resolves_attention = action_resolves
        && matches!(
            status,
            BlockReceiptStatus::Succeeded | BlockReceiptStatus::Denied
        );
    let builder = build_block_receipt(&BlockReceiptInput {
        channel_id,
        action_event_id,
        instance_event_id,
        instance_id: coordinates.instance_id,
        idempotency_key,
        action_id,
        manifest: &resolved.manifest,
        status,
        result: read_json(result_path)?,
        resolves_attention,
    })
    .map_err(sdk_error)?;
    let event = client.sign_event(builder)?;
    let event_id = event.id.to_hex();
    let response = client.submit_event(event).await?;
    println!(
        "{}",
        merge_write_response(
            &response,
            json!({
                "event_id": event_id,
                "instance_id": coordinates.instance_id,
                "idempotency_key": idempotency_key,
                "status": receipt_status_name(status),
                "resolves_attention": resolves_attention
            })
        )
    );
    Ok(())
}

pub(crate) async fn resolve_active_manifest(
    client: &BuzzClient,
    raw_handle: &str,
) -> Result<(EventId, BlockManifest), CliError> {
    let handle = normalize_block_handle(raw_handle).map_err(block_error)?;
    let relay_self = relay_self(client).await?;
    let events = client
        .query_paginated(
            json!({
                "kinds": [KIND_BLOCK_CATALOG_ENTRY],
                "authors": [relay_self.to_hex()],
                "#d": [handle],
                "limit": 1
            }),
            1,
        )
        .await?;
    let event = events
        .into_iter()
        .next()
        .ok_or_else(|| CliError::NotFound(format!("active Core Block @{handle} not found")))?;
    let event: Event = serde_json::from_value(event)
        .map_err(|error| CliError::Other(format!("catalog event is malformed: {error}")))?;
    let entry: BlockCatalogEntry = serde_json::from_str(&event.content)
        .map_err(|error| CliError::Other(format!("catalog content is malformed: {error}")))?;
    if entry.status != BlockCatalogStatus::Active || entry.handle != handle {
        return Err(CliError::NotFound(format!(
            "active Core Block @{handle} not found"
        )));
    }
    let manifest_id = parse_event_id(&entry.active_manifest_id)?;
    let resolved = fetch_manifest(client, manifest_id).await?;
    if resolved.manifest.handle != handle {
        return Err(CliError::Other(
            "catalog head and immutable manifest handles differ".to_owned(),
        ));
    }
    Ok((resolved.event_id, resolved.manifest))
}

async fn fetch_manifest(
    client: &BuzzClient,
    manifest_id: EventId,
) -> Result<ResolvedManifest, CliError> {
    let event = fetch_event(client, manifest_id, KIND_BLOCK_MANIFEST).await?;
    let manifest = parse_manifest(&event.content).map_err(block_error)?;
    Ok(ResolvedManifest {
        event_id: event.id,
        manifest,
    })
}

async fn fetch_event(client: &BuzzClient, event_id: EventId, kind: u32) -> Result<Event, CliError> {
    let events = client
        .query_paginated(
            json!({
                "ids": [event_id.to_hex()],
                "kinds": [kind],
                "limit": 1
            }),
            1,
        )
        .await?;
    let value = events
        .into_iter()
        .next()
        .ok_or_else(|| CliError::NotFound(format!("event {} not found", event_id.to_hex())))?;
    serde_json::from_value(value)
        .map_err(|error| CliError::Other(format!("stored event is malformed: {error}")))
}

async fn relay_self(client: &BuzzClient) -> Result<PublicKey, CliError> {
    let raw = client.get_public("/").await?;
    let document: Value = serde_json::from_str(&raw)
        .map_err(|error| CliError::Other(format!("relay info is malformed: {error}")))?;
    let value = document
        .get("self")
        .and_then(Value::as_str)
        .ok_or_else(|| CliError::Other("relay info is missing self pubkey".to_owned()))?;
    PublicKey::parse(value)
        .map_err(|error| CliError::Other(format!("relay self pubkey is invalid: {error}")))
}

fn instance_coordinates(event: &Event) -> Result<InstanceCoordinates, CliError> {
    let block = event
        .tags
        .iter()
        .map(Tag::as_slice)
        .find(|tag| tag.first().map(String::as_str) == Some("block"))
        .ok_or_else(|| CliError::Usage("event is not a Block instance".to_owned()))?;
    if block.len() != 5 || block.get(1).map(String::as_str) != Some("1") {
        return Err(CliError::Usage(
            "event has a malformed Block instance tag".to_owned(),
        ));
    }
    let manifest_id = parse_event_id(&block[3])?;
    let instance_id = parse_uuid(&block[4])?;
    let processor = event
        .tags
        .iter()
        .map(Tag::as_slice)
        .find(|tag| tag.first().map(String::as_str) == Some("p"))
        .and_then(|tag| tag.get(1))
        .ok_or_else(|| CliError::Usage("Block instance has no processor".to_owned()))
        .and_then(|value| {
            PublicKey::parse(value)
                .map_err(|error| CliError::Usage(format!("invalid processor pubkey: {error}")))
        })?;
    Ok(InstanceCoordinates {
        manifest_id,
        instance_id,
        processor,
    })
}

fn action_coordinates(event: &Event) -> Result<(String, Uuid, Uuid), CliError> {
    let action = event
        .tags
        .iter()
        .map(Tag::as_slice)
        .find(|tag| tag.first().map(String::as_str) == Some("block-action"))
        .ok_or_else(|| CliError::Usage("event is not a Block action".to_owned()))?;
    if action.len() != 5 || action.get(1).map(String::as_str) != Some("1") {
        return Err(CliError::Usage(
            "event has a malformed Block action tag".to_owned(),
        ));
    }
    Ok((
        action[2].clone(),
        parse_uuid(&action[3])?,
        parse_uuid(&action[4])?,
    ))
}

fn read_manifest(path: &str) -> Result<BlockManifest, CliError> {
    let content = fs::read_to_string(path)
        .map_err(|error| CliError::Usage(format!("could not read manifest {path}: {error}")))?;
    parse_manifest(&content).map_err(block_error)
}

fn read_json(path: &str) -> Result<Value, CliError> {
    let content = fs::read_to_string(path)
        .map_err(|error| CliError::Usage(format!("could not read JSON {path}: {error}")))?;
    serde_json::from_str(&content)
        .map_err(|error| CliError::Usage(format!("invalid JSON in {path}: {error}")))
}

fn render_fallback(template: &str, data: &Value) -> Result<String, CliError> {
    let mut fallback = template.to_owned();
    if let Some(values) = data.as_object() {
        for (key, value) in values {
            let rendered = value
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| value.to_string());
            fallback = fallback.replace(&format!("{{{{{key}}}}}"), &rendered);
        }
    }
    if fallback.trim().is_empty() {
        return Err(CliError::Usage(
            "manifest generated an empty fallback".to_owned(),
        ));
    }
    Ok(fallback)
}

fn canonical_serialized<T: Serialize>(value: &T) -> Result<String, CliError> {
    let value = serde_json::to_value(value)
        .map_err(|error| CliError::Other(format!("could not serialize Block: {error}")))?;
    canonical_json(&value).map_err(block_error)
}

fn merge_write_response(response: &str, additions: Value) -> Value {
    let mut value: Value = serde_json::from_str(response).unwrap_or_else(|_| json!({}));
    if !value.is_object() {
        value = json!({ "message": response });
    }
    if let (Some(target), Some(additions)) = (value.as_object_mut(), additions.as_object()) {
        for (key, value) in additions {
            target.insert(key.clone(), value.clone());
        }
    }
    value
}

fn normalize_action_write_response(
    response: &str,
    attempted_event_id: &str,
    idempotency_key: Uuid,
) -> Value {
    let parsed = serde_json::from_str::<Value>(response).ok();
    let accepted = parsed
        .as_ref()
        .and_then(|value| value.get("accepted"))
        .and_then(Value::as_bool);
    let response_event_id = parsed
        .as_ref()
        .and_then(|value| value.get("event_id"))
        .and_then(Value::as_str)
        .and_then(|value| EventId::parse(value).ok())
        .map(|event_id| event_id.to_hex());
    let original_event_id = (accepted == Some(false))
        .then(|| response_event_id.clone())
        .flatten();
    let stable_event_id = match accepted {
        Some(true) | Some(false) => response_event_id.as_deref().unwrap_or(attempted_event_id),
        None => attempted_event_id,
    };

    merge_write_response(
        response,
        json!({
            "event_id": stable_event_id,
            "attempted_event_id": attempted_event_id,
            "idempotency_key": idempotency_key,
            "duplicate": original_event_id.is_some(),
            "original_event_id": original_event_id
        }),
    )
}

fn receipt_status(status: BlockReceiptStatusArg) -> BlockReceiptStatus {
    match status {
        BlockReceiptStatusArg::Succeeded => BlockReceiptStatus::Succeeded,
        BlockReceiptStatusArg::Denied => BlockReceiptStatus::Denied,
        BlockReceiptStatusArg::Failed => BlockReceiptStatus::Failed,
        BlockReceiptStatusArg::TimedOut => BlockReceiptStatus::TimedOut,
    }
}

fn receipt_status_name(status: BlockReceiptStatus) -> &'static str {
    match status {
        BlockReceiptStatus::Succeeded => "succeeded",
        BlockReceiptStatus::Denied => "denied",
        BlockReceiptStatus::Failed => "failed",
        BlockReceiptStatus::TimedOut => "timed-out",
    }
}

fn tag(parts: &[&str]) -> Result<Tag, CliError> {
    Tag::parse(parts.iter().copied())
        .map_err(|error| CliError::Usage(format!("invalid Block tag: {error}")))
}

fn block_error(error: buzz_core::block::BlockError) -> CliError {
    CliError::Usage(error.to_string())
}

fn sdk_error(error: buzz_sdk::SdkError) -> CliError {
    CliError::Usage(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        build_catalog_action_request, normalize_action_write_response, render_fallback,
        require_tested_validation, resolve_instance_processor, CATALOG_ACTION_SCHEMA,
        CATALOG_ACTION_TTL_SECONDS,
    };
    use buzz_core::block::{parse_manifest, BlockValidation, BlockValidationState};
    use nostr::{EventId, Keys};
    use serde_json::json;

    #[test]
    fn fallback_replaces_top_level_values_without_executing_templates() {
        assert_eq!(
            render_fallback(
                "**{{name}}** — {{score}}",
                &json!({
                    "name": "Tennant Group",
                    "score": 87
                })
            )
            .expect("fallback"),
            "**Tennant Group** — 87"
        );
    }

    #[test]
    fn catalog_request_uses_the_exact_global_reserved_envelope() {
        let manifest_id = EventId::parse(&"ab".repeat(32)).expect("manifest ID");
        let relay = Keys::generate().public_key();
        let created_at = 1_000_u64;
        let request = build_catalog_action_request(
            "catalog.activate",
            "lead-card",
            manifest_id,
            relay,
            created_at,
        )
        .expect("catalog request");

        assert_eq!(request.expires_at, created_at + CATALOG_ACTION_TTL_SECONDS);
        assert_eq!(
            request.content,
            format!(
                "{{\"expires_at\":1300,\"handle\":\"lead-card\",\"schema\":\"{CATALOG_ACTION_SCHEMA}\",\"target_manifest_id\":\"{}\"}}",
                "ab".repeat(32)
            )
        );
        let tags = request
            .tags
            .iter()
            .map(nostr::Tag::as_slice)
            .collect::<Vec<_>>();
        assert_eq!(tags.len(), 3);
        assert_eq!(tags[0], ["p", &relay.to_hex()]);
        assert_eq!(tags[1], ["e", &"ab".repeat(32), "", "block-manifest"]);
        assert_eq!(tags[2][0], "block-action");
        assert_eq!(tags[2][1], "1");
        assert_eq!(tags[2][2], "catalog.activate");
        assert_eq!(tags[2][3], request.request_id.to_string());
        assert_eq!(tags[2][4], request.idempotency_key.to_string());
        assert!(tags.iter().all(|tag| tag[0] != "h"));
        assert!(tags
            .iter()
            .all(|tag| tag.get(3).is_none_or(|marker| marker != "block-instance")));
    }

    #[test]
    fn duplicate_response_recovers_original_event_id() {
        let winner = "a".repeat(64);
        let attempted = "b".repeat(64);
        let idempotency_key = uuid::Uuid::new_v4();
        let response = json!({
            "accepted": false,
            "event_id": winner,
            "message": format!("duplicate: original action {}", "a".repeat(64))
        })
        .to_string();
        let output = normalize_action_write_response(&response, &attempted, idempotency_key);

        assert_eq!(output["accepted"], false);
        assert_eq!(output["duplicate"], true);
        assert_eq!(output["event_id"], winner);
        assert_eq!(output["original_event_id"], winner);
        assert_eq!(output["attempted_event_id"], attempted);
        assert_eq!(output["idempotency_key"], idempotency_key.to_string());
    }

    #[test]
    fn accepted_action_keeps_the_relays_actual_event_id() {
        let actual = "a".repeat(64);
        let attempted = "b".repeat(64);
        let output = normalize_action_write_response(
            &json!({
                "accepted": true,
                "event_id": actual,
                "message": "stored"
            })
            .to_string(),
            &attempted,
            uuid::Uuid::new_v4(),
        );

        assert_eq!(output["duplicate"], false);
        assert_eq!(output["event_id"], actual);
        assert!(output["original_event_id"].is_null());
        assert_eq!(output["attempted_event_id"], attempted);
    }

    #[test]
    fn invalid_or_missing_response_ids_never_claim_a_duplicate_winner() {
        let attempted = "b".repeat(64);
        for response in [
            json!({
                "accepted": false,
                "event_id": "not-an-event-id",
                "message": format!("duplicate: original action {}", "a".repeat(64))
            })
            .to_string(),
            json!({
                "accepted": false,
                "message": "duplicate"
            })
            .to_string(),
            json!({
                "accepted": true,
                "event_id": "invalid",
                "message": "stored"
            })
            .to_string(),
        ] {
            let output =
                normalize_action_write_response(&response, &attempted, uuid::Uuid::new_v4());
            assert_eq!(output["duplicate"], false);
            assert_eq!(output["event_id"], attempted);
            assert!(output["original_event_id"].is_null());
        }
    }

    #[test]
    fn catalog_mutations_reject_draft_and_unmarked_validation_state() {
        let draft = BlockValidation::default();
        assert_eq!(draft.state, BlockValidationState::Draft);
        assert!(require_tested_validation(&draft).is_err());

        let unmarked: BlockValidation =
            serde_json::from_value(json!({"requires_attention": false}))
                .expect("legacy unmarked validation");
        assert_eq!(unmarked.state, BlockValidationState::Draft);
        assert!(require_tested_validation(&unmarked).is_err());

        let tested: BlockValidation =
            serde_json::from_value(json!({"state": "tested", "requires_attention": false}))
                .expect("tested validation");
        require_tested_validation(&tested).expect("tested manifest");
    }

    #[test]
    fn signed_action_instances_require_an_explicit_processor() {
        let manifest = parse_manifest(include_str!(
            "../../../buzz-relay/src/core_blocks/composites/agent-proposal.json"
        ))
        .expect("signed-action manifest");

        assert!(resolve_instance_processor(&manifest, None)
            .expect_err("signed actions need a processor")
            .to_string()
            .contains("--processor is required"));
        let processor = Keys::generate().public_key();
        assert_eq!(
            resolve_instance_processor(&manifest, Some(&processor.to_hex()))
                .expect("valid processor"),
            Some(processor)
        );
    }
}
