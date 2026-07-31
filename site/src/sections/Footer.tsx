// site/src/sections/Footer.tsx
import { AntMark } from "@/brand/AntMark";

const GITHUB_URL = "https://github.com/block/buzz";

export function Footer() {
  return (
    <footer className="border-t border-zinc-800 bg-zinc-950 px-6 py-12">
      <div className="mx-auto flex max-w-5xl flex-col items-center gap-4 text-center sm:flex-row sm:justify-between sm:text-left">
        <div className="flex items-center gap-3">
          <span className="block w-6 text-colony-violet">
            <AntMark className="h-auto w-full" />
          </span>
          <span className="text-base font-semibold text-zinc-50">Colony</span>
        </div>
        <div className="flex flex-col items-center gap-1 text-sm text-zinc-500 sm:items-end">
          <a
            href={GITHUB_URL}
            className="text-zinc-400 underline underline-offset-4 transition hover:text-zinc-50"
          >
            GitHub
          </a>
          <p>Built on Buzz</p>
          <p>AI Native Ventures</p>
        </div>
      </div>
    </footer>
  );
}
