# Inline Model and Reasoning Implementation Plan

**Goal:** Let an owner choose the model and supported reasoning effort for the next reply from one existing teammate in a channel or thread, preserving every saved default.

**Architecture:** Carry the canonical adapter model ID (including an advertised effort suffix) on one signed `agent-reply` message tag. The native sender and relay validate that tag; the ACP queue isolates the request, and the targeted owner's agent applies it strictly in a disposable conversation session. Controls derive their choices from runtime/model discovery, with absent effort options explicitly unavailable rather than guessed.

**Tech stack:** React/TypeScript, current model discovery IPC, Nostr signed messages, Rust core/relay/ACP, existing Node test runner and Playwright CI.

## Acceptance gate

- The composer exposes Model and Reasoning for one selected existing owned teammate. Selecting changes only the next submitted message, never agent defaults or an active run.
- Signed wire tag: `["agent-reply", "1", "<target pubkey>", "<canonical model ID>"]`. Exactly one tag; kind 9 only; target must be a `p` recipient. The canonical ID includes a reasoning suffix only when that exact pair is advertised.
- The harness accepts the request only when its signer is the configured agent owner and target is this agent. Unsupported adapter options or apply failures prevent inference with a different model.
- A scoped request is never coalesced with another queued request or injected as active-turn steering. The override session is invalidated on every terminal path; sibling conversations and saved defaults survive.
- Loading, discovery error, unsupported model/effort, requested and applied are distinct. A send acknowledgement never claims model application.

## Steps

- [x] Add the shared Rust tag parser/validator in `crates/buzz-core/src/agent_reply.rs`, registration in `lib.rs`, focused tests, relay ingestion validation and native optional `replyModelTags` validation.
- [x] Add the separate outgoing tag bucket in the existing sender, including Rust native command transport (shared by Tauri and Electron's generated invocation bridge). Keep the composer callback signature compatible by carrying the tag in its existing merged outgoing tags.
- [x] Add `replyModelSelection.ts`, `useReplyModelSelection.ts`, and `ReplyModelControls.tsx` under agents. Use `AgentModelInfo`, `baseModelOptions`, `effortsForModel`, `modelAllowsInheritedEffort`, and existing runtime descriptors. Capture the choice with the send, enforce target retention after mention resolution, and reset only after successful submission.
- [x] Add `crates/buzz-acp/src/reply_model.rs` for owner/request validation and strict adapter application. Isolate tagged queue entries, keep them out of steering, and invalidate the scoped session on return without changing `desired_model`.
- [x] Add focused Node contract tests and a browser regression spec for channel/thread composition, supported effort pairs, defaults preservation, discovery errors and target changes. Add Rust parser/queue/application tests for CI; do not run Cargo or desktop builds locally.
- [x] Update agent configuration contributor rules and protocol documentation. Run only targeted Node checks and source formatting; root runs GitHub CI, reviews, commits and pushes.

## Explicit limits

No conversation preference, comparison UI, active-run restart, provider/harness switching, image-engine switching, worker reconfiguration, new spend, or automatic fallback. Runtime/model catalogs may legitimately expose no selectable reasoning values; the UI must state that rather than invent them.

## Verification policy

User prohibited heavy local builds and full suites. Local validation is limited to focused Node tests and formatting checks. Rust and browser execution are CI gates and remain unproven until the root reports those results.

## Source checkpoint

Implemented the signed request through composer, native IPC, relay validation,
owner-targeted ACP dispatch, and strict runtime application. A requested message
label is distinct from the acknowledged `reply_model_applied` observer record.
The ordinary conversation session, delivery ledger and turn count are preserved;
temporary sessions close when supported, with a bounded budget otherwise.
Credits discovery uses the existing native lease and the already-running gateway
route; served text models and supported pairs share the bundled runtime helper.
Native and browser execution, Rust compilation and fixture tests remain CI gates.
Quick Node checks passed for model/effort projection, request/recipient validation,
send-tag transport and the extracted draft auto-submit scheduler.
