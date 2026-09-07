// A separate executable prevents ordinary Tauri builds from replacing a running
// Electron helper with a binary that lacks the private transport feature.
fn main() {
    if std::env::var("COLONY_ELECTRON_HOST").as_deref() != Ok("1") {
        eprintln!("colony-native-host must be launched by the Electron parent");
        std::process::exit(1);
    }
    #[cfg(target_os = "linux")]
    if let Err(diagnostic) = buzz_lib::webkit_rendering::apply() {
        eprintln!("colony-native-host: {diagnostic}");
        std::process::exit(1);
    }
    buzz_lib::run();
}
