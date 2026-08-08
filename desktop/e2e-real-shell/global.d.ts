// Global WebdriverIO types for the real-shell harness.
//
// `@wdio/globals/types` declares the Node-runner globals (browser, $, $$,
// expect) used by the specs; `@wdio/tauri-service` pulls in the native-types
// augmentation (browser.tauri.execute) and `webdriverio` supplies the core
// browser command surface ($/$$/waitUntil/getWindowRect/pause). Listing these
// here keeps the harness files type-checked without the ambient `types`
// config, which would drag app globals into the main tsconfig.
import "@wdio/globals/types";
import "@wdio/tauri-service";
import "webdriverio";
