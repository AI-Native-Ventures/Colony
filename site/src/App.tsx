import { Cards } from "@/sections/Cards";
import { Download } from "@/sections/Download";
import { Footer } from "@/sections/Footer";
import { Hero } from "@/sections/Hero";
import { ProductShowcase } from "@/sections/ProductShowcase";
import { Statement } from "@/sections/Statement";

export function App() {
  return (
    <main className="min-h-screen bg-colony-canvas text-colony-ink">
      <Hero />
      <Statement />
      <ProductShowcase />
      <Cards />
      <Download />
      <Footer />
    </main>
  );
}
