import path from "node:path";

/** Conventional profile roots. Call only from the local privileged process. */
export function browserLocations({ platform, homeDir, env = {} }) {
  const p = platform === "win32" ? path.win32 : path.posix;
  if (!p.isAbsolute(homeDir))
    throw new Error("An absolute home directory is required");
  const root = (id, name, relative, family = "chromium") => ({
    id,
    name,
    family,
    directory: p.join(homeDir, ...relative),
  });
  if (platform === "darwin") {
    const support = ["Library", "Application Support"];
    return [
      root("chrome", "Google Chrome", [...support, "Google", "Chrome"]),
      root("edge", "Microsoft Edge", [...support, "Microsoft Edge"]),
      root("brave", "Brave", [...support, "BraveSoftware", "Brave-Browser"]),
      root("chromium", "Chromium", [...support, "Chromium"]),
      root("arc", "Arc", [...support, "Arc", "User Data"]),
      root("dia", "Dia", [...support, "Dia", "User Data"]),
      root(
        "firefox",
        "Firefox",
        [...support, "Firefox", "Profiles"],
        "firefox",
      ),
      root("safari", "Safari", ["Library", "Cookies"], "safari"),
      root(
        "safari-container",
        "Safari",
        [
          "Library",
          "Containers",
          "com.apple.Safari",
          "Data",
          "Library",
          "Cookies",
        ],
        "safari",
      ),
    ];
  }
  if (platform === "win32") {
    const local = p.isAbsolute(env.LOCALAPPDATA || "")
      ? env.LOCALAPPDATA
      : p.join(homeDir, "AppData", "Local");
    const roaming = p.isAbsolute(env.APPDATA || "")
      ? env.APPDATA
      : p.join(homeDir, "AppData", "Roaming");
    const win = (id, name, parts, family = "chromium", parent = local) => ({
      id,
      name,
      family,
      directory: p.join(parent, ...parts),
    });
    return [
      win("chrome", "Google Chrome", ["Google", "Chrome", "User Data"]),
      win("edge", "Microsoft Edge", ["Microsoft", "Edge", "User Data"]),
      win("brave", "Brave", ["BraveSoftware", "Brave-Browser", "User Data"]),
      win("chromium", "Chromium", ["Chromium", "User Data"]),
      win(
        "firefox",
        "Firefox",
        ["Mozilla", "Firefox", "Profiles"],
        "firefox",
        roaming,
      ),
    ];
  }
  if (platform === "linux") {
    const config = p.isAbsolute(env.XDG_CONFIG_HOME || "")
      ? env.XDG_CONFIG_HOME
      : p.join(homeDir, ".config");
    return [
      ...[
        ["chrome", "Google Chrome", "google-chrome"],
        ["edge", "Microsoft Edge", "microsoft-edge"],
        ["brave", "Brave", "BraveSoftware/Brave-Browser"],
        ["chromium", "Chromium", "chromium"],
      ].map(([id, name, suffix]) => ({
        id,
        name,
        family: "chromium",
        directory: p.join(config, suffix),
      })),
      root("firefox", "Firefox", [".mozilla", "firefox"], "firefox"),
    ];
  }
  return [];
}
