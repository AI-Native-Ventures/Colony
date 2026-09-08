import { AntParade } from "@/brand/BrandField";
import { BusinessTour } from "./BusinessTour";

export function Hero() {
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
      </div>
      <BusinessTour />
    </section>
  );
}
