//! The `initial-window-reveal` plugin.
//!
//! macOS applies restored window geometry asynchronously, and WebKit needs a
//! frame before the first surface is trustworthy. The plugin waits for stable
//! geometry and for React to commit the startup surface before revealing the
//! main window, so the previous app or a blank surface never flashes on launch.

use crate::electron_host;
use crate::initial_window::reveal_initial_window;
#[cfg(target_os = "macos")]
use crate::initial_window::{
    clear_initial_window_backing, set_initial_window_backing,
    wait_for_stable_initial_window_geometry, INITIAL_RENDER_READY_EVENT,
};
#[cfg(target_os = "macos")]
use tauri::{Listener, Manager};

pub(crate) fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::<R, ()>::new("initial-window-reveal")
        .on_webview_ready(|webview| {
            if webview.label() != "main" || electron_host::enabled() {
                return;
            }
            // macOS applies the restored geometry asynchronously. Wait
            // for several identical outer bounds and for React to
            // commit the startup surface before revealing it.
            let window = webview.window();

            #[cfg(target_os = "macos")]
            {
                set_initial_window_backing(&window);
                let (initial_render_tx, initial_render_rx) = tokio::sync::oneshot::channel();
                window
                    .app_handle()
                    .once(INITIAL_RENDER_READY_EVENT, move |_| {
                        let _ = initial_render_tx.send(());
                    });

                tauri::async_runtime::spawn(async move {
                    wait_for_stable_initial_window_geometry(&window).await;

                    if tokio::time::timeout(std::time::Duration::from_secs(5), initial_render_rx)
                        .await
                        .is_err()
                    {
                        eprintln!(
                            "buzz-desktop: initial render did not commit before reveal timeout"
                        );
                    }

                    reveal_initial_window(&window);
                    clear_initial_window_backing(&window).await;
                });
            }

            #[cfg(not(target_os = "macos"))]
            {
                reveal_initial_window(&window);
            }
        })
        .build()
}
