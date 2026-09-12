# Website Manager protocol (Phase 1 contract)

Status: pure `buzz-core` contract. There is no relay, database, network, or
worker integration yet. Phase 2 obligations are listed in section 8.

This document is the source of truth for three shared artifacts:

1. the preview manifest that the native preview worker publishes,
2. the website review record that tracks revisions, QA, and decisions,
3. the deterministic decision identity used for once-only dispatch.

The Rust implementation lives in `crates/buzz-core/src/website.rs` and
`crates/buzz-core/src/website/`. Shared vectors live in
`crates/buzz-core/testdata/website/`.

## 1. Preview manifest wire format

The manifest is a single JSON object. It is the raw byte string whose SHA-256
is the revision's manifest hash. Unknown fields are rejected at every level.

```json
{
  "schema": "colony.website-preview/1",
  "entrypoint": "index.html",
  "files": [
    {
      "path": "index.html",
      "url": "https://cdn.example.com/sites/abc/index.html",
      "sha256": "<64 lowercase hex>",
      "mime": "text/html",
      "size": 123
    }
  ]
}
```

| field | meaning |
| --- | --- |
| `schema` | exactly `colony.website-preview/1` |
| `entrypoint` | path of the entry document; must exist in `files` and have `text/html` |
| `files[].path` | literal relative asset path inside the site |
| `files[].url` | public HTTPS URL serving the exact bytes |
| `files[].sha256` | SHA-256 of the exact file bytes, lowercase hex |
| `files[].mime` | bare MIME type from the allowlist below |
| `files[].size` | byte length of the exact file bytes |

Hash rule: `sha256` values hash the referenced raw bytes exactly. The
manifest hash is taken over the published manifest bytes, not over a
re-serialized object, so re-encoding the JSON changes the hash. File hashes
cover file bytes, never a combined archive. An artifact ref is the pair
`{url, sha256}`; its hash is the SHA-256 of the raw bytes behind the URL.

### Limits

| limit | value |
| --- | --- |
| raw manifest bytes | 262144 (256 KiB) |
| files | 512 |
| one file size | 16777216 (16 MiB) |
| sum of file sizes | 67108864 (64 MiB) |
| path bytes | 1024 |
| url bytes | 2048 |
| decision note characters | 2000 |

Sizes are non-negative JSON integers. Negative, fractional, or overflowing
numbers are invalid input. An empty file is legitimate when `size` is 0.

### Path rules

A path must be a literal relative asset path:

- non-empty and at most 1024 bytes,
- no leading or trailing slash, no backslash, no `%`, no `?`, no `#`,
- no empty segment, no `.` segment, no `..` segment,
- no control characters,
- no segment ending in a space or a dot (Windows folds these away).

Two files may not share a path. Case-insensitive collisions are also rejected
(`Index.html` vs `index.html`) because target filesystems may fold case.
Unicode normalization is not checked; publishers must emit one form.

### URL rules

Every file URL, artifact ref URL, source URL, and handover asset URL must be:

- an absolute HTTPS URL,
- at most 2048 bytes,
- without userinfo (`user:password@` is rejected),
- without a fragment; a query string is allowed,
- hosted on a hostname that core can prove is public:
  - an IP literal that is not private, loopback, link-local, CGNAT,
    benchmarking, documentation, multicast, ULA, NAT64, Teredo, or 6to4
    (classification shared with `buzz_core::network::is_private_ip`),
  - a DNS name with at least one dot that is not `localhost`, `*.localhost`,
    `*.local`, `*.internal`, or `*.home.arpa`.

Core cannot resolve DNS or follow redirects. The native preview worker must
re-check the resolved address and every redirect hop before download, and must
reject a public name that resolves to a blocked address. That check is a
Phase 2 obligation, not a property core can prove.

### MIME allowlist

`text/html`, `text/css`, `text/plain`, `text/javascript`,
`application/javascript`, `application/json`, `application/manifest+json`,
`image/png`, `image/jpeg`, `image/gif`, `image/svg+xml`, `image/webp`,
`image/avif`, `image/x-icon`, `image/vnd.microsoft.icon`, `font/woff`,
`font/woff2`, `application/wasm`.

