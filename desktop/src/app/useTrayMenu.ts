import * as React from "react";
import { isTauri, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import {
  getActiveTurnsForAgent,
  useActiveAgentTurnsByChannel,
} from "@/features/agents/activeAgentTurnsStore";
import {
  useManagedAgentsQuery,
  useRelayAgentsQuery,
} from "@/features/agents/hooks";
import { normalizePubkey, truncatePubkey } from "@/shared/lib/pubkey";
import { useNow } from "@/shared/lib/useNow";
import { formatElapsed } from "@/features/agents/ui/agentSessionUtils";
import type { Channel } from "@/shared/api/types";

type TrayAgentActivity = {
  activityId: string;
  agentName: string;
  channelId: string;
  channelName: string;
  elapsed: string;
};

const MAX_RECENT_TRAY_ACTIVITIES = 5;

/**
 * Keeps Buzz's native tray menu synchronized with active agent turns and
 * forwards its navigation actions into the React app.
 */
export function useTrayMenu({
  channels,
  goChannel,
  openCreateChannel,
}: {
  channels: Channel[];
  goChannel: (channelId: string) => Promise<unknown>;
  openCreateChannel: () => void;
}): void {
  const activeTurns = useActiveAgentTurnsByChannel();
  const now = useNow(1000);
  const managedAgents = useManagedAgentsQuery().data;
  const relayAgents = useRelayAgentsQuery().data;
  const previousActivitiesRef = React.useRef(
    new Map<string, TrayAgentActivity>(),
  );
  const [recentActivities, setRecentActivities] = React.useState<
    TrayAgentActivity[]
  >([]);

  const activities = React.useMemo<TrayAgentActivity[]>(() => {
    const channelNames = new Map(
      channels.map((channel) => [channel.id, channel.name]),
    );
    const agentNames = new Map<string, string>();
    for (const agent of [...(managedAgents ?? []), ...(relayAgents ?? [])]) {
      agentNames.set(normalizePubkey(agent.pubkey), agent.name);
    }

    return activeTurns.flatMap((channelTurn) =>
      channelTurn.agentPubkeys.map((pubkey) => {
        const agentTurn = getActiveTurnsForAgent(pubkey).find(
          (turn) => turn.channelId === channelTurn.channelId,
        );

        return {
          activityId: `${channelTurn.channelId}:${normalizePubkey(pubkey)}`,
          agentName:
            agentNames.get(normalizePubkey(pubkey)) ??
            `Agent ${truncatePubkey(pubkey)}`,
          channelId: channelTurn.channelId,
          channelName:
            channelNames.get(channelTurn.channelId) ?? "Unknown channel",
          elapsed: formatElapsed(
            now - (agentTurn?.anchorAt ?? channelTurn.anchorAt),
          ),
        };
      }),
    );
  }, [activeTurns, channels, managedAgents, now, relayAgents]);

  React.useEffect(() => {
    const currentActivities = new Map(
      activities.map((activity) => [activity.activityId, activity]),
    );
    const completedActivities = [...previousActivitiesRef.current.entries()]
      .filter(([activityId]) => !currentActivities.has(activityId))
      .map(([, activity]) => ({
        ...activity,
        activityId: `recent:${activity.activityId}:${Date.now()}`,
      }));

    if (completedActivities.length > 0) {
      setRecentActivities((current) =>
        [...completedActivities, ...current].slice(
          0,
          MAX_RECENT_TRAY_ACTIVITIES,
        ),
      );
    }
    previousActivitiesRef.current = currentActivities;
  }, [activities]);

  React.useEffect(() => {
    if (!isTauri()) return;
    void invoke("update_tray_agent_activity", {
      activities,
      recentActivities,
    });
  }, [activities, recentActivities]);

  React.useEffect(() => {
    if (!isTauri()) return;

    const unlistenChannel = listen<string>("tray-open-channel", (event) => {
      void goChannel(event.payload);
    });
    const unlistenNewChannel = listen("tray-new-channel", () => {
      openCreateChannel();
    });

    return () => {
      void unlistenChannel.then((unlisten) => unlisten());
      void unlistenNewChannel.then((unlisten) => unlisten());
    };
  }, [goChannel, openCreateChannel]);
}
