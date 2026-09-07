import path from "node:path";

/** Resolve app-owned resources without depending on the launch directory. */
export function runtimePaths({ packaged, appPath, resourcesPath, env = {} }) {
  const devUrl = packaged ? undefined : env.COLONY_ELECTRON_DEV_URL;
  if (devUrl && new URL(devUrl).origin !== "http://127.0.0.1:1425")
    throw new Error("Unexpected development origin");
  const nativeHost = packaged
    ? path.join(resourcesPath, "native/buzz-desktop")
    : env.COLONY_NATIVE_HOST ||
      path.join(appPath, "src-tauri/target/debug/colony-native-host");
  if (!path.isAbsolute(nativeHost))
    throw new Error("COLONY_NATIVE_HOST must be an absolute path");
  return {
    appPath,
    devUrl,
    nativeHost,
    config: path.join(
      appPath,
      packaged ? "runtime-config.json" : "src-tauri/tauri.conf.json",
    ),
    name: packaged ? "Colony Electron Beta" : "Colony Electron Development",
    profile: packaged ? "colony-electron-beta" : "colony-electron-development",
  };
}
