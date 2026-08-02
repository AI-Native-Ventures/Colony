// site/src/sections/Download.tsx
// One-click download. Every release publishes the macOS dmg under the
// stable asset name `Colony_aarch64.dmg` alongside the versioned one, so
// this URL always serves the latest build without a site redeploy per
// release. The releases page stays available as the secondary link.
const DOWNLOAD_URL =
  "https://github.com/AI-Native-Ventures/colony-releases/releases/latest/download/Colony_aarch64.dmg";
const RELEASES_URL =
  "https://github.com/AI-Native-Ventures/colony-releases/releases";

export function Download() {
  return (
    <section
      id="download"
      className="bg-colony-canvas px-6 py-10 text-center sm:py-14"
    >
      <div className="mx-auto max-w-2xl">
        <h2 className="text-3xl font-semibold text-colony-ink sm:text-4xl">
          Download Colony for macOS
        </h2>
        <p className="mt-4 text-base leading-relaxed text-colony-ink/70 sm:text-lg">
          Colony runs as a native desktop app. Bring your own AI provider and
          start building with agents today.
        </p>
        <a
          href={DOWNLOAD_URL}
          className="mt-8 inline-flex items-center justify-center rounded-full bg-colony-ink px-8 py-3 text-base font-medium text-colony-canvas transition hover:opacity-90"
        >
          Download Colony for macOS
        </a>
        <p className="mt-3 text-sm text-colony-ink/60">
          Apple Silicon macOS ·{" "}
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
            <p>
              Colony isn&apos;t notarized by Apple yet, so macOS asks for
              confirmation the first time you open it.
            </p>
            <ol className="mt-4 list-decimal space-y-2 pl-5">
              <li>Open the DMG and drag Colony to Applications.</li>
              <li>
                On first launch, macOS will say it can&apos;t verify the app is
                free of malware. Dismiss the dialog.
              </li>
              <li>
                Open System Settings, go to Privacy &amp; Security, scroll to
                the Security section near the bottom, and click{" "}
                <span className="text-colony-ink">Open Anyway</span> next to
                Colony.
              </li>
              <li>
                Click <span className="text-colony-ink">Open</span> to confirm.
              </li>
            </ol>
          </div>
        </details>
      </div>
    </section>
  );
}
