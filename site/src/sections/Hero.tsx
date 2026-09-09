import { AntParade } from "@/brand/BrandField";
import { WorkspacePreview } from "./WorkspacePreview";

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
          <span>For small business owners</span>
        </div>
        <h1 id="hero-title">Run your business with a team of AI employees.</h1>
        <p className="hero-description">
          Colony is an app that gives your business a team of AI employees. One
          finds new customers. One writes your website, emails and quotes. One
          keeps track of it all and reports to you. They do the work, then ask
          you before anything is sent out.
        </p>
        <p className="hero-audience">
          AI employees are software you can talk to. They use tools to research,
          write and carry out tasks for your business.
        </p>
        <div className="hero-actions">
          <a className="button button-dark" href="#early-access">
            Apply for early access <span aria-hidden="true">↗</span>
          </a>
          <a className="button button-glass" href="#how-it-works">
            See how it works <span aria-hidden="true">↓</span>
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
      <WorkspacePreview />
    </section>
  );
}
