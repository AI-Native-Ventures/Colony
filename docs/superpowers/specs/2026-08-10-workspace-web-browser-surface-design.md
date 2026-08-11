# Workspace Web Browser Surface Design

## Status

Approved by the owner on 2026-08-10 after review of the first packaged Web-tab screenshot.

## Product bar

The Web tab must read as a browser, not a CDP debugger. Its normal surface has a compact toolbar with Back, Forward, Reload, a single URL field, connection status, and an overflow control. DevTools endpoint and target ID remain available only inside an advanced connection disclosure.

The live page consumes every pixel below the toolbar. The frontend observes the available page surface and sends bounded dimensions to the native session. The Tauri CDP host applies those dimensions with `Emulation.setDeviceMetricsOverride`, so subsequent screencast frames match the panel instead of being centered at a fixed headless-browser size. The image remains undistorted and fills the surface.

## Boundaries

- The generic workspace shell does not branch on `web`.
- The Web kind owns its toolbar, advanced connection controls, sizing, and input mapping.
- The native Web manager owns CDP history/reload/viewport commands.
- Endpoint and target ID remain in the tab payload, but never dominate the normal browser UI.
- The feature remains default-off.

## Interaction

- Enter in the URL field launches the session when disconnected and navigates when connected.
- Back and Forward use the page's CDP navigation history.
- Reload uses `Page.reload`.
- Advanced connection controls are collapsed by default.
- Resize updates are debounced by animation frame, integer-clamped, and ignored while disconnected.

## Proof

- A focused frontend regression observes browser chrome and native resize/navigation commands.
- Focused Rust tests cover viewport validation and command construction.
- The packaged Tauri flow proves a real screencast fills the page surface, accepts pointer and keyboard input, reaches the remote PASS state, and reaps owned Chromium on tab close, community switch, and app quit.
- The final screenshot is inspected visually. Broad local CI remains intentionally unrun.
