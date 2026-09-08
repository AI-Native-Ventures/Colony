# Colony conversation example

## Goal

Replace the misleading hero dashboard with an accurate, clearly illustrative explanation of how people and AI work together in Colony. Preserve the approved landing copy, gradients, ant motion and early-access form.

## Evidence and design

The current `BusinessTour` renders Inbox / Work / Clients / Team from a September 7 recommendation as invented application screens. It also turns a sample answer directly into an execution-state change. The positioning task and current source instead ground the explanation in shared conversations, job threads, questions and openable work. `PRODUCT.md`, `TaskThreadContext.tsx`, `AskDetailCard.tsx` and the workspace focus-mode design support these relationships. Source presence does not prove the proposed complete leader/worker execution loop.

Use an editorial illustration with one shared job conversation on the left and a readable example result alongside it. Label all content as illustrative. Show a business owner asking for a comparison of two supplied quotes, an AI teammate clarifying the priority, and a colleague replying. Show the actual sample comparison and its arithmetic. Do not invent application navigation, status changes, timers, execution controls or a purchase action. The only optional interaction opens supplied sample details using native disclosure.

## Implementation

- Replace `BusinessTour.tsx` and `business-tour.css` with focused `WorkConversation.tsx` and `work-conversation.css`; update the Hero import.
- Retain the `inside-colony` anchor for existing links, but label navigation `See an example` to describe its real destination.
- Use existing type, ant geometry and colours; two columns on wide screens, conversation then result on phones. Keep every message and number readable at 320px without horizontal overflow.
- Update the site README to describe the example and its actual interactions.

## Acceptance

Independently review the example against source and positioning evidence. Confirm there is no invented app shell or simulated execution. Check the arithmetic: R2,700 minus R2,400 equals R300 for the same quantity of 100 folders. Verify disclosure, reading order, contrast, desktop/mobile layout, navigation, unchanged form and existing motion controls in the browser. Run site checks/build and the required repository gate, then protected PR/deploy, exact served bytes and fresh public-browser verification. Preserve unrelated files and clean up task-owned processes.

## Local verification

- Independent fidelity review found no blockers. The invented dashboard component and styles were removed; the old shell and strings are absent from the built page.
- Site check passed for 42 files and three email tests; TypeScript and Vite build passed. Final local assets: `index-D1vxZaxY.js` and `index-C0G_KtlE.css`.
- Browser checks passed at 320, 390, 800 and 1280 pixels with no overflow or console errors. The sample quote disclosure opens by mouse and closes with Enter; the readable comparison shows the correct R300 difference. Header/footer example links and required application validation still work.
- Full `just ci` passed on its first run for this correction, including 6,801 desktop JavaScript tests and 967 mobile tests (one mobile skip). Log: `/private/tmp/colony-conversation-example-ci.log`. No unrelated source or tests were changed.
- Protected PR checks, deployment, exact served bytes and public-browser acceptance remain separate release gates.
