# Onboarding redesign

Status: approved flow, ready for implementation planning
Date: 2026-08-21
Scope: onboarding UX only. Auth, payments, scrape and invites are named as
contracts here and specified separately.

## Problem

Colony was forked from Buzz, which was built for developers. The first cohort
of trusted testers was overwhelmingly non-technical, and the overwhelming
majority said they could not get started. They do not know what a CLI is, what
a terminal is, what ACP is, or what an API key is. The current flow assumes all
four.

The download button has been removed from the marketing site so no new users
can arrive until this is fixed.

Current state in the repo:

- `desktop/src/features/onboarding/machineOnboarding.ts` plus `SetupStep`,
  `DefaultConfigStep`, `BackupStep`, `DownloadKeyStep`: runtime and key setup,
  developer-facing.
- `desktop/src/features/onboarding/ui/OnboardingFlow.tsx`: the community flow,
  two steps, `profile` then `avatar`.
- `desktop/src/features/onboarding/ui/agentReadiness.ts` and
  `onboardingRuntimeSelection.ts`: existing CLI and runtime detection. The new
  "preparing your workspace" screen builds on these rather than replacing them.

## Principles

1. **Nothing developer-facing on screen.** No key, no nsec, no terminal, no API
   key, no CLI name the user did not already have installed.
2. **Never trap the user.** Every blocking step has a timeout and a way
   forward. A dead website or a hung binary probe must not end onboarding.
3. **Tell the truth in copy.** The workspace step reads the user's filesystem.
   Copy says so. No cheerful misdirection.
4. **Ask for money after value, not before.** Payment is requested on the
   screen after the user reads an accurate description of their own business
   that they did not write.
5. **Who pays for inference decides who sees a wall.** Users with their own CLI
   run on their own subscription and cost Colony nothing, so they are not
   walled. Users without one run on Colony's spend and are.

## Flow

```
1  Create account       email, password, name, city
2  Recovery code        one-time code
3  Company              company name
4  Preparing workspace  probe for installed CLIs
   |- found  -> 5a  installed agents listed, pick default brain
   |- none   -> 5b  Colony agent installed for them
6  Business             launched or pre-launch, website or not
7  Reading your site    scrape plus describe (Colony funded, once per account)
8  Your business        editable description
9  Credits              $5 minimum, paid via Paystack
   |- CLI branch:    skippable
   |- Colony branch: hard gate
10 Invite team          emails, or "just me for now"
-> Colony
```

Progress indicator shows "Step N of 10" throughout. On the CLI branch screen 9
is skippable but still counted, so the number never changes meaning mid-flow.

---

## Screen 1: Create account

**Purpose:** account exists, identity key generated, minimum viable profile.

**Fields**

| Field | Type | Validation | Notes |
|---|---|---|---|
| Name | text | required, 1 to 64 chars | full name, used for display |
| Email | email | required, RFC-valid, unique | account identifier |
| Password | password | required, min 10 chars, zxcvbn score >= 2 | strength meter inline |
| City | text | optional | prefilled from IP, always editable |

**Copy**

- Title: "Welcome to Colony"
- Subtitle: "Let's get your workspace set up. This takes about two minutes."
- Password helper: "At least 10 characters."
- City helper: "We use this for timezone and local context."
- Primary button: "Continue"

**City prefill:** resolved server-side from request IP at page load, written
into the field as a normal editable value. No browser geolocation prompt, no
Google Maps dependency. If lookup fails or is slow (> 1s), the field renders
empty and unlabelled as an error. It is optional; nothing blocks on it.

**Dropped from the original plan:** date of birth and gender. No stated product
use, and they sit at the highest-friction point in the flow. If the data is
wanted for statistics, ask post-signup where non-response does not cost a
signup. Both belong in the profile as optional fields.

**States**

- `idle`, `submitting`, `error`.
- Email already registered: inline error on the email field, "That email
  already has a Colony account", with a "Sign in instead" link.
- Network failure: form stays filled, banner with retry. Never clear the
  password field on a network error.

**On submit:** call `auth.signUp`. A keypair is generated client-side, encrypted
with a key derived from the password, and the encrypted blob is stored against
the email. The user is never shown the key and never told one exists.

---

## Screen 2: Recovery code

