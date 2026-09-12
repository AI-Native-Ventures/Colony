//! The bundled Website Manager recipe: the trusted, compile-time source the
//! installer seeds from.
//!
//! Everything here is embedded from `persona-packs/website-manager/` at build
//! time. The pack directory remains the single source of truth (and stays
//! readable with `buzz pack inspect`), while the installer never reads a
//! user-writable path for recipe content, so a pack on disk cannot change what
//! gets installed.
//!
//! Users edit the *installed* copies (persona prompts in Agents, skills in the
//! agent workspace, team instructions in the team editor). The installer only
//! seeds missing records and never overwrites an existing definition or skill,
//! so those edits survive reinstall and upgrade.

/// Recipe identity exposed to the UI and recorded in the install journal.
pub const RECIPE_ID: &str = "website-manager";
pub const RECIPE_VERSION: &str = "0.1.0";
/// The same version as a monotonic stamp for `ManagedAgentRecord`, whose
/// `provisioned_version` is numeric because the relay stamps the employees it
/// mints that way. Bump it with `RECIPE_VERSION`.
pub const RECIPE_RECORD_VERSION: i64 = 1;

/// Team slug, used in the per-community team id.
pub const TEAM_SLUG: &str = "website-manager";
pub const TEAM_NAME: &str = "Website Manager";
pub const TEAM_DESCRIPTION: &str =
    "A four-person website studio: research, direction, build, and independent review.";

/// One-sentence outcome shown on the Agents entry point.
pub const OUTCOME_SENTENCE: &str =
    "Installs a four-person website studio that researches your site, redesigns and builds it, then checks the result independently on desktop and mobile.";

/// The example starter prompt the install dialog offers.
pub const EXAMPLE_PROMPT: &str = "Improve my website";

/// Integration boundary note shown in the install dialog. Deliberately says
/// the command surface is not documented here yet.
pub const INTEGRATION_NOTE: &str = "Installing the team is complete when the status shows the team, personas, and agents published. Starting a website job uses the Website Manager job surface; the exact command is documented in docs/website-manager-protocol.md.";

/// Persona ids are the stable NIP-AP `d`-tag slugs. They must satisfy
/// `^[a-z0-9][a-z0-9_-]{0,63}$` because the relay publishes them as the
/// persona coordinate, so no colons or other separators are used.
pub struct RecipePersona {
    pub slug: &'static str,
    pub persona_id: &'static str,
    pub display_name: &'static str,
    pub role_id: &'static str,
    pub role_title: &'static str,
    /// `leader` or `worker`; written into the published managed-agent head.
    pub tier: &'static str,
    /// Stable palette index for persona chips in the install result.
    pub color_index: u8,
    pub skill_names: &'static [&'static str],
    pub persona_md: &'static str,
}

pub const AVERY_PERSONA_ID: &str = "website-manager-avery";
pub const REN_PERSONA_ID: &str = "website-manager-ren";
pub const JULES_PERSONA_ID: &str = "website-manager-jules";
pub const VERA_PERSONA_ID: &str = "website-manager-vera";

pub const PERSONAS: &[RecipePersona] = &[
    RecipePersona {
        slug: "avery",
        persona_id: AVERY_PERSONA_ID,
        display_name: "Avery",
        role_id: "website-manager",
        role_title: "Website Manager",
        tier: "leader",
        color_index: 0,
        skill_names: &["website-team-workflow", "website-owner-review"],
        persona_md: include_str!(
            "../../../../../persona-packs/website-manager/personas/avery.persona.md"
        ),
    },
    RecipePersona {
        slug: "ren",
        persona_id: REN_PERSONA_ID,
        display_name: "Ren",
        role_id: "website-researcher",
        role_title: "Website Researcher",
        tier: "worker",
        color_index: 1,
        skill_names: &["website-research"],
        persona_md: include_str!(
            "../../../../../persona-packs/website-manager/personas/ren.persona.md"
        ),
    },
    RecipePersona {
        slug: "jules",
        persona_id: JULES_PERSONA_ID,
        display_name: "Jules",
        role_id: "website-designer-builder",
        role_title: "Website Designer-builder",
        tier: "worker",
        color_index: 2,
        skill_names: &["website-direction-build", "website-handover"],
        persona_md: include_str!(
            "../../../../../persona-packs/website-manager/personas/jules.persona.md"
        ),
    },
    RecipePersona {
        slug: "vera",
        persona_id: VERA_PERSONA_ID,
        display_name: "Vera",
        role_id: "website-reviewer",
        role_title: "Website Reviewer",
        tier: "worker",
        color_index: 3,
        skill_names: &["website-independent-review"],
        persona_md: include_str!(
            "../../../../../persona-packs/website-manager/personas/vera.persona.md"
        ),
    },
];

/// Shared method appended to every member deployment through the team's
/// `instructions` field (`effective_team_instructions` layers it at spawn).
pub const TEAM_INSTRUCTIONS: &str =
    include_str!("../../../../../persona-packs/website-manager/instructions.md");

pub struct RecipeSkill {
    pub name: &'static str,
    pub description: &'static str,
    pub version: u32,
    pub content: &'static str,
}

