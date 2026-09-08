import { AntParade } from "@/brand/BrandField";
import { ExampleJob } from "./ExampleJob";

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
          <span className="hero-tagline">Your team and work, in one app.</span>
        </h1>
        <p className="hero-description">
          Colony is an app where you and your team can talk, share files and
          keep track of work. Give AI assistants a job, check what they produce
          and ask for changes.
        </p>
        <p className="hero-audience">
          Start a business or bring the one you already run. Set up Colony
          around the work your business needs to do.
        </p>
        <div className="hero-actions">
          <a className="button button-dark" href="#early-access">
            Apply for early access <span aria-hidden="true">↗</span>
          </a>
          <a className="button button-glass" href="#example">
            See how it works <span aria-hidden="true">↓</span>
          </a>
        </div>
        <p className="availability">
          We’re building and testing Colony. Apply to try it early.
        </p>
      </div>
      <ExampleJob />
    </section>
  );
}
