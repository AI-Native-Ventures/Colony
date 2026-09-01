import * as React from "react";

import type { AgentPersona } from "@/shared/api/types";
import { STARTER_PERSONA_IDS } from "@/shared/constants/starterPersonas";

const STORAGE_KEY = "buzz:bot-recents";
const MAX_RECENTS = 8;

// Starter personas seeded into the quick-bot list when there are no recents,
// in the order they should appear. Matched by persona ID, not display name:
// IDs are stable and persisted relay-side, while display names are branding
// and can change. Matching on the name made this silently fall back to
// catalog order the moment the starter team was renamed, with no error.
export const DEFAULT_PERSONA_IDS = [STARTER_PERSONA_IDS.fizz] as const;

export function pickQuickBotPersonas(
  personas: readonly AgentPersona[],
  recentIds: readonly string[],
  maxCount = 3,
) {
  if (personas.length === 0) {
    return [];
  }

  const resolved: AgentPersona[] = [];

  const addPersona = (persona: AgentPersona | undefined) => {
    if (!persona || resolved.some((candidate) => candidate.id === persona.id)) {
      return;
    }

    resolved.push(persona);
  };

  for (const id of recentIds) {
    if (resolved.length >= maxCount) {
      break;
    }

    addPersona(personas.find((persona) => persona.id === id));
  }

  for (const personaId of DEFAULT_PERSONA_IDS) {
    if (resolved.length >= maxCount) {
      break;
    }

    addPersona(personas.find((persona) => persona.id === personaId));
  }

  for (const persona of personas) {
    if (resolved.length >= maxCount) {
      break;
    }

    addPersona(persona);
  }

  return resolved;
}

export function useBotRecents(): {
  recentIds: string[];
  pushRecent: (personaId: string) => void;
} {
  const [recentIds, setRecentIds] = React.useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  });

  const pushRecent = React.useCallback((personaId: string) => {
    setRecentIds((prev) => {
      const next = [personaId, ...prev.filter((id) => id !== personaId)].slice(
        0,
        MAX_RECENTS,
      );
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // localStorage full — ignore
      }
      return next;
    });
  }, []);

  return { recentIds, pushRecent };
}
