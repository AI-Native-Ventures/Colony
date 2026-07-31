// site/src/sections/Download.tsx
// Download URL: matches GITHUB_RELEASES_URL in
// desktop/src/features/settings/hooks/use-updater.ts, the URL the desktop
// app's own in-app updater points at when it falls back to a manual
// download. Until an owned DMG URL is live, point at the same place.
const RELEASES_URL = "https://github.com/block/buzz/releases/latest";

export function Download() {
  return (
    <section
      id="download"
      className="bg-zinc-950 px-6 py-24 text-center sm:py-32"
    >
      <div className="mx-auto max-w-2xl">
        <h2 className="text-3xl font-semibold text-zinc-50 sm:text-4xl">
          Download Colony for macOS
        </h2>
        <p className="mt-4 text-base leading-relaxed text-zinc-400 sm:text-lg">
          Colony runs as a native desktop app. Bring your own AI provider and
          start building with agents today.
        </p>
        <a
          href={RELEASES_URL}
          className="mt-8 inline-flex items-center justify-center rounded-full bg-colony-violet px-8 py-3 text-base font-medium text-zinc-950 transition hover:opacity-90"
        >
          Download Colony for macOS
        </a>
        <p className="mt-3 text-sm text-zinc-500">Apple Silicon macOS</p>
      </div>
    </section>
  );
}
