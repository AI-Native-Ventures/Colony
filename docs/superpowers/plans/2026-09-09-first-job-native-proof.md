# Hosted native first-job proof implementation plan

**Goal:** Fix scoped first-job Team readiness and prove fresh worker preparation, delegation, returned work and Scout review through the packaged app on GitHub.
**Architecture:** Reuse the joined fixture and deterministic provider; replace Docker with owned native services and manual staffing with the actual approval UI.
**Tech stack:** Electron, Playwright, native Rust relay/ACP, PostgreSQL 17, Redis 7, MinIO, GitHub macOS 15.

- [x] Add a checksum/commit-pinned GitHub-only service build script and process launcher. Preserve real S3 bucket setup and relay conformance admission; fail on early exit and clean every owned process.
- [x] Refactor relay fixture backing-service setup behind the existing query/close contract. Keep normal Docker fixture support; use explicit native tools on the hosted job.
- [x] Replace manual company and worker writes with signed readback and the actual Approve team and start action. Retain zero-credit and no-early-work assertions; identify returned native worker from the approval receipt.
- [x] Adapt provider context to unmodified approved persona prompts and lazily read the native worker after approval. Retain actual CLI exit/accepted checks and all output, completion and reload evidence.
- [x] Add meaningful fixture contract/unit regressions; execution remains on GitHub only. Add a separate gating hosted workflow with cached pinned service builds and private fixture package, full relay build, artifact upload and exact proof fields.
- [x] Open draft PR #675 and diagnose hosted native failures. Dependency #669 is merged. Run 34445569128 provides exact red-before evidence: verified Task action and conflict receipt, matching native WebSocket refusal for a missing coordination Team, zero Task/model calls.
- [ ] Add the scoped native Team publication/readback barrier, preserving manual authority, owner/relay fencing and deletion history; independently review its regressions.
- [ ] Prove deterministic recovery after physical loss of one genuine already-synced Team in the isolated relay. Require compile-gated native before-sign evidence and signed readback, with no local mutation or fake Team publication.
- [ ] Complete current-head GitHub source/package/migration/joined gates, inspect actual worker/Scout/ledger evidence, verify current develop ancestry and merge only after every applicable gate passes.

Implementation checkboxes record source completion only; no tests or builds have run locally. Earlier full source and standard package/migration gates passed; the native end-to-end gate remains incomplete until the corrected current head passes.
