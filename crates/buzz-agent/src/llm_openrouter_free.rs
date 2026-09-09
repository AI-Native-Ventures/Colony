//! A free primary model must never turn a retry into paid inference.

pub(super) fn fallbacks(model: &str, mut candidates: Vec<String>) -> Vec<String> {
    if is_free(model) {
        candidates.retain(|candidate| is_free(candidate));
    }
    candidates
}

fn is_free(model: &str) -> bool {
    model == "openrouter/free" || model.ends_with(":free")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn refreshed_and_configured_chains_cannot_charge_a_free_request() {
        for model in ["openrouter/free", "vendor/model:free"] {
            let mut body = json!({ "model": model });
            super::super::apply_openrouter_mutations(
                &mut body,
                None,
                model,
                false,
                &["paid/model".into(), "other/model:free".into()],
                false,
            );
            assert_eq!(body["models"], json!([model, "other/model:free"]));
        }
    }

    #[test]
    fn all_paid_fallbacks_leave_the_free_primary_as_the_only_route() {
        let mut body = json!({ "model": "openrouter/free" });
        super::super::apply_openrouter_mutations(
            &mut body,
            None,
            "openrouter/free",
            false,
            &["paid/model".into()],
            false,
        );
        assert_eq!(body["model"], "openrouter/free");
        assert!(body.get("models").is_none());
    }

    #[test]
    fn explicit_paid_primary_retains_its_configured_chain() {
        let candidates = vec!["paid/model".into(), "other/model:free".into()];
        assert_eq!(fallbacks("chosen/paid", candidates.clone()), candidates);
    }
}
