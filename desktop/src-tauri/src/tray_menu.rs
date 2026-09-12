//! Native system-tray menu for the desktop app.
//!
//! The webview owns the live agent-turn state. It sends the small display
//! projection here so the native menu can remain useful while Buzz is hidden.

// Mouse back/forward (X1/X2 buttons and swipe) is also macOS-only native I/O;
// group it here so both platform-layer init paths share one call site in lib.rs.
#[path = "mouse_nav.rs"]
pub(crate) mod mouse_nav;

use std::{
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

#[cfg(target_os = "macos")]
use objc2::MainThreadMarker;
#[cfg(target_os = "macos")]
use objc2_foundation::{NSProcessInfo, NSString};
use serde::{Deserialize, Serialize};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{TrayIcon, TrayIconBuilder},
    AppHandle, Emitter, Manager, Runtime,
};

const TRAY_ID: &str = "buzz-tray";
const OPEN_BUZZ_ID: &str = "tray-open-buzz";
const NEW_CHANNEL_ID: &str = "tray-new-channel";
const QUIT_ID: &str = "tray-quit";
const OPEN_CHANNEL_PREFIX: &str = "tray-open-channel:";
const OPEN_CHANNEL_ACTIVITY_SEPARATOR: char = '|';
#[cfg(target_os = "macos")]
const TRAY_MENU_MINIMUM_WIDTH: f64 = 320.0;

static PREVIEW_STARTED_AT: OnceLock<Instant> = OnceLock::new();

/// A local-only menu preview for demonstrating the working-agent section
/// without connecting to a relay. It is deliberately unavailable in release
/// builds and must be explicitly enabled when launching the debug app.
fn preview_activities() -> Option<Vec<TrayAgentActivity>> {
    if !cfg!(debug_assertions) || std::env::var("BUZZ_TRAY_MENU_DEMO").ok().as_deref() != Some("1")
    {
        return None;
    }

    let preview_elapsed = PREVIEW_STARTED_AT.get_or_init(Instant::now).elapsed();

    Some(vec![
        TrayAgentActivity {
            activity_id: "tray-preview-planning-scout".into(),
            agent_name: "Scout".into(),
            channel_id: "tray-preview-planning".into(),
            channel_name: "planning".into(),
            elapsed: format_elapsed(Duration::from_secs(192) + preview_elapsed),
        },
        TrayAgentActivity {
            activity_id: "tray-preview-planning-builder".into(),
            agent_name: "Builder".into(),
            channel_id: "tray-preview-planning".into(),
            channel_name: "planning".into(),
            elapsed: format_elapsed(Duration::from_secs(68) + preview_elapsed),
        },
        TrayAgentActivity {
            activity_id: "tray-preview-mobile-reviewer".into(),
            agent_name: "Reviewer".into(),
            channel_id: "tray-preview-mobile".into(),
            channel_name: "mobile".into(),
            elapsed: format_elapsed(Duration::from_secs(31) + preview_elapsed),
        },
    ])
}

fn preview_recent_activities() -> Option<Vec<TrayAgentActivity>> {
    if !cfg!(debug_assertions) || std::env::var("BUZZ_TRAY_MENU_DEMO").ok().as_deref() != Some("1")
    {
        return None;
    }

    Some(vec![TrayAgentActivity {
        activity_id: "recent:tray-preview-design-architect".into(),
        agent_name: "Architect".into(),
        channel_id: "tray-preview-design".into(),
        channel_name: "design".into(),
        elapsed: "4m 25s".into(),
    }])
}

fn format_elapsed(elapsed: Duration) -> String {
    let total_seconds = elapsed.as_secs();
    if total_seconds < 60 {
        return format!("{total_seconds}s");
    }

    let seconds = total_seconds % 60;
    let total_minutes = total_seconds / 60;
    if total_minutes < 60 {
        return format!("{total_minutes}m {seconds}s");
    }

    let minutes = total_minutes % 60;
    let hours = total_minutes / 60;
    format!("{hours}h {minutes}m {seconds}s")
}

