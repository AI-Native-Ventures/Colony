-- One open task per thread, arbitrated by a row rather than by agreement.
--
-- Task heads are relay-authored NIP-33 events, so "does this thread already
-- have an open task" cannot be answered by a uniqueness constraint on the
-- event store: replaceable heads have no column to constrain, and two clients
-- (desktop and mobile) preparing the same send would each read "no open task"
-- and each create one. This table is the claim: the primary key makes the
-- winning INSERT the decision, and the loser reads the winner's task id back
-- out of it instead of writing a second task.
--
-- Keyed by the member, not by the thread alone: a task belongs to whoever
-- opened it, so a second member working in one thread opens their own task and
-- their turns settle against their own team and cost centre.
--
-- `thread_key` is the thread root when the send is a reply, `send:<send id>`
-- when the send starts its own thread (whose root event does not exist yet and
-- is rebound the moment the message arrives), and `conversation` for a DM,
-- where the conversation is the thread for its whole life.
CREATE TABLE thread_open_tasks (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL,
    thread_key TEXT NOT NULL,
    owner_pubkey TEXT NOT NULL,
    -- 'work' is the thread's visible task. 'chat' carries the cost of turns
    -- that were not work, so a greeting still charges somewhere without
    -- putting a greeting on the Tasks page.
    slot TEXT NOT NULL CHECK (slot IN ('work', 'chat')),
    task_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, channel_id, thread_key, owner_pubkey, slot)
);

-- The release path knows the task, not the thread: a task reaching Completed
-- or Cancelled frees its slot so the next work-implying message in that thread
-- opens a new task rather than reopening a finished one.
CREATE INDEX thread_open_tasks_task_idx ON thread_open_tasks (community_id, task_id);

-- Sub-tasks opened under a thread's task, so the cap is countable in the same
-- transaction that would exceed it and the parent's cascade close has a
-- durable child list to walk.
CREATE TABLE thread_subtasks (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    parent_task_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, parent_task_id, task_id)
);

-- Community-scoped tables must carry the write fence, or a write can outlive
-- the community it belongs to. schema.sql (which CI provisions from) declares
-- this separately, so a fence added there and not here leaves a
-- migration-built database unfenced.
SELECT attach_community_write_fence('thread_open_tasks'::REGCLASS);
SELECT attach_community_write_fence('thread_subtasks'::REGCLASS);