The entrypoint must be `text/html`. MIME parameters (`; charset=utf-8`) are
not allowed in the manifest.

## 2. Review record

The review record is a single JSON object with `schema` set to
`colony.website-review/v1`. Unknown fields are rejected, so no extension can
smuggle behavior past a strict reader.

| field | meaning |
| --- | --- |
| `schema` | exactly `colony.website-review/v1` |
| `jobId` | stable UUID of the website job |
| `taskId` | canonical CompanyTask id this job serves |
| `channel` | channel id that owns the job thread |
| `threadRoot` | root event id (64 hex) of the job thread |
| `owner` | pinned owner pubkey (64 hex) with approval authority |
| `coordinator` | optional coordinator pubkey (64 hex); may request changes |
| `sourceUrl` | public HTTPS source reference for the site source |
| `status` | see section 4 |
| `currentRevision` | highest recorded revision; 0 while `draft` |
| `revisions` | append-only revision history |
| `approvals` | append-only history of every approval ever granted |
| `activeApprovalId` | decision id of the approval authorizing the current revision |
| `decisions` | append-only history of every applied decision |
| `stageEvidence` | evidence records pointing at signed external events |
| `handover` | present exactly when status is `handedOver` |

A revision record carries:

| field | meaning |
| --- | --- |
| `revision` | 1-based number; each new revision is exactly current + 1 |
| `preview` | artifact ref `{url, sha256}` for the exact manifest bytes |
| `sourceUrl` | public HTTPS source reference for this revision |
| `archive` | optional artifact ref for the source archive |
| `captures` | `before`, `desktop`, and `mobile` capture artifact refs |
| `builtBy` | designer/builder pubkey (64 hex); may not review their own QA |
| `qa` | optional independent QA evidence |

QA evidence carries `reviewer` (64 hex), `revision`, `manifestSha256`,
`passed`, `reportEventId` (64 hex signed task-report event), and `report`
(artifact ref for the QA report). Ready-for-review requires `passed` true, a
reviewer different from `builtBy`, and a revision and manifest hash that match
the revision it is attached to.

Stage evidence carries `stage` (`brief`, `work`, `review`, `revision`,
`approval`, `handover`), an optional `revision` that must exist, `kind`, and
`eventId` (64 hex). Evidence kinds mirror the existing execution surfaces:
`jobOutcome` and `jobCheckpoint` for `buzz jobs` records, `taskReport` for
agent-signable `KIND_TASK_REPORT` reports that a broker verifies against an
assignee and completes on the canonical CompanyTask, and `workEvent` for any
other signed work event.

A decision carries `decisionId`, `kind` (`approve` or `requestChanges`),
`jobId`, `taskId`, `channel`, `revision`, `manifestSha256`, `actor`
(64 hex), and an optional `note`. The scope fields are re-checked against the
record; they exist so a decision routed to the wrong job fails closed.

A handover carries `jobId`, `taskId`, `approvedRevision`,
`approvedManifestSha256`, `sourceUrl`, optional `sourceArchive`, `assets`
(path plus artifact ref), and `acceptedBy` (64 hex). There is deliberately no
publish, deploy, or cutover field: a handover transfers source and an approved
revision, and nothing in this contract authorizes serving the site.

## 3. Lifecycle

| from | action | to | requirements |
| --- | --- | --- | --- |
| `draft` | `begin_work` | `working` | none |
| `working` | `record_revision` | `working` | revision = current + 1, valid manifest, hash matches raw bytes |
| `working` | `record_qa` | `working` | current revision, no QA yet, reviewer differs from builder |
| `working` | `mark_ready_for_review` | `readyForReview` | current revision, QA present and passed |
| `readyForReview` | `approve` | `approved` | pinned owner, current revision, hash matches, QA valid |
| `readyForReview` | `request_changes` | `changesRequested` | owner or coordinator, current revision |
| `approved` | `request_changes` | `changesRequested` | owner or coordinator, current revision |
| `changesRequested` | `record_revision` | `working` | revision = current + 1 |
| `approved` | `record_handover` | `handedOver` | current revision and active approval |