/// Bounding box of the ant in `desktop/public/colony.svg`, in the coordinates
/// of that file's inner `translate(73 180) scale(1.9)` group. The rasteriser
/// samples exactly this window, so the icon's aspect ratio is the artwork's.
const ANT_MIN_X: f32 = 24.0;
const ANT_MIN_Y: f32 = 37.0;
const ANT_MAX_X: f32 = 440.0;
const ANT_MAX_Y: f32 = 313.0;
/// Half of the artwork's `stroke-width="26"`.
const ANT_STROKE_RADIUS: f32 = 13.0;
/// 416 by 276 artwork units, rounded to whole pixels at the menu bar's height.
const ANT_ICON_WIDTH: u32 = 65;
const ANT_ICON_HEIGHT: u32 = 43;
const ANT_SAMPLES_PER_AXIS: u32 = 4;

/// Body: the three filled circles of the masked group.
const ANT_BODY_CIRCLES: [(f32, f32, f32); 3] = [
    (104.0, 172.0, 80.0),
    (226.0, 164.0, 52.0),
    (313.0, 148.0, 46.0),
];
/// The eye the mask punches out of the body.
const ANT_EYE: (f32, f32, f32) = (335.0, 136.0, 11.0);
/// Legs: round-capped straight strokes.
const ANT_LEGS: [(f32, f32, f32, f32); 6] = [
    (202.0, 203.0, 136.0, 292.0),
    (220.0, 210.0, 196.0, 298.0),
    (235.0, 209.0, 246.0, 300.0),
    (247.0, 205.0, 294.0, 294.0),
    (257.0, 198.0, 336.0, 282.0),
    (164.0, 215.0, 112.0, 272.0),
];
/// Antennae: round-capped quadratic strokes, as `from`, `control`, `to`.
const ANT_ANTENNAE: [((f32, f32), (f32, f32), (f32, f32)); 2] = [
    ((327.0, 114.0), (345.0, 64.0), (397.0, 50.0)),
    ((343.0, 126.0), (377.0, 86.0), (427.0, 80.0)),
];

fn circle_contains(x: f32, y: f32, center_x: f32, center_y: f32, radius: f32) -> bool {
    let delta_x = x - center_x;
    let delta_y = y - center_y;
    delta_x * delta_x + delta_y * delta_y <= radius * radius
}

/// The shape SVG paints for a `stroke-linecap="round"` straight segment.
fn segment_contains(x: f32, y: f32, from: (f32, f32), to: (f32, f32), radius: f32) -> bool {
    let delta_x = to.0 - from.0;
    let delta_y = to.1 - from.1;
    let length_squared = delta_x * delta_x + delta_y * delta_y;
    let along = if length_squared <= f32::EPSILON {
        0.0
    } else {
        (((x - from.0) * delta_x + (y - from.1) * delta_y) / length_squared).clamp(0.0, 1.0)
    };
    circle_contains(
        x,
        y,
        from.0 + along * delta_x,
        from.1 + along * delta_y,
        radius,
    )
}

/// The same, for a quadratic curve, flattened into round-capped segments.
fn quadratic_contains(
    x: f32,
    y: f32,
    from: (f32, f32),
    control: (f32, f32),
    to: (f32, f32),
    radius: f32,
) -> bool {
    const FLATTENING_STEPS: u32 = 16;

    let mut previous = from;
    for step in 1..=FLATTENING_STEPS {
        let t = step as f32 / FLATTENING_STEPS as f32;
        let inverse = 1.0 - t;
        let point = (
            inverse * inverse * from.0 + 2.0 * inverse * t * control.0 + t * t * to.0,
            inverse * inverse * from.1 + 2.0 * inverse * t * control.1 + t * t * to.1,
        );
        if segment_contains(x, y, previous, point, radius) {
            return true;
        }
        previous = point;
    }

    false
}

fn ant_contains(x: f32, y: f32) -> bool {
    // The legs and antennae are stroked in their own unmasked group, painted
    // under the body, so the eye cutout removes body fill and never stroke.
    let stroked = ANT_LEGS.iter().any(|&(from_x, from_y, to_x, to_y)| {
        segment_contains(x, y, (from_x, from_y), (to_x, to_y), ANT_STROKE_RADIUS)
    }) || ANT_ANTENNAE
        .iter()
        .any(|&(from, control, to)| quadratic_contains(x, y, from, control, to, ANT_STROKE_RADIUS));
    if stroked {
        return true;
    }

    let body = ANT_BODY_CIRCLES
        .iter()
        .any(|&(center_x, center_y, radius)| circle_contains(x, y, center_x, center_y, radius));
    body && !circle_contains(x, y, ANT_EYE.0, ANT_EYE.1, ANT_EYE.2)
}

