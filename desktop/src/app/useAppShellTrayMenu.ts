import type { Channel } from "@/shared/api/types";

import { useTrayMenu } from "@/app/useTrayMenu";

/** Keeps the ticking native tray menu outside AppShell's render cycle. */
export function AppShellTrayMenu({
  channels,
  goChannel,
  openCreateChannel,
}: {
  channels: Channel[];
  goChannel: (channelId: string) => Promise<unknown>;
  openCreateChannel: () => void;
}): null {
  useTrayMenu({
    channels,
    goChannel,
    openCreateChannel,
  });
  return null;
}