**Purpose:** make password loss survivable. Required by the email and password
model: the password decrypts the identity key, so without a second factor a
forgotten password is an unrecoverable account.

**Copy**

- Title: "Save your recovery code"
- Body: "If you forget your password, this code is the only way back into your
  account. Colony cannot reset it for you."
- Code: displayed in monospace, grouped, with a copy button and a download
  button ("Save as file").
- Confirmation: a checkbox, "I've saved my recovery code", which gates the
  Continue button.

**Deliberately not** framed as a key, a seed phrase, or a backup. It is a
recovery code, which is a concept non-technical users already meet at banks and
password managers.

**States:** `idle`, `copied`, `downloaded`, `confirmed`. Continue is disabled
until the checkbox is ticked. Back is disabled: the account already exists.

---

## Screen 3: Company

**Purpose:** create the company entity the workspace hangs off.

**Fields:** company name, text, required, 1 to 80 chars.

**Copy**

- Title: "What's your company called?"
- Subtitle: "This becomes your workspace. You can change it later."
- Primary button: "Create workspace"

**States:** `idle`, `submitting`, `error`. Name collisions are allowed:
companies are scoped per account, not globally unique.

---

## Screen 4: Preparing your workspace

**Purpose:** detect installed agent CLIs, and decide the branch for the rest of
the flow. This is the only screen with no user input.

**What actually runs**

Probe for each known agent runtime, in parallel, reusing
`agentReadiness.ts`:

| Runtime | Detection |
|---|---|
| Claude Code | binary on PATH, then config presence |
| Codex | binary on PATH, then config presence |
| OpenCode | binary on PATH, then config presence |
| Pi | binary on PATH, then config presence |
| Goose | binary on PATH, then config presence |

Detection is two-phase and cheap first:

1. **Presence:** binary resolves on PATH, and a config file or credential store
   exists for it. Cheap, no tokens, no network.
2. **Liveness:** only for runtimes that pass phase 1, a minimal probe to
   confirm it is actually configured and answers.

Phase 2 spends the user's own quota, so it is one minimal request per runtime,
never a real prompt, and it is skipped entirely if phase 1 found nothing.

**Timeouts:** each probe is capped at 5s, the whole screen at 8s. Any runtime
that has not answered by then is treated as absent. A hung binary can therefore
delay the flow by at most 8 seconds, never block it.

