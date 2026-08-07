//! Human-shaped mouse and keyboard input.

use std::time::Duration;

use serde_json::json;

use crate::cdp::CdpClient;
use crate::contracts::BrowserError;
use crate::snapshot::Snapshot;

/// Eased mouse path with jitter; last point lands on target.
pub fn human_mouse_path(
    from_x: f64,
    from_y: f64,
    to_x: f64,
    to_y: f64,
    steps: usize,
) -> Vec<(f64, f64)> {
    let steps = steps.clamp(12, 60);
    (1..=steps)
        .map(|i| {
            let t = i as f64 / steps as f64;
            let eased = t * t * (3.0 - 2.0 * t);
            if i == 1 {
                return (from_x, from_y);
            }
            if i == steps {
                return (to_x, to_y);
            }
            let jitter = 1.5;
            (
                from_x + (to_x - from_x) * eased + (rand() * 2.0 - 1.0) * jitter,
                from_y + (to_y - from_y) * eased + (rand() * 2.0 - 1.0) * jitter,
            )
        })
        .collect()
}

fn rand() -> f64 {
    // Simple deterministic LCG for tests; not security-sensitive.
    use std::cell::Cell;
    thread_local! {
        static SEED: Cell<u64> = Cell::new(0x9E3779B97F4A7C15);
    }
    SEED.with(|s| {
        let mut x = s.get();
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        s.set(x);
        (x >> 11) as f64 / (1u64 << 53) as f64
    })
}

async fn mouse_move(client: &mut CdpClient, x: f64, y: f64) -> Result<(), BrowserError> {
    client
        .send_command(
            "Input.dispatchMouseEvent",
            json!({ "type": "mouseMoved", "x": x, "y": y, "button": "none" }),
        )
        .await?;
    Ok(())
}

/// Click a snapshot ref with a human-shaped move and trusted events.
pub async fn click_ref(
    client: &mut CdpClient,
    snapshot: &Snapshot,
    ref_id: &str,
) -> Result<(), BrowserError> {
    let target = snapshot
        .refs
        .get(ref_id)
        .ok_or_else(|| BrowserError::Input(format!("unknown ref {ref_id}")))?;
    let (mut cx, mut cy) = (target.x, target.y);
    if target.offscreen {
        let _ = client
            .evaluate(&format!(
                "document.elementFromPoint({cx},{cy})?.scrollIntoView({{\"block\":\"center\"}})"
            ))
            .await;
        if let Some((x, y)) = client.get_box_center(target.backend_node_id).await? {
            cx = x;
            cy = y;
        }
    }
    let path = human_mouse_path(40.0, 40.0, cx, cy, (cx / 25.0) as usize);
    for (x, y) in path {
        mouse_move(client, x, y).await?;
        tokio::time::sleep(Duration::from_millis(8)).await;
    }
    client
        .send_command(
            "Input.dispatchMouseEvent",
            json!({ "type": "mousePressed", "x": cx, "y": cy, "button": "left", "clickCount": 1 }),
        )
        .await?;
    tokio::time::sleep(Duration::from_millis(60)).await;
    client
        .send_command(
            "Input.dispatchMouseEvent",
            json!({ "type": "mouseReleased", "x": cx, "y": cy, "button": "left", "clickCount": 1 }),
        )
        .await?;
    Ok(())
}

/// Type text via trusted input events with per-character pacing.
pub async fn type_text(client: &mut CdpClient, text: &str) -> Result<(), BrowserError> {
    for ch in text.chars() {
        client
            .send_command("Input.insertText", json!({ "text": ch.to_string() }))
            .await?;
        tokio::time::sleep(Duration::from_millis(12)).await;
    }
    Ok(())
}

/// Press Enter (submit).
pub async fn press_enter(client: &mut CdpClient) -> Result<(), BrowserError> {
    for key_type in ["keyDown", "keyUp"] {
        client
            .send_command(
                "Input.dispatchKeyEvent",
                json!({ "type": key_type, "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13 }),
            )
            .await?;
    }
    Ok(())
}

/// Scroll the page with a mouse-wheel event.
pub async fn scroll_by(client: &mut CdpClient, delta_y: i64) -> Result<(), BrowserError> {
    client
        .send_command(
            "Input.dispatchMouseEvent",
            json!({ "type": "mouseWheel", "x": 200, "y": 200, "deltaX": 0, "deltaY": delta_y }),
        )
        .await?;
    Ok(())
}

/// Wait until a selector exists or the timeout elapses.
pub async fn wait_for_selector(
    client: &mut CdpClient,
    selector: &str,
    timeout_ms: u64,
) -> Result<(), BrowserError> {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        let found = client
            .evaluate(&format!("!!document.querySelector({selector:?})"))
            .await
            .and_then(|v| {
                v.as_bool()
                    .ok_or_else(|| BrowserError::Input("bad evaluate result".into()))
            })
            .unwrap_or(false);
        if found {
            return Ok(());
        }
        if tokio::time::Instant::now() > deadline {
            return Err(BrowserError::Input(format!(
                "wait_for timed out: {selector}"
            )));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::budget::estimate_tokens;

    #[test]
    fn mouse_path_starts_and_ends_at_targets() {
        let path = human_mouse_path(0.0, 0.0, 100.0, 100.0, 20);
        assert_eq!(path.first().unwrap().0, 0.0);
        assert_eq!(path.first().unwrap().1, 0.0);
        let last = path.last().unwrap();
        assert!((last.0 - 100.0).abs() < 3.0);
        assert!((last.1 - 100.0).abs() < 3.0);
        assert!(path.len() >= 12 && path.len() <= 60);
    }

    #[test]
    fn token_estimate_is_deterministic() {
        assert_eq!(estimate_tokens("hello world".chars().count()), 3);
        assert_eq!(estimate_tokens(0), 1);
    }

    #[test]
    fn module_loads() {}
}
