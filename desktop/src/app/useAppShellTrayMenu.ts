import type { Channel } from "@/shared/api/types";

import { useTrayMenu } from "@/app/useTrayMenu";

/** Connects the native tray menu to the AppShell's channel navigation. */
export function useAppShellTrayMenu(
  channels: Channel[],
  goChannel: (channelId: string) => Promise<unknown>,
  openCreateChannel: () => void,
): void {
  useTrayMenu({
    channels,
    goChannel,
    openCreateChannel,
  });
}
