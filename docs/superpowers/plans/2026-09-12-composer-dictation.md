# Composer Dictation Implementation Plan

**Goal:** Implement the approved mic → recording → editable draft → explicit Send interaction, using the selected theme colors.

**Architecture:** Capture bounded mono PCM using an AudioWorklet. Decode on-device through bundled quantized Whisper Base English via NativeBridge, shared by Electron and Tauri. Keep dictation separate from the huddle pipeline so audio cannot become a posted huddle transcript. Recording is limited to 60 seconds; Stop flushes the final audio frame. A session controller invalidates pending capture/transcription on cancel, navigation, and unmount. Insert plain text at the captured editor selection, preserving surrounding rich text and attachments.

**Tech Stack:** React, Tiptap, Web Audio, NativeBridge, Rust, whisper-rs/whisper.cpp. Model resource and portability gates are in the 2026-09-13 compact-dictation plan.

## Acceptance gates

- [ ] Native command validates PCM bounds and sample values, reports missing models, serializes decoding, and returns text without publishing messages.
- [ ] Capture releases the microphone on stop/cancel/failure; flushes the final worklet frame; displays actual audio levels; enforces 60-second limit.
- [ ] Controller tests prove cancellation during permission, stop, and decode cannot insert stale text; errors preserve drafts; duplicate starts are blocked.
- [ ] Composer mic sits beside Send; recording controls, waveform, and focus use primary/theme tokens; draft remains editable after Stop; active dictation blocks all submit paths.
- [ ] Focused tests, TypeScript, formatting, native inventory/boundary checks pass. Full builds and Rust validation run on GitHub, not locally.
- [ ] Open PR against develop with auto-merge and report exact proof reached; packaged microphone recognition remains a separate live gate.

## Files and responsibilities

- `desktop/src-tauri/src/dictation.rs`: readiness and bounded PCM-to-text commands, validation tests.
- `desktop/src-tauri/src/lib.rs`, `desktop/src-tauri/src/command_registry.rs`: command registration shared with Electron.
- `desktop/public/dictation-worklet.js`: bounded PCM batches plus final flush.
- `desktop/src/features/messages/lib/dictationCapture.ts`: browser capture and resource cleanup.
- `desktop/src/features/messages/lib/dictationSession.ts`: independently testable async session lifecycle.
- `desktop/src/features/messages/lib/useComposerDictation.ts`: React/editor adapter and context invalidation.
- `desktop/src/features/messages/ui/ComposerDictation.tsx`: theme-aware mic, recording controls, error/review states.
- `desktop/src/features/messages/ui/MessageComposer.tsx`, `MessageComposerToolbar.tsx`: composer integration and send guards.

## Execution

1. Write controller and worklet regression tests and run them before implementation; expect missing-module or unregistered-worklet failure.
2. Implement bounded native decode using the existing recognizer config. Add Rust validation tests for empty, oversized, misaligned, non-finite PCM.
3. Implement capture, controller and React adapter; test late permission resolution, cancel during decode, failures, Stop insertion, and max-duration/flush.
4. Integrate accessible theme-aware controls; verify rich-text insertion and explicit-send behavior with component tests.
5. Run focused checks once, fix any failures, update native inventory, commit with signoff, push and open a PR. Do not run local app builds, Rust compilation, or full CI.

## Focused validation

- 24 focused tests pass: capture/session/worklet lifecycle, real Tiptap insertion and undo, navigation, auto-send invalidation, themed controls and keyboard cancellation, Electron permission isolation, and existing auto-submit scheduling.
- TypeScript, Biome on all changed frontend files, native inventory, bridge boundary and file-size ratchet pass. Rust files formatted without compilation.
- Added browser smoke test exercising a real AudioWorklet with synthetic microphone input and mocked native recognition, including two theme color screenshots. Runs in GitHub CI.
- Electron microphone policy now allows audio only from the trusted main frame. macOS packaging declares the microphone usage purpose; existing signing defaults already include audio-input entitlement.
- Native decoding and browser smoke results remain pending GitHub. Packaged real-microphone recognition remains unproven.
