//! Data bindings for a closed native tree, including answer validation against a pinned question.
use super::{
    valid_json_pointer, validate_instance, BlockError, BlockManifest, BlockNode, DetailItem,
    QuestionMode, QuestionNode,
};
use serde_json::Value;
use std::collections::HashSet;

pub(super) fn validate_field_bindings(node: &BlockNode) -> Result<(), BlockError> {
    let paths = match node {
        BlockNode::Question(question) => vec![question.mode_path.as_deref()],
        BlockNode::Details(details) => vec![details.items_path.as_deref()],
        BlockNode::Status(status) => {
            if status.position_path.is_some() != status.total_path.is_some() {
                return Err(BlockError::InvalidManifest(
                    "Status position_path and total_path must be supplied together".into(),
                ));
            }
            vec![
                status.progress_path.as_deref(),
                status.position_path.as_deref(),
                status.total_path.as_deref(),
            ]
        }
        _ => vec![],
    };
    if paths
        .into_iter()
        .flatten()
        .any(|path| !valid_json_pointer(path))
    {
        return Err(BlockError::InvalidManifest(
            "Block field paths must be bounded JSON Pointers".into(),
        ));
    }
    Ok(())
}

fn question_mode(question: &QuestionNode, data: &Value) -> Result<QuestionMode, BlockError> {
    let Some(value) = question
        .mode_path
        .as_ref()
        .and_then(|path| data.pointer(path))
    else {
        return Ok(question.mode);
    };
    let mode = match value.as_str() {
        Some("single-select") => QuestionMode::SingleSelect,
        Some("multi-select") => QuestionMode::MultiSelect,
        _ => {
            return Err(BlockError::InvalidInstance(
                "Question mode must be single-select or multi-select".into(),
            ))
        }
    };
    if mode == QuestionMode::SingleSelect && question.min_selections > 1 {
        return Err(BlockError::InvalidInstance(
            "A single-select question cannot require multiple choices".into(),
        ));
    }
    Ok(mode)
}

pub(super) fn validate_dynamic_fields(node: &BlockNode, data: &Value) -> Result<(), BlockError> {
    match node {
        BlockNode::Question(question) => {
            question_mode(question, data)?;
        }
        BlockNode::Details(details) => {
            if let Some(value) = details
                .items_path
                .as_ref()
                .and_then(|path| data.pointer(path))
            {
                let items = value.as_array().ok_or_else(|| {
                    BlockError::InvalidInstance(
                        "Details items_path must resolve to an array".into(),
                    )
                })?;
                if items.is_empty() || items.len() > 24 {
                    return Err(BlockError::InvalidInstance(
                        "Details require between 1 and 24 items".into(),
                    ));
                }
                for value in items {
                    let item: DetailItem = serde_json::from_value(value.clone()).map_err(|_| {
                        BlockError::InvalidInstance(
                            "Details items require strict label/value text and supported format"
                                .into(),
                        )
                    })?;
                    if item.label.trim().is_empty()
                        || item.label.chars().count() > 120
                        || item.value.chars().count() > 2000
                    {
                        return Err(BlockError::InvalidInstance(
                            "Details item text exceeds supported bounds".into(),
                        ));
                    }
                }
            }
        }
        _ => {}
    }
    Ok(())
}

/// Validate a declared action and any selected answers against its exact pinned instance.
/// Unknown IDs, duplicate selections and multiple answers to a single-choice question fail closed.
/// Pass `None` when externally stored instance data has not been verified; Question actions
/// cannot be accepted without that evidence, even when their choices are static.
pub fn validate_manifest_action_input(
    manifest: &BlockManifest,
    instance_data: Option<&Value>,
    action_id: &str,
    input: &Value,
) -> Result<(), BlockError> {
    let action = manifest
        .actions
        .iter()
        .find(|action| action.id == action_id)
        .ok_or_else(|| {
            BlockError::InvalidInstance("Action is not declared by the pinned manifest".into())
        })?;
    if let Some(schema) = &action.input_schema {
        validate_instance(schema, input)?;
    }
    match instance_data {
        Some(data) => validate_question_answer(&manifest.tree, data, action_id, input),
        None if contains_question_action(&manifest.tree, action_id) => Err(
            BlockError::InvalidInstance(
                "Question answer requires verified instance data; external instance data is unavailable".into(),
            ),
        ),
        None => Ok(()),
    }
}

fn contains_question_action(node: &BlockNode, action_id: &str) -> bool {
    match node {
        BlockNode::Question(question) => question.submit_action == action_id,
        BlockNode::Stack { children, .. } | BlockNode::Grid { children, .. } => children
            .iter()
            .any(|child| contains_question_action(child, action_id)),
        BlockNode::Card(card) => card
            .children
            .iter()
            .any(|child| contains_question_action(child, action_id)),
        BlockNode::CardList(list) => contains_question_action(&list.card, action_id),
        _ => false,
    }
}

