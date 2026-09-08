# Agency Landing Page Implementation Plan

**Goal:** Publish the approved plain-language agency offer with a usable early-access action.

**Architecture:** Keep the standalone React marketing site, Colony ant identity and existing colour system. Replace the long organisational tour with agency introduction, example outputs, three services, the owner's steps, FAQs and early-access contact. Use the established static hosting path; avoid new infrastructure or paid services.

**Tech stack:** React 19, TypeScript, Vite, Tailwind and focused CSS, Cloudflare Pages.

## Acceptance contract

The visitor understands Colony is an app with AI assistants; it serves new and existing website/social media agencies; it helps find potential clients and create/update client work; the owner gives instructions and checks results; applying is not immediate access. Illustrations are labelled. No guaranteed sales, unlimited work, fake testimonials or unproven public availability.

## Tasks

- [x] Replace App.tsx composition and Hero.tsx. Compact brand header, plain explanation, start/run headline, early-access anchor, immediate illustrative work preview. Keep one h1.
- [x] Add AgencyWork.tsx and WorkExample.tsx: three recognisable jobs and a fictional bakery website/post example with a generated cake photograph. Show readable words and pictures; preserve clear example labelling.
- [x] Replace HowItWorks.tsx and WhatItIs.tsx with simple owner steps and new/existing agency entry points. Add FAQ.tsx using native details/summary.
- [x] Replace ComingSoon.tsx with early-access flow using an existing verified contact destination. If no destination exists, request it while completing the independent page. Never say an application was sent when only a mail draft opened.
- [x] Update styles.css, metadata and site README. Preserve brand assets and reduced motion. Remove developer terminology and irrelevant org-chart tour from the public composition.
- [x] Run site lint, typecheck and production build. Run mandatory repository gate and record any environmental blocker distinctly. Inspect page at desktop, narrow and mobile widths, anchor navigation, FAQ keyboard behaviour, image load, contrast, no overflow, and early-access validation and handoff.
- [ ] Independent copy/code review and fix findings. Commit with DCO signoff; PR targeting main through the documented hotfix lane to avoid releasing unrelated develop work. Arm auto-merge only in compliance with the promotion gate: every non-skipped check must pass before permitting production merge.
- [ ] Verify deploy workflow and served bytes, then rerun affected live-browser acceptance checks. Back-merge main to develop under normal queue rules. Clean up temporary servers and report the furthest verified state.

## Release scope

The live page currently makes broad claims and exposes developer-oriented language inconsistent with the approved customer offer. This production marketing correction is confined to site/ and its planning/review records. Main and develop contain unrelated divergence, so a general product promotion is outside the task. No DNS, pricing, permissions, subscriptions or third-party account creation changes.

## Verification recorded before PR

- Site Biome check, TypeScript and Vite production build passed. Three email helper tests passed.
- Negative control: removing URI encoding from the body made two tests fail; production code retains encoding.
- CUA browser: desktop, tablet (768px), mobile (390px) and narrow mobile (320px) inspected. No horizontal overflow in the measured mobile/tablet views. Images load. One h1.
- Both example selectors work. FAQ expands on click and collapses with Enter. Anchor links reach their target. Dark keyboard focus was verified after fixing low contrast.
- Form: empty submission blocked, valid new-agency draft shows the fixed mailbox, special characters preserved, copy succeeds, edits invalidate old draft, spaces-only name blocked. No test email sent.
- Independent read-only review found a duplicate JSX attribute and focus-ring contrast issue; both fixed.
- Sharing card updated from editable SVG and visually inspected. A new public filename avoids retaining the old message in cached link previews.
- A real unfamiliar-reader study, actual mailbox delivery, and clipboard-denial path have not been exercised.
- Every recipe in the full repository `just ci` gate passed across environment-repair retries. The isolated checkout initially lacked desktop and web dependency links; the existing installed dependencies were linked without changing package versions. The rerun passed check, Rust unit tests, 6,801 desktop tests, desktop build, native desktop check/tests, then stopped at the missing web dependency link. After repairing that link, `just web-build mobile-test` passed, including 967 mobile tests (one skipped). No product test failure was waived.
- The production Vite preview was inspected separately on desktop and mobile, including both example views and the email-draft flow. Release checks and live deployment remain the next gate.
