use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

use buzz_core_pkg::company::{CommercialPurpose, CostCentreKind};
use buzz_core_pkg::company_roster::{
    BaselineRoleId, BlueprintCompany, BlueprintCostCentre, BlueprintInitiative,
    BlueprintRosterEntry, BlueprintService, BlueprintTeam, BlueprintTeamKind, CompanyBlueprint,
};

use super::*;

/// The IDs a run would address. The command derives these through `seed`,
/// which shares `persona_id_for` and `materialized_team_id` with this, so
/// there is one definition of an ID rather than two that can drift.
fn planned_persona_ids(scope: &str, blueprint: &CompanyBlueprint) -> Vec<String> {
    blueprint
        .roster
        .iter()
        .filter(|entry| entry.enabled)
        .map(|entry| persona_id_for(scope, &blueprint.company.id, entry.role_id))
        .collect()
}

fn planned_team_ids(scope: &str, blueprint: &CompanyBlueprint) -> Vec<String> {
    blueprint
        .teams
        .iter()
        .map(|team| {
            buzz_core_pkg::company_roster::materialized_team_id(
                scope,
                &blueprint.company.id,
                &team.id,
            )
        })
        .collect()
}

const OWNER: &str = "ownerpubkeyhex";
const SCOPE: &str = "relay.example";
const REQUEST: &str = "3f6c1a2e-0000-4000-8000-000000000001";

fn blueprint() -> CompanyBlueprint {
    CompanyBlueprint {
        schema: buzz_core_pkg::company_roster::BLUEPRINT_SCHEMA.to_string(),
        request_id: REQUEST.to_string(),
        company: BlueprintCompany {
            id: "horizon-labs".to_string(),
            trading_name: "Horizon Labs".to_string(),
            legal_name: None,
            website: None,
            summary: "Marketing websites".to_string(),
            business_type: "agency".to_string(),
            services: vec![BlueprintService {
                id: "web".to_string(),
                name: "Web".to_string(),
                description: "Sites".to_string(),
            }],
            customer_segments: vec!["smb".to_string()],
        },
        roster: vec![
            BlueprintRosterEntry {
                role_id: BaselineRoleId::ChiefOfStaff,
                personal_name: "Fizz".to_string(),
                enabled: true,
            },
            BlueprintRosterEntry {
                role_id: BaselineRoleId::Cto,
                personal_name: "Jason".to_string(),
                enabled: true,
            },
            BlueprintRosterEntry {
                role_id: BaselineRoleId::Cfo,
                personal_name: "Ada".to_string(),
                enabled: false,
            },
        ],
        teams: vec![BlueprintTeam {
            id: "engineering".to_string(),
            name: "Engineering".to_string(),
            description: "Builds".to_string(),
            lead_role_id: BaselineRoleId::Cto,
            member_role_ids: vec![BaselineRoleId::Cto],
            kind: BlueprintTeamKind::Baseline,
            service_id: None,
        }],
        cost_centres: vec![BlueprintCostCentre {
            id: "internal".to_string(),
            name: "Internal".to_string(),
            kind: CostCentreKind::Internal,
            service_id: None,
        }],
        readiness_gaps: vec![],
        proposed_initiatives: (1..=3)
            .map(|index| BlueprintInitiative {
                id: format!("init-{index}"),
                title: format!("Initiative {index}"),
                summary: "First".to_string(),
                owner_role_id: BaselineRoleId::ChiefOfStaff,
                cost_centre_id: "internal".to_string(),
                commercial_purpose: CommercialPurpose::Administration,
            })
            .collect(),
    }
}

