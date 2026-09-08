import { AntMark } from "@/brand/AntMark";
import { BrandField } from "@/brand/BrandField";
import { ClientWork } from "@/sections/ClientWork";
import { ComingSoon } from "@/sections/ComingSoon";
import { FAQ } from "@/sections/FAQ";
import { Hero } from "@/sections/Hero";

export function App() {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className="opening-canvas">
        <BrandField />
        <header className="site-header section-wrap">
          <a className="brand" href="#main" aria-label="Colony home">
            <AntMark />
            <span>Colony</span>
          </a>
          <nav aria-label="Main navigation">
            <a href="#how-it-works">How it works</a>
            <a href="#what-you-can-do">What you can do</a>
            <a className="nav-apply" href="#early-access">
              Apply for early access <span aria-hidden="true">↗</span>
            </a>
          </nav>
        </header>
        <main id="main">
          <Hero />
          <div className="page-content">
            <ClientWork />
            <FAQ />
            <ComingSoon />
          </div>
        </main>
      </div>
      <footer className="site-footer section-wrap">
        <a className="brand" href="#main" aria-label="Colony home">
          <AntMark />
          <span>Colony</span>
        </a>
        <span>Built by AI Native Ventures</span>
        <a href="mailto:basheer@ainative.ventures">Contact us ↗</a>
      </footer>
    </>
  );
}
