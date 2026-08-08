//! Runtime macOS window vibrancy (blur-behind) toggle.
//!
//! Vibrancy applies an `NSVisualEffectView` behind the webview so the desktop
//! (and windows behind Buzz) blur through wherever the app's CSS is
//! transparent. It is a native, macOS-only effect: there is no "intensity"
//! setting at the OS level, only a set of material presets. The frontend tunes
//! perceived intensity by changing CSS surface opacity while this command
//! handles the native material.
//!
//! This is fully reversible at runtime: enabling applies the chosen material,
//! disabling clears it. On non-macOS platforms the command is a no-op so the
//! shared frontend can call it unconditionally.
//!
//! # Phase 1 note
//!
//! This is the first command converted to the `HostCtx` seam, and it was chosen
//! as the proof case because `window_vibrancy::apply_vibrancy` needs the
//! underlying `NSWindow`. Unlike everything else behind `ShellProxy`, this
//! operation is not merely *convenient* to perform shell-side — it is impossible
//! to perform anywhere else, so it is the strongest test of whether the seam can
//! express what the app actually does. The native work now lives in
//! `host::TauriShellProxy::set_window_vibrancy`; what remains here is the
//! command's argument handling.

use buzz_native::VibrancyMaterial;

use crate::host::Ctx;

/// Apply or clear macOS window vibrancy for the main window.
///
/// `material` accepts the common `NSVisualEffectMaterial` names
/// (`sidebar`, `hud-window`, `under-window-background`, `fullscreen-ui`,
/// `header-view`, `popover`, `menu`, `titlebar`). Unknown values fall back to
/// `sidebar`.
#[tauri::command]
pub fn set_window_vibrancy(
    enabled: bool,
    material: Option<String>,
    ctx: tauri::State<'_, Ctx>,
) -> Result<(), String> {
    // `enabled == false` clears, and the material is ignored in that case.
    let material = enabled.then(|| VibrancyMaterial::from_wire(material.as_deref()));

    ctx.shell()
        .set_window_vibrancy("main", material)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use buzz_native::VibrancyMaterial;

    #[test]
    fn disabling_ignores_the_material() {
        // Mirrors the command body: the old code returned before parsing the
        // material at all when `enabled` was false.
        let enabled = false;
        let material = Some("popover".to_string());
        assert_eq!(
            enabled.then(|| VibrancyMaterial::from_wire(material.as_deref())),
            None,
        );
    }

    #[test]
    fn enabling_without_a_material_uses_sidebar() {
        let enabled = true;
        let material: Option<String> = None;
        assert_eq!(
            enabled.then(|| VibrancyMaterial::from_wire(material.as_deref())),
            Some(VibrancyMaterial::Sidebar),
        );
    }

    #[test]
    fn enabling_with_an_unknown_material_uses_sidebar() {
        let enabled = true;
        let material = Some("chartreuse".to_string());
        assert_eq!(
            enabled.then(|| VibrancyMaterial::from_wire(material.as_deref())),
            Some(VibrancyMaterial::Sidebar),
        );
    }
}
