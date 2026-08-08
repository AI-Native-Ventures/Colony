// site/src/sections/AppWindow.tsx
// Shared frame for every product screenshot on the page: a light macOS-style
// window with traffic lights, matching the "native desktop app" story the
// Download section makes. This replaced the near-black rounded slab, which
// the owner read as a fake tablet rather than a desktop app.
import type { ReactNode } from "react";

export function AppWindow({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-colony-ink/10 bg-white shadow-2xl shadow-colony-ink/20">
      <div
        aria-hidden
        className="flex items-center gap-1.5 border-b border-colony-ink/10 bg-colony-ink/[0.04] px-4 py-2.5"
      >
        <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
        <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
        <span className="h-3 w-3 rounded-full bg-[#28c840]" />
      </div>
      {children}
    </div>
  );
}
