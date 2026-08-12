# Durable Task Execution Phase 1

**Date:** 2026-08-12
**Status:** Approved for autonomous implementation by delegation
**Scope:** Durable execution for existing Colony Tasks

## Outcome

Meaningful work that starts in chat already receives a canonical relay-authored
Task. Phase 1 makes the execution of that Task durable as well: one employee is
assigned, one worker seat holds an expiring lease, the current holder may write
fenced checkpoints, and a replacement worker can resume from the latest durable
checkpoint after the lease is lost. A task-linked run is Delivered only when its
current lease holder declares at least one artifact and the relay records the
outcome event as the delivery receipt.

The relay remains the coordination system of record. CLI workers execute work;
their process state, chat activity, and silence are never treated as durable
execution truth.

## Scope boundary

Phase 1 includes:

- linkage from the existing canonical Task to the existing relay job queue;
- an explicit accountable employee on each run, in addition to the Task's
  existing one owning team and assigned personas;
- atomic claim, lease, heartbeat, fencing, checkpoint, lease-loss recovery, and
  evidence-gated delivery;
- CLI syntax for filing a task run, checkpointing it, and delivering it;
- strict parsers, database invariants, relay arbitration, canonical job-head
  projection, unit tests, and a real-relay acceptance flow.

It does not include a task/dashboard UI, billing changes, playbooks, connector
execution, browser automation, a cloud worker fleet, cross-seat automatic
handoff, or proof of external side effects.

## Existing foundation

Colony already has:

- relay-authored `Company`, `Initiative`, and `Task` NIP-33 heads;
- owner-signed Company Actions and relay-signed receipts;
- idempotent chat-to-implicit-Task planning before paid work;
- an employee job queue backed by Postgres with atomic claims, 120-second
  leases, 30-second heartbeats, attempt fencing, recovery after lease expiry,
  and relay-published canonical job heads;
- worker-mode execution and typed Ask escalation.

The missing capability is the narrow bridge between a Task and that execution
queue, plus durable checkpoints and delivery evidence.

## Approaches considered

### Extend the employee job queue (selected)

Add optional Task linkage and checkpoint/delivery fields to the existing job
row and wire protocol. This reuses proven lease arbitration and recovery,
preserves legacy non-Task jobs, and gives Tasks one durable execution path.

### Create a separate task-runs table and event family

This gives Task terminology a clean slate but duplicates claims, fencing,
sweeps, heads, worker polling, and escalation. Two schedulers would inevitably
drift and violate the requirement to avoid a parallel work system.

### Store run state in the canonical Task head

This overloads an owner-authorized planning record with high-frequency worker
heartbeats and cannot atomically arbitrate racing claims. Nostr replacement
ordering is not a mutex, so it cannot provide truthful ownership.

## Data model

Migration `0064_task_run_durability.sql` adds nullable fields to `jobs` so
legacy filings remain valid:

| Field | Meaning |
|---|---|
| `task_id TEXT` | Stable `CompanyTask.id`; present means this job is a Task run |
| `checkpoint_seq BIGINT` | Monotonic sequence within the run, initially zero |
| `checkpoint JSONB` | Latest opaque, bounded resumable checkpoint object |
| `checkpoint_event BYTEA` | Worker-signed checkpoint event receipt |
| `checkpoint_at BIGINT` | Relay acceptance time of the latest checkpoint |
| `artifacts JSONB` | Declared delivery artifacts on a delivered run |
| `outcome_event BYTEA` | Worker-signed outcome event used as delivery receipt |

`task_id` is indexed per community. Event IDs remain 32 bytes. A checkpoint is
an object with:

```json
{
  "summary": "Completed source audit; resume at synthesis",
  "resumeToken": "phase:synthesis",
  "progress": 55
}
```

`summary` is required and bounded, `resumeToken` is optional and bounded, and
`progress` is an optional integer from 0 through 100. Checkpoints must contain
no credentials or arbitrary binary data.

Each delivery artifact is:

```json
{
  "kind": "event",
  "ref": "64-lowercase-hex-event-id",
  "label": "Phase 1 design"
}
```

`kind` is one of `event`, `url`, `path`, or `text`; `ref` and optional `label`
are bounded non-empty strings. Phase 1 declares evidence but does not dereference
or assert the external effect behind a URL or path.

## Wire protocol

The existing kinds remain authoritative:

- `43010` Job Filing
- `43011` Job Claim
- `43012` Job Heartbeat
- `43013` Job Outcome
- `30191` Job Head

Phase 1 adds `43014` Job Checkpoint.

### Filing

A Task-linked filing adds exactly one `task` tag containing the stable Task ID.
The relay requires that a current relay-authored `KIND_TASK` head exists at that
ID before inserting the job. The existing `p` tag remains the accountable
employee. Existing filings without `task` remain valid legacy jobs.

### Claim and heartbeat

Claims and heartbeats retain the current `(job_id, holder_pubkey, attempt)`
fence. A successful claim increments `attempts`. A lease may be recovered
directly after expiry without waiting for the background sweep.

### Checkpoint

