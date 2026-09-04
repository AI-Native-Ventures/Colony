NIP-TT
======

Thread-Scoped Tasks
-------------------

`draft` `optional` `relay`

This NIP defines how Colony decides which Task a paid agent turn is charged
to. A thread holds at most one open Task, and the relay, not any client,
decides which Task a given send belongs to. A client asks with a Company
Action (kind `40013`) carrying a `threadAttach` payload; the relay answers
with a receipt naming the Task head the send resolved to. Assignees close
their own share with a Task Completion Report (kind `40026`).

## Motivation

Colony used to mint a Task on the client for every agent-directed message.
One piece of work discussed over five messages produced five Tasks, so the
Tasks page read as a transcript of the conversation rather than a list of
work. The obvious fix, "reuse the Task if the thread already has one", cannot
be made safe on the client: a desktop and a phone preparing the same send both
read "no open task" and both create one. The decision has to be arbitrated
where there is exactly one copy of the answer, which is the relay's database.

The second problem is attribution. Once a Task is shared by every agent that
answers in its thread, "the team that owns the Task" is no longer the team
that should pay for each turn. The turn is charged to the team of the agent
that answered.

## The rule

1. **One open Task per thread per member.** The first work-implying message in
   a thread opens it, titled with that instruction rather than with the thread
   root. Every later agent-directed turn in that thread attaches to it,
   whichever agent is mentioned, and even when none is.
2. **Closing.** A Task closes when every assignee has reported its own share
   complete, or when the owner closes it directly. `blocked` and `snoozed`
   never close on their own. There is no idle timer: a thread nobody has
   written in for a week is a thread waiting, not a Task finished.
3. **Sequential work.** After a Task closes, the next work-implying message in
   that thread opens a new Task in the same thread.
4. **Parallel work.** A client may send an explicit "new task" request that
   opens a second Task even though one is open. The previous Task stays open;
   later attaches go to the newest. Assignees of a Task may open sub-tasks
   under it, capped at 20 per Task; a sub-task closes when its parent closes.
5. **Turns that are not work.** A message that implies no work ("are you
   there?") opens no visible Task, but its turn is still charged: to the
   thread's open Task if it has one, and otherwise to a hidden per-thread chat
   Task that never appears on the Tasks page and produces no coordination rows.
6. **Other members.** A Task belongs to the member who opened it. A second
   member working in the same thread opens their own Task, so their cost and
   team resolve from them.
7. **Billing.** Every turn charges to the Task it attached to, and the turn's
   cost is recorded against the responding agent's own team.
8. **DMs.** The conversation is the thread: one open Task per member per DM.
9. **Forum channels.** The forum root is not a Task; the first instruction
   inside opens one, and rule 3 applies from there.

## Thread attach

A client that is about to send an agent-directed message first asks the relay
which Task to name. The request is an ordinary Company Action whose payload is
a `threadAttach` record:

```jsonc
{
  "kind": "threadAttach",
  "record": {
    "schema": "colony.thread-attach/v1",
    "id": "thread-slot:<uuid>",       // the thread's slot coordinate
    "channelId": "<channel uuid>",
    "threadRoot": "<event id>",        // absent when the send starts a thread
    "conversationScope": false,        // true for a DM
    "mode": "open" | "attach" | "new",
    "title": "Cut the release video",
    "sendId": "<client's stable id for this send>",
    "agentPersonaId": "persona-cto",
    "clientOrganizationId": null,
    "parentTaskId": null,
    "createdAt": 1767225600
  }
}
```

The action's `a` target names the slot, not a Task: the client cannot know
which Task it will be given, and a target it invented would be a claim about
company state rather than a question about it. The slot coordinate is derived
from the channel, the thread, the asking member, and the slot, so two clients
preparing the same send address the same slot.

Modes:

| Mode | Meaning |
|------|---------|
| `open` | This send implies work. Attach to the thread's open Task, or open one titled with this instruction. |
| `attach` | This send does not imply work. Attach to the thread's open Task if it has one, otherwise to the hidden chat Task, created on first use. Never opens a visible Task. |
| `new` | Open a second Task even though one is open, and make it the thread's current Task. |

`parentTaskId` opens a sub-task instead of touching the thread's slot. Only an
assignee of the parent may open one, and the relay resolves the asking agent's
persona from its own kind `30177` head rather than from anything the request
claims.

The relay answers with a Company Receipt (kind `40014`) whose `headEventId`
names the Task head the send resolved to. Attaching to a Task that already
exists writes no new head: rewriting it to say the same thing would churn a
record nobody asked to change.

A send that starts its own thread is claimed under its `sendId`, because the
root event it will become does not exist yet. When that message arrives, the
relay moves the claim onto the real root, so the first reply in the thread does
not look like a brand-new thread.

## Task Completion Report (kind `40026`)

```jsonc
{
  "kind": 40026,
  "tags": [["task", "thread-task:<uuid>"]],
  "content": "{\"schema\":\"colony.task-report/v1\",\"note\":null}"
}
```

Agent-signable on purpose. A Company Action may only be signed by the human
owner, so without this an agent had no legal way to say its own share of shared
work had finished. The relay:

- resolves the reporter's persona from its managed-agent head,
- refuses a report from anybody the Task is not assigned to,
- records the persona in the Task head's `reportedCompleteBy`,
- closes the Task once that set covers `assigneePersonaIds`, and
- releases the thread slot and closes the Task's sub-tasks when it does.

A repeat report is answered rather than refused: an agent retrying after a lost
connection must not be told its work does not count.

## Task head fields

Three fields are added to `colony.task/v1`. All three are omitted from the head
when unused, so a Task that uses none of them serialises exactly as it did
before.

| Field | Meaning |
|-------|---------|
| `reportedCompleteBy` | Assignees that have reported their own share complete. |
| `hidden` | This Task only carries the cost of turns that were not work. |
| `parentTaskId` | The Task this one was split out of. |

## Authorization

A thread attach is authorized by community membership, not ownership. It
creates nothing a member could have created by hand: the Task's id, title,
team, cost centre, and status are all relay decisions, and the member is only
saying which conversation their next turn belongs to. Refusing non-owners would
mean a second member in a thread could never have their own work recorded,
which is precisely the case that puts cost on the wrong team. Every other
Company Action remains human-owner-only.
