import { WorkExample } from "@/sections/WorkExample";

export function Hero() {
  return (
    <section className="hero wrap" aria-labelledby="hero-title">
      <div className="hero-copy">
        <p className="eyebrow">
          <span className="small-dot" /> For website & social media agencies
        </p>
        <h1 id="hero-title">Start or run your agency with an AI team.</h1>
        <p className="hero-description">
          Colony is an app with AI assistants that help you do work for other
          businesses.
        </p>
        <p className="hero-jobs">
          Find potential clients. Build and update their websites. Create their
          social media posts.
        </p>
        <a className="button button-dark" href="#early-access">
          Apply for early access <span aria-hidden="true">↗</span>
        </a>
        <p className="availability">
          Coming soon. Apply to try Colony before it opens to everyone.
        </p>
      </div>
      <WorkExample />
    </section>
  );
}