/// Supersamples the ant silhouette into a one-byte-per-pixel coverage mask.
fn ant_alpha_mask(width: u32, height: u32) -> Vec<u8> {
    let samples = ANT_SAMPLES_PER_AXIS * ANT_SAMPLES_PER_AXIS;
    let mut alpha = vec![0u8; (width * height) as usize];

    for pixel_y in 0..height {
        for pixel_x in 0..width {
            let mut covered_samples = 0;
            for sample_y in 0..ANT_SAMPLES_PER_AXIS {
                for sample_x in 0..ANT_SAMPLES_PER_AXIS {
                    let x = ANT_MIN_X
                        + (pixel_x as f32 + (sample_x as f32 + 0.5) / ANT_SAMPLES_PER_AXIS as f32)
                            / width as f32
                            * (ANT_MAX_X - ANT_MIN_X);
                    let y = ANT_MIN_Y
                        + (pixel_y as f32 + (sample_y as f32 + 0.5) / ANT_SAMPLES_PER_AXIS as f32)
                            / height as f32
                            * (ANT_MAX_Y - ANT_MIN_Y);
                    if ant_contains(x, y) {
                        covered_samples += 1;
                    }
                }
            }

            alpha[(pixel_y * width + pixel_x) as usize] =
                (covered_samples * u8::MAX as u32 / samples) as u8;
        }
    }

    alpha
}

/// Builds the standalone Colony ant as a transparent, macOS template image.
///
/// The app icon includes a rounded square, which is useful for the Dock but
/// looks out of place beside the monochrome menu-bar icons. Keeping this
/// vector-derived mask here also lets macOS tint it correctly in light and
/// dark menu bars without a separate bitmap asset.
fn tray_ant_icon() -> Image<'static> {
    let alpha = ant_alpha_mask(ANT_ICON_WIDTH, ANT_ICON_HEIGHT);
    let mut rgba = vec![0; alpha.len() * 4];
    for (index, coverage) in alpha.iter().enumerate() {
        rgba[index * 4 + 3] = *coverage;
    }

    Image::new_owned(rgba, ANT_ICON_WIDTH, ANT_ICON_HEIGHT)
}

/// A running agent and its current channel.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayAgentActivity {
    activity_id: String,
    agent_name: String,
    channel_id: String,
    channel_name: String,
    elapsed: String,
}

struct TrayActivityMenuItem<R: Runtime> {
    activity_id: String,
    channel_id: String,
    agent_item: MenuItem<R>,
}

struct TrayActionQueue {
    community_generation: u64,
    pending_actions: Vec<TrayAction>,
}

struct TrayMenuState<R: Runtime> {
    activity_items: Mutex<Vec<TrayActivityMenuItem<R>>>,
    action_queue: Mutex<TrayActionQueue>,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum TrayAction {
    NewChannel,
    OpenChannel {
        #[serde(rename = "channelId")]
        channel_id: String,
        #[serde(rename = "communityGeneration")]
        community_generation: u64,
    },
}

pub(crate) fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if crate::electron_host::enabled() {
        return;
    }
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if let Err(error) = window.unminimize() {
        eprintln!("buzz-desktop: failed to restore main window from tray: {error}");
        return;
    }
    if let Err(error) = window.show() {
        eprintln!("buzz-desktop: failed to show main window from tray: {error}");
        return;
    }
    if let Err(error) = window.set_focus() {
        eprintln!("buzz-desktop: failed to focus main window from tray: {error}");
    }
}

fn queue_tray_action<R: Runtime>(app: &AppHandle<R>, mut action: TrayAction) {
    let state = app.state::<TrayMenuState<R>>();
    let Ok(mut queue) = state.action_queue.lock() else {
        eprintln!("buzz-desktop: tray action queue is unavailable");
        return;
    };
    if let TrayAction::OpenChannel {
        community_generation,
        ..
    } = &mut action
    {
        *community_generation = queue.community_generation;
    }
    queue.pending_actions.push(action);
    drop(queue);

    if let Err(error) = app.emit("tray-action-available", ()) {
        eprintln!("buzz-desktop: failed to notify frontend of tray action: {error}");
    }
}

