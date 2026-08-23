-- 0061: drop the dead channels.canvas column.
--
-- The live channel-canvas path is entirely event-sourced: kind 40100 events
-- keyed by an `h` tag on the channel UUID. This column was a parallel,
-- column-based implementation with no writers — every INSERT into channels
-- omitted it — and its only accessors, buzz_db get_canvas/set_canvas, had zero
-- callers across the whole workspace. Dropped so nobody building on canvas
-- mistakes the dead path for the live one.
ALTER TABLE channels DROP COLUMN IF EXISTS canvas;
