import { verifyEvent } from "nostr-tools/pure";

import type { TaskArtifact } from "../../company/taskRunContracts.ts";
import type { RelayEvent } from "../../../shared/api/types.ts";
import { taskArtifactPayload } from "./artifactPayload.ts";
import { setChannelSurfaceMode } from "./channelSurfaceMode.ts";
import { getTabKind } from "./tabKindRegistry.ts";
import { getTaskArtifactEvent } from "./taskArtifactEvent.ts";
import { openTab } from "./workspaceTabs.ts";

type ArtifactOpenDecision =
  | { supported: true; kind: "artifact" | "web" }
  | { supported: false; message: string };

export type TaskArtifactOpenResult =
  | { ok: true }
  | { ok: false; message: string };

type ArtifactOpenDependencies = {
  getKind: (kind: string) => unknown;
  getEvent: (eventId: string) => Promise<RelayEvent>;
  openTab: typeof openTab;
  setSurfaceMode: typeof setChannelSurfaceMode;
};

const DEFAULT_DEPENDENCIES: ArtifactOpenDependencies = {
  getKind: getTabKind,
  getEvent: getTaskArtifactEvent,
  openTab,
  setSurfaceMode: setChannelSurfaceMode,
};

let artifactOpenGeneration = 0;

function validWebUrl(reference: string): boolean {
  try {
    const url = new URL(reference);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** Decide whether a relay-portable reference has an in-app surface here. */
export function decideTaskArtifactOpening(
  artifact: TaskArtifact,
  hasKind: (kind: string) => boolean,
): ArtifactOpenDecision {
  switch (artifact.kind) {
    case "text":
    case "event":
      return { supported: true, kind: "artifact" };
    case "url":
      if (!validWebUrl(artifact.reference)) {
        return {
          supported: false,
          message: "This accepted reference is not an HTTP or HTTPS URL.",
        };
      }
      return hasKind("web")
        ? { supported: true, kind: "web" }
        : {
            supported: false,
            message:
              "This build cannot open web evidence in-app. The accepted URL remains available below.",
          };
    case "path":
      return {
        supported: false,
        message:
          "This path belongs to the worker workspace and is not available on this device.",
      };
  }
}

/** Read the initialized workspace registry when rendering an open affordance. */
export function canOpenTaskArtifact(
  artifact: TaskArtifact,
): ArtifactOpenDecision {
  return decideTaskArtifactOpening(
    artifact,
    (kind) => getTabKind(kind) !== undefined,
  );
}

function validSignedEvent(event: RelayEvent): boolean {
  try {
    return verifyEvent({
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.created_at,
      kind: event.kind,
      tags: event.tags.map((tag) => [...tag]),
      content: event.content,
      sig: event.sig,
    });
  } catch {
    return false;
  }
}

/** Open accepted evidence through the existing per-channel workspace registry. */
export async function openTaskArtifact(
  input: {
    channelId: string;
    artifact: TaskArtifact;
    createdBy: string;
  },
  dependencies: ArtifactOpenDependencies = DEFAULT_DEPENDENCIES,
): Promise<TaskArtifactOpenResult> {
  const generation = artifactOpenGeneration;
  const decision = decideTaskArtifactOpening(
    input.artifact,
    (kind) => dependencies.getKind(kind) !== undefined,
  );
  if (!decision.supported) return { ok: false, message: decision.message };

  const title = input.artifact.label ?? "Task deliverable";
  try {
    if (decision.kind === "web") {
      dependencies.openTab(input.channelId, {
        kind: "web",
        title,
        createdBy: input.createdBy,
        payload: {
          endpoint: null,
          targetId: null,
          url: input.artifact.reference,
        },
      });
    } else if (input.artifact.kind === "event") {
      const event = await dependencies.getEvent(input.artifact.reference);
      if (
        generation !== artifactOpenGeneration ||
        event.id.toLowerCase() !== input.artifact.reference.toLowerCase() ||
        !validSignedEvent(event)
      ) {
        return {
          ok: false,
          message:
            generation !== artifactOpenGeneration
              ? "Artifact opening was cancelled because the active community changed."
              : "The relay did not return the exact signed event named by the accepted artifact reference.",
        };
      }
      dependencies.openTab(input.channelId, {
        kind: "artifact",
        title,
        createdBy: event.pubkey,
        payload: taskArtifactPayload({
          content: event.content,
          reference: input.artifact.reference,
          sourceEventId: event.id,
          sourceKind: "event",
        }),
      });
    } else {
      dependencies.openTab(input.channelId, {
        kind: "artifact",
        title,
        createdBy: input.createdBy,
        payload: taskArtifactPayload({
          content: input.artifact.reference,
          reference: input.artifact.reference,
          sourceEventId: null,
          sourceKind: "text",
        }),
      });
    }
    dependencies.setSurfaceMode(input.channelId, "workspace");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: `This artifact could not be opened in-app: ${String(error)}`,
    };
  }
}

/** Cancel event-artifact reads that crossed an active-community boundary. */
export function resetTaskArtifactOpeningState(): void {
  artifactOpenGeneration += 1;
}
