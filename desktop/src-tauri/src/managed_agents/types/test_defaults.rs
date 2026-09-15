//! A blank [`AgentDefinition`] for tests to build on.
//!
//! Test-only on purpose. Production code constructs a definition through
//! `create_persona` or a snapshot import, both of which decide every field
//! deliberately, and a `Default` on the production type would quietly let a
//! future field arrive unconsidered. In a test the opposite is true: a helper
//! that spells out twenty irrelevant fields to vary one is noise, and every new
//! field makes each such helper longer for no reader's benefit.
//!
//! `is_active` is `true`, matching `default_record_active`, so a definition
//! built here behaves like a stored one rather than a retired one.

use std::collections::BTreeMap;

use super::AgentDefinition;

impl Default for AgentDefinition {
    fn default() -> Self {
        Self {
            id: String::new(),
            role_id: None,
            role_title: None,
            display_name: String::new(),
            avatar_url: None,
            system_prompt: String::new(),
            runtime: None,
            model: None,
            provider: None,
            fallback_models: None,
            name_pool: Vec::new(),
            is_builtin: false,
            is_active: true,
            shared: false,
            source_team: None,
            source_team_persona_slug: None,
            catalog_source: None,
            env_vars: BTreeMap::new(),
            respond_to: None,
            respond_to_allowlist: Vec::new(),
            parallelism: None,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }
}
