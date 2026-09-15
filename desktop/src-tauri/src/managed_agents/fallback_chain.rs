//! The rules an authored OpenRouter fallback chain obeys.
//!
//! A chain is an ordered list of model ids the harness tries after the primary
//! model refuses. It reaches the agent as one comma-joined
//! `OPENROUTER_FALLBACK_MODELS` value, which is why an id may not contain
//! whitespace or a comma: both would silently split one entry into two.
//!
//! Two operations, deliberately separate:
//!
//! - [`normalize_fallback_models`] is the shape the store keeps. It trims,
//!   drops blanks, removes later duplicates, and caps the length. Every one of
//!   those changes is safe to make on the user's behalf because none of them
//!   can turn one model id into a different model id.
//! - [`validate_fallback_models`] refuses what normalization must not paper
//!   over: an id that would not survive the join, or one large enough to be a
//!   paste accident rather than a model id.

use super::env_vars::MAX_ENV_VALUE_BYTES;

/// How many fallbacks one chain may carry.
///
/// Mirrors `MAX_CHAIN_LEN` in the harness (`crates/buzz-agent`): if five models
/// are down, the sixth is not the problem.
pub(crate) const MAX_FALLBACK_MODELS: usize = 5;

/// Trim entries, drop blanks, drop later duplicates, and cap at
/// [`MAX_FALLBACK_MODELS`].
///
/// The first occurrence of a duplicated id keeps its position, because the
/// order of the chain is the order the harness tries it in and a person who
/// listed a model twice meant the earlier slot.
pub(crate) fn normalize_fallback_models(models: &[String]) -> Vec<String> {
    let mut normalized: Vec<String> = Vec::new();
    for model in models {
        let trimmed = model.trim();
        if trimmed.is_empty() {
            continue;
        }
        if normalized.iter().any(|kept| kept == trimmed) {
            continue;
        }
        normalized.push(trimmed.to_string());
        if normalized.len() == MAX_FALLBACK_MODELS {
            break;
        }
    }
    normalized
}

/// Refuse a chain that cannot be carried by the spawn env.
///
/// `field` names the offending field in the returned message, so a global
/// config save and a persona save can share this without either pretending to
/// be the other.
pub(crate) fn validate_fallback_models(field: &str, models: &[String]) -> Result<(), String> {
    for model in models {
        let trimmed = model.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.contains('\0') {
            return Err(format!("`{field}` model ids must not contain NUL bytes"));
        }
        if trimmed.contains(',') || trimmed.chars().any(char::is_whitespace) {
            return Err(format!(
                "`{field}` model ids must not contain whitespace or commas: `{trimmed}`"
            ));
        }
        if trimmed.len() > MAX_ENV_VALUE_BYTES {
            return Err(format!(
                "`{field}` model id exceeds the maximum allowed length ({MAX_ENV_VALUE_BYTES} bytes)"
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chain(entries: &[&str]) -> Vec<String> {
        entries.iter().map(|e| (*e).to_string()).collect()
    }

    #[test]
    fn normalization_trims_and_drops_blanks() {
        assert_eq!(
            normalize_fallback_models(&chain(&["  a/one:free ", "", "   ", "b/two:free"])),
            chain(&["a/one:free", "b/two:free"])
        );
    }

    /// The earlier slot wins: the chain's order is the order it is tried in.
    #[test]
    fn normalization_keeps_the_first_of_a_duplicate_pair() {
        assert_eq!(
            normalize_fallback_models(&chain(&["a/one:free", "b/two:free", "a/one:free"])),
            chain(&["a/one:free", "b/two:free"])
        );
    }

    #[test]
    fn normalization_caps_the_chain() {
        let long = chain(&["a", "b", "c", "d", "e", "f", "g"]);
        assert_eq!(
            normalize_fallback_models(&long),
            chain(&["a", "b", "c", "d", "e"])
        );
    }

    /// A space would split one id into two once the chain is comma-joined for
    /// the spawn env, so it is refused rather than silently rewritten.
    #[test]
    fn validation_refuses_whitespace_and_commas() {
        assert!(validate_fallback_models("fallback_models", &chain(&["a/one :free"])).is_err());
        assert!(validate_fallback_models("fallback_models", &chain(&["a/one,b/two"])).is_err());
        assert!(validate_fallback_models("fallback_models", &chain(&["a/one:free"])).is_ok());
    }

    #[test]
    fn validation_refuses_nul_bytes() {
        assert!(validate_fallback_models("fallback_models", &chain(&["a/one\0:free"])).is_err());
    }

    /// Blank entries are normalization's business, not validation's: a caller
    /// that has not normalized yet must not be refused for a stray empty row.
    #[test]
    fn validation_ignores_blank_entries() {
        assert!(validate_fallback_models("fallback_models", &chain(&["", "  "])).is_ok());
    }
}
