import type * as React from "react";
import { electronDesktop } from "@/shared/api/electronNativeBridge";

import { registerTabKind } from "@/features/workspace/lib/tabKindRegistry";
import {
  ArtifactBody,
  artifactKindDefinition,
} from "@/features/workspace/kinds/artifactKind";
import {
  FileBody,
  fileKindDefinition,
} from "@/features/workspace/kinds/fileKind";
import {
  ImageBody,
  imageKindDefinition,
} from "@/features/workspace/kinds/imageKind";
import {
  ScratchpadBody,
  scratchpadKindDefinition,
  type TabBodyProps,
} from "@/features/workspace/kinds/scratchpadKind";
import {
  TerminalBody,
  terminalKindDefinition,
} from "@/features/workspace/kinds/terminalKind";
import { WebBody, webKindDefinition } from "@/features/workspace/kinds/webKind";
import {
  FactoryBody,
  factoryKindDefinition,
} from "@/features/workspace/kinds/factoryKind";
import {
  AgentBody,
  agentKindDefinition,
} from "@/features/workspace/kinds/agentKind";
import {
  CommGraphBody,
  commGraphKindDefinition,
} from "@/features/workspace/kinds/commGraphKind";
import { getFeature } from "@/shared/features/manifest";
import { resolveEnabled } from "@/shared/features/resolveEnabled";
import { getOverrides } from "@/shared/features/store";

/**
 * Kind string to body component.
 *
 * Kept separate from the registry so the registry stays a plain `.ts` module
 * that the `node --test` type-stripper can load without JSX.
 */
const bodies = new Map<string, React.ComponentType<TabBodyProps>>();

const WEB_TAB_FEATURE_ID = "workspaceWebTab";
const FACTORY_TAB_FEATURE_ID = "workspaceFactoryTab";
let stableKindsRegistered = false;
let webKindRegistered = false;
let factoryKindRegistered = false;

function workspaceFactoryTabEnabled(): boolean {
  const feature = getFeature(FACTORY_TAB_FEATURE_ID);
  return feature
    ? resolveEnabled(
        FACTORY_TAB_FEATURE_ID,
        getOverrides(),
        feature.defaultEnabled,
      )
    : true; // Default on when not in manifest.
}

function workspaceWebTabEnabled(): boolean {
  // The Electron browser is a shipping surface, independent of the old Tauri preview.
  if (electronDesktop()) return true;
  // The registry is also loaded by direct-loader tests without a browser
  // global. The desktop runtime always has window/localStorage; the safe
  // fallback keeps the preview surface default-off in non-browser contexts.
  if (typeof window === "undefined") return false;
  const feature = getFeature(WEB_TAB_FEATURE_ID);
  return feature
    ? resolveEnabled(WEB_TAB_FEATURE_ID, getOverrides(), feature.defaultEnabled)
    : false;
}

/** Look up the body for a kind. Unknown kinds render a fallback in the shell. */
export function getTabBody(
  kind: string,
): React.ComponentType<TabBodyProps> | undefined {
  return bodies.get(kind);
}

/**
 * Register every shipping kind. Idempotent, because the workspace shell calls
 * it on mount and a channel remount must not throw on a duplicate kind.
 */
export function registerAllTabKinds(): void {
  if (!stableKindsRegistered) {
    stableKindsRegistered = true;
    registerTabKind(scratchpadKindDefinition);
    bodies.set(scratchpadKindDefinition.kind, ScratchpadBody);
    registerTabKind(artifactKindDefinition);
    bodies.set(artifactKindDefinition.kind, ArtifactBody);
    registerTabKind(fileKindDefinition);
    bodies.set(fileKindDefinition.kind, FileBody);
    registerTabKind(imageKindDefinition);
    bodies.set(imageKindDefinition.kind, ImageBody);
    registerTabKind(terminalKindDefinition);
    bodies.set(terminalKindDefinition.kind, TerminalBody);
  }
  if (!factoryKindRegistered && workspaceFactoryTabEnabled()) {
    factoryKindRegistered = true;
    registerTabKind(factoryKindDefinition);
    bodies.set(factoryKindDefinition.kind, FactoryBody);
    // The agent tile is a Factory surface: it rides the same flag, so a build
    // without the Factory tab cannot restore an agent tab it cannot render.
    registerTabKind(agentKindDefinition);
    bodies.set(agentKindDefinition.kind, AgentBody);
    // The graph is part of the same surface, on the same flag.
    registerTabKind(commGraphKindDefinition);
    bodies.set(commGraphKindDefinition.kind, CommGraphBody);
  }
  if (!webKindRegistered && workspaceWebTabEnabled()) {
    webKindRegistered = true;
    registerTabKind(webKindDefinition);
    bodies.set(webKindDefinition.kind, WebBody);
  }
}

export type { TabBodyProps };
export { TerminalBody };
export { WebBody };
