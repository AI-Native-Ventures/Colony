// site/src/sections/Download.tsx
// One-click download. Every release publishes stable, unversioned asset
// names alongside the versioned ones — `Colony_aarch64.dmg` for macOS and
// `Colony_x86_64-setup_unsigned.exe` for Windows — so these URLs always
// serve the latest build without a site redeploy per release. The primary
// button follows the visitor's OS; the toggle overrides it. The releases
// page stays available as the secondary link.
import { useState } from "react";

const MACOS_URL =
  "https://github.com/AI-Native-Ventures/colony-releases/releases/latest/download/Colony_aarch64.dmg";
const WINDOWS_URL =
  "https://github.com/AI-Native-Ventures/colony-releases/releases/latest/download/Colony_x86_64-setup_unsigned.exe";
const RELEASES_URL =
  "https://github.com/AI-Native-Ventures/colony-releases/releases";

type Platform = "macos" | "windows";

const PLATFORM_LABEL: Record<Platform, string> = {
  macos: "macOS",
  windows: "Windows",
};

function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  const uaData = (
    navigator as Navigator & {
      userAgentData?: { platform?: string };
    }
  ).userAgentData;
  const platform = uaData?.platform ?? navigator.platform ?? "";
  if (/mac|iphone|ipad/i.test(platform) || /mac os/i.test(ua)) return "macos";
  if (/win/i.test(platform) || /windows/i.test(ua)) return "windows";
  // Unknown platform (Linux, ChromeOS, …): default to the macOS build, the
  // same default the site had before Windows builds existed.
  return "macos";
}

export function Download() {
  const [platform, setPlatform] = useState<Platform>(detectPlatform);

  return (
    <section
      id="download"
      className="bg-colony-canvas px-6 py-10 text-center sm:py-14"
    >
      <div className="mx-auto max-w-2xl">
        <h2 className="text-3xl font-semibold text-colony-ink sm:text-4xl">
          Download Colony for {PLATFORM_LABEL[platform]}
        </h2>
        <p className="mt-4 text-base leading-relaxed text-colony-ink/70 sm:text-lg">
          Colony runs as a native desktop app. Bring your own AI provider and
          start building with agents today.
        </p>

        <fieldset className="mt-8 inline-flex rounded-full border border-colony-ink/15 bg-colony-ink/5 p-1">
          <legend className="sr-only">Choose your platform</legend>
          {(Object.keys(PLATFORM_LABEL) as Platform[]).map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={platform === p}
              onClick={() => setPlatform(p)}
              className={`rounded-full px-5 py-1.5 text-sm font-medium transition ${
                platform === p
                  ? "bg-colony-ink text-colony-canvas"
                  : "text-colony-ink/60 hover:text-colony-ink"
              }`}
            >
              {PLATFORM_LABEL[p]}
            </button>
          ))}
        </fieldset>

        <a
          href={platform === "macos" ? MACOS_URL : WINDOWS_URL}
          className="mt-4 inline-flex items-center justify-center rounded-full bg-colony-ink px-8 py-3 text-base font-medium text-colony-canvas transition hover:opacity-90"
        >
          Download for {PLATFORM_LABEL[platform]}
        </a>
        <p className="mt-3 text-sm text-colony-ink/60">
          {platform === "macos"
            ? "Apple Silicon macOS"
            : "Windows 10 and 11 · x64"}{" "}
          ·{" "}
          <a
            href={RELEASES_URL}
            className="underline underline-offset-4 transition hover:text-colony-ink"
          >
            release notes
          </a>
        </p>

        <details className="mx-auto mt-8 max-w-md text-left">
          <summary className="cursor-pointer text-center text-sm text-colony-ink/60 underline underline-offset-4 transition hover:text-colony-ink">
            First time opening Colony? Here&apos;s what to expect.
          </summary>
          <div className="mt-4 rounded-2xl border border-colony-ink/10 bg-colony-ink/5 p-6 text-sm leading-relaxed text-colony-ink/70">
            {platform === "macos" ? (
              <>
                <p>
                  Colony isn&apos;t notarized by Apple yet, so macOS asks for
                  confirmation the first time you open it.
                </p>
                <ol className="mt-4 list-decimal space-y-2 pl-5">
                  <li>Open the DMG and drag Colony to Applications.</li>
                  <li>
                    On first launch, macOS will say it can&apos;t verify the app
                    is free of malware. Dismiss the dialog.
                  </li>
                  <li>
                    Open System Settings, go to Privacy &amp; Security, scroll
                    to the Security section near the bottom, and click{" "}
                    <span className="text-colony-ink">Open Anyway</span> next to
                    Colony.
                  </li>
                  <li>
                    Click <span className="text-colony-ink">Open</span> to
                    confirm.
                  </li>
                </ol>
              </>
            ) : (
              <>
                <p>
                  Colony isn&apos;t code-signed yet, so Windows shows a
                  SmartScreen warning the first time you run the installer.
                </p>
                <ol className="mt-4 list-decimal space-y-2 pl-5">
                  <li>Download and run the installer.</li>
                  <li>
                    If SmartScreen says it blocked the app, click{" "}
                    <span className="text-colony-ink">More info</span>.
                  </li>
                  <li>
                    Click <span className="text-colony-ink">Run anyway</span>.
                  </li>
                  <li>Colony installs; launch it from the Start menu.</li>
                </ol>
              </>
            )}
          </div>
        </details>
      </div>
    </section>
  );
}
