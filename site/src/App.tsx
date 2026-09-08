import { AntMark } from "@/brand/AntMark";
import { AgencyWork } from "@/sections/AgencyWork";
import { ComingSoon } from "@/sections/ComingSoon";
import { FAQ } from "@/sections/FAQ";
import { Footer } from "@/sections/Footer";
import { Hero } from "@/sections/Hero";
import { HowItWorks } from "@/sections/HowItWorks";
import { WhatItIs } from "@/sections/WhatItIs";

export function App() {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header wrap">
        <a className="brand" href="#main" aria-label="Colony home">
          <AntMark className="brand-ant" />
          <span>Colony</span>
        </a>
        <nav aria-label="Main navigation">
          <a className="nav-explainer" href="#what-you-can-do">
            What you can do
          </a>
          <a className="nav-apply" href="#early-access">
            Apply for early access <span aria-hidden="true">↗</span>
          </a>
        </nav>
      </header>
      <main id="main">
        <Hero />
        <WhatItIs />
        <AgencyWork />
        <HowItWorks />
        <FAQ />
        <ComingSoon />
      </main>
      <Footer />
    </>
  );
}
