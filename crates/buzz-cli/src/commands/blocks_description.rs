//! Read-only, one-command discovery of a pinned Block contract.
use buzz_core::block::{BlockInteraction, BlockManifest, MAX_BLOCK_DEPTH, MAX_BLOCK_NODES};
use serde_json::{json, Value};

pub(super) fn describe_manifest(manifest: &BlockManifest, manifest_id: &str) -> Value {
    let required = manifest
        .input_schema
        .get("required")
        .and_then(Value::as_array);
    let fields: Vec<Value> = manifest.input_schema.get("properties").and_then(Value::as_object)
        .into_iter().flatten().map(|(name, schema)| json!({
            "field": name,
            "required_in_every_payload": required.is_some_and(|items| items.iter().any(|item| item.as_str() == Some(name.as_str()))),
            "schema": schema
        })).collect();
    let requires_processor = manifest
        .actions
        .iter()
        .any(|action| matches!(action.interaction, BlockInteraction::Signed { .. }));
    let processor = if requires_processor {
        " --processor <your-pubkey>"
    } else {
        ""
    };
    json!({
        "handle": manifest.handle,
        "name": manifest.name,
        "version": manifest.version.to_string(),
        "manifest_id": manifest_id,
        "description": manifest.description,
        "input_schema": manifest.input_schema,
        "customizable_fields": fields,
        "examples": manifest.examples,
        "actions": manifest.actions,
        "permissions": manifest.permissions,
        "definition": manifest,
        "usage": {
            "invoke": format!("buzz blocks invoke --channel <channel-uuid> --handle {} --manifest {} --data <json-file>{processor} --reply-to <current-reply-event-id>", manifest.handle, manifest_id),
            "data": "Pass a plain JSON file path, not @file syntax. Only schema-exposed content can vary; instance data cannot add buttons or change the native tree.",
            "requires_processor": requires_processor,
            "requires_attention": manifest.validation.requires_attention,
            "responses": "Signed actions return to the pinned processor. Read with blocks actions --channel <channel> --instance <instance-event-id>; publish a separate blocks receipt after handling the authorized result. The instance event ID is different from its UUID.",
            "revisions": "Definitions and posted instances are pinned. There is no general instance-data update command. Deliverable revisions use a new version, history and supersedes reference.",
            "composition": "Use existing catalog handles in ordinary agent conversations. Custom native definitions are a separate authoring workflow; agents must not create or activate them from chat.",
            "catalog_authority": "Activation, rollback and deprecation require a human community owner or admin. Declared capabilities do not grant execution permission.",
            "diagram_files": "Upload a bounded Mermaid source file (.mmd or .mermaid) and supply its descriptor to Media, or use a fenced mermaid block in Markdown. This uses Colony's native viewer; no arbitrary HTML, JavaScript or new primitive is accepted.",
            "composition_limits": { "max_depth": MAX_BLOCK_DEPTH, "max_nodes": MAX_BLOCK_NODES }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::block::parse_manifest;

    #[test]
    fn describe_returns_the_resolved_question_contract_and_pinned_usage() {
        let manifest = parse_manifest(include_str!(
            "../../../buzz-relay/src/core_blocks/primitives/question.json"
        ))
        .expect("bundled question");
        let output = describe_manifest(&manifest, &"a".repeat(64));
        assert_eq!(output["handle"], "question");
        assert_eq!(output["version"], "2.0.0");
        assert_eq!(output["input_schema"], manifest.input_schema);
        assert_eq!(output["definition"]["tree"]["mode_path"], "/mode");
        assert_eq!(output["usage"]["requires_processor"], true);
        assert!(output["usage"]["invoke"]
            .as_str()
            .expect("command")
            .contains("--manifest aaaa"));
        assert!(
            output["customizable_fields"]
                .as_array()
                .expect("fields")
                .iter()
                .any(|field| field["field"] == "choices"
                    && field["required_in_every_payload"] == true)
        );
        assert_eq!(output["examples"].as_array().expect("examples").len(), 2);
    }

    #[test]
    fn describe_read_only_details_exposes_legacy_and_items_alternatives() {
        let manifest = parse_manifest(include_str!(
            "../../../buzz-relay/src/core_blocks/primitives/details.json"
        ))
        .expect("bundled details");
        let output = describe_manifest(&manifest, &"b".repeat(64));
        assert_eq!(output["usage"]["requires_processor"], false);
        assert!(!output["usage"]["invoke"]
            .as_str()
            .expect("command")
            .contains("--processor"));
        assert_eq!(output["input_schema"]["anyOf"][0]["required"][0], "items");
        assert!(output["customizable_fields"]
            .as_array()
            .expect("fields")
            .iter()
            .any(|field| field["field"] == "items"));
    }
}
