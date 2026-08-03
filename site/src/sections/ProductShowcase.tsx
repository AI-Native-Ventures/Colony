// site/src/sections/ProductShowcase.tsx
// The single largest piece of evidence on the page: an actual Colony
// screenshot instead of another description. Captured from the real desktop
// app via the E2E screenshot pipeline (just desktop-screenshot), not staged
// or drawn.
//
// The screenshot sits inside a near-black frame with deep padding, and that
// frame is the whole point of this section. Before it, the shot was a
// thin-bordered image on the page's palest tint: the app's own white chrome
// against a near-white background, so the most important thing on the page
// receded into it. Dark surround gives the white chrome an edge to push
// against, and the padding reads as a device rather than a pasted image.
//
// #211f1f, not colony-ink (#171717): a frame at pure ink matched the body
// text's own colour and flattened against the footer's dark band. Lifting it
// a few points keeps it reading as a surface.
const FRAME = "#211f1f";

// Regenerating product-channel.png: the capture's clip ran ~8px wider and
// taller than the app window, so the shipped file carried a strip of the page
// behind it down its right and bottom edges — and that page was still
// Buzz-era chartreuse, rgb(212,219,201). Invisible on the old pale
// background, obvious once the frame below went near-black. The committed
// file is cropped to the window (1131x851, from 1140x859). Re-crop after any
// re-capture, or tighten the clip so it never appears.

export function ProductShowcase() {
  return (
    <section className="bg-colony-canvasLight px-6 py-16 sm:py-24">
      <div className="mx-auto max-w-6xl">
        <p className="text-center text-sm font-medium uppercase tracking-wide text-colony-ink/60">
          Inside a Colony channel
        </p>

        <div
          // Padding scales with the viewport: at phone widths a 4rem inset
          // would leave the screenshot narrower than the text above it.
          className="mt-8 rounded-3xl p-4 shadow-2xl shadow-colony-ink/20 sm:p-10 lg:p-16"
          style={{ backgroundColor: FRAME }}
        >
          <img
            src="/product-channel.png"
            alt="A Colony engineering channel: a teammate cuts a release branch, an agent named mira reviews the diff and replies in a thread, an agent named nadia reports a triggered workflow and queued notarization with reactions, and the composer sits ready at the bottom."
            width={1131}
            height={851}
            className="w-full rounded-xl"
          />
        </div>

        <p className="mx-auto mt-8 max-w-2xl text-center text-sm leading-relaxed text-colony-ink/60 sm:text-base">
          Chat, agent activity, and workflow runs in one thread: nothing to
          reconstruct from a separate dashboard.
        </p>
      </div>
    </section>
  );
}