pub const SKILLS: &[RecipeSkill] = &[
    RecipeSkill {
        name: "website-team-workflow",
        description: "Run the six-stage website method as one durable project with mention handoffs and evidence gates.",
        version: 1,
        content: include_str!(
            "../../../../../persona-packs/website-manager/skills/website-team-workflow/SKILL.md"
        ),
    },
    RecipeSkill {
        name: "website-owner-review",
        description: "One review request per version, exact-version approval, and feedback mapped to the protocol's requestChanges decision.",
        version: 1,
        content: include_str!(
            "../../../../../persona-packs/website-manager/skills/website-owner-review/SKILL.md"
        ),
    },
    RecipeSkill {
        name: "website-handover",
        description: "Assemble the delivery bundle and access-request draft for an approved revision; publication stays separate.",
        version: 1,
        content: include_str!(
            "../../../../../persona-packs/website-manager/skills/website-handover/SKILL.md"
        ),
    },
    RecipeSkill {
        name: "website-research",
        description: "Build a cited business dossier and site inventory from bounded public evidence and captured before states.",
        version: 1,
        content: include_str!(
            "../../../../../persona-packs/website-manager/skills/website-research/SKILL.md"
        ),
    },
    RecipeSkill {
        name: "website-direction-build",
        description: "Choose one evidence-grounded direction and implement it as an immutable, self-checked version.",
        version: 1,
        content: include_str!(
            "../../../../../persona-packs/website-manager/skills/website-direction-build/SKILL.md"
        ),
    },
    RecipeSkill {
        name: "website-independent-review",
        description: "Review one exact revision, rendered and functional on desktop and mobile, with evidence-backed findings and a verdict.",
        version: 1,
        content: include_str!(
            "../../../../../persona-packs/website-manager/skills/website-independent-review/SKILL.md"
        ),
    },
];

/// Strip the YAML frontmatter from an embedded persona file.
///
/// The pack format keeps identity/trigger config in frontmatter and the
/// editable prompt in the body; the desktop definition stores only the body.
pub fn persona_body(raw: &str) -> &str {
    let rest = match raw
        .strip_prefix("---\r\n")
        .or_else(|| raw.strip_prefix("---\n"))
    {
        Some(rest) => rest,
        None => return raw,
    };
    let mut offset = 0usize;
    for line in rest.split_inclusive('\n') {
        if line.trim_end_matches(['\r', '\n']) == "---" {
            return rest[offset + line.len()..].trim_start_matches(['\r', '\n']);
        }
        offset += line.len();
    }
    raw
}

/// Compose the definition prompt seeded for a recipe persona: the editable
/// persona body plus a pointer to the skill files the installer writes.
///
/// Only used when the definition is first seeded. Once stored, the definition
/// is the user's and the installer never rewrites it.
pub fn persona_system_prompt(persona: &RecipePersona) -> String {
    let body = persona_body(persona.persona_md).trim_end();
    let skills = persona
        .skill_names
        .iter()
        .map(|name| format!("- `{name}`"))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "{body}\n\n## Installed skills\n\nYour runbooks are installed in this agent's workspace under `.agents/skills/`. Read the skill below before starting its stage:\n{skills}\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persona_ids_are_valid_nip_ap_slugs() {
        for persona in PERSONAS {
            let id = persona.persona_id;
            let valid_slug = id.len() <= 64
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
            assert!(valid_slug, "{id} must be a valid lowercase slug");
            assert!(id.starts_with("website-manager-"), "{id}");
        }
    }

    #[test]
    fn every_skill_is_claimed_by_exactly_one_persona() {
        for skill in SKILLS {
            let claimants = PERSONAS
                .iter()
                .filter(|persona| persona.skill_names.contains(&skill.name))
                .count();
            assert_eq!(claimants, 1, "{} must be owned by one persona", skill.name);
        }
        for persona in PERSONAS {
            for skill in persona.skill_names {
                assert!(
                    SKILLS.iter().any(|candidate| candidate.name == *skill),
                    "{} references unknown skill {skill}",
                    persona.slug
                );
            }
        }
    }

    #[test]
    fn avery_leads_and_everyone_else_reports_to_the_team() {
        assert_eq!(PERSONAS[0].persona_id, AVERY_PERSONA_ID);
        assert_eq!(PERSONAS[0].tier, "leader");
        for worker in &PERSONAS[1..] {
            assert_eq!(worker.tier, "worker");
        }
    }

    #[test]
    fn persona_body_strips_frontmatter() {
        let body = persona_body(PERSONAS[0].persona_md);
        assert!(body.starts_with("You are Avery"), "{body}");
        assert!(!body.contains("display_name:"), "{body}");
    }

    #[test]
    fn composed_prompt_names_installed_skills() {
        let vera = PERSONAS
            .iter()
            .find(|persona| persona.slug == "vera")
            .expect("vera is in the recipe");
        let prompt = persona_system_prompt(vera);
        assert!(prompt.contains("website-independent-review"));
        assert!(prompt.contains(".agents/skills/"));
    }
}
