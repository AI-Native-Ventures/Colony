# Colony redesign: implementation and verification

## Implemented scope

The approved founder and workspace designs are implemented in the desktop app.
Founder setup has an account form, a recovery-code checkpoint and one business
form. Existing sign-in, key import, recovery, community membership and Welcome
paths remain available. The Electron beta package now bakes the hosted account
endpoint instead of relying on a developer shell's relay configuration.

Colony's existing accent selection now colours the frame, channel and adjacent
thread together. Soft mesh, Diagonal wash and Halo live in Settings > Appearance
and persist through the existing community preference record. Reading surfaces
remain opaque and quieter than the surrounding gradient. Decorative ants stay
outside the reading column. Normal message typography, native thread resizing,
focus mode, draft ownership and existing navigation are preserved.

Agent messages and one-to-one DMs show the same job title and Agent marker.
The definition editor exposes the existing persisted job-title field. Existing
avatars retain their design; missing avatars use a stable identity colour that
does not change with the workspace accent. Rank, manager and execution settings
retain their existing meaning. Inline work continues through the existing Blocks
renderer; this change does not add a social publishing workflow.

## Local application checks

Browser checks render the production React components through the repository's
E2E bridge. Identities, relay events, account responses and native save results
are synthetic. These checks establish rendered behaviour, not a live hosted
account signup or publication.

| Gate | Result |
| --- | --- |
| Final onboarding screens, narrow/short windows, import geometry, recovery retry and website context | 14 Playwright tests passed after rebuilding the final styles |
| Returning account sign-in and taken-email escape | 2 Playwright tests passed |
| Agent message/DM identity, long messages with a native Block, stable colour and editable role | 3 Playwright tests passed |
| Existing key/profile/recovery and second-identity paths | 11 Playwright tests passed |
| Existing onboarding integration suite | 51 Playwright tests passed |
| Additional business and existing credits display | 5 Playwright tests passed |
| Thread split/focus/width and light/dark appearance reload | 6 Playwright tests passed |
| Theme and appearance suite | 24 Playwright tests passed |
| Desktop unit suite | 6,859 tests passed |
| Native desktop unit suite | 2,922 passed; 25 explicitly ignored environment/performance cases |
| Repository gate | `just ci` passed, including Rust checks/tests, desktop build/tests, web build and 967 mobile tests |
| Final source checks | TypeScript, Biome, file-size, rem typography, native inventory and bridge boundary passed |

The final onboarding screenshots were visually inspected at 1440px and 360px;
the short-window gate also checks 1280×720 and 800×500. Workspace evidence includes
violet, warm pink and dark green, populated side-by-side conversations, the role
editor and an existing inline report. Screenshot capture waits for animations;
appearance screenshots were checked for distinct hashes.

## Failures found and corrected

- The CSS build lowered `light-dark()` into unresolved switches, making the
  intended form backgrounds transparent. Explicit light/dark tokens and real
  computed-colour assertions now prove opaque fields and cards.
- The primary-button selector matched attributes the shared Button does not
  render. Scoped classes now apply the dark CTA and an opaque disabled state.
- Ants crossed introductory copy, and dark placeholders inherited a light-theme
  colour. Decoration masks and explicit placeholder tokens fix both.
- The business form exceeded a 720px-tall window by 13px. Reducing only short
  desktop chrome padding removes the overflow without shrinking fields or text.
- A browser-import identity query mounted outside its query provider and stopped
  startup. The eligibility check now uses the existing native identity API.
- A previous community's ready flag could complete a new community handoff.
  Completion now requires the exact target relay for the current identity.
- Rejected email and taken-address attempts prevented corrected retries. Only
  definitive rejection releases the exact pending attempt. Network uncertainty,
  locked responses and incomplete ownership records retain it.

New state-transition regressions were observed failing before their fixes.
An independent review found the retry defects, then re-ran the previously failing
ownership probes and confirmed closure. Native recovery tests cover identity and
attempt binding, registered-state protection, durable code reuse and exclusive
owner-only file export.

## Remaining proof stages

The GitHub PR/merge gate and installable Electron package remain separate from
the passing local results above. The packaged signup
script verifies the real renderer KDF and native backups against a local HTTP
fixture, then relaunches to verify recovery continuity. Its optional screenshots
mask the recovery code and its cleanup removes only the synthetic test profile.
An actual OS save-dialog interaction and a real hosted signup are separate from
the mocked save and local-account fixture checks.
