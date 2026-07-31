import { Download } from "@/sections/Download";
import { Features } from "@/sections/Features";
import { Footer } from "@/sections/Footer";
import { Hero } from "@/sections/Hero";
import { Story } from "@/sections/Story";

export function App() {
  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-50">
      <Hero />
      <Story />
      <Features />
      <Download />
      <Footer />
    </main>
  );
}
