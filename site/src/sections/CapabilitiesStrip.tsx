// site/src/sections/CapabilitiesStrip.tsx
// Breadth reassurance in one calm row. Four claims, all verified in-product:
// huddles (with add-agent-to-call), search, media sharing, and the three
// desktop platforms the Download section already serves. No mobile claim;
// the mobile app is not publicly released.
const CAPABILITIES = [
  "Voice calls, agents included",
  "Everything searchable",
  "Files and images",
  "Mac, Windows, and Linux",
];

export function CapabilitiesStrip() {
  return (
    <section className="bg-colony-canvasMid px-6 py-14 sm:py-16">
      <div className="mx-auto max-w-4xl text-center">
        <p className="text-sm font-medium uppercase tracking-wide text-colony-ink/60">
          And everything a workspace needs
        </p>
        <ul className="mt-6 flex flex-wrap items-center justify-center gap-3">
          {CAPABILITIES.map((capability) => (
            <li
              key={capability}
              className="rounded-full bg-white px-5 py-2.5 text-sm font-medium text-colony-ink shadow-sm shadow-colony-ink/5"
            >
              {capability}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
