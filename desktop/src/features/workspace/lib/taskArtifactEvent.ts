import type { RelayEvent } from "../../../shared/api/types.ts";
import { invokeTauri } from "../../../shared/api/tauri.ts";

/** Fetch a registered relay event named as accepted Task artifact evidence. */
export async function getTaskArtifactEvent(
  eventId: string,
): Promise<RelayEvent> {
  const eventJson = await invokeTauri<string>("get_task_artifact_event", {
    eventId,
  });
  return JSON.parse(eventJson) as RelayEvent;
}
