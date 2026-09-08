//! Pure checkpoint transitions and the native recovery-file writer.

use serde::{Deserialize, Serialize};

const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// Whether registration is confirmed or may still have an uncertain outcome.
#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SignupPhase {
    Prepared,
    Registered,
}

/// Pending account recovery material; stored only by the native SecretStore.
/// Deliberately does not implement `Debug` to avoid accidental secret logging.
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PendingSignup {
    pub pubkey: String,
    pub email: String,
    pub attempt_id: String,
    pub recovery_code: String,
    pub phase: SignupPhase,
}

fn normalize_email(email: &str) -> Result<String, String> {
    let email = email.trim().to_lowercase();
    if email.is_empty()
        || email.len() > 320
        || !email.contains('@')
        || email.chars().any(char::is_whitespace)
    {
        return Err("Enter a valid email address".into());
    }
    Ok(email)
}

fn validate_code(code: &str) -> Result<(), String> {
    let groups: Vec<_> = code.split('-').collect();
    if groups.len() != 4
        || groups
            .iter()
            .any(|group| group.len() != 5 || !group.bytes().all(|byte| ALPHABET.contains(&byte)))
    {
        return Err("The saved recovery code is invalid; use account sign-in to continue".into());
    }
    Ok(())
}

fn generate_code() -> Result<String, String> {
    let mut entropy = [0_u8; 20];
    getrandom::fill(&mut entropy).map_err(|_| "Could not securely generate your recovery code")?;
    let groups: Vec<String> = entropy
        .chunks(5)
        .map(|group| {
            group
                .iter()
                .map(|byte| char::from(ALPHABET[usize::from(byte & 31)]))
                .collect()
        })
        .collect();
    Ok(groups.join("-"))
}

pub(super) fn load(value: Option<&str>, pubkey: &str) -> Result<Option<PendingSignup>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let record: PendingSignup = serde_json::from_str(value).map_err(|_| {
        "Your pending signup could not be restored; use account sign-in to continue"
    })?;
    if record.pubkey != pubkey
        || uuid::Uuid::parse_str(&record.attempt_id).is_err()
        || normalize_email(&record.email)? != record.email
    {
        return Err(
            "Your pending signup does not match this identity; use account sign-in to continue"
                .into(),
        );
    }
    validate_code(&record.recovery_code)?;
    Ok(Some(record))
}

fn encode(record: &PendingSignup) -> Result<Option<String>, String> {
    serde_json::to_string(record)
        .map(Some)
        .map_err(|_| "Could not secure signup recovery".into())
}

pub(super) fn prepare(
    value: Option<&str>,
    pubkey: &str,
    email: &str,
    recovery_code: Option<&str>,
) -> Result<(Option<String>, PendingSignup), String> {
    let email = normalize_email(email)?;
    if let Some(record) = load(value, pubkey)? {
        if record.email != email {
            return Err("A signup is already pending for another email; finish recovery or use account sign-in".into());
        }
        // Never regenerate after an uncertain POST, even if the caller supplies
        // a new code. Only the persisted code may unlock the registered account.
        return Ok((value.map(str::to_string), record));
    }
    let recovery_code = match recovery_code {
        Some(code) => {
            validate_code(code)?;
            code.to_string()
        }
        None => generate_code()?,
    };
    let record = PendingSignup {
        pubkey: pubkey.to_string(),
        email,
        attempt_id: uuid::Uuid::new_v4().to_string(),
        recovery_code,
        phase: SignupPhase::Prepared,
    };
    Ok((encode(&record)?, record))
}

fn attempt(value: Option<&str>, pubkey: &str, attempt_id: &str) -> Result<PendingSignup, String> {
    let record = load(value, pubkey)?
        .ok_or("The original recovery code is unavailable; use account sign-in to continue")?;
    if record.attempt_id != attempt_id {
        return Err("Your signup attempt changed; reopen recovery to continue".into());
    }
    Ok(record)
}

pub(super) fn registered_attempt(
    value: Option<&str>,
    pubkey: &str,
    attempt_id: &str,
) -> Result<PendingSignup, String> {
    let record = attempt(value, pubkey, attempt_id)?;
    if record.phase != SignupPhase::Registered {
        return Err("Confirm your account registration before saving or finishing recovery".into());
    }
    Ok(record)
}

pub(super) fn mark_registered(
    value: Option<&str>,
    pubkey: &str,
    attempt_id: &str,
) -> Result<(Option<String>, PendingSignup), String> {
    let mut record = attempt(value, pubkey, attempt_id)?;
    record.phase = SignupPhase::Registered;
    Ok((encode(&record)?, record))
}

pub(super) fn discard_prepared(
    value: Option<&str>,
    pubkey: &str,
    attempt_id: &str,
) -> Result<(Option<String>, ()), String> {
    let record = attempt(value, pubkey, attempt_id)?;
    if record.phase != SignupPhase::Prepared {
        return Err("A registered account's recovery cannot be discarded".into());
    }
    Ok((None, ()))
}

pub(super) fn write_recovery_file(
    path: &std::path::Path,
    record: &PendingSignup,
) -> Result<(), String> {
    use std::io::Write;
    validate_code(&record.recovery_code)?;
    if record.phase != SignupPhase::Registered {
        return Err("Confirm your account registration before saving recovery".into());
    }
    let content = format!("Colony recovery code\n\n{}\n\nKeep this code somewhere private. It can recover your Colony account.\n", record.recovery_code);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            "That file already exists. Choose a new filename to keep the existing file safe"
                .to_string()
        } else {
            "Could not create your recovery file. Choose another location".to_string()
        }
    })?;
    let result = file
        .write_all(content.as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(|_| "Could not write your recovery file".to_string());
    drop(file);
    let result = result.and_then(|()| {
        let bytes = std::fs::read(path).map_err(|_| "Could not verify your recovery file")?;
        if bytes != content.as_bytes() {
            return Err("Your recovery file could not be verified".into());
        }
        Ok(())
    });
    if result.is_err() {
        // The exclusive create above ensures this is only our failed export.
        let _ = std::fs::remove_file(path);
    }
    result
}

#[cfg(test)]
#[path = "onboarding_recovery_tests.rs"]
mod tests;
