import { CapabilitiesStrip } from "@/sections/CapabilitiesStrip";
import { Cards } from "@/sections/Cards";
import { ChainOfCommand } from "@/sections/ChainOfCommand";
import { ComingSoon } from "@/sections/ComingSoon";
import { Footer } from "@/sections/Footer";
import { Hero } from "@/sections/Hero";
import { Jobs } from "@/sections/Jobs";
import { ProductShowcase } from "@/sections/ProductShowcase";
import { Statement } from "@/sections/Statement";

export function App() {
  return (
    <main className="min-h-screen bg-colony-canvas text-colony-ink">
      <Hero />
      <Statement />
      <ProductShowcase />
      <ChainOfCommand />
      <Jobs />
      <CapabilitiesStrip />
      <Cards />
      <ComingSoon />
      <Footer />
    </main>
  );
}