Terminal state: `handedOver`. Revisions and decisions are refused afterwards.

`record_revision` is refused while `readyForReview`
(`revision_while_under_review`), while `approved` (`revision_after_approval`),
and after handover (`revision_after_handover`). Recoding an approved revision
is therefore a two-step act: `request_changes` on the approved revision, then
a new revision. This keeps the approval list as history without letting an old
approval block new work.

## 4. Decision identity and idempotency

`decisionId` is derived, not supplied:

```
uuidv5(WEBSITE_DECISION_NAMESPACE,
       "colony.website:{jobId}:{taskId}:{channel}:{revision}:{kind}:{actor}:{manifestSha256}")
```

The fixed namespace UUID is defined in `buzz-core::website::WEBSITE_DECISION_NAMESPACE`.
Because the id derives from the decision content, a retry that carries the
same scope, revision, kind, actor, and manifest hash produces the same id.
Notes are not part of the identity; editing a note does not create a new
decision.

`apply_decision` returns one of:

- `Applied`: the new record. The decision is appended and the status changes.
- `Duplicate`: the previously applied decision record, byte for byte. No
  state changes. Replaying a decision is safe and returns the original.

And fails with:

- `scope_mismatch`: `jobId`, `taskId`, or `channel` does not match the record.
- `stale_revision`: the decision targets a revision that is not current.
- `manifest_hash_mismatch`: the decision hash does not match the current
  revision manifest hash.
- `conflicting_decision`: a different decision already targets the same
  revision with the same kind, or an `approve` contradicts an existing
  `request_changes` on that revision. Two simultaneous contradictory
  decisions cannot both win.
- `not_pinned_owner`: an `approve` from anyone but the pinned owner.
- `not_authorized`: a `request_changes` from anyone but the owner or
  coordinator.
- `not_ready_for_review`: an `approve` while the status is not
  `readyForReview`.
- `qa_missing`, `qa_not_independent`, `qa_not_passed`, `qa_mismatch`.

The one allowed cross-kind sequence is `approve` followed by
`request_changes` on the same revision. It sets `changesRequested`, preserves
the approval in `approvals`, and clears `activeApprovalId`, so the old
approval stays visible as history but no longer authorizes anything.

The derived id is the idempotency key for dispatch. Phase 2 must persist the
first application atomically, after which retries observe the stored decision;
core cannot provide database atomicity by itself.

## 5. Handover

Handover requires status `approved`, a matching active approval, matching
revision and manifest hash, valid source and asset refs, and an accepted-by
identity. It sets status `handedOver` and stores the handover. It never emits
a publish command and never performs a cutover. Cleanup of preview hosting,
DNS, or serving remains outside this contract.

## 6. Validation and error codes

Every failure maps to a stable snake-case code used by vectors and by other
languages that consume the same vectors. Manifest and review JSON that does
not deserialize reports `manifest_json` or `review_json`. Structural codes:
`manifest_too_large`, `manifest_schema`, `too_many_files`, `path_invalid`,
`path_duplicate`, `path_ambiguous`, `url_invalid`, `url_insecure`,
`url_credentials`, `url_blocked_host`, `sha256_invalid`, `mime_invalid`,
`file_too_large`, `total_too_large`, `entrypoint_missing`,
`entrypoint_not_html`. Review codes: `review_schema`, `identity_invalid`,
`event_id_invalid`, `revision_unknown`, `revision_number_mismatch`,
`current_revision_mismatch`, `revision_while_under_review`,
`revision_after_approval`, `revision_after_handover`, `invalid_transition`,
`qa_missing`, `qa_already_recorded`, `qa_not_independent`, `qa_not_passed`,
`qa_mismatch`, `not_pinned_owner`, `not_authorized`, `not_ready_for_review`,
`scope_mismatch`, `decision_id_mismatch`, `stale_revision`,
`manifest_hash_mismatch`, `conflicting_decision`, `handover_mismatch`,
`invalid_handover`, `note_too_long`.

Stored-record validation reports the most specific cause first: a decision
whose `jobId`, `taskId`, or `channel` differs from the record fails
`scope_mismatch` before the derived-id comparison, while a tampered
`decisionId` with intact scope fails `decision_id_mismatch`.

