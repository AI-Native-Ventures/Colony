/// Forward an operating-system app link through the existing native parser.
#[tauri::command]
pub(crate) fn electron_open_deep_link(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if !super::enabled() || url.len() > 8192 {
        return Err("Invalid Electron app link".into());
    }
    let parsed = url::Url::parse(&url).map_err(|_| "Invalid app link")?;
    if parsed.scheme() != "buzz" || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Unsupported app link".into());
    }
    crate::handle_deep_link_url(&app, &url);
    Ok(())
}
