# Colony: explain how an owner runs the business

The owner approved the multicolour gradient and ant visual style, but rejected the page's story. This revision replaces the service-output demo and every rendered reference to the old service examples. The audience is people starting or running a business, with no assumed AI or software knowledge. The CTA remains Apply for early access, using the existing reviewed email draft to basheer@ainative.ventures.

## Source and limits

Read the actual Define startup product positioning task (01a06e85-ca80-7382-8478-a5c229d699a0), including ready-equipped teammates, accountable leaders, worker delegation and one owner conversation. Cross-check its saved September 5 skills-first/business-primitives reviews and September 7 launch recommendation in the primary checkout. The latest requested broad business positioning overrides those documents' older agency-first marketing choice.

The September 7 visible-product recommendation names Inbox, Work, Clients and Team. Current source contains inbox/actions, tasks with ownership and threads, client records and team surfaces. The simplified navigation and complete managed workflows remain proposed. The marketing tour must say it illustrates the planned experience, use fictional information, and never be presented as a live product run or final screenshot. Do not promise accounting, payroll, inventory, automatic outreach, guaranteed results, unlimited work or full support for every business process.

## New page story

1. Define Colony in the hero as an app to manage business work with people and AI teammates. Explain what AI teammates are in ordinary language. Lead with assigning jobs, following progress and reviewing results.
2. Replace the bakery/output demo with an interactive business workspace tour. Its four views answer: what needs my decision, who is doing what, what do we know about this client, who can help. Match proposed Inbox / Work / Clients / Team navigation. Use one fictional staff-training business and linked proposal/research/report tasks, never the rejected service examples.
3. Explain the practical sequence: describe the business and share useful information; tell a ready-equipped teammate the job and deadline; follow progress, answer questions and inspect the result. Show exactly what an owner might type and what comes back, without implying a universal live capability.
4. Explain the responsibility split simply: owner chooses priorities and makes decisions; AI team handles assigned work and brings back results; people can work alongside it. Hide model/runtime/worker machinery from normal copy.
5. Explain how starting and existing businesses use the same place. Avoid claiming every business function is complete.
6. Rewrite all FAQs and application copy to fit this story. Preserve accessible validated email handoff.

## Acceptance gate

A new visitor can answer what Colony is, what an AI teammate is, what they do first, what they see during work, and how decisions/results return. No rendered website/social/cake/agency examples, no jargon, no fabricated current product claims. All four tour views work by mouse and keyboard, remain readable on 320px/390px/768px/desktop, and fit the approved gradient/ant style. Check form draft/validation, navigation, console, reduced-motion and horizontal overflow. Run site check/typecheck/build and required repo CI. Release only after the local gate, PR checks, exact deployed assets and fresh public-browser proof. Preserve unrelated primary-checkout work.

## Local review evidence

- Replaced the old hero illustration and body sections with BusinessTour and BusinessGuide. Navigation, FAQ, application intro and sharing metadata now follow the same business-owner story.
- A separate source reviewer checked the actual product recommendations and the new active component graph. Corrected an inconsistent client status, clarified the hero instruction and removed language implying owners must organise individual AI workers.
- Site check (Biome plus three email-encoding tests), TypeScript and production build passed. Active page/metadata scan contains none of the rejected service examples.
- Browser verified at 320, 390, 768, 1280 and 1440px: no horizontal overflow; inspected phone, tablet and desktop compositions. Desktop headline has no decorative-ant intersection.
- Inbox choices work with pointer and Space; section navigation works with Enter. Selecting one day or two days updates the example answer, Work status and client information. Meeting summary opens to readable content. These are checks of the landing-page illustration only.
- Empty application and whitespace-only work are rejected. A completed form creates the fixed-recipient draft with all entered information and moves focus to it. Editing an answer clears the draft. No application was sent.
- FAQ opens and explains AI teammates. No browser warning/error logs observed. Existing reduced-motion CSS is retained; the tour has no motion or timer.
- Full repository CI, PR gates and deployed-byte/public-browser verification are separate release gates; record their outcome after they complete.
- Final keyboard review caught the Work-to-Inbox button unmounting itself and leaving focus on BODY. Reproduced before fixing. The button now focuses the Inbox panel after the view change; browser recheck confirms the next Tab reaches “One day”. Site checks/build passed again after this targeted fix.
- Full `just ci` passed (log: /private/tmp/colony-owner-story-ci.log). Final accessibility review also identified low-contrast supporting text. Darkened explanatory labels in the new tour/guide to the existing muted ink palette, retaining the gradients and ant geometry; browser confirmed the computed colours and readable layout. Site check and build passed after these CSS-only corrections.
