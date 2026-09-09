# Hosted native first-job proof implementation plan

**Goal:** Prove fresh worker preparation, delegation, returned work and Scout review through the packaged app on GitHub.
**Architecture:** Reuse the joined fixture and deterministic provider; replace Docker with owned native services and manual staffing with the actual approval UI.
**Tech stack:** Electron, Playwright, native Rust relay/ACP, PostgreSQL 17, Redis 7, MinIO, GitHub macOS 15.

- [x] Add a checksum/commit-pinned GitHub-only service build script and process launcher. Preserve real S3 bucket setup and relay conformance admission; fail on early exit and clean every owned process.
- [x] Refactor relay fixture backing-service setup behind the existing query/close contract. Keep normal Docker fixture support; use explicit native tools on the hosted job.
- [x] Replace manual company and worker writes with signed readback and the actual Approve team and start action. Retain zero-credit and no-early-work assertions; identify returned native worker from the approval receipt.
- [x] Adapt provider context to unmodified approved persona prompts and lazily read the native worker after approval. Retain actual CLI exit/accepted checks and all output, completion and reload evidence.
- [x] Add meaningful fixture contract/unit regressions; execution remains on GitHub only. Add a separate gating hosted workflow with cached pinned service builds and private fixture package, full relay build, artifact upload and exact proof fields.
- [ ] Review source, format only, open a draft dependent PR, inspect GitHub results and repair concrete failures. Do not merge before #669 and all current-head proof gates pass.

Implementation checkboxes record source completion only; no tests or builds have run locally. Hosted execution and results are pending.