## 7. Evidence and authority

Stage evidence and QA evidence reference signed events. Core validates shape,
identities, revision references, and hashes. Core does not verify signatures,
assignees, or that an event exists; those checks belong to the relay
verification pipeline.

## 8. Relay implementation (implemented)

The relay backend is implemented; this section is the operational contract.

### Kinds and events

| kind | author | shape |
| --- | --- | --- |
| 30203 `KIND_WEBSITE_HEAD` | relay | NIP-33 head, `d` = job UUID. Content is the exact `colony.website-review/v1` record. Tags: `h` channel, `task`, `thread`, `instance` (review-card Block instance event id), `manifest` (active website-job Block manifest event id), `generation`, and `p` tags for owner then coordinator. |
| 40027 `KIND_WEBSITE_ACTION` | client | Channel-scoped command. Tags: `h`, `task`, `thread`, `request` (per-actor UUID), optional `generation`, optional `instance`/`manifest` (required on `create`). Content is a strict `colony.website-action/v1` object. |
| 40028 `KIND_WEBSITE_RECEIPT` | relay | Channel-scoped receipt; content is `colony.website-receipt/v1` (`op`, `outcome`, `jobId`, `generation`, `revision`, `headEventId`, optional `decisionId`). |
| 40026 `KIND_TASK_REPORT` | agent | QA binding tag `["website-qa", revision, manifestSha256, reportUrl, reportSha256]` for `recordQa`, plus `task`. |

Actions: `create`, `beginWork`, `addRevision`, `recordQa`, `stageEvidence`, `ready`, `requestChanges`, `handover`. Owner approve/request-changes decisions arrive as reserved Block actions `website.approve` / `website.request-changes` through the generic Block pipeline; they are then brokered here.

### Creation sequence (real flow)

1. The owner writes an ordinary message in a channel; it becomes the thread root (and the relay opens the canonical thread task from it).
2. The coordinator agent posts a `website-job` Block instance (kind 9 with `block`/`block-processor`/attention tags) inside that thread, referencing the active `website-job` manifest. The instance inline data is schema-validated by the manifest and carries `taskId` (string), `threadRoot` (64 lowercase hex), `sourceUrl` (public HTTPS, max 2048), and a `brief` object with `summary` (max 600 code points), `preserve` (max 8 strings, 160 each), `redesign` (max 8 strings, 160 each), and `deliverables` (max 6 strings, 160 each). Owner-facing prose about improvements and handover lives in thread messages and the canonical record, never in instance data.
3. Owner or coordinator submits `create`. The action names the review `--instance` and `--manifest`. The broker verifies owner authorship of the thread root, managed-agent ownership, installed-team membership for every persona, the active relay-authored manifest for the instance handle, the schema-validated inline data, and the instance's channel/thread/processor/attention pins.
4. The broker reconciles the canonical task assignment in the same phase: assignees widen to the research/build/review personas plus the coordinator, and `qaPersonaId` is set to the first review persona. Only personas from the owner's published teams are added.

### Retry and concurrency

Every action carries a per-actor `request` UUID and a canonical payload digest. `website_actions` is keyed `(community, actor, request)` and uniquely by action event id; an exact retry returns the recorded head and receipt (including after the old head was superseded), a replay with a different digest is refused, and a retry never re-fetches artifacts. Mutations compare-and-set the row `generation`; a stale generation is refused.

### Reopen after handover

`requestChanges` (owner through Blocks or the coordinator through the action path) reopens work. If the canonical task is `completed`, the broker bounces it with the validated `completed -> ready` transition (reason attached, `bounceCount` + 1), clears completion reports, widens assignment from the owner's installed teams, and re-claims the thread slot so dispatch can find the open work. A `cancelled` task is refused with a clear reopen instruction. Vera's QA task report alone cannot close a four-assignee task: `report_closes_task` requires every assignee to report.

### Access request

`handover` may carry `accessRequest: {text, authoredBy}`. `text` is 1..=4000 code points with ordinary newlines; `authoredBy` must be a managed agent owned by the job owner holding an assigned build persona. The owner presents it; the agent authors it.

