use super::*;

const PUBKEY: &str = "owner-a";
const CODE: &str = "01234-56789-ABCDE-FGHJK";

fn prepared() -> (Option<String>, PendingSignup) {
    prepare(None, PUBKEY, "person@example.test", Some(CODE)).unwrap()
}

fn registered() -> (Option<String>, PendingSignup) {
    let (stored, record) = prepared();
    mark_registered(stored.as_deref(), PUBKEY, &record.attempt_id).unwrap()
}

#[test]
fn uncertain_retry_and_relaunch_reuse_exact_code_and_attempt() {
    let (stored, first) = prepared();
    let (retried, again) = prepare(
        stored.as_deref(),
        PUBKEY,
        " PERSON@EXAMPLE.TEST ",
        Some("ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ"),
    )
    .unwrap();
    assert!(first == again);
    assert!(stored == retried);
    assert!(load(retried.as_deref(), PUBKEY).unwrap() == Some(first));
}

#[test]
fn pending_email_and_identity_cannot_be_replaced() {
    let (stored, _) = prepared();
    assert!(prepare(stored.as_deref(), PUBKEY, "another@example.test", None).is_err());
    assert!(load(stored.as_deref(), "owner-b").is_err());
    assert!(prepare(stored.as_deref(), "owner-b", "person@example.test", None).is_err());
}

#[test]
fn missing_and_corrupt_records_never_fabricate_a_recovery() {
    assert!(load(None, PUBKEY).unwrap().is_none());
    assert!(load(Some("{}"), PUBKEY).is_err());
    assert!(registered_attempt(None, PUBKEY, "missing-attempt").is_err());
    let (stored, record) = prepared();
    let mut invalid = record;
    invalid.recovery_code.clear();
    assert!(load(encode(&invalid).unwrap().as_deref(), PUBKEY).is_err());
    assert!(mark_registered(stored.as_deref(), PUBKEY, "wrong-attempt").is_err());
}

#[test]
fn registration_is_guarded_idempotent_and_preserves_secret() {
    let (stored, before) = prepared();
    assert!(registered_attempt(stored.as_deref(), PUBKEY, &before.attempt_id).is_err());
    let (marked, after) = mark_registered(stored.as_deref(), PUBKEY, &before.attempt_id).unwrap();
    assert!(after.phase == SignupPhase::Registered);
    assert!(after.recovery_code == before.recovery_code);
    assert!(after.attempt_id == before.attempt_id);
    let (marked_again, again) =
        mark_registered(marked.as_deref(), PUBKEY, &before.attempt_id).unwrap();
    assert!(marked == marked_again);
    assert!(after == again);
    assert!(registered_attempt(marked.as_deref(), PUBKEY, "wrong-attempt").is_err());
}

#[test]
fn discarding_exact_prepared_attempt_allows_a_different_email() {
    let (stored, record) = prepared();
    let (discarded, ()) = discard_prepared(stored.as_deref(), PUBKEY, &record.attempt_id).unwrap();
    assert!(discarded.is_none());
    let (_, next) = prepare(discarded.as_deref(), PUBKEY, "another@example.test", None).unwrap();
    assert_eq!(next.email, "another@example.test");
    assert!(next.attempt_id != record.attempt_id);
    assert!(next.phase == SignupPhase::Prepared);
}

#[test]
fn discard_rejects_wrong_identity_attempt_and_registered_recovery() {
    let (stored, record) = prepared();
    for (pubkey, attempt_id) in [
        ("owner-b", record.attempt_id.as_str()),
        (PUBKEY, "wrong-attempt"),
    ] {
        assert!(discard_prepared(stored.as_deref(), pubkey, attempt_id).is_err());
        assert!(load(stored.as_deref(), PUBKEY).unwrap() == Some(record.clone()));
    }
    assert!(discard_prepared(None, PUBKEY, &record.attempt_id).is_err());
    let (confirmed, registered) =
        mark_registered(stored.as_deref(), PUBKEY, &record.attempt_id).unwrap();
    assert!(discard_prepared(confirmed.as_deref(), PUBKEY, &record.attempt_id).is_err());
    assert!(load(confirmed.as_deref(), PUBKEY).unwrap() == Some(registered));
    // A rejected discard leaves the ordinary uncertain retry policy intact.
    assert!(prepare(stored.as_deref(), PUBKEY, "another@example.test", None).is_err());
}

#[test]
fn native_generation_and_supplied_code_validation() {
    let (_, first) = prepare(None, PUBKEY, "person@example.test", None).unwrap();
    let (_, second) = prepare(None, PUBKEY, "person@example.test", None).unwrap();
    assert!(validate_code(&first.recovery_code).is_ok());
    assert!(first.recovery_code != second.recovery_code);
    assert!(first.attempt_id != second.attempt_id);
    for invalid in [
        "",
        "hello",
        "OOOOO-OOOOO-OOOOO-OOOOO",
        "01234-56789-ABCDE-FGHJK\n",
    ] {
        assert!(prepare(None, PUBKEY, "person@example.test", Some(invalid)).is_err());
    }
    assert!(prepare(None, PUBKEY, " ", None).is_err());
}

#[test]
fn serialised_checkpoint_has_only_the_supported_contract() {
    let (stored, _) = prepared();
    let record: serde_json::Value = serde_json::from_str(stored.as_deref().unwrap()).unwrap();
    assert!(record.get("attemptId").is_some());
    assert!(record.get("recoveryCode").is_some());
    assert!(record.get("phase").is_some_and(|value| value == "prepared"));
    assert_eq!(record.as_object().unwrap().len(), 5);
    assert!(record.get("password").is_none());
}

#[test]
fn export_is_verified_owner_only_and_does_not_overwrite() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("recovery.txt");
    let (_, record) = registered();
    write_recovery_file(&path, &record).unwrap();
    let saved = std::fs::read_to_string(&path).unwrap();
    assert!(saved.contains(&record.recovery_code));
    assert!(!saved.contains(&record.email));
    assert!(!saved.contains(&record.pubkey));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    assert!(write_recovery_file(&path, &record).is_err());
    assert!(std::fs::read_to_string(&path).unwrap() == saved);
}

#[test]
fn export_rejects_invalid_or_unconfirmed_records_and_write_failure() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("recovery.txt");
    let (_, mut record) = prepared();
    assert!(write_recovery_file(&path, &record).is_err());
    assert!(!path.exists());
    record.phase = SignupPhase::Registered;
    assert!(write_recovery_file(&temp.path().join("missing/secret.txt"), &record).is_err());
    record.recovery_code.clear();
    assert!(write_recovery_file(&path, &record).is_err());
    assert!(!path.exists());
}

#[cfg(unix)]
#[test]
fn export_does_not_follow_a_selected_symlink() {
    let temp = tempfile::tempdir().unwrap();
    let original = temp.path().join("existing.txt");
    let selected = temp.path().join("recovery.txt");
    std::fs::write(&original, "existing data").unwrap();
    std::os::unix::fs::symlink(&original, &selected).unwrap();
    let (_, record) = registered();
    assert!(write_recovery_file(&selected, &record).is_err());
    assert_eq!(std::fs::read_to_string(original).unwrap(), "existing data");
}