fn append_separator<R: Runtime>(app: &AppHandle<R>, menu: &Menu<R>) -> tauri::Result<()> {
    menu.append(&PredefinedMenuItem::separator(app)?)
}

fn agent_item_label(activity: &TrayAgentActivity) -> String {
    let primary = format!("{} · {}", activity.agent_name, activity.elapsed);

    #[cfg(target_os = "macos")]
    {
        if supports_menu_item_subtitles() {
            primary
        } else {
            format!("{primary} — #{}", activity.channel_name)
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        format!("{primary} — #{}", activity.channel_name)
    }
}

#[cfg(target_os = "macos")]
fn supports_menu_item_subtitles() -> bool {
    static SUPPORTS_SUBTITLES: OnceLock<bool> = OnceLock::new();
    *SUPPORTS_SUBTITLES.get_or_init(|| {
        NSProcessInfo::processInfo()
            .operatingSystemVersion()
            .majorVersion
            >= 14
    })
}

fn channel_item_id(activity: &TrayAgentActivity) -> String {
    format!(
        "{OPEN_CHANNEL_PREFIX}{}{OPEN_CHANNEL_ACTIVITY_SEPARATOR}{}",
        activity.channel_id, activity.activity_id
    )
}

fn build_menu<R: Runtime>(
    app: &AppHandle<R>,
    activities: &[TrayAgentActivity],
    recent_activities: &[TrayAgentActivity],
) -> tauri::Result<(Menu<R>, Vec<TrayActivityMenuItem<R>>)> {
    let menu = Menu::new(app)?;
    let mut activity_items =
        Vec::with_capacity(activities.len().saturating_add(recent_activities.len()));

    let running = MenuItem::new(app, "Running", false, None::<&str>)?;
    menu.append(&running)?;

    if activities.is_empty() {
        let empty = MenuItem::new(app, "No agents are running", false, None::<&str>)?;
        menu.append(&empty)?;
    } else {
        append_activity_items(app, &menu, activities, &mut activity_items)?;
    }

    if !recent_activities.is_empty() {
        append_separator(app, &menu)?;
        let recent = MenuItem::new(app, "Recent", false, None::<&str>)?;
        menu.append(&recent)?;
        append_activity_items(app, &menu, recent_activities, &mut activity_items)?;
    }

    append_separator(app, &menu)?;
    menu.append(&MenuItem::with_id(
        app,
        NEW_CHANNEL_ID,
        "New Channel",
        true,
        None::<&str>,
    )?)?;
    append_separator(app, &menu)?;
    menu.append(&MenuItem::with_id(
        app,
        OPEN_BUZZ_ID,
        "Open Colony",
        true,
        None::<&str>,
    )?)?;
    append_separator(app, &menu)?;
    menu.append(&MenuItem::with_id(
        app,
        QUIT_ID,
        "Quit Colony",
        true,
        None::<&str>,
    )?)?;

    Ok((menu, activity_items))
}

fn append_activity_items<R: Runtime>(
    app: &AppHandle<R>,
    menu: &Menu<R>,
    activities: &[TrayAgentActivity],
    activity_items: &mut Vec<TrayActivityMenuItem<R>>,
) -> tauri::Result<()> {
    for activity in activities {
        let agent_item = MenuItem::with_id(
            app,
            channel_item_id(activity),
            agent_item_label(activity),
            true,
            None::<&str>,
        )?;
        menu.append(&agent_item)?;
        activity_items.push(TrayActivityMenuItem {
            activity_id: activity.activity_id.clone(),
            channel_id: activity.channel_id.clone(),
            agent_item,
        });
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn apply_activity_presentation<R: Runtime>(
    tray: &TrayIcon<R>,
    activities: &[TrayAgentActivity],
    recent_activities: &[TrayAgentActivity],
) -> Result<(), String> {
    if !supports_menu_item_subtitles() {
        return Ok(());
    }

    let subtitles = activities
        .iter()
        .chain(recent_activities)
        .map(|activity| format!("#{}", activity.channel_name))
        .collect::<Vec<_>>();
    let running_count = activities.len();
    let recent_count = recent_activities.len();

    tray.with_inner_tray_icon(move |inner| {
        let Some(status_item) = inner.ns_status_item() else {
            return;
        };
        let Some(main_thread) = MainThreadMarker::new() else {
            return;
        };
        let Some(menu) = status_item.menu(main_thread) else {
            return;
        };
        menu.setMinimumWidth(TRAY_MENU_MINIMUM_WIDTH);

        let mut item_index = 1;
        for subtitle in subtitles.iter().take(running_count) {
            if let Some(item) = menu.itemAtIndex(item_index) {
                let subtitle = NSString::from_str(subtitle);
                item.setSubtitle(Some(&subtitle));
            }
            item_index += 1;
        }

        if running_count == 0 {
            item_index += 1;
        }

        if recent_count > 0 {
            // The separator and Recent heading precede the completed rows.
            item_index += 2;
            for subtitle in subtitles.iter().skip(running_count) {
                if let Some(item) = menu.itemAtIndex(item_index) {
                    let subtitle = NSString::from_str(subtitle);
                    item.setSubtitle(Some(&subtitle));
                }
                item_index += 1;
            }
        }
    })
    .map_err(|error| error.to_string())
}

#[cfg(not(target_os = "macos"))]
fn apply_activity_presentation<R: Runtime>(
    _tray: &TrayIcon<R>,
    _activities: &[TrayAgentActivity],
    _recent_activities: &[TrayAgentActivity],
) -> Result<(), String> {
    Ok(())
}

fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        OPEN_BUZZ_ID => show_main_window(app),
        NEW_CHANNEL_ID => {
            show_main_window(app);
            queue_tray_action(app, TrayAction::NewChannel);
        }
        QUIT_ID => app.exit(0),
        _ => {
            let Some(channel_id) = id.strip_prefix(OPEN_CHANNEL_PREFIX) else {
                return;
            };
            show_main_window(app);
            let channel_id = channel_id
                .split_once(OPEN_CHANNEL_ACTIVITY_SEPARATOR)
                .map(|(channel_id, _)| channel_id)
                .unwrap_or(channel_id);
            queue_tray_action(
                app,
                TrayAction::OpenChannel {
                    channel_id: channel_id.into(),
                    community_generation: 0,
                },
            );
        }
    }
}

/// Installs the persistent Buzz tray icon with the initial empty activity menu.
pub fn init<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let preview_activities = preview_activities();
    let preview_recent_activities = preview_recent_activities();
    let activities = preview_activities.as_deref().unwrap_or(&[]);
    let recent_activities = preview_recent_activities.as_deref().unwrap_or(&[]);
    let (menu, activity_items) = build_menu(app, activities, recent_activities)?;
    app.manage(TrayMenuState {
        activity_items: Mutex::new(activity_items),
        action_queue: Mutex::new(TrayActionQueue {
            community_generation: 0,
            pending_actions: Vec::new(),
        }),
    });
    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .icon(tray_ant_icon())
        .icon_as_template(true)
        .on_menu_event(|app, event| handle_menu_event(app, event.id.as_ref()))
        .build(app)?;
    if let Err(error) = apply_activity_presentation(&tray, activities, recent_activities) {
        eprintln!("buzz-desktop: failed to apply tray menu presentation: {error}");
    }
    mouse_nav::init(app);
    Ok(())
}