A checkpoint event carries `job`, `attempt`, and `sequence` tags plus canonical
JSON content. One conditional update accepts it only while:

- the job is `leased`;
- the event author is the current lease holder;
- the attempt equals the current fencing token;
- the lease has not expired;
- `sequence` is strictly greater than `checkpoint_seq`.

Acceptance stores the event ID and checkpoint atomically and extends the lease
by the normal lease duration. A stale worker, duplicate sequence, or worker
whose lease expired changes nothing.

### Delivery

A Task-linked `done` outcome must carry one or more `artifact` tags, each
containing canonical artifact JSON. The relay validates and stores the artifact
list and exact outcome event ID in the same fenced update that marks the job
done. A Task-linked outcome with no artifact is rejected before any state
change. Legacy non-Task jobs retain their existing result-only completion.

The job head includes `task`, `checkpoint-seq`, `checkpoint-event`, and
`outcome-event` tags when present. Its JSON content contains the latest
checkpoint and declared artifacts. The head is the current projection; the
signed checkpoint and outcome event IDs are the append-only receipts.

## Invariants

1. One Task run has one accountable employee (`jobs.employee`).
2. One run has at most one current lease holder.
3. Attempt count is the fencing token; a superseded attempt cannot checkpoint,
   heartbeat, or deliver.
4. Checkpoint sequence strictly increases and never resets across recovery.
5. Lease loss preserves the latest checkpoint and its receipt.
6. A recovered claimant sees the same Task ID and latest checkpoint in the
   canonical head before executing.
7. Task-linked `done` implies at least one stored artifact and one stored
   outcome-event receipt.
8. Chat silence is not a state transition. Only relay row transitions change
   execution truth.
9. Legacy jobs remain readable and executable without Task linkage,
   checkpoints, or artifact requirements.
10. Task heads remain owner-controlled planning records; workers never author
    or heartbeat the Task head.

## State machine

The canonical Task lifecycle remains unchanged. Execution state is projected
from the job row:

| Row state | Run state | Meaning |
|---|---|---|
| `open`, attempts `0` | `queued` | Awaiting its first claim |
| `leased` | `executing` | One fenced holder owns the lease |
| `open`, attempts `>0` | `recoverable` | Prior lease was lost; checkpoint may exist |
| `done`, Task-linked | `delivered` | Artifacts and outcome receipt are durable |
| `failed` | `failed` | Current holder reported failure |
| `abandoned` | `abandoned` | Retry cap reached; Ask escalation applies |

`recoverable -> executing` increments the attempt. No `working` state is
derived from recent messages, process presence, or elapsed chat silence.

## Compatibility and migration

- All new columns are nullable or have non-breaking defaults.
- Existing job events parse exactly as before.
- Existing `jobs file` and `jobs done` commands remain valid for non-Task jobs.
- The CLI adds Task-oriented aliases while sharing the same builders and
  parsers; it does not create a second protocol.
- Existing Task heads need no rewrite.
- Rolling deploy order is migration first, then relay/CLI. Old relay instances
  ignore kind `43014`; new clients must not checkpoint until the upgraded relay
  accepts the event.

## CLI contract

The public Task flow is:

```text
buzz jobs file --employee <pubkey> --task <task-id> --instruction <text> \
  --channel <uuid> --thread <event-id>
buzz jobs claim --job <event-id>
buzz jobs checkpoint --job <event-id> --attempt <n> --sequence <n> \
  --summary <text> [--resume-token <text>] [--progress <0-100>]
buzz jobs done --job <event-id> --attempt <n> --result <text> \
  --artifact <kind>:<ref> [--artifact <kind>:<ref>...]
buzz jobs show --job <event-id>
```

The existing `jobs` namespace is retained because worker mode already uses it.
Task linkage makes these rows task runs without a duplicate command family.

## Error behavior

Malformed events fail before database mutation. Conditional-update misses from
stale holders are benign no-ops and republish or preserve the canonical head;
they do not overwrite newer work. Database errors return a failure and do not
claim success. A head publication failure is logged and healed by the next
transition, while the Postgres row remains authoritative.

## Acceptance proof

The Phase 1 gate requires one automated real-relay scenario:

1. create or reuse an implicit chat Task and assert its one owning team and
   assigned accountable persona;
2. file a job linked to that exact Task and employee;
3. claim attempt 1 and observe the canonical executing head;
4. write checkpoint sequence 1 and read it back from the head;
5. simulate interruption by expiring the lease in the test database;
6. claim attempt 2 and assert the checkpoint and Task link survived;
7. prove attempt 1 cannot checkpoint or deliver;
8. prove attempt 2 cannot deliver without an artifact;
9. deliver from attempt 2 with one declared artifact;
10. assert `delivered`, artifact, checkpoint receipt, and outcome receipt on the
    canonical head.

Targeted unit tests additionally cover parser cardinality, bounds, canonical
JSON, migration registration, SQL fence clauses, backward compatibility, CLI
event construction, and relay head round-trips.

This proves relay durability, claim fencing, checkpoint recovery, and declared
delivery evidence. It does not prove the artifact exists at an external URL,
that a browser action occurred, or that any third-party side effect succeeded.
