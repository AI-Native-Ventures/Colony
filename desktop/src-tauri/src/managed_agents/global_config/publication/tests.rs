use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

use super::*;

fn choice(model: &str) -> GlobalAgentConfig {
    GlobalAgentConfig {
        model: Some(model.into()),
        ..Default::default()
    }
}

#[test]
fn later_save_refuses_earlier_spawn_and_registration() {
    let requested = choice("old-selection");
    let saved = Mutex::new(requested.clone());
    {
        let _write = lock().unwrap();
        *saved.lock().unwrap() = choice("later-selection");
    }
    // Both commit points use this guard; no child/receipt/map operation may follow refusal.
    for _boundary in ["spawn", "register"] {
        let attempted = AtomicBool::new(false);
        let result = (|| {
            let _commit = lock_expected(&requested, || Ok(saved.lock().unwrap().clone()))?;
            attempted.store(true, Ordering::SeqCst);
            Ok::<_, String>(())
        })();
        assert!(result.is_err());
        assert!(!attempted.load(Ordering::SeqCst));
    }
    assert_eq!(*saved.lock().unwrap(), choice("later-selection"));
}

#[test]
fn final_commit_serializes_with_all_config_publications() {
    let expected = choice("selected");
    let saved = Arc::new(Mutex::new(expected.clone()));
    let commit = lock_expected(&expected, || Ok(saved.lock().unwrap().clone())).unwrap();
    let (attempted_tx, attempted_rx) = std::sync::mpsc::channel();
    let writer_saved = Arc::clone(&saved);
    let writer = std::thread::spawn(move || {
        // This is the same mutex used by every save_global_agent_config caller.
        let blocked = matches!(
            PUBLICATION.try_lock(),
            Err(std::sync::TryLockError::WouldBlock)
        );
        attempted_tx.send(blocked).unwrap();
        let _write = lock().unwrap();
        *writer_saved.lock().unwrap() = choice("later-selection");
    });
    let blocked = attempted_rx.recv().unwrap();
    let at_commit = saved.lock().unwrap().clone();
    drop(commit);
    writer.join().unwrap();
    assert!(blocked);
    assert_eq!(at_commit, expected);
    assert_eq!(*saved.lock().unwrap(), choice("later-selection"));
}

#[test]
fn failed_read_cannot_accept_a_matching_looking_config() {
    let result = lock_expected(&choice("selected"), || Err("unreadable config".into()));
    assert!(result.is_err());
}