fn temp_dir(label: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "colony-txn-{label}-{}",
        std::process::id() as u128 * 1_000_003 + label.len() as u128
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

/// Side effects a materialization performs, recorded so a rerun can be checked
/// for having performed them twice.
#[derive(Default)]
struct Effects {
    company_published: AtomicUsize,
    personas_created: AtomicUsize,
    teams_created: AtomicUsize,
    initiatives_published: AtomicUsize,
    instances_started: AtomicUsize,
}

/// Run the transaction, stopping right after `fail_after` completes.
///
/// This is the fault injection: the process is presumed to die at that point,
/// so nothing past it runs and no further checkpoint is written.
fn run(
    dir: &std::path::Path,
    blueprint: &CompanyBlueprint,
    effects: &Effects,
    fail_after: Option<BlueprintCheckpoint>,
) -> Result<BlueprintJournal, TransactionError> {
    let path = journal_path(dir, OWNER, SCOPE, REQUEST);
    let mut journal = begin(load_journal(&path)?, OWNER, SCOPE, REQUEST, blueprint)?;
    advance(&mut journal, &path, BlueprintCheckpoint::Validated)?;

    let stop = |reached: BlueprintCheckpoint| fail_after == Some(reached);

    if needs(&journal, BlueprintCheckpoint::CompanyPublished) {
        effects.company_published.fetch_add(1, Ordering::SeqCst);
        journal.company_event_id = Some("companyeventid".to_string());
        advance(&mut journal, &path, BlueprintCheckpoint::CompanyPublished)?;
    }
    if stop(BlueprintCheckpoint::CompanyPublished) {
        return Ok(journal);
    }

    if needs(&journal, BlueprintCheckpoint::PersonasSeeded) {
        let planned = planned_persona_ids(SCOPE, blueprint);
        for id in &planned {
            effects.personas_created.fetch_add(1, Ordering::SeqCst);
            // Fizz already exists and is mid-conversation; only new employees
            // get a managed instance started.
            if id != "builtin:fizz" {
                effects.instances_started.fetch_add(1, Ordering::SeqCst);
            }
        }
        journal.persona_ids = planned;
        advance(&mut journal, &path, BlueprintCheckpoint::PersonasSeeded)?;
    }
    if stop(BlueprintCheckpoint::PersonasSeeded) {
        return Ok(journal);
    }

    if needs(&journal, BlueprintCheckpoint::TeamsSeeded) {
        let planned = planned_team_ids(SCOPE, blueprint);
        effects
            .teams_created
            .fetch_add(planned.len(), Ordering::SeqCst);
        journal.team_ids = planned;
        advance(&mut journal, &path, BlueprintCheckpoint::TeamsSeeded)?;
    }
    if stop(BlueprintCheckpoint::TeamsSeeded) {
        return Ok(journal);
    }

    if needs(&journal, BlueprintCheckpoint::InitiativesPublished) {
        let planned = planned_initiative_ids(blueprint);
        effects
            .initiatives_published
            .fetch_add(planned.len(), Ordering::SeqCst);
        journal.initiative_ids = planned;
        advance(
            &mut journal,
            &path,
            BlueprintCheckpoint::InitiativesPublished,
        )?;
    }
    if stop(BlueprintCheckpoint::InitiativesPublished) {
        return Ok(journal);
    }

    advance(&mut journal, &path, BlueprintCheckpoint::Completed)?;
    Ok(journal)
}

/// THE test. The app can be closed between any two steps of creating a
/// company. Resuming from every one of those points must finish the job and
/// leave exactly one of everything.
#[test]
fn interrupting_after_any_checkpoint_and_rerunning_creates_exactly_one_company() {
    for (index, interrupt) in [
        BlueprintCheckpoint::CompanyPublished,
        BlueprintCheckpoint::PersonasSeeded,
        BlueprintCheckpoint::TeamsSeeded,
        BlueprintCheckpoint::InitiativesPublished,
    ]
    .into_iter()
    .enumerate()
    {
        let dir = temp_dir(&format!("interrupt{index}"));
        let blueprint = blueprint();
        let effects = Effects::default();

        run(&dir, &blueprint, &effects, Some(interrupt)).expect("interrupted run");
        let resumed = run(&dir, &blueprint, &effects, None).expect("resumed run");

        assert_eq!(resumed.checkpoint, BlueprintCheckpoint::Completed);
        assert_eq!(
            effects.company_published.load(Ordering::SeqCst),
            1,
            "interrupted at {interrupt:?}: company published more than once"
        );
        assert_eq!(
            effects.personas_created.load(Ordering::SeqCst),
            2,
            "interrupted at {interrupt:?}: personas created more than once"
        );
        assert_eq!(
            effects.teams_created.load(Ordering::SeqCst),
            1,
            "interrupted at {interrupt:?}: teams created more than once"
        );
        assert_eq!(
            effects.initiatives_published.load(Ordering::SeqCst),
            3,
            "interrupted at {interrupt:?}: initiatives published more than once"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// Running the whole thing twice from scratch, with no interruption, must also
/// be a no-op the second time.
#[test]
fn rerunning_a_completed_transaction_does_nothing() {
    let dir = temp_dir("rerun");
    let blueprint = blueprint();
    let effects = Effects::default();

    run(&dir, &blueprint, &effects, None).expect("first run");
    let second = run(&dir, &blueprint, &effects, None).expect("second run");

    assert_eq!(second.checkpoint, BlueprintCheckpoint::Completed);
    assert_eq!(effects.company_published.load(Ordering::SeqCst), 1);
    assert_eq!(effects.personas_created.load(Ordering::SeqCst), 2);
    assert_eq!(effects.teams_created.load(Ordering::SeqCst), 1);
    assert_eq!(effects.initiatives_published.load(Ordering::SeqCst), 3);
    let _ = std::fs::remove_dir_all(&dir);
}

/// An edited Blueprint resubmitted under the old request ID would apply
/// changes the owner approved for a different document.
#[test]
fn a_request_id_reused_with_different_content_is_refused() {
    let dir = temp_dir("hashmismatch");
    let effects = Effects::default();
    run(
        &dir,
        &blueprint(),
        &effects,
        Some(BlueprintCheckpoint::CompanyPublished),
    )
    .expect("first run");

    let mut edited = blueprint();
    edited.roster[1].personal_name = "Someone Else".to_string();
    assert_eq!(
        run(&dir, &edited, &effects, None).unwrap_err(),
        TransactionError::HashMismatch
    );
    // And the refusal performed no side effect beyond the interrupted run.
    assert_eq!(effects.company_published.load(Ordering::SeqCst), 1);
    let _ = std::fs::remove_dir_all(&dir);
}

/// A stale journal must not let one owner resume another's transaction.
#[test]
fn a_journal_belonging_to_another_owner_is_refused() {
    let blueprint = blueprint();
    let journal = BlueprintJournal {
        owner_pubkey: "someoneelse".to_string(),
        community_scope: SCOPE.to_string(),
        request_id: REQUEST.to_string(),
        blueprint_hash: blueprint_hash(&blueprint),
        company_id: blueprint.company.id.clone(),
        checkpoint: BlueprintCheckpoint::PersonasSeeded,
        company_event_id: None,
        persona_ids: vec![],
        team_ids: vec![],
        initiative_ids: vec![],
    };
    assert_eq!(
        begin(Some(journal), OWNER, SCOPE, REQUEST, &blueprint).unwrap_err(),
        TransactionError::HashMismatch
    );
}

/// The mechanism that has to hold even when the journal is lost: a retry
/// addresses the same relay writes because the key is derived, not generated.
#[test]
fn idempotency_keys_are_derived_from_the_request_and_step() {
    let first = step_idempotency_key(REQUEST, "company");
    let again = step_idempotency_key(REQUEST, "company");
    assert_eq!(first, again, "the same step must retry under the same key");

    assert_ne!(
        step_idempotency_key(REQUEST, "company"),
        step_idempotency_key(REQUEST, "initiative:init-1"),
        "different steps must not collide"
    );
    assert_ne!(
        step_idempotency_key(REQUEST, "company"),
        step_idempotency_key("00000000-0000-4000-8000-000000000002", "company"),
        "different approvals must not collide"
    );
    // Pinned: changing the namespace would make every in-flight retry generate
    // fresh keys and re-apply completed relay writes.
    assert_eq!(
        step_idempotency_key(REQUEST, "company").to_string(),
        "c144c660-ebd0-5bfc-b1f3-dc71572f5cbb"
    );
}

/// Two employees cannot both be `@cto`, so materialized IDs are stable
/// functions of company and role rather than anything generated per run.
#[test]
fn materialized_ids_are_stable_across_runs() {
    let blueprint = blueprint();
    assert_eq!(
        planned_persona_ids(SCOPE, &blueprint),
        planned_persona_ids(SCOPE, &blueprint)
    );
    let personas = planned_persona_ids(SCOPE, &blueprint);
    assert_eq!(personas[0], "builtin:fizz");
    assert!(personas[1].ends_with(":horizon-labs:cto"));
    assert!(planned_team_ids(SCOPE, &blueprint)[0].ends_with(":horizon-labs:engineering"));
    assert_eq!(
        planned_initiative_ids(&blueprint),
        vec![
            "horizon-labs:init-1".to_string(),
            "horizon-labs:init-2".to_string(),
            "horizon-labs:init-3".to_string(),
        ]
    );
}

/// A disabled roster entry was declined by the owner during review. It must
/// not be created anyway.
#[test]
fn a_disabled_roster_entry_is_not_materialized() {
    let blueprint = blueprint();
    assert!(
        !planned_persona_ids(SCOPE, &blueprint)
            .iter()
            .any(|id| id.ends_with(":cfo")),
        "the owner unchecked the CFO; it must not be created"
    );
}

/// Fizz is already talking to the owner. A second Chief of Staff would leave
/// the owner with two, one having no memory of the conversation.
#[test]
fn the_existing_chief_of_staff_is_reused_rather_than_duplicated() {
    assert_eq!(
        persona_id_for(SCOPE, "horizon-labs", BaselineRoleId::ChiefOfStaff),
        "builtin:fizz"
    );
    assert_eq!(
        persona_id_for(SCOPE, "horizon-labs", BaselineRoleId::Cto),
        materialized_persona_id(SCOPE, "horizon-labs", BaselineRoleId::Cto)
    );
}

/// Approving a company proposes work; it does not start it. Only employees
/// that did not already exist get an instance, and Fizz is not restarted.
#[test]
fn no_instance_is_started_for_the_existing_chief_of_staff() {
    let dir = temp_dir("instances");
    let effects = Effects::default();
    run(&dir, &blueprint(), &effects, None).expect("run");
    assert_eq!(
        effects.instances_started.load(Ordering::SeqCst),
        1,
        "only the newly created CTO gets an instance"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// Two clicks on Approve, or a click plus a retry, must join one transaction
/// rather than race.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_approvals_join_one_transaction() {
    reset_locks_for_test();
    let dir = temp_dir("concurrent");
    let effects = Arc::new(Effects::default());
    let path = journal_path(&dir, OWNER, SCOPE, REQUEST);

    let mut handles = Vec::new();
    for _ in 0..6 {
        let dir = dir.clone();
        let effects = Arc::clone(&effects);
        let lock = transaction_lock(&path);
        handles.push(tokio::spawn(async move {
            let _guard = lock.lock().await;
            run(&dir, &blueprint(), &effects, None).expect("concurrent run")
        }));
    }
    for handle in handles {
        let journal = handle.await.expect("join");
        assert_eq!(journal.checkpoint, BlueprintCheckpoint::Completed);
    }

    assert_eq!(effects.company_published.load(Ordering::SeqCst), 1);
    assert_eq!(effects.personas_created.load(Ordering::SeqCst), 2);
    assert_eq!(effects.teams_created.load(Ordering::SeqCst), 1);
    assert_eq!(effects.initiatives_published.load(Ordering::SeqCst), 3);
    let _ = std::fs::remove_dir_all(&dir);
}

/// A half-written journal reads as progress that did not happen, which is
/// worse than no journal at all.
#[test]
fn a_journal_is_never_left_half_written() {
    let dir = temp_dir("atomic");
    let path = journal_path(&dir, OWNER, SCOPE, REQUEST);
    let blueprint = blueprint();
    let journal = begin(None, OWNER, SCOPE, REQUEST, &blueprint).expect("begin");
    store_journal(&path, &journal).expect("store");

    let raw = std::fs::read_to_string(&path).expect("read");
    serde_json::from_str::<BlueprintJournal>(&raw).expect("a stored journal always parses");
    assert!(
        !dir.join(format!(
            "{}.json.tmp",
            path.file_stem().unwrap().to_string_lossy()
        ))
        .exists(),
        "the temporary file must be renamed away, not left behind"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// The journal is a file on a user's disk. A crash-recovery aid is not worth
/// a credential leak.
#[test]
fn the_journal_holds_no_secrets_and_is_owner_only() {
    let dir = temp_dir("secrets");
    let path = journal_path(&dir, OWNER, SCOPE, REQUEST);
    let blueprint = blueprint();
    let mut journal = begin(None, OWNER, SCOPE, REQUEST, &blueprint).expect("begin");
    journal.persona_ids = planned_persona_ids(SCOPE, &blueprint);
    store_journal(&path, &journal).expect("store");

    let raw = std::fs::read_to_string(&path).expect("read");
    for forbidden in ["You are the", "nsec", "systemPrompt", "apiKey", "BUZZ_"] {
        assert!(
            !raw.contains(forbidden),
            "journal must not contain `{forbidden}`"
        );
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path).expect("stat").permissions().mode();
        assert_eq!(
            mode & 0o777,
            0o600,
            "journal must be readable only by owner"
        );
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// An owner's public key should not be readable from a directory listing.
#[test]
fn the_journal_filename_does_not_leak_the_owner_key() {
    let dir = std::path::Path::new("/tmp/colony");
    let path = journal_path(dir, OWNER, SCOPE, REQUEST);
    let name = path.file_name().unwrap().to_string_lossy().to_string();
    assert!(!name.contains(OWNER));
    assert!(!name.contains(SCOPE));
    assert!(!name.contains(REQUEST));
    // Distinct keys still get distinct files.
    assert_ne!(path, journal_path(dir, "otherowner", SCOPE, REQUEST));
    assert_ne!(path, journal_path(dir, OWNER, "other.example", REQUEST));
}

/// Two equal blueprints must hash equal whatever order a client emitted their
/// keys in, or a retry from a different client would read as an edit.
#[test]
fn the_blueprint_hash_is_independent_of_key_order() {
    let blueprint = blueprint();
    let hash = blueprint_hash(&blueprint);
    let reparsed: CompanyBlueprint =
        serde_json::from_str(&serde_json::to_string(&blueprint).expect("serialize"))
            .expect("round trip");
    assert_eq!(blueprint_hash(&reparsed), hash);

    let mut changed = blueprint.clone();
    changed.company.trading_name = "Horizon Labs Ltd".to_string();
    assert_ne!(
        blueprint_hash(&changed),
        hash,
        "an edit must change the hash"
    );
}

/// The hash-mismatch guard is only as good as the canonicalisation. If two
/// different blueprints could produce the same canonical string, an edited
/// document would resume an approval it was not approved for.
///
/// Keys and string values both go through JSON quoting, so a separator inside
/// a value stays inside quotes and cannot be confused for structure. These are
/// the inputs that would break a naive `key:value` join.
#[test]
fn separators_inside_content_cannot_forge_a_matching_hash() {
    let mut a = blueprint();
    a.company.trading_name = "Horizon\",\"legalName\":\"Forged".to_string();
    let mut b = blueprint();
    b.company.trading_name = "Horizon".to_string();
    b.company.legal_name = Some("Forged".to_string());
    assert_ne!(
        blueprint_hash(&a),
        blueprint_hash(&b),
        "a value that looks like structure must not hash as structure"
    );

    for hostile in [
        "a:b",
        "a,b",
        "}{",
        "\"quoted\"",
        "back\\slash",
        "new\nline",
        "unicode \u{2028} sep",
    ] {
        let mut left = blueprint();
        left.company.summary = hostile.to_string();
        let mut right = blueprint();
        right.company.summary = format!("{hostile} ");
        assert_ne!(
            blueprint_hash(&left),
            blueprint_hash(&right),
            "`{hostile}` must hash distinctly from itself plus a space"
        );
    }
}
