use super::*;

#[test]
fn web_url_normalization_keeps_about_blank_and_rejects_empty() {
    assert_eq!(normalize_url(" about:blank ").unwrap(), "about:blank");
    assert!(normalize_url(" ").is_err());
}

#[test]
fn input_validation_accepts_supported_events_and_rejects_bad_coordinates() {
    assert!(validate_mouse(&WebMouseInput {
        event_type: "mousePressed".into(),
        x: 20.0,
        y: 40.0,
        button: Some("left".into()),
        click_count: Some(1),
    })
    .is_ok());
    assert!(validate_mouse(&WebMouseInput {
        event_type: "mouseMoved".into(),
        x: f64::NAN,
        y: 0.0,
        button: None,
        click_count: None,
    })
    .is_err());
}

#[test]
fn key_validation_preserves_text_support() {
    assert!(validate_key(&WebKeyInput {
        event_type: "keyDown".into(),
        key: "a".into(),
        code: Some("KeyA".into()),
        text: Some("a".into()),
        modifiers: Some(0),
        windows_virtual_key_code: Some(65),
    })
    .is_ok());
    assert!(validate_key(&WebKeyInput {
        event_type: "keyPress".into(),
        key: "a".into(),
        code: None,
        text: None,
        modifiers: None,
        windows_virtual_key_code: None,
    })
    .is_err());
}

#[test]
fn viewport_validation_rejects_tiny_and_unbounded_surfaces() {
    assert!(validate_viewport(1280, 720).is_ok());
    assert!(validate_viewport(120, 720).is_err());
    assert!(validate_viewport(1280, 8_000).is_err());
}

#[test]
fn device_scale_factor_validation_rejects_out_of_range_and_non_finite() {
    assert!(validate_device_scale_factor(1.0).is_ok());
    assert!(validate_device_scale_factor(2.0).is_ok());
    assert!(validate_device_scale_factor(1.5).is_ok());
    assert!(validate_device_scale_factor(0.5).is_err());
    assert!(validate_device_scale_factor(2.5).is_err());
    assert!(validate_device_scale_factor(f64::NAN).is_err());
}

#[tokio::test]
async fn close_all_invalidates_a_deferred_start_before_late_insertion() {
    let manager = WebManager::default();
    let (token, done_sender, cancel_receiver) = manager.begin_start().unwrap();
    let cancelled = tokio::spawn(async move { cancel_receiver.await.is_ok() });

    let (drained_sessions, pending_starts) = manager.invalidate_and_drain().unwrap();
    assert!(drained_sessions.is_empty());
    assert_eq!(pending_starts.len(), 1);
    assert!(
        !manager
            .insert_if_current(token, "late-session".into(), test_session())
            .unwrap(),
        "a late host must not populate after close_all invalidates its generation"
    );
    assert!(manager.sessions.lock().unwrap().is_empty());
    assert!(cancelled.await.unwrap());

    manager.finish_start(token, done_sender);
    assert!(pending_starts[0]
        .recv_timeout(Duration::from_secs(1))
        .is_ok());
}

#[test]
fn shared_endpoint_is_none_with_no_sessions_and_reports_the_only_one() {
    let manager = WebManager::default();
    assert!(manager.shared_endpoint().is_none());

    manager
        .sessions
        .lock()
        .unwrap()
        .insert("only-session".into(), test_session());
    assert_eq!(
        manager.shared_endpoint(),
        Some(("ws://127.0.0.1:9222".into(), "target-1".into()))
    );
}

fn test_session() -> Arc<WebSession> {
    let (commands, _receiver) = mpsc::channel(1);
    let (_done_sender, done_receiver) = std::sync::mpsc::channel();
    Arc::new(WebSession {
        commands,
        stop_requested: Arc::new(AtomicBool::new(false)),
        done: Mutex::new(Some(done_receiver)),
        task: Mutex::new(None),
        shared_host: None,
        shared: shared_endpoint::SharedTabInfo {
            endpoint: "ws://127.0.0.1:9222".into(),
            target_id: "target-1".into(),
        },
    })
}
