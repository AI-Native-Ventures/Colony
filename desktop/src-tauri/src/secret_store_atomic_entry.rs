//! Guarded single-entry transitions using the store's existing blob lock.

use super::SecretStore;

impl SecretStore {
    /// Transform one freshly read entry under the interprocess blob lock.
    /// A failed transition leaves durable storage unchanged. Changed values
    /// are verified against the OS backend before returning the result.
    pub(crate) fn update_entry<T>(
        &self,
        key: &str,
        update: impl FnOnce(Option<&str>) -> Result<(Option<String>, T), String>,
    ) -> Result<T, String> {
        #[cfg(feature = "system-keyring")]
        {
            let mut outcome = None;
            let mut changed = false;
            let mut expected = None;
            self.mutate_blob(|map| {
                outcome = Some(
                    update(map.get(key).map(String::as_str)).map(|(next, result)| {
                        changed = map.get(key) != next.as_ref();
                        expected = next.clone();
                        match next {
                            Some(value) => {
                                map.insert(key.to_string(), value);
                            }
                            None => {
                                map.remove(key);
                            }
                        }
                        result
                    }),
                );
            })?;
            let result = outcome.ok_or("secure storage transition did not run")??;
            if changed {
                let bytes = self.read_blob_raw()?;
                let persisted: std::collections::HashMap<String, String> = match bytes {
                    Some(bytes) => serde_json::from_slice(&bytes)
                        .map_err(|_| "secure storage verification failed")?,
                    None => std::collections::HashMap::new(),
                };
                if persisted.get(key) != expected.as_ref() {
                    return Err("secure storage verification failed".into());
                }
            }
            Ok(result)
        }
        #[cfg(not(feature = "system-keyring"))]
        {
            let _ = (key, update);
            Err("system-keyring feature disabled".into())
        }
    }
}

#[cfg(all(test, not(feature = "system-keyring")))]
mod tests {
    use super::SecretStore;

    #[test]
    fn unavailable_secure_storage_never_runs_or_returns_a_pending_transition() {
        let store = SecretStore::keyring("onboarding-disabled-keyring-test");
        let called = std::cell::Cell::new(false);
        let result = store.update_entry("pending", |_| {
            called.set(true);
            Ok((Some("synthetic checkpoint".into()), ()))
        });
        assert!(result.is_err());
        assert!(!called.get());
    }
}