/// Drains actions selected from the tray while the frontend was unavailable.
#[tauri::command]
pub fn take_tray_actions<R: Runtime>(app: AppHandle<R>) -> Result<Vec<TrayAction>, String> {
    let state = app.state::<TrayMenuState<R>>();
    let mut queue = state
        .action_queue
        .lock()
        .map_err(|_| "Colony tray action queue is unavailable".to_string())?;
    Ok(std::mem::take(&mut queue.pending_actions))
}

fn requeue_actions(queue: &mut TrayActionQueue, mut actions: Vec<TrayAction>) {
    actions.retain(|action| match action {
        TrayAction::NewChannel => true,
        TrayAction::OpenChannel {
            community_generation,
            ..
        } => *community_generation == queue.community_generation,
    });
    actions.append(&mut queue.pending_actions);
    queue.pending_actions = actions;
}

/// Restores actions that were drained as the frontend unmounted. Channel
/// actions from a previous community generation are discarded.
#[tauri::command]
pub fn requeue_tray_actions<R: Runtime>(
    app: AppHandle<R>,
    actions: Vec<TrayAction>,
) -> Result<(), String> {
    let state = app.state::<TrayMenuState<R>>();
    let mut queue = state
        .action_queue
        .lock()
        .map_err(|_| "Colony tray action queue is unavailable".to_string())?;
    requeue_actions(&mut queue, actions);
    drop(queue);
    app.emit("tray-action-available", ())
        .map_err(|error| error.to_string())
}

