//! One-pass text fallback interpolation. Instance values never become templates.
use crate::error::CliError;
use serde_json::Value;

/// Resolve a dotted placeholder path, so a nested exact field such as
/// `content.subject` reaches the fallback sentence instead of vanishing.
fn resolve_path<'a>(data: &'a Value, path: &str) -> Option<&'a Value> {
    let mut current = data;
    for segment in path.split('.') {
        current = current.get(segment)?;
    }
    Some(current)
}

pub(super) fn render_fallback(template: &str, data: &Value) -> Result<String, CliError> {
    let mut result = String::new();
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        result.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            result.push_str(&rest[start..]);
            rest = "";
            break;
        };
        if let Some(value) = resolve_path(data, after[..end].trim()) {
            if let Some(text) = value.as_str() {
                result.push_str(text);
            } else {
                result.push_str(&value.to_string());
            }
        }
        rest = &after[end + 2..];
    }
    result.push_str(rest);
    if result.trim().is_empty() {
        return Err(CliError::Usage(
            "manifest generated an empty fallback".into(),
        ));
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn optional_fields_disappear_but_inserted_values_remain_literal() {
        let data = json!({"label":"Note","value":"Keep {{value}} and {{missing}} literal"});
        assert_eq!(
            render_fallback("{{items}}{{label}}: {{value}}", &data).expect("fallback"),
            "Note: Keep {{value}} and {{missing}} literal"
        );
        assert!(render_fallback("{{missing}}", &data).is_err());
    }

    #[test]
    fn nested_exact_fields_reach_the_fallback_sentence() {
        let data = json!({"content":{"subject":"Winter special","body":"Hi there"}});
        assert_eq!(
            render_fallback("Subject: {{content.subject}}", &data).expect("fallback"),
            "Subject: Winter special"
        );
        assert!(render_fallback("{{content.missing}}", &data).is_err());
    }
}
