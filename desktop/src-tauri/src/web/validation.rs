use crate::web::{WebKeyInput, WebMouseInput, WebWheelInput};
use url::Url;

const MAX_COMMAND_TEXT: usize = 64 * 1024;
const MAX_COORDINATE: f64 = 100_000.0;
const MIN_VIEWPORT: u32 = 240;
const MAX_VIEWPORT: u32 = 4_096;
const MIN_DEVICE_SCALE_FACTOR: f64 = 1.0;
const MAX_DEVICE_SCALE_FACTOR: f64 = 2.0;

pub(crate) fn normalize_url(url: &str) -> Result<String, String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("web URL must not be empty".to_string());
    }
    if url.len() > 8 * 1024 {
        return Err("web URL is too long".to_string());
    }
    if url == "about:blank" {
        return Ok(url.to_string());
    }
    if url.chars().any(|character| character.is_ascii_control()) {
        return Err("web URL contains unsupported characters".to_string());
    }
    let parsed = Url::parse(url).map_err(|_| "web URL is invalid".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("web URL scheme is not allowed".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("web URL credentials are not allowed".to_string());
    }
    Ok(url.to_string())
}

pub(crate) fn validate_mouse(input: &WebMouseInput) -> Result<(), String> {
    if !matches!(
        input.event_type.as_str(),
        "mouseMoved" | "mousePressed" | "mouseReleased"
    ) {
        return Err("unsupported web mouse event".to_string());
    }
    validate_coordinate(input.x)?;
    validate_coordinate(input.y)?;
    if let Some(button) = input.button.as_deref() {
        if !matches!(
            button,
            "none" | "left" | "middle" | "right" | "back" | "forward"
        ) {
            return Err("unsupported web mouse button".to_string());
        }
    }
    Ok(())
}

pub(crate) fn validate_wheel(input: &WebWheelInput) -> Result<(), String> {
    validate_coordinate(input.x)?;
    validate_coordinate(input.y)?;
    if !input.delta_x.is_finite() || !input.delta_y.is_finite() {
        return Err("web wheel deltas must be finite".to_string());
    }
    Ok(())
}

pub(crate) fn validate_key(input: &WebKeyInput) -> Result<(), String> {
    if !matches!(input.event_type.as_str(), "keyDown" | "keyUp") {
        return Err("unsupported web key event".to_string());
    }
    if input.key.is_empty() || input.key.len() > 256 {
        return Err("web key must be present and short".to_string());
    }
    if let Some(text) = input.text.as_deref() {
        validate_text(text)?;
    }
    Ok(())
}

pub(crate) fn validate_text(text: &str) -> Result<(), String> {
    if text.len() > MAX_COMMAND_TEXT {
        return Err("web input text is too long".to_string());
    }
    Ok(())
}

pub(crate) fn validate_viewport(width: u32, height: u32) -> Result<(), String> {
    if !(MIN_VIEWPORT..=MAX_VIEWPORT).contains(&width)
        || !(MIN_VIEWPORT..=MAX_VIEWPORT).contains(&height)
    {
        return Err("web viewport dimensions are outside the supported range".to_string());
    }
    Ok(())
}

pub(crate) fn validate_device_scale_factor(value: f64) -> Result<(), String> {
    if !value.is_finite() || !(MIN_DEVICE_SCALE_FACTOR..=MAX_DEVICE_SCALE_FACTOR).contains(&value) {
        return Err("web device scale factor is outside the supported range".to_string());
    }
    Ok(())
}

fn validate_coordinate(value: f64) -> Result<(), String> {
    if !value.is_finite() || value.abs() > MAX_COORDINATE {
        return Err("web input coordinate is outside the supported range".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::normalize_url;

    #[test]
    fn web_url_normalization_keeps_safe_http_urls() {
        assert_eq!(
            normalize_url(" https://example.com/path?q=1#result ").unwrap(),
            "https://example.com/path?q=1#result"
        );
    }

    #[test]
    fn web_url_normalization_rejects_hostile_navigation_payloads() {
        for hostile in [
            "file:///Users/person/private.txt",
            "javascript:alert(document.cookie)",
            "data:text/html,<script>alert(1)</script>",
            "https://user:secret@example.com/private",
            "http://user@example.com/private",
            "https://example.com/\nheader: value",
        ] {
            assert!(
                normalize_url(hostile).is_err(),
                "hostile URL unexpectedly passed: {hostile}"
            );
        }
    }
}
