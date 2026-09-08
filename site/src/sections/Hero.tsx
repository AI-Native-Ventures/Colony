import { AntParade } from "@/brand/BrandField";
import { WorkConversation } from "./WorkConversation";

export function Hero({
  motionPaused,
  showMotionToggle,
  toggleMotion,
}: {
  motionPaused: boolean;
  showMotionToggle: boolean;
  toggleMotion: () => void;
}) {
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="hero-copy">
        <div className="hero-intro">
          <AntParade />
          <span>Meet Colony</span>
        </div>
        <h1 id="hero-title">
          Run your business in Colony.
          <br />
          <span className="hero-tagline">
            Give your team a job. Check the result.
          </span>
        </h1>
        <p className="hero-description">
          Colony is an app for managing your business with people and AI
          teammates. Assign jobs, see who is doing what, and check the results
          before deciding what happens next.
        </p>
        <p className="hero-audience">
          AI teammates are software you can talk to. They use tools to research,
          write and carry out tasks for your business.
        </p>
        <div className="hero-actions">
          <a className="button button-dark" href="#early-access">
            Apply for early access <span aria-hidden="true">↗</span>
          </a>
          <a className="button button-glass" href="#how-it-works">
            How you use it <span aria-hidden="true">↓</span>
          </a>
        </div>
        <p className="availability">
          Colony is being built. Apply to help shape it and try it early.
        </p>
        {showMotionToggle && (
          <button
            className="motion-toggle"
            type="button"
            onClick={toggleMotion}
          >
            <svg viewBox="0 0 12 12" aria-hidden="true">
              {motionPaused ? (
                <path d="M3 1 11 6 3 11Z" />
              ) : (
                <path d="M2 1H5V11H2ZM7 1H10V11H7Z" />
              )}
            </svg>
            {motionPaused ? "Play motion" : "Pause motion"}
          </button>
        )}
      </div>
      <WorkConversation />
    </section>
  );
}
