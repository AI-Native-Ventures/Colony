import * as React from "react";
import "@xterm/xterm/css/xterm.css";

import { useCommunities } from "@/features/communities/useCommunities";
import { useProjectsQuery, type Project } from "@/features/projects/hooks";
import type { TabKindDefinition } from "@/features/workspace/lib/tabKindRegistry";
import {
  disposeTerminalSession,
  ensureTerminalSession,
  getTerminalSession,
  resizeTerminal,
  subscribeTerminalSession,
  writeTerminalInput,
} from "@/features/workspace/lib/terminalSessions";
import type { TerminalStartRequest } from "@/features/workspace/lib/terminalSessions";
import type { TabBodyProps } from "@/features/workspace/kinds/scratchpadKind";

const TERMINAL_FONT_SCALE = 7 / 8;
type TerminalInstance = import("@xterm/xterm").Terminal;

export const terminalKindDefinition: TabKindDefinition = {
  kind: "terminal",
  label: "Terminal",
  createTitle: () => "Terminal",
  createPayload: () => ({ sessionKey: null }),
  canCreateFromNewTabPage: true,
  dispose: (tab) => disposeTerminalSession(tab.id),
};

function computedTerminalFontSize(): number {
  const rootSize = Number.parseFloat(
    globalThis.getComputedStyle(document.documentElement).fontSize,
  );
  return Number.isFinite(rootSize)
    ? Math.max(10, rootSize * TERMINAL_FONT_SCALE)
    : 14;
}

/**
 * Build the one native start request allowed for a terminal body.
 *
 * The project query must settle first: an unresolved query is not evidence
 * that the channel has no linked project, so starting then would permanently
 * pin the PTY to the home directory.
 */
export function buildTerminalStartRequest({
  channelId,
  project,
  projectsSettled,
  reposDir,
}: {
  channelId: string;
  project: Project | null | undefined;
  projectsSettled: boolean;
  reposDir: string | null;
}): TerminalStartRequest | null {
  if (!projectsSettled) return null;
  return {
    channelId,
    projectDtag: project?.dtag ?? null,
    cloneUrl: project?.cloneUrls[0] ?? null,
    reposDir,
    cols: 80,
    rows: 24,
    pixelWidth: 0,
    pixelHeight: 0,
  };
}

/** Real xterm.js terminal renderer backed by the NativeBridge PTY. */
export function TerminalBody({
  channelId,
  tab,
}: TabBodyProps): React.JSX.Element {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const terminalRef = React.useRef<TerminalInstance | null>(null);
  const renderedOutputLengthRef = React.useRef(0);
  const latestOutputRef = React.useRef("");
  const { activeCommunity } = useCommunities();
  const projects = useProjectsQuery();
  const session = React.useSyncExternalStore(
    React.useCallback(
      (listener) => subscribeTerminalSession(tab.id, listener),
      [tab.id],
    ),
    React.useCallback(() => getTerminalSession(tab.id), [tab.id]),
    React.useCallback(() => getTerminalSession(tab.id), [tab.id]),
  );
  latestOutputRef.current = session.output;
  const project = projects.data?.find(
    (candidate) => candidate.projectChannelId === channelId,
  );
  const request = React.useMemo(
    () =>
      buildTerminalStartRequest({
        channelId,
        project,
        projectsSettled: projects.isFetched,
        reposDir: activeCommunity?.reposDir ?? null,
      }),
    [activeCommunity?.reposDir, channelId, project, projects.isFetched],
  );

  React.useEffect(() => {
    if (!request) return;
    void ensureTerminalSession(tab.id, request);
  }, [request, tab.id]);

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let terminal: TerminalInstance | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let rootObserver: MutationObserver | null = null;
    let onData: { dispose(): void } | null = null;
    const cleanup = () => {
      disposed = true;
      onData?.dispose();
      resizeObserver?.disconnect();
      rootObserver?.disconnect();
      terminal?.dispose();
      terminalRef.current = null;
    };
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed) return;
      terminal = new Terminal({
        convertEol: true,
        cursorBlink: true,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: computedTerminalFontSize(),
        scrollback: 5000,
        theme: {
          background: "#101217",
          foreground: "#e6e8ee",
        },
      });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(host);
      terminalRef.current = terminal;
      const syncSize = () => {
        fit.fit();
        const dimensions = fit.proposeDimensions();
        if (dimensions) {
          void resizeTerminal(tab.id, dimensions.cols, dimensions.rows);
        }
      };
      resizeObserver = new ResizeObserver(syncSize);
      resizeObserver.observe(host);
      rootObserver = new MutationObserver(() => {
        const fontSize = computedTerminalFontSize();
        if (terminal) terminal.options.fontSize = fontSize;
        host.dataset.terminalFontSize = String(fontSize);
        host.dataset.terminalRootFontSize =
          document.documentElement.style.fontSize;
        syncSize();
      });
      rootObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["style", "class"],
      });
      onData = terminal.onData((data) => {
        void writeTerminalInput(tab.id, data);
      });
      host.dataset.terminalRootFontSize = getComputedStyle(
        document.documentElement,
      ).fontSize;
      host.dataset.terminalFontSize = String(computedTerminalFontSize());
      syncSize();
      terminal.focus();
      if (latestOutputRef.current) {
        terminal.write(latestOutputRef.current);
        renderedOutputLengthRef.current = latestOutputRef.current.length;
      }
    })();
    return cleanup;
  }, [tab.id]);

  React.useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const previousLength = renderedOutputLengthRef.current;
    if (session.output.length < previousLength) {
      terminal.clear();
      renderedOutputLengthRef.current = 0;
    }
    const start = renderedOutputLengthRef.current;
    if (session.output.length > start) {
      terminal.write(session.output.slice(start));
      renderedOutputLengthRef.current = session.output.length;
    }
  }, [session.output]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div
        className="xterm-host min-h-0 flex-1 overflow-hidden"
        aria-label="Workspace terminal"
        data-cwd={session.cwd ?? undefined}
        data-output={session.output}
        data-pid={session.pid?.toString() ?? undefined}
        data-status={session.status}
        data-testid="workspace-terminal-body"
        role="application"
        ref={hostRef}
      />
      {session.status === "error" ? (
        <div
          className="shrink-0 border-t border-destructive/30 px-3 py-1 text-xs text-destructive"
          data-testid="workspace-terminal-error"
        >
          {session.error ?? "Terminal failed to start."}
        </div>
      ) : session.status === "exited" ? (
        <div
          className="shrink-0 border-t border-border px-3 py-1 text-xs text-muted-foreground"
          data-testid="workspace-terminal-exited"
        >
          Terminal exited
        </div>
      ) : null}
    </div>
  );
}