/// Clears community-scoped agent activity and queued channel navigation from
/// the native tray menu.
#[tauri::command]
pub fn clear_tray_agent_activity<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let state = app.state::<TrayMenuState<R>>();
    let mut queue = state
        .action_queue
        .lock()
        .map_err(|_| "Colony tray action queue is unavailable".to_string())?;
    queue.community_generation = queue.community_generation.wrapping_add(1);
    queue
        .pending_actions
        .retain(|action| matches!(action, TrayAction::NewChannel));
    drop(queue);

    update_tray_agent_activity(app, Vec::new(), Vec::new())
}

/// Replaces the native menu's activity section with the current live work.
#[tauri::command]
pub fn update_tray_agent_activity<R: Runtime>(
    app: AppHandle<R>,
    activities: Vec<TrayAgentActivity>,
    recent_activities: Vec<TrayAgentActivity>,
) -> Result<(), String> {
    let preview_activities = preview_activities();
    let preview_recent_activities = preview_recent_activities();
    let activities = preview_activities.as_deref().unwrap_or(&activities);
    let recent_activities = preview_recent_activities
        .as_deref()
        .unwrap_or(&recent_activities);
    let state = app.state::<TrayMenuState<R>>();
    let mut activity_items = state
        .activity_items
        .lock()
        .map_err(|_| "Colony tray menu state is unavailable".to_string())?;

    if activity_items.len() == activities.len().saturating_add(recent_activities.len())
        && activity_items
            .iter()
            .zip(activities.iter().chain(recent_activities))
            .all(|(item, activity)| {
                item.activity_id == activity.activity_id && item.channel_id == activity.channel_id
            })
    {
        for (item, activity) in activity_items
            .iter()
            .zip(activities.iter().chain(recent_activities))
        {
            item.agent_item
                .set_text(agent_item_label(activity))
                .map_err(|error| error.to_string())?;
        }
        let tray = app
            .tray_by_id(TRAY_ID)
            .ok_or_else(|| "Colony tray icon is not available".to_string())?;
        apply_activity_presentation(&tray, activities, recent_activities)?;
        return Ok(());
    }

    let (menu, next_activity_items) =
        build_menu(&app, activities, recent_activities).map_err(|error| error.to_string())?;
    let tray = app
        .tray_by_id(TRAY_ID)
        .ok_or_else(|| "Colony tray icon is not available".to_string())?;
    tray.set_menu(Some(menu))
        .map_err(|error| error.to_string())?;
    apply_activity_presentation(&tray, activities, recent_activities)?;
    *activity_items = next_activity_items;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        ant_alpha_mask, requeue_actions, TrayAction, TrayActionQueue, ANT_ICON_HEIGHT,
        ANT_ICON_WIDTH, ANT_MAX_X, ANT_MAX_Y, ANT_MIN_X, ANT_MIN_Y,
    };

    /// Reads the mask at a point given in the artwork's own coordinates, so the
    /// assertions below can be checked directly against `colony.svg`.
    fn alpha_at(mask: &[u8], x: f32, y: f32) -> u8 {
        let pixel_x = (((x - ANT_MIN_X) / (ANT_MAX_X - ANT_MIN_X) * ANT_ICON_WIDTH as f32) as u32)
            .min(ANT_ICON_WIDTH - 1);
        let pixel_y = (((y - ANT_MIN_Y) / (ANT_MAX_Y - ANT_MIN_Y) * ANT_ICON_HEIGHT as f32) as u32)
            .min(ANT_ICON_HEIGHT - 1);
        mask[(pixel_y * ANT_ICON_WIDTH + pixel_x) as usize]
    }

    #[test]
    fn tray_ant_icon_keeps_the_artwork_aspect_ratio() {
        let artwork = (ANT_MAX_X - ANT_MIN_X) / (ANT_MAX_Y - ANT_MIN_Y);
        let raster = ANT_ICON_WIDTH as f32 / ANT_ICON_HEIGHT as f32;

        assert!(
            (raster - artwork).abs() < 0.01,
            "raster aspect {raster} must follow the artwork's {artwork}"
        );
    }

    #[test]
    fn tray_ant_icon_mask_is_neither_blank_nor_solid() {
        let mask = ant_alpha_mask(ANT_ICON_WIDTH, ANT_ICON_HEIGHT);
        assert_eq!(mask.len(), (ANT_ICON_WIDTH * ANT_ICON_HEIGHT) as usize);

        let coverage =
            mask.iter().map(|alpha| *alpha as f32).sum::<f32>() / (mask.len() as f32 * 255.0);
        assert!(
            (0.30..0.60).contains(&coverage),
            "ant coverage {coverage} is outside the band a drawn silhouette occupies"
        );
        assert!(
            mask.iter().any(|alpha| *alpha == u8::MAX),
            "the ant must have fully opaque interior pixels"
        );
        assert!(
            mask.iter().any(|alpha| *alpha == 0),
            "the ant must leave fully transparent background pixels"
        );
    }

    #[test]
    fn tray_ant_icon_mask_follows_the_artwork_geometry() {
        let mask = ant_alpha_mask(ANT_ICON_WIDTH, ANT_ICON_HEIGHT);

        // One point per drawing primitive, so a dropped primitive fails here:
        // the three body circle centres, a leg segment's midpoint, and an
        // antenna's far endpoint (the only points the curve flattening reaches
        // exactly).
        for (label, x, y) in [
            ("abdomen circle centre", 104.0, 172.0),
            ("thorax circle centre", 226.0, 164.0),
            ("head circle centre", 313.0, 148.0),
            ("front-left leg midpoint", 169.0, 247.5),
            ("upper antenna tip", 397.0, 50.0),
        ] {
            assert_eq!(
                alpha_at(&mask, x, y),
                u8::MAX,
                "{label} at ({x}, {y}) must be opaque"
            );
        }

        // Corners of the sampled window, which the ant's convex-ish silhouette
        // never reaches, plus the gap to the right of the head below the
        // antennae.
        for (label, x, y) in [
            ("top-left of the window", 24.0, 37.0),
            ("bottom-left of the window", 60.0, 300.0),
            ("bottom-right of the window", 430.0, 300.0),
            ("gap under the lower antenna", 430.0, 140.0),
        ] {
            assert_eq!(
                alpha_at(&mask, x, y),
                0,
                "{label} at ({x}, {y}) must be transparent"
            );
        }

        // The eye. Its centre is deliberately not sampled: the lower antenna's
        // round cap is painted under the masked body and fills that pixel, so
        // the cutout only clears fully at (328, 136.5), one pixel left of it.
        assert_eq!(
            alpha_at(&mask, 328.0, 136.5),
            0,
            "the eye must be punched out of the head"
        );
        assert_eq!(
            alpha_at(&mask, 321.0, 136.5),
            u8::MAX,
            "the head must stay solid immediately beside the eye"
        );
    }

    #[test]
    fn open_channel_action_serializes_with_frontend_field_names() {
        let action = TrayAction::OpenChannel {
            channel_id: "channel-123".into(),
            community_generation: 7,
        };

        assert_eq!(
            serde_json::to_value(action).expect("tray action should serialize"),
            serde_json::json!({
                "kind": "openChannel",
                "channelId": "channel-123",
                "communityGeneration": 7,
            })
        );
    }

    #[test]
    fn stale_channel_actions_are_not_requeued_after_community_change() {
        let mut queue = TrayActionQueue {
            community_generation: 2,
            pending_actions: Vec::new(),
        };

        requeue_actions(
            &mut queue,
            vec![TrayAction::OpenChannel {
                channel_id: "old-channel".into(),
                community_generation: 1,
            }],
        );

        assert!(queue.pending_actions.is_empty());
    }

    #[test]
    fn new_channel_actions_survive_community_change() {
        let mut queue = TrayActionQueue {
            community_generation: 2,
            pending_actions: Vec::new(),
        };

        requeue_actions(&mut queue, vec![TrayAction::NewChannel]);

        assert_eq!(queue.pending_actions, vec![TrayAction::NewChannel]);
    }
}
