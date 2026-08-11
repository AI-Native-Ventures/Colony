use crate::web::{WebKeyInput, WebMouseInput, WebWheelInput};

const MAX_COMMAND_TEXT: usize = 64 * 1024;
const MAX_COORDINATE: f64 = 100_000.0;
const MIN_VIEWPORT: u32 = 240;
const MAX_VIEWPORT: u32 = 4_096;

pub(crate) fn normalize_url(url: &str) -> Result<String, String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("web URL must not be empty".to_string());
    }
    if url.len() > 8 * 1024 {
        return Err("web URL is too long".to_string());
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

fn validate_coordinate(value: f64) -> Result<(), String> {
    if !value.is_finite() || value.abs() > MAX_COORDINATE {
        return Err("web input coordinate is outside the supported range".to_string());
    }
    Ok(())
}
