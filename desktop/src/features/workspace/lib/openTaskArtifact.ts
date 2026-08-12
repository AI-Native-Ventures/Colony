import type { TaskArtifact } from "../../company/taskRunContracts.ts";
import { getEventById } from "../../../shared/api/tauri.ts";
import { setChannelSurfaceMode } from "./channelSurfaceMode.ts";
import { getTabKind } from "./tabKindRegistry.ts";
import { openTab } from "./workspaceTabs.ts";

type ArtifactOpenDecision =
  | { supported: true; kind: "artifact" | "web" }
  | { supported: false; message: string };

export type TaskArtifactOpenResult =
  | { ok: true }
  | { ok: false; message: string };

type ArtifactOpenDependencies = {
  getKind: (kind: string) => unknown;
  getEvent: (eventId: string) => Promise<{
    id: string;
    pubkey: string;
    content: string;
  }>;
  openTab: typeof openTab;
  setSurfaceMode: typeof setChannelSurfaceMode;
};

const DEFAULT_DEPENDENCIES: ArtifactOpenDependencies = {
  getKind: getTabKind,
  getEvent: getEventById,
  openTab,
  setSurfaceMode: setChannelSurfaceMode,
};

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

/** Open accepted evidence through the existing per-channel workspace registry. */
export async function openTaskArtifact(
  input: {
    channelId: string;
    artifact: TaskArtifact;
    createdBy: string;
  },
  dependencies: ArtifactOpenDependencies = DEFAULT_DEPENDENCIES,
): Promise<TaskArtifactOpenResult> {
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
      if (event.id.toLowerCase() !== input.artifact.reference.toLowerCase()) {
        return {
          ok: false,
          message:
            "The relay returned a different event than the accepted artifact reference.",
        };
      }
      dependencies.openTab(input.channelId, {
        kind: "artifact",
        title,
        createdBy: event.pubkey,
        payload: {
          content: event.content,
          reference: input.artifact.reference,
          sourceEventId: event.id,
          sourceKind: "event",
        },
      });
    } else {
      dependencies.openTab(input.channelId, {
        kind: "artifact",
        title,
        createdBy: input.createdBy,
        payload: {
          content: input.artifact.reference,
          reference: input.artifact.reference,
          sourceEventId: null,
          sourceKind: "text",
        },
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
