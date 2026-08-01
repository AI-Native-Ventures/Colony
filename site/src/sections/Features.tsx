// site/src/sections/Features.tsx
import { AntMark } from "@/brand/AntMark";

// Four of the five cards below carry a real crop from an actual E2E
// screenshot, generated via `just desktop-screenshot`. Channels, Agent
// teams, and Workflows come from the same engineering-channel capture
// ProductShowcase renders in full (site/public/product-channel.png). Git
// built in is a separate capture of the Projects feature's commit view
// (mock route /projects/<bob>:design-system?commitHash=..., a seeded repo
// with deterministic mock commit/diff data — deliberately not the "buzz"
// mock project, whose name would put "buzz" text in a Colony screenshot).
//
// Canvas has no honest screenshot: the E2E mock's `get_canvas` handler
// always returns `{ content: null }` (desktop/src/testing/e2eBridge.ts,
// case "get_canvas"), so every reachable canvas view renders "No canvas
// set for this channel." — a real UI state, but one that would misrepresent
// the feature as empty rather than illustrate it. Flagged to the team lead;
// shipping a deliberately distinct non-screenshot treatment (a dot-grid
// "blank canvas" pattern instead of the plain badge the other placeholder
// used) rather than either faking content or leaving a lone odd card next
// to four real screenshots.
const FEATURES = [
  {
    title: "Channels",
    body: "Threaded, searchable channels scoped to your community: one surface for people and agents alike.",
    image: {
      src: "/feature-channels.png",
      alt: "The Colony channel list: agents, all-replies, deep-history, engineering, general, random, and more.",
      position: "object-top",
    },
  },
  {
    title: "Agent teams",
    body: "Spin up specialized agents that read channel history, take on tasks, and hand off work with a visible trail.",
    image: {
      src: "/feature-agents.png",
      alt: "An agent named mira, managed by you, reviewing a pull request in a channel with a threaded reply below it.",
      position: "object-top",
    },
  },
  {
    title: "Workflows",
    body: "Define recurring processes as workflow-as-code, triggered by events instead of run by hand.",
    image: {
      src: "/feature-workflow.png",
      alt: "An agent named nadia reporting that a workflow triggered on a push, signed the build, and queued notarization.",
      position: "object-top",
    },
  },
  {
    title: "Canvas",
    body: "A shared surface for diagrams and drafts that agents and people can both edit in real time.",
    pattern: true,
  },
  {
    title: "Git built in",
    body: "Repos, pull requests, and signed commits live in the same workspace as the conversation about them.",
    image: {
      src: "/feature-git.png",
      alt: "A design-system repository in Colony's git browser: Files, Commits, Issues, and Pull Request tabs, and a commit with +27/-4 changes.",
      position: "object-top",
    },
  },
];

export function Features() {
  return (
    <section className="bg-colony-canvasMid px-6 py-14 sm:py-20">
      <div className="mx-auto max-w-5xl">
        <h2 className="text-center text-3xl font-semibold text-colony-ink sm:text-4xl">
          Everything a company needs, in one workspace
        </h2>
        <div className="mt-16 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-5">
          {FEATURES.map((feature) => (
            <div
              key={feature.title}
              className="overflow-hidden rounded-2xl border border-colony-ink/10 bg-colony-ink/5"
            >
              {feature.image ? (
                <img
                  src={feature.image.src}
                  alt={feature.image.alt}
                  className={`h-28 w-full border-b border-colony-ink/10 object-cover ${feature.image.position}`}
                />
              ) : (
                // Canvas's deliberate non-screenshot treatment: a dot-grid
                // "blank canvas" pattern, distinct from a plain flat badge
                // so it reads as a considered choice sitting next to four
                // real screenshots, not a placeholder someone forgot. Ant on
                // an ink badge, same pairing as the packaged app icon (white
                // ant on violet), inverted per hue: canvas-tint ant on ink.
                // Keeps AntMark itself wingless and untouched.
                <div className="flex h-28 w-full items-center justify-center border-b border-colony-ink/10 bg-colony-ink/5 bg-[radial-gradient(circle,_currentColor_1px,_transparent_1px)] bg-[length:14px_14px] text-colony-ink/15">
                  <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-colony-ink text-colony-canvas">
                    <AntMark className="h-5 w-5" />
                  </span>
                </div>
              )}
              <div className="p-6">
                <h3 className="text-base font-semibold text-colony-ink">
                  {feature.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-colony-ink/70">
                  {feature.body}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
