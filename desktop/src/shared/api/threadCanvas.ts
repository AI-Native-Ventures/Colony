/**
 * Thread-scoped canvas reads and writes.
 *
 * Lives outside `tauri.ts` because that file is already over the desktop file
 * size ratchet and may not grow. Same invoke conventions as the channel canvas
 * calls it sits beside there: snake_case over the bridge, camelCase in TS.
 */
import {
  invokeTauri,
  type RawCanvasResponse,
  type RawSetCanvasResult,
} from "./tauri";
import type {
  CanvasResponse,
  SetCanvasResult,
  SetThreadCanvasInput,
} from "./types";

/** Read the newest kind:40100 event carrying an `e` tag on this thread root. */
export async function getThreadCanvas(
  channelId: string,
  threadRootId: string,
): Promise<CanvasResponse> {
  const response = await invokeTauri<RawCanvasResponse>("get_thread_canvas", {
    channelId,
    threadRootId,
  });
  return {
    content: response.content,
    updatedAt: response.updated_at ?? null,
    author: response.author ?? null,
  };
}

export async function setThreadCanvas(
  input: SetThreadCanvasInput,
): Promise<SetCanvasResult> {
  const response = await invokeTauri<RawSetCanvasResult>("set_thread_canvas", {
    channelId: input.channelId,
    threadRootId: input.threadRootId,
    content: input.content,
  });
  return {
    ok: response.ok,
    eventId: response.event_id,
  };
}