fn validate_question_answer(
    node: &BlockNode,
    data: &Value,
    action_id: &str,
    input: &Value,
) -> Result<(), BlockError> {
    match node {
        BlockNode::Question(question) if question.submit_action == action_id => {
            let mode = question_mode(question, data)?;
            let selected = input
                .get("selected")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    BlockError::InvalidInstance("Question answer requires selected IDs".into())
                })?;
            let max = if mode == QuestionMode::SingleSelect {
                1
            } else {
                usize::from(question.max_selections)
            };
            if selected.len() < usize::from(question.min_selections) || selected.len() > max {
                return Err(BlockError::InvalidInstance(
                    "Question answer exceeds its selection bounds".into(),
                ));
            }
            let options: HashSet<&str> = if let Some(path) = &question.options_path {
                data.pointer(path)
                    .and_then(Value::as_array)
                    .ok_or_else(|| {
                        BlockError::InvalidInstance(
                            "Question answer requires verified inline instance choices".into(),
                        )
                    })?
                    .iter()
                    .filter_map(|option| option.get("id").and_then(Value::as_str))
                    .collect()
            } else {
                question
                    .options
                    .iter()
                    .map(|option| option.id.as_str())
                    .collect()
            };
            let mut unique = HashSet::new();
            for value in selected {
                let id = value.as_str().ok_or_else(|| {
                    BlockError::InvalidInstance("Question selections must be IDs".into())
                })?;
                if !options.contains(id) || !unique.insert(id) {
                    return Err(BlockError::InvalidInstance(
                        "Question answer contains unknown or duplicate choices".into(),
                    ));
                }
            }
            if let Some(custom) = input.get("custom_input") {
                if !question.allow_custom
                    || !custom.is_string()
                    || custom
                        .as_str()
                        .is_some_and(|text| text.chars().count() > 2000)
                {
                    return Err(BlockError::InvalidInstance(
                        "Question custom input is unavailable or exceeds its limit".into(),
                    ));
                }
            }
            if question.require_custom_input
                && input
                    .get("custom_input")
                    .and_then(Value::as_str)
                    .is_none_or(|text| text.trim().is_empty())
            {
                return Err(BlockError::InvalidInstance(
                    "Question answer requires a written explanation".into(),
                ));
            }
        }
        BlockNode::Stack { children, .. } | BlockNode::Grid { children, .. } => {
            for child in children {
                validate_question_answer(child, data, action_id, input)?;
            }
        }
        BlockNode::Card(card) => {
            for child in &card.children {
                validate_question_answer(child, data, action_id, input)?;
            }
        }
        BlockNode::CardList(list) => {
            if let Some(items) = data.pointer(&list.items_path).and_then(Value::as_array) {
                for item in items {
                    validate_question_answer(&list.card, item, action_id, input)?;
                }
            }
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn manifest() -> BlockManifest {
        serde_json::from_value(json!({
            "schema":"test", "handle":"choice", "version":"1.0.0", "name":"Choice", "description":"A choice", "origin":"workspace-custom", "created_at":1,
            "input_schema":{"$schema":"https://json-schema.org/draft/2020-12/schema", "type":"object"},
            "tree":{"type":"question", "prompt":"Choose", "mode":"multi-select", "mode_path":"/mode", "options_path":"/choices", "min_selections":1,"max_selections":12,"allow_custom":true,"require_custom_input":false,"submit_action":"choice.submit"},
            "actions":[{"id":"choice.submit","label":"Submit","interaction":{"type":"signed","action_id":"choice.submit","resolves_attention":false},"permissions":[]}],
            "permissions":[],"fallback_template":"Choose","supported_clients":["desktop"],"primitive_versions":{"question":1},"examples":[],"validation":{"state":"tested","requires_attention":false}
        })).expect("valid fixture")
    }

    #[test]
    fn answers_obey_the_pinned_dynamic_mode_and_choices() {
        let manifest = manifest();
        let single = json!({"mode":"single-select","choices":[{"id":"a"},{"id":"b"}]});
        assert!(validate_manifest_action_input(
            &manifest,
            Some(&single),
            "choice.submit",
            &json!({"selected":["a"]})
        )
        .is_ok());
        assert!(validate_manifest_action_input(
            &manifest,
            Some(&single),
            "choice.submit",
            &json!({"selected":["a","b"]})
        )
        .is_err());
        let multiple = json!({"mode":"multi-select","choices":[{"id":"a"},{"id":"b"}]});
        assert!(validate_manifest_action_input(
            &manifest,
            Some(&multiple),
            "choice.submit",
            &json!({"selected":["a","b"]})
        )
        .is_ok());
        for selected in [json!(["unknown"]), json!(["a", "a"]), json!([])] {
            assert!(validate_manifest_action_input(
                &manifest,
                Some(&multiple),
                "choice.submit",
                &json!({"selected":selected})
            )
            .is_err());
        }
        assert!(validate_manifest_action_input(
            &manifest,
            Some(&Value::Null),
            "choice.submit",
            &json!({"selected":["a"]})
        )
        .is_err());
    }

    #[test]
    fn unavailable_external_data_never_falls_back_to_unverified_question_modes_or_rows() {
        let mut manifest = manifest();
        let BlockNode::Question(question) = &mut manifest.tree else {
            panic!("fixture is a Question")
        };
        question.options_path = None;
        question.options = serde_json::from_value(json!([
            {"id":"a", "label":"A"}, {"id":"b", "label":"B"}
        ]))
        .expect("static choices");
        question.max_selections = 2;
        let answers = json!({"selected":["a","b"]});
        assert!(validate_manifest_action_input(
            &manifest,
            Some(&json!({"mode":"multi-select"})),
            "choice.submit",
            &answers,
        )
        .is_ok());
        assert!(validate_manifest_action_input(
            &manifest,
            Some(&json!({"mode":"single-select"})),
            "choice.submit",
            &answers,
        )
        .is_err());
        let unavailable =
            validate_manifest_action_input(&manifest, None, "choice.submit", &answers)
                .expect_err("external modes must be verified");
        assert!(unavailable.to_string().contains("verified instance data"));

        if let BlockNode::Question(question) = &mut manifest.tree {
            question.mode_path = None;
        }
        assert!(
            validate_manifest_action_input(&manifest, None, "choice.submit", &answers).is_err(),
            "even static Questions require verified instance data"
        );

        let question = serde_json::to_value(&manifest.tree).expect("Question tree");
        manifest.tree = serde_json::from_value(json!({
            "type":"card-list", "items_path":"/items", "card":question
        }))
        .expect("legacy repeated Question tree");
        assert!(
            validate_manifest_action_input(&manifest, None, "choice.submit", &answers,).is_err()
        );
    }

    #[test]
    fn unavailable_external_data_does_not_disable_non_question_actions() {
        let mut manifest = manifest();
        manifest.tree = serde_json::from_value(json!({
            "type":"section", "text":"An ordinary signed action"
        }))
        .expect("section");
        assert!(
            validate_manifest_action_input(&manifest, None, "choice.submit", &json!({}),).is_ok()
        );
    }

    #[test]
    fn exact_bundled_question_obeys_its_posted_mode_and_retains_legacy_contract() {
        let current = super::super::parse_manifest(include_str!(
            "../../buzz-relay/src/core_blocks/primitives/question.json"
        ))
        .expect("current bundled Question");
        let legacy = super::super::parse_manifest(include_str!(
            "../../buzz-relay/src/core_blocks/legacy/question-1.0.0.json"
        ))
        .expect("legacy bundled Question");
        let single = &current.examples[0].data;
        let multiple = &current.examples[1].data;
        assert!(super::super::validate_manifest_instance(&current, single).is_ok());
        assert!(super::super::validate_manifest_instance(&legacy, single).is_err());
        assert!(
            super::super::validate_manifest_instance(&legacy, &legacy.examples[0].data).is_ok()
        );
        let selected = json!({"selected":["client-story","practical-guide"]});
        assert!(validate_manifest_action_input(
            &current,
            Some(single),
            "question.submit",
            &selected
        )
        .is_err());
        assert!(validate_manifest_action_input(
            &current,
            Some(multiple),
            "question.submit",
            &selected
        )
        .is_ok());
        let legacy_tree = serde_json::to_value(&legacy.tree).expect("legacy tree");
        assert!(
            legacy_tree.get("mode_path").is_none(),
            "absent optional fields must not change pinned legacy serialization"
        );
    }

    #[test]
    fn details_and_presentation_bindings_are_bounded() {
        let node: BlockNode =
            serde_json::from_value(json!({"type":"details","items":[],"items_path":"/items"}))
                .expect("node");
        assert!(
            validate_dynamic_fields(&node, &json!({"items":[{"label":"Owner","value":"Mo"}]}))
                .is_ok()
        );
        assert!(validate_dynamic_fields(
            &node,
            &json!({"items":[{"label":"Owner","value":"Mo","html":"script"}]})
        )
        .is_err());
        assert!(validate_dynamic_fields(&node, &json!({"items":[]})).is_err());
        let status: BlockNode = serde_json::from_value(
            json!({"type":"status","label":"Progress","position_path":"/step"}),
        )
        .expect("node");
        assert!(validate_field_bindings(&status).is_err());
    }
}
