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

## Deploy

```bash
npx wrangler pages project create colony-site --production-branch main
npx wrangler pages deploy site/dist --project-name colony-site --branch main
```

The `project create` step only needs to run once; once `colony-site` exists, re-running it
fails harmlessly with "already exists" and can be ignored. `pages deploy` is the command to
re-run for every subsequent deploy.

`--branch main` matters: wrangler deploys to **preview** unless the branch matches the
project's production branch. Deploying from a feature branch without `--branch` produces a
preview with a branch alias (`<branch>.colony-site.pages.dev`) and never flips production.

Requires `npx wrangler whoami` to show an authenticated account with `pages (write)`
permission. If not authenticated, run `wrangler login` interactively before deploying;
do not attempt to deploy unauthenticated.

- **Project name:** `colony-site`
- **Account:** `Phiribash@gmail.com's Account`, account ID `828c27dca37f41abb7d43603228ea05d`
- **Production branch (Pages project setting):** `main`
- **Custom domain (live):** `https://colony.ainative.ventures`

Each `wrangler pages deploy` prints a deployment-specific URL in the form
`https://<hash>.colony-site.pages.dev`, plus the project's stable alias
`https://colony-site.pages.dev`, which always points at the latest production deployment.
The custom domain `colony.ainative.ventures` is attached to the project and serves the
latest production deployment, so a successful `--branch main` deploy is immediately live
there.

## Custom domain

Already attached and serving production: `colony.ainative.ventures` is a Pages custom domain
on the `colony-site` project, provisioned against the `ainative.ventures` zone in the same
Cloudflare account. No manual DNS records are needed for routine deploys. Zone-level changes
(cache purge, DNS) are owner-only actions and should not be part of a routine deploy.

## CI/CD

Automated. `.github/workflows/site-deploy.yml` rebuilds and deploys on every push to `main`
that touches `site/`, and the run only goes green once `scripts/verify-site-live.sh` proves
`https://colony.ainative.ventures` is serving that exact build. `workflow_dispatch` redeploys
the current `main` without needing a commit.

The manual procedure above still works and is still the fallback, but it should no longer be
the routine path. A hand-run deploy is now a signal that something is wrong with the
workflow.

**Requires the `CLOUDFLARE_API_TOKEN` repository secret**, scoped to `Cloudflare Pages:Edit`
on account `828c27dca37f41abb7d43603228ea05d`. Without it the deploy step fails with an
explicit message rather than silently skipping. The account ID itself is not a secret and is
set inline in the workflow.

Scope limits, deliberate: it does not deploy from `develop` or from pull requests, and it
does not touch DNS, the zone cache, or the Pages project settings. Those stay owner actions.

Because it triggers on `main`, a change to the workflow only takes effect once it has been
promoted from `develop` to `main`; it does nothing while it sits on `develop` alone.

## Resolved issues

- **Stale 404-fallback cache on the custom domain.** A missing hashed asset URL
  (`/assets/index-*.js`) can be cached at the `ainative.ventures` zone edge with the SPA
  fallback for up to `max-age=14400` (4 hours), which breaks a freshly deployed site until
  the entry expires. Fixed by renaming the hashed assets in `dist` (fresh URLs miss the
  stale fallback) and redeploying; the orphaned entries expire on their own. If this bites
  again and an owner is available, purge the zone cache instead (the machine OAuth token
  only has `zone:read`, so the purge must be done by an owner in the dashboard or with a
  token scoped to `zone:cache:purge`).

- **Download and GitHub links pointed at the wrong repo (fixed).** The primary call to
  action ("Download Colony for macOS" in `site/src/sections/Download.tsx`) used to link to
  `https://github.com/block/buzz/releases/latest`, and the footer's GitHub link
  (`site/src/sections/Footer.tsx`) used to point at `https://github.com/block/buzz`. Both now
  point at this repo's actual origin, `https://github.com/AI-Native-Ventures/colony-releases`.
  Since this fork has zero releases as of this fix, both links use the releases list
  (`/releases`) rather than `/releases/latest`, which 404s with no releases published.

## Verification performed for this preview deploy

Fetched the live preview and confirmed: the page returns HTTP 200, the rendered page
contains the Colony headline ("Run your company with AI agents"), and both `/favicon.svg` and
`/og.png` return HTTP 200 rather than 404. Rendered the live URL in a headless browser and
confirmed it matches the local build: hero, scatter field, feature sections, download CTA,
and footer all present, with no console errors.
