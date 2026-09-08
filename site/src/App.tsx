import { useEffect, useState } from "react";
import { AntMark } from "@/brand/AntMark";
import { BrandField } from "@/brand/BrandField";
import { getBrandScene } from "@/brand/brandScene";
import { BusinessGuide } from "@/sections/BusinessGuide";
import { ComingSoon } from "@/sections/ComingSoon";
import { FAQ } from "@/sections/FAQ";
import { Hero } from "@/sections/Hero";
import { Footer } from "@/sections/Footer";

export function App() {
  const [scene] = useState(getBrandScene);
  const [motionPaused, setMotionPaused] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(
    () => matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const changed = () => setReducedMotion(media.matches);
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div
        className="opening-canvas"
        style={scene.style}
        data-scene={scene.name}
      >
        <BrandField paused={motionPaused || reducedMotion} />
        <header className="site-header section-wrap">
          <a className="brand" href="#main" aria-label="Colony home">
            <AntMark />
            <span>Colony</span>
          </a>
          <nav aria-label="Main navigation">
            <a href="#how-it-works">How it works</a>
            <a href="#inside-colony">Inside Colony</a>
            <a className="nav-apply" href="#early-access">
              Apply for early access <span aria-hidden="true">↗</span>
            </a>
          </nav>
        </header>
        <main id="main">
          <Hero
            motionPaused={motionPaused}
            showMotionToggle={!reducedMotion}
            toggleMotion={() => setMotionPaused((paused) => !paused)}
          />
          <div className="page-content">
            <BusinessGuide />
            <FAQ />
            <ComingSoon />
          </div>
        </main>
      </div>
      <Footer />
    </>
  );
}
