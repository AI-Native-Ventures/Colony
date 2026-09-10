//! Question actions address one node in an instance, never an ambiguous repeated row.
use super::{BlockError, BlockNode};
use std::collections::HashSet;

pub(super) fn validate_question_composition(tree: &BlockNode) -> Result<(), BlockError> {
    fn visit(
        node: &BlockNode,
        repeated: bool,
        actions: &mut HashSet<String>,
    ) -> Result<(), BlockError> {
        match node {
            BlockNode::Question(question) => {
                if repeated {
                    return Err(BlockError::InvalidManifest(
                        "Question cannot appear inside a card-list until answers can address a specific row".into(),
                    ));
                }
                if !actions.insert(question.submit_action.clone()) {
                    return Err(BlockError::InvalidManifest(
                        "Each Question must have a unique submit_action within its Block".into(),
                    ));
                }
            }
            BlockNode::CardList(list) => visit(&list.card, true, actions)?,
            BlockNode::Stack { children, .. } | BlockNode::Grid { children, .. } => {
                for child in children {
                    visit(child, repeated, actions)?;
                }
            }
            BlockNode::Card(card) => {
                for child in &card.children {
                    visit(child, repeated, actions)?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    visit(tree, false, &mut HashSet::new())
}

#[cfg(test)]
mod tests {
    use crate::block::{parse_manifest, validate_manifest, BlockManifest};
    use serde_json::json;

    fn manifest() -> BlockManifest {
        let mut manifest = parse_manifest(include_str!(
            "../../buzz-relay/src/core_blocks/primitives/question.json"
        ))
        .expect("bundled Question");
        manifest.examples.clear();
        manifest
    }

    #[test]
    fn repeated_and_ambiguous_question_actions_are_not_publishable() {
        let mut manifest = manifest();
        let question = serde_json::to_value(&manifest.tree).expect("Question tree");
        for tree in [
            json!({"type":"card-list", "items_path":"/items", "card":question}),
            json!({"type":"card-list", "items_path":"/items", "card":{"type":"card", "children":[question]}}),
            json!({"type":"stack", "gap":"medium", "children":[question, {"type":"card", "children":[question]}]}),
        ] {
            manifest.tree = serde_json::from_value(tree).expect("bounded tree");
            assert!(validate_manifest(&manifest).is_err());
        }
    }

    #[test]
    fn separate_questions_keep_distinct_actions() {
        let mut manifest = manifest();
        let first = serde_json::to_value(&manifest.tree).expect("Question tree");
        let mut second = first.clone();
        second["submit_action"] = json!("second.submit");
        let mut action = serde_json::to_value(&manifest.actions[0]).expect("Question action");
        action["id"] = json!("second.submit");
        action["interaction"]["action_id"] = json!("second.submit");
        manifest
            .actions
            .push(serde_json::from_value(action).expect("distinct action"));
        manifest.tree = serde_json::from_value(json!({
            "type":"stack", "gap":"medium", "children":[first,second]
        }))
        .expect("two Questions");
        assert!(validate_manifest(&manifest).is_ok());
    }
}
