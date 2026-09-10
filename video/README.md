Standalone `video/` package for Colony's motion-graphics pipeline.

Why standalone: the workspace's shared `pnpm-lock.yaml` resolved desktop's React down from 19.2.8 to 19.1.0 (video's earlier pin), which broke the desktop build. A standalone package with `.npmrc` (`ignore-workspace=true`) and `pnpm-lock.yaml` keeps the workspace untouched.

Install: `cd video && pnpm install`
Scripts: `dev`, `render`, `render:t1`, `render:batch`, `check`
Stack: Remotion 4.0.522, React 19.2.8, TypeScript 6.0.3, Biome 2.4.16, Zod 4.4.3, Inter via `@remotion/google-fonts`.