**Copy** (honest: this screen reads the user's filesystem)

- Title: "Setting up your workspace"
- Status line, cycling as each stage completes:
  - "Creating your workspace"
  - "Checking what's already on your computer"
  - "Getting your agents ready"
- No progress percentage. An indeterminate animation, because the duration is
  genuinely unknown.

If the probe finishes in under 2s, hold the screen to 2s minimum so it reads as
a step rather than a flash. Do not pad beyond that.

**Branch:** one or more runtimes pass phase 1 and phase 2 goes to screen 5a.
Otherwise 5b. The branch is recorded on the account as `onboardingTrack`
(`byo` or `colony`) but is not permanent: a `byo` user who later removes their
CLI, or a `colony` user who installs one, is handled by normal settings, not by
re-running onboarding.

---

## Screen 5a: Choose your default brain (CLI branch)

**Purpose:** pick which detected runtime powers the user's agents by default.

**Copy**

- Title: "You're already set up"
- Subtitle: "We found these on your computer. Which should your agents use by
  default?"
- Each option: runtime name, icon, and a status line ("Ready"), rendered with
  the existing `RuntimeIcon`.
- Helper below: "You can change this any time, and use a different one per
  agent."

**States:** one runtime is preselected (first by a fixed preference order, not
by detection order, so the choice is stable across runs). Continue is enabled
immediately.

**Term note:** the user-facing word is "brain". "Runtime", "harness", "CLI" and
"ACP" never appear on screen.

---

## Screen 5b: Colony agent setup (no-CLI branch)

**Purpose:** install the Colony agent runtime so the user has a working brain
without ever meeting a terminal.

**Copy**

- Title: "Setting up your agent"
- Body: "Colony is installing its own agent so you're ready to go. Nothing for
  you to do."
- Progress: indeterminate, with a status line.

**Consent:** this writes to the user's machine, so the body text says so
plainly. No separate consent dialog: installing the thing the product needs to
function is within what "set up my workspace" already means, and a second
prompt here would read as a scary interruption to the exact user this flow is
for.

**Failure:** install fails (no network, permissions, disk) shows a retry, and a
"Continue anyway" that routes to a degraded state where agents are unavailable
until setup is repeated from settings. Never a dead end, and never a terminal
command as the remedy.

---

## Screen 6: Business

**Purpose:** the two facts that shape everything downstream.

**Question 1:** "Is your company already up and running?"

- "Yes, we're live and making money"
- "Not yet, we're still building"

Stored for segmentation. Does not branch the flow.

**Question 2:** "Do you have a website?"

- Yes, plus a URL field: required if yes, must parse as a URL, scheme optional
  and defaulted to `https://`.
- No.

**Routing:** yes goes to screen 7. No skips to screen 8 with an empty
description and a prompt to write one.

---

## Screen 7: Reading your site

**Purpose:** the one funded moment. Fetch the site and generate a description
of the business.

**What runs:** `scrape.describeBusiness(url)`. Fetch the landing page and up to
4 linked pages on the same origin (about, product, pricing, services),
summarise into 2 to 4 sentences.

**Cost and recoupment:** runs on Colony's inference spend via the house
provider (`LLM_PROVIDER=deepseek`, dynamic through the Vercel AI SDK, per the
repo convention). One per account, enforced by a counter on the account, not by
client state. The cost is recorded against the account and recouped from the
user's first credit purchase, so it is a float, not a giveaway. A user who
never buys credits never uses the workspace, so the exposure per abandoned
signup is a fraction of a cent.

**Copy**

- Title: "Reading your website"
- Status lines: "Fetching your site", "Understanding what you do", "Writing it
  up"
- Cannot go back or forward while this runs. The back control is hidden, not
  disabled-with-tooltip, because there is nothing useful to say about it.

**Timeouts:** fetch capped at 10s per page, whole step at 30s.

**Failures**, all landing on screen 8 with an explanation rather than an error
screen:

| Failure | Handling |
|---|---|
| DNS or connection failure | "We couldn't reach that site." Description empty, user writes their own. |
| 403 / bot wall / Cloudflare | Same as above, wording identical. Do not explain bot protection to this user. |
| Page loads but is empty or JS-only | Same as above. |
| Model call fails | Retry once, then same as above. |
| Timeout | Same as above. |

---

## Screen 8: Your business

**Purpose:** confirm or correct the description. This is the payoff screen.

**Copy**

- Title, scraped path: "Here's what we understand about your business"
- Title, no-website path: "Tell us about your business"
- Body: an editable multi-line text area, prefilled with the generated
  description where there is one.
- Helper: "Edit anything that's not right. Your agents use this."
- Primary button: "Looks right"

**Validation:** non-empty, 20 to 1000 chars. On the no-website path the field
starts empty and the button is disabled until 20 chars are entered.

---

## Screen 9: Credits

**Purpose:** payment, through Paystack. Behaviour differs by branch.

### Currency: USD, end to end

Everything is USD and nothing converts. Agent spend is metered in USD because
that is what inference costs, credits are denominated in USD, and Paystack
charges in USD. Accepting USD is the reason Paystack was chosen.

This means the Paystack account must have USD enabled. Confirm that on the
account before launch, since a South African Paystack account is not USD
enabled by default and the failure appears only at the first live transaction.

Amounts go to Paystack as integer cents: $5.00 is `500`.

**Both branches see:**

- Title: "Put your colony to work."
- Body: what credits pay for, in plain words.
- Amount selector: $5, $10, $25, plus a custom amount (min $5).
- A handoff panel, not a card form: "You will pay with Paystack, then come
  straight back here. Card or instant EFT. Colony never sees your card
  details."

**No card fields anywhere in Colony.** Paystack hosts the payment, which keeps
card data out of the product entirely and keeps Colony out of PCI scope. The
relay creates the transaction with `PAYSTACK_SECRET_KEY`; the desktop app only
ever holds `PAYSTACK_PUBLIC_KEY`. Amounts go to Paystack as integer cents
($5.00 is `500`).

**Environment guard:** the relay refuses to start in production when
`PAYSTACK_SECRET_KEY` begins with `sk_test_`. Test keys in production otherwise
present as payments that appear to work and never settle.

**CLI branch:** a secondary action, "I'll use my own agent for now", which
skips to screen 10. These users cost Colony nothing at rest, so a wall here
would be friction with no economics behind it. They meet the credits screen
again, in context, on their first credit-consuming action.

**Colony branch:** no skip. Body gains one line: "Your agent runs on Colony, so
credits are what keep it working." Every action this user takes is Colony
inference spend, so this is where it is paid for.

**Recoupment:** the funded description from screen 7 is debited from the first
payment, shown on the receipt as a line item, not hidden. A surprise deduction
is worse than a disclosed one.

**States:** `idle`, `leaving`, `abandoned`, `succeeded`. The user leaves the app
for Paystack, so two cases matter more than they would in an inline form:

- **Abandoned:** they close the Paystack page or fail payment. Copy is "That
  payment was not completed. Nothing has been charged." Button becomes "Try
  again". Never imply a charge that did not happen.
- **Paid but the callback never arrives.** The webhook is the source of truth,
  not the browser returning. On return, poll the balance; if credits are
  present, continue regardless of what the redirect said. A customer who paid
  and got stranded on a payment screen is the worst outcome this flow has.

**Verification is server side, always.** Credit the ledger on a verified
Paystack webhook (signature checked against the secret key), never on the
browser's return URL, which anyone can forge.

---

## Screen 10: Invite your team

**Purpose:** optional multiplayer.

**Copy**

- Title: "Who else is joining?"
- Body: an email input that turns each entry into a removable pill on Enter,
  comma, or blur. Validates per entry.
- Primary: "Send invites"
- Secondary: "It's just me for now"

**On send:** `invites.invite(emails[])`. Each recipient gets an email with a
deep link that downloads the app and joins them to the company.

**Blocked dependency:** the download button is currently removed from the
marketing site, so invite links have no working destination. Screen 10 ships
disabled or hidden until download is restored. Shipping it before then sends
people to a dead end, which is a worse first impression than not being invited
at all.

---

## Persistence

Each screen commits on Continue, so a crash or quit resumes at the next
unfinished screen rather than restarting.

| After screen | Persisted |
|---|---|
| 1 | account, encrypted key, name, city |
| 2 | recovery code acknowledged |
| 3 | company |
| 4 | `onboardingTrack`, detected runtimes |
| 5a / 5b | default brain, or Colony agent install state |
| 6 | launch status, website URL |
| 7 | generated description, funded-call counter |
| 8 | final description |
| 9 | credit balance |
| 10 | invites sent |

Resume rule: on relaunch, route to the first screen whose data is absent.
Screens 4 and 7 re-run on resume rather than restoring a partial result.

## Contracts required from other projects

```
auth.signUp(email, password)   -> { pubkey, encryptedKey, recoveryCode }
auth.signIn(email, password)   -> { keypair }
auth.recover(email, code)      -> { keypair, resetToken }

payments.createTransaction(usdCents >= 500, email) -> { authorizationUrl, reference }
payments.verify(reference)                         -> { paid, usdCents }
payments.balance(pubkey)                           -> { usdCents }
payments.debitFunded(pubkey, usdCents)             -> void  // screen 7 recoupment
payments.webhook(signature, body)                  -> void  // credits the ledger

scrape.describeBusiness(url) -> { description, sourcePages } | TypedFailure

invites.invite(emails[]) -> { links }
```

## Telemetry

Per-screen: entered, completed, abandoned, time on screen. The point is to find
the next drop-off cliff, since this redesign exists because of one. Also track:
branch split (`byo` vs `colony`), scrape success rate by failure type, and
skip rate on screen 9 for the CLI branch.

## Out of scope

- Auth service internals, key escrow, password reset flow.
- Payments integration, metering, balance display inside the app.
- Scrape implementation.
- Invite emails and deep-link handling.
- Re-enabling the download button.
- Migrating existing accounts to email and password.

## Open questions

1. Does an existing Buzz-era account with only a key need a path to attach an
   email and password? Assumed yes, but out of scope here.
2. Team invite recipients: does the invitee run this same onboarding, or a
   shortened join flow? Assumed shortened, spec pending.
3. Refunds on credits, and what happens to the recouped description cost if the
   user refunds. Payments spec.
