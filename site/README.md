# Colony marketing site: deploy runbook

Static marketing site for Colony (Vite + React 19 + Tailwind, TypeScript). Deploys to
Cloudflare Pages. This document is the manual deploy procedure; there is no CI/CD
automation for this site yet.

## Build

```bash
pnpm -C site build
```

This runs `tsc && vite build` and writes output to `site/dist`. Confirm `site/dist/index.html`
exists before deploying, along with `site/dist/favicon.svg` and `site/dist/og.png`. Both are
referenced by root-absolute path (`/favicon.svg`, `/og.png`) from `site/index.html`, so a
missing file 404s in production even though the build itself succeeds.

`site/dist` is gitignored. Nothing under it is committed; every deploy rebuilds from source.

## Deploy (preview)

```bash
npx wrangler pages project create colony-site --production-branch colony-rebrand
npx wrangler pages deploy site/dist --project-name colony-site
```

The `project create` step only needs to run once; once `colony-site` exists, re-running it
fails harmlessly with "already exists" and can be ignored. `pages deploy` is the command to
re-run for every subsequent deploy.

Requires `npx wrangler whoami` to show an authenticated account with `pages (write)`
permission. If not authenticated, run `wrangler login` interactively before deploying;
do not attempt to deploy unauthenticated.

- **Project name:** `colony-site`
- **Account:** `Phiribash@gmail.com's Account`, account ID `828c27dca37f41abb7d43603228ea05d`
- **Production branch (Pages project setting):** `colony-rebrand`

Each `wrangler pages deploy` prints a deployment-specific URL in the form
`https://<hash>.colony-site.pages.dev`, plus the project's stable alias
`https://colony-site.pages.dev`, which always points at the latest production deployment.
Prefer the stable alias when sharing a preview link: the hash-specific subdomain has been
observed to intermittently fail TLS handshakes shortly after a fresh deploy (see "Known
issues" below), while the stable alias has been reliable in testing.

## Custom domain (do not run yet)

The target production domain is `colony.ainative.ventures`. Attaching it is a deliberate,
owner-approved step, not part of a routine deploy. It happens only after the owner reviews
the `*.pages.dev` preview and signs off.

When the owner approves, a human performs this in the Cloudflare dashboard, it is not
scripted:

1. Cloudflare dashboard, Pages, `colony-site`, Custom domains.
2. Add domain: `colony.ainative.ventures`.
3. This requires the `ainative.ventures` zone to already live in the same Cloudflare account
   as the `colony-site` Pages project. If it is in a different account, transfer or delegate
   the zone first.
4. Cloudflare provisions the certificate and DNS record automatically once the domain is
   added to the Pages project; no manual DNS record needs to be created by hand in the
   common case.

DNS cutover to `colony.ainative.ventures` happens only after the owner has approved the
preview. Nobody should attach the custom domain, edit DNS, or make any zone-level change on
`ainative.ventures` before that approval.

## CI/CD

Deliberately out of scope for this phase. Deploys are manual, run from a developer machine
with `wrangler`. Automating this (GitHub Actions, Pages' native Git integration, or similar)
is a separate follow-up, not assumed by this runbook.

## Known issues, resolve before DNS cutover

- **Download and GitHub links point at the wrong repo.** The primary call to action
  ("Download Colony for macOS" in `site/src/sections/Download.tsx`) links to
  `https://github.com/block/buzz/releases/latest`, and the footer's GitHub link
  (`site/src/sections/Footer.tsx`) points at `https://github.com/block/buzz`. This repo's
  actual origin is `github.com/nocodeafrica/AI-Native-Ventures-App`. A button that reads
  "Download Colony for macOS" and lands on a project called Buzz reads as broken to a visitor.
  This has been escalated to the owner and was not fixed as part of the preview deploy.
  Do not promote this site to `colony.ainative.ventures` until it is resolved.

## Verification performed for this preview deploy

Fetched the live preview and confirmed: the page returns HTTP 200, the rendered page
contains the Colony headline ("Your company, run by agents"), and both `/favicon.svg` and
`/og.png` return HTTP 200 rather than 404. Rendered the live URL in a headless browser and
confirmed it matches the local build: hero, scatter field, feature sections, download CTA,
and footer all present, with no console errors.
