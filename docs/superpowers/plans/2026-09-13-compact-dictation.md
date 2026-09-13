# Compact Dictation Implementation Plan

**Goal:** Bundle quantized Whisper Base English for offline composer dictation on macOS and Windows with low idle memory.

**Architecture:** A pinned model manifest drives a checksum-verified build-time resource download. Tauri resolves its bundled resource; Electron stages the same directory beside its native helper. A safe whisper-rs CPU decoder loads on demand and drops its context after each bounded recording. Existing draft, cancellation and theme behavior stays in place.

**Tech Stack:** whisper-rs 0.16, whisper.cpp, Node resource staging, existing Rust/Tauri/Electron bridge.

The user approved implementation; execute inline. No local application builds or Rust compilation: hosted CI supplies those gates.

- [x] Add `desktop/scripts/stage-dictation-model.mjs` and fault tests for checksum mismatch, truncation, oversized data and verified cache reuse. Pin model revision, SHA-256 and length in `desktop/dictation-model.json`. Include MIT attribution.
- [x] Stage resources from Tauri's before-build hook and Electron's packager; check the packaged copy. Keep download work outside renderer builds and Rust build scripts.
- [x] Replace Parakeet in `desktop/src-tauri/src/dictation.rs` with CPU Whisper, language English, two threads, no carry-over context, no transcript logging, and dropped model state after decode. Resolve paths in a separate `dictation_model.rs`; no runtime network fallback.
- [x] Add a bounded deadline to inference; retain silence filtering, 60-second input cap and existing single-decoder guard.
- [x] Run focused staging/lifecycle tests, format and inventory checks. Update Cargo.lock using dependency resolution only.
- [ ] Push signed-off changes to the dictation PR, arm auto-merge, and dispatch Windows typecheck for the exact branch. Hosted Rust/build results remain separate from packaged real-microphone and low-memory Windows proof.

Acceptance: model stage rejects incorrect bytes, packaged-resource paths agree across hosts, focused regressions pass, hosted platform checks pass. Real accented/noisy microphone accuracy and packaged peak RAM remain a subsequent device acceptance gate; the single-sample 371 MiB Python benchmark is not application proof.
