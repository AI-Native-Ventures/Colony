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
          Create websites and social media posts.
          <br />
          <span className="hero-tagline">Tell Colony what you need.</span>
        </h1>
        <p className="hero-description">
          Colony is an app where you chat with AI assistants to get work done.
          Give them your client’s details. They create the website, pictures or
          writing. You check it and ask for changes.
        </p>
        <p className="hero-audience">
          For people who make websites or manage social media for other
          businesses. Start with your first client, or use it for clients you
          already have.
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