### Artifact verification

Manifest and QA report bytes are fetched through one bounded, DNS-pinned public transport (single wall-clock deadline over DNS, redirects, headers, and body; every hop re-validated against core's public-URL policy; byte cap). `addRevision` verifies the fetched manifest hashes to the declared ref; `handover` verifies the approved revision's manifest and asset membership; `recordQa` verifies the report hash, reviewer, revision, manifest, and that the checklist agrees with `passed`.

### CLI

```
buzz website get --channel <uuid> [--task <id>] [--job <uuid>]
buzz website list --channel <uuid> [--limit N]
buzz website create --channel <uuid> --task <id> --thread <hex> \
    --instance <event-id> --manifest <event-id> --coordinator <pubkey> \
    --source-url <url> [--research <persona>]... [--build <persona>]... [--review <persona>]...
buzz website begin-work --channel <uuid> --task <id> --thread <hex> [--generation N]
buzz website revision --channel <uuid> --task <id> --thread <hex> [--generation N] --file <json>
buzz website qa --channel <uuid> --task <id> --thread <hex> [--generation N] \
    --revision N (--passed | ) --report-url <url> --report-file <path> [--report-event <hex>]
buzz website evidence --channel <uuid> --task <id> --thread <hex> [--generation N] \
    --stage <stage> [--revision N] --kind <kind> --event <hex>
buzz website ready --channel <uuid> --task <id> --thread <hex> [--generation N]
buzz website request-changes --channel <uuid> --task <id> --thread <hex> [--generation N] \
    --revision N --hash <sha256> --note <text>
buzz website handover --channel <uuid> --task <id> --thread <hex> [--generation N] --file <json>
```

`--generation` is read from the current head when omitted. `revision` and `handover` files match the wire structs; `handover` may include `accessRequest`. `qa` publishes the signed task report carrying the `website-qa` binding tag first, then the `recordQa` action referencing it.

### Bundling a built site

```
buzz website bundle --dir <built-site> --source <editable-source-dir-or-archive> \
    --before <png> --desktop <png> --mobile <png> \
    [--entrypoint index.html] --source-url <https-url> [--out revision.json]
```

The command packages an already-built site; it never runs a build. It walks `--dir`
(sorted, deterministic), validates every path and MIME against the preview
contract, rejects symlinks, case-fold collisions, unknown types, >16 MiB files,
and >64 MiB totals, uploads every file plus the manifest, the source archive,
and the three PNG captures through the authenticated Blossom client, downloads
each upload back, and refuses success unless the readback bytes hash and size
match exactly. A source directory becomes a deterministic uncompressed ustar
archive; `node_modules`, `.git`, `target`, `__pycache__`, `.env`, and symlinks
are refused rather than silently dropped. Because generic uploads are capped at
50 MiB, an archive over that bound fails clearly; pass a smaller source or a
pre-built archive.

Output is exactly what `buzz website revision --file` consumes; a missing
`revision` field is filled from the current head by the revision command, so
the two commands chain without hand editing.

Transport vs preview MIME rule: the authenticated upload infers a transport
Content-Type (text assets commonly go as `application/octet-stream` and are
served as downloads), while the preview manifest declares the MIME the native
loader uses for isolated serving. The loader trusts the manifest MIME, not the
transport header, so no upload policy changes are needed; the manifest is what
must list only allowed preview MIMEs.

The command does not fetch resources linked from the built HTML. The agent must
localize required assets into the built directory before bundling; anything not
present is reported by the walker as a missing file at build time and never
silently omitted. A user-visible preview always renders the actual produced
site files from the manifest, never a screenshot-only archive.



## 9. Shared vectors

- `crates/buzz-core/testdata/website/preview_manifest_vectors.json` lists raw
  manifest strings with accept or reject expectations and error codes.
- `crates/buzz-core/testdata/website/review_vectors.json` lists review flows
  as ordered operations with expected outcomes, statuses, and error codes.

Rust tests consume both with `include_str!`. Other implementations can consume
the same files without depending on Rust.
