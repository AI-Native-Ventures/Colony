# Simple founder onboarding

Status: the approved account/recovery/business journey, signup configuration
repair and corrected workspace visuals merged in [PR #655](https://github.com/AI-Native-Ventures/Colony/pull/655).
The available normal beta and its packaged checks are recorded in
[the redesign verification report](../reports/2026-09-08-colony-redesign-proof.md).
The initial PR screenshots were rejected; the corrected real-app screenshots
replace that failed visual gate. The explicit first-job handoff merged in
[PR #660](https://github.com/AI-Native-Ventures/Colony/pull/660), tracked in
[its proof ledger](../reports/2026-09-08-first-job-handoff-proof.md).
Its joined native fixtures prove account-to-completed-work behaviour, live
completion in both panes and completed-state recovery after reload.
The [starter fidelity report](../reports/2026-09-08-first-job-starter-fidelity.md)
records the untouched five-caption/five-visual-brief default and rendered output.
PR merge and normal-beta availability remain separate delivery gates. Hosted signup,
real payment settlement and autonomous model quality are not claimed.

The user also clarified that this must preserve Colony's channels-and-threads
execution environment. The illustrative Work sidebar/dashboard in the first
preview is withdrawn. This scope changes onboarding and its handoff into the
existing conversation, not Colony's global navigation or information architecture.

## Outcome

A nontechnical business owner understands Colony, creates an account, supplies
one useful piece of business context, and reaches a specific first job. They
never need to choose a model, runtime, provider, API key, or team structure.

The default journey has two forms: account and business. The account stage also
contains a compact recovery safeguard. The first job lives inside Colony rather
than becoming another onboarding form. Funding is requested immediately before
paid work starts, with an option to explore first.

## Findings before implementation

- The downloaded 0.16.7 release beta reports a null compiled relay, defaults to
  `ws://localhost:3000`, and sends account requests to `http://localhost:3000`.
  Existing stable and canary releases bake Colony's hosted relay. This is a beta
  packaging defect; the screenshot's connection diagnosis is misleading.
- The fresh-founder path is entry, account, recovery, company, building, brain,
  credits, then a Welcome conversation. Invites are hidden by a feature flag.
- Gender has no account or provisioning purpose. Revenue stage is consumed by
  resume validation but not by the business brief or provisioning.
- Brain selection advertises third-party runtimes which the isolated Electron
  launcher deliberately refuses. Its default should be the built-in Colony Agent.
- Recovery is not ordinary email password reset. The code currently exists only
  in React state; answers persist acknowledgement, not the code. Closing at that
  checkpoint can resume with an empty code. This needs a correctness repair.
- There is no signup credit grant. A desktop-authored welcome message is not
  evidence that an agent can respond or has performed work.

Source anchors: `flow/steps.ts`, `ui/new/NewOnboardingFlow.tsx`,
`ui/new/screens/{Account,Recovery,Company,Building,Brain,Credits}Screen.tsx`,
`flow/persistence.ts`, `flow/founderBrief.ts`, `welcomeCreditsNotice.ts`, and
`managed_agents/isolation/launch.rs`.

## Options considered

1. Shorten the existing six-screen wizard. Cheap, but still forces business
   owners to configure AI and pay before understanding the product.
2. Two forms, safe account recovery, then a concrete job in Colony. Recommended:
   removes decisions the product can make while keeping account and spending
   behavior visible and truthful.
3. A chat-only onboarding interview. Useful for follow-up questions, but a poor
   default for account creation, recoverability, progress, and people who do not
   know what to ask an agent. Use conversation after the initial setup.

## The proposed journey

### Account

Use a calm, compact form with email, password, Create account, and a persistent
Sign in alternative. Put name and other profile details in Profile settings.
Fold the preceding 'Start with Colony' screen into this entry. Initialize the
required local identity behind the signup action without making a first-time
owner choose a key or a server; keep existing identity import under More options.
Keep the existing password requirement without a misleading strength meter that
equates length with strength. Do not promise a two-minute setup or free work.

An existing-account error keeps the entered email and offers Sign in. A failed
request keeps the form intact and presents a retry. Only a proven connectivity
failure should be described as one; crypto, native, server, rate-limit and
configuration errors must not all become 'check your connection'. Technical
details can be expanded for diagnosis without occupying the normal flow.

Signup must use the branded package's hosted account service. Verify the baked
default independently of test-time relay overrides, then exercise the actual
renderer, key derivation, native identity backup and recovery transition against
a synthetic account server. Hosted health/CORS checks alone are not signup proof.

### Recovery within account setup

Keep the reason concrete: 'Keep this code safe. You need it if you forget your
password.' Offer a primary Save and continue action and an alternate copy path.
Advance only after a native save succeeds, or the user explicitly acknowledges
the copy path. Cancellation, empty codes and clipboard failures stay visible.

Before the account request is sent, store the pending recovery material in the
existing native encrypted secret store, bound to the current identity and signup
attempt. Keep it across uncertain network outcomes and app restarts. Never put
it in localStorage, general logs, analytics, or a normal onboarding draft. Clear
the registered pending secret after successful backup acknowledgement. A
definitively rejected prepared attempt may be discarded only through the native
identity/attempt-bound transition so the user can correct the rejected details.
Uncertain, locked, partial or incomplete ownership outcomes retain the checkpoint. A fresh launch must
recover the same pending checkpoint; it must not invent a new code for an account
whose recovery hash was already registered.

An old draft with acknowledgement false and no recoverable pending secret cannot
pretend a blank code is valid. Explain that the original code is no longer
available on this device and offer the existing account sign-in route. A signed-in
owner can use the existing encrypted key-backup workflow; do not describe that
backup as a newly valid email recovery code. The current account API cannot rotate
the registered recovery code using a password alone. Do not silently acknowledge
the lost code, create another identity, or invent a server reset method.

### Business

Ask for the business name and an optional website. Without a website, expose one
short description field. Remove revenue stage and the separate yes/no website
question. All three values remain editable later.

Read the website inline and show an editable business summary on this same page.
Make manual description available immediately. A timeout or unreadable site must
not strand the user. A late scan result must not overwrite an edited description.
Do not run fake progress beats or show a successful website read without a result.

Continue creates or resumes the same business provisioning transaction. Retries,
double clicks and app relaunch must not claim another business or provision a
second teammate. Keep a clear way back or out, especially when adding another
business to an existing account.

### The first job, inside Colony

Account and business setup occupy the full onboarding surface, without an app
sidebar. Completing setup opens the existing Welcome conversation and focuses
the first-job thread, using Colony's existing navigation and thread/workspace
layout. The revised preview isolates this thread for clarity; it is not a new
dashboard, another onboarding sidebar, or a replacement app shell.

Present a suggested first-job block inside the conversation, with Scout as the
responsible teammate, the business context visible and a brief the owner can
edit. Label this as a setup suggestion, not a response generated by an unfunded
agent. For Horizon Labs:

> Draft five Instagram captions and matching visual briefs for our branding
> service. Keep them ready for my review.

Describe the expected result as five captions and visual briefs. Do not imply
finished images, automatic publication, or a preinstalled Social Media Manager
that the onboarding path has not actually provisioned. Offer finding potential
clients as another useful starting task where Discovery is available.

Scout remains the coordinator in the agreed leader/worker model. Actual work
belongs to a supported worker through the task handoff. Do not ask the owner to
build that team. If the worker/task handoff is unavailable, show that condition
and do not label an automatically authored welcome message as a completed job.

Use the built-in Colony Agent by default. Await successful configuration and
verify the supported runtime before calling the teammate ready. A failure belongs
in this task with a retry; it must not be hidden in Settings while a fake greeting
suggests the agent is working.

When the owner presses Start, check their actual credit state. Zero balance shows
Add credits and Explore for now in context. Load actual available prices from the
existing service; do not invent a free allowance, fixed job price or number of
jobs covered. An unreadable balance is an error to retry, not a zero balance.
Returning from payment must verify the actual balance/payment result before work
starts. Preserve existing spend limits and approval controls.

Open and update the same task when the real job starts. The first completed
response must come from the actual runtime and be a reviewable output. Keep
blocked, running, failed and completed states distinct.

The card is a proposed structured view of the conversation's brief and actions.
Starting it should use the existing thread-scoped task mechanism; discussion,
delegation updates, questions, funding context and review remain attached to the
same thread. It does not create a separate initiative by default or a second task
store. Retain existing Tasks/initiative views where applicable. Outputs such as
documents, designs or websites can use the existing workspace beside the thread.
The owner can continue through normal replies, without learning a new dashboard.

## Browser accounts and advanced settings

Retain browser-profile detection and voluntary import on first use, and the
existing Settings import action. Present an optional connection action once the
business is open, rather than an import modal covering another onboarding step.
When a job needs Instagram, ask to connect or share that account in that context.
Do not silently import sessions, publish content, or grant an agent browser access.

Supported own-key and runtime settings remain accessible to technical users.
The default path should never advertise a runtime the current platform rejects.
Do not automatically reuse an unrelated personal subscription or credential.

## Visual direction

Colony's multicolour gradient backgrounds and ants are essential brand elements,
including in onboarding. Keep the wordmark, tight typography and strong ink.
The primary direction uses expansive gradients from the existing violet, blue,
pink, amber and green palette. Use coherent families across the journey, such as
lavender/periwinkle, pink/amber and green/cobalt, as seen on Colony's Instagram.
Colour should be present by default; it must not require an optional violet theme
to make the product recognizable.

Retain the actual Colony ant geometry, with a recognizable mark and a small
colony or trail around the background margins. Keep ants outside field and text
areas, noninteractive and decorative. Any motion respects reduced-motion
preferences, leaving static ants visible. Gradients stay static while a person
is entering information. Preserve the lighter two-form journey with visible
field boundaries, solid readable form surfaces and one obvious next action.
Carry the brand into the first-job view without reducing task readability.

The revised preview offers a small set of coherent gradient families for visual
comparison. These are design-review controls, not more choices for a new user.

Make account, recovery, business, first-task, funding and failure states
inspectable as a whole. The preview uses example data and simulated transitions;
it never creates an account, saves a real recovery code, charges money or runs an
agent. Product screenshots must later be captured from the implemented app.

## Existing users and interrupted setup

- Existing-account sign-in restores the correct identity and offers the existing
  business selection or invite flow. Never rerun owner provisioning for members.
- Existing identities creating another business skip account and recovery, keep
  an exit, and use an independent draft/provisioning transaction.
- Preserve explicit key import for people who already use it, outside the primary
  new-founder path. Do not turn an empty identity into an accidental new signup.
- Migrate old saved onboarding answers without re-asking removed questions or
  dropping known business context. Treat uncertain server outcomes as resumable
  operations, not permission to duplicate them.

## Acceptance gates

1. Reproduce the beta default-address failure against the delivered binary and
   prove the repaired compiled helper uses the hosted service. Add a package gate
   that cannot be masked by synthetic runtime endpoint overrides.
2. Inspect the complete proposed journey, including sign-in, failed signup,
   recovery-save cancellation/relaunch, unreadable website and zero-credit start.
3. Implement the accepted journey and prove signup-to-first-job with real native
   crypto, persistence, provisioning and agent tools against isolated fixtures.
   Use actual app screens for visual proof, including narrow windows.
4. Verify fresh and existing identities, second-business entry, retries,
   duplicate-click prevention, config failure, credit-read failure, payment
   return, browser import timing, and a real first output. Run required repository
   checks and rebuild the beta before claiming the redesign is available.

Production promotion, a different account-recovery trust model, new pricing or
free-credit policy, automatic social publication and a new agent catalogue are
outside this change.
