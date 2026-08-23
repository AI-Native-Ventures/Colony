// desktop/src/features/onboarding/ui/new/screens/ReadingScreen.tsx
import { useEffect, useState } from "react";
import type { OnboardingServices, ScrapeResult } from "../../../contracts";

/**
 * Whole-step budget. Reading spends Colony's own money on a scrape and must
 * never hold the user longer than this, whatever the website does.
 */
export const READING_BUDGET_MS = 30000;

const PAGES = ["Home", "Services", "About", "Contact"];

/** Cadence of the decorative page fill. Purely visual, gated in JS. */
const PAGE_INTERVAL_MS = 800;

type Props = {
  url: string;
  services: OnboardingServices;
  reducedMotion: boolean;
  onDone: (result: ScrapeResult) => void;
};

export function ReadingScreen({ url, services, reducedMotion, onDone }: Props) {
  const [read, setRead] = useState(0);

  // The page fill is a JS-timed animation, so it is gated here rather than in
  // CSS. With reduced motion the pages sit as static skeletons.
  useEffect(() => {
    if (reducedMotion) return undefined;
    const id = setInterval(
      () => setRead((current) => Math.min(current + 1, PAGES.length)),
      PAGE_INTERVAL_MS,
    );
    return () => clearInterval(id);
  }, [reducedMotion]);

  useEffect(() => {
    let cancelled = false;
    let settled = false;

    const finish = (result: ScrapeResult) => {
      if (cancelled || settled) return;
      settled = true;
      onDone(result);
    };

    // The whole step is capped. A site that never answers reports a typed
    // timeout instead of holding the user here, so nobody can be trapped.
    const budget = setTimeout(
      () => finish({ ok: false, reason: "timeout" }),
      READING_BUDGET_MS,
    );

    services.scrape
      .describeBusiness(url)
      .then((result) => {
        clearTimeout(budget);
        finish(result);
      })
      .catch(() => {
        clearTimeout(budget);
        // A rejected read is still a typed failure, never an unhandled error.
        finish({ ok: false, reason: "unreachable" });
      });

    return () => {
      cancelled = true;
      clearTimeout(budget);
    };
  }, [services, url, onDone]);

  // No back control: the scrape runs for the whole visit, and going back would
  // spend money to show the user the screen they were trying to leave.
  return (
    <div className="onb-screen" data-wide="true" data-solo="true">
      <div className="onb-col-head">
        <h1 className="onb-headline">
          Reading your <em>website</em>.
        </h1>
        <p className="onb-sub">
          Give us a moment. We are working out what your business does.
        </p>
      </div>
      <div className="onb-window">
        <div className="onb-window__bar" aria-hidden="true">
          <span className="onb-window__dot" style={{ background: "#ff5f57" }} />
          <span className="onb-window__dot" style={{ background: "#febc2e" }} />
          <span className="onb-window__dot" style={{ background: "#28c840" }} />
        </div>
        <div style={{ position: "relative" }}>
          <svg
            viewBox="0 0 440 24"
            preserveAspectRatio="none"
            aria-hidden="true"
            style={{
              position: "absolute",
              inset: "0 0 auto 0",
              height: "24px",
              width: "100%",
            }}
          >
            {/* Dashed trail across the page tops. Its animation lives in
                onboarding-canvas.css and is switched off there under reduced
                motion, so no JS gate is needed for it. */}
            <path
              d="M20 12 L120 12 L220 12 L320 12 L420 12"
              fill="none"
              stroke="#10b981"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray="3 9"
              opacity="0.8"
              className="onb-trail__path"
            />
          </svg>
          <div className="onb-pages">
            {PAGES.map((page, index) => (
              <div
                key={page}
                className="onb-page"
                data-read={index < read ? "true" : "false"}
              >
                <div className="onb-page__name">{page}</div>
                <div className="onb-skel" style={{ width: "80%" }} />
                <div className="onb-skel" style={{ width: "95%" }} />
                <div className="onb-skel" style={{ width: "60%" }} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
