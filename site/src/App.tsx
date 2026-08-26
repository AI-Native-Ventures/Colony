// site/src/App.tsx
// The landing page, in the order a stranger needs it: what this is, how it
// works in four steps, who you talk to, the org chart those steps produce,
// then the proof for each claim. Nothing is named before it has been shown.
import scoutArt from "@/assets/scout.png";
import { Approval } from "@/sections/Approval";
import { Blocks } from "@/sections/Blocks";
import { ComingSoon } from "@/sections/ComingSoon";
import {
  FindCustomers,
  Pipeline,
  SameRoom,
  WorkDelivered,
} from "@/sections/Evidence";
import { Footer } from "@/sections/Footer";
import { Hero } from "@/sections/Hero";
import { HowItWorks } from "@/sections/HowItWorks";
import { MeetScout } from "@/sections/MeetScout";
import { OrgChart } from "@/sections/OrgChart";
import { TheRest } from "@/sections/TheRest";
import { WhatItIs } from "@/sections/WhatItIs";

export function App() {
  return (
    <main className="min-h-screen bg-colony-canvas text-colony-ink">
      <Hero />
      <WhatItIs />
      <HowItWorks />
      <MeetScout />
      <OrgChart scoutArt={scoutArt} />
      <SameRoom />
      <FindCustomers />
      <Pipeline />
      <Approval />
      <WorkDelivered />
      <Blocks />
      <TheRest />
      <ComingSoon />
      <Footer />
    </main>
  );
}
