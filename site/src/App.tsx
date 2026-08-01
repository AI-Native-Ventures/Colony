import { Download } from "@/sections/Download";
import { Features } from "@/sections/Features";
import { Footer } from "@/sections/Footer";
import { Hero } from "@/sections/Hero";
import { Story } from "@/sections/Story";

export function App() {
  return (
    <main className="min-h-screen bg-colony-canvas text-colony-ink">
      <Hero />
      <Story />
      <Features />
      <Download />
      <Footer />
    </main>
  );
}
