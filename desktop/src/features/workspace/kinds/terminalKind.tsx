import * as React from "react";
import "@xterm/xterm/css/xterm.css";
import { Search, ArrowUp, ArrowDown, X } from "lucide-react";

import { useCommunities } from "@/features/communities/useCommunities";
import { useProjectsQuery, type Project } from "@/features/projects/hooks";
import type { TabKindDefinition } from "@/features/workspace/lib/tabKindRegistry";
import {
  ackTerminalOutput,
  disposeTerminalSession,
  ensureTerminalSession,
  getTerminalSession,
  resizeTerminal,
  subscribeTerminalOutput,
  subscribeTerminalSession,
  writeTerminalInput,
} from "@/features/workspace/lib/terminalSessions";
import type {
  TerminalChunk,
  TerminalStartRequest,
} from "@/features/workspace/lib/terminalSessions";
import { openTab } from "@/features/workspace/lib/workspaceTabs";
import { openUrl } from "@/shared/api/nativeBridge";
import { resolveTerminalKey } from "./terminalKeys";
import type { TabBodyProps } from "@/features/workspace/kinds/scratchpadKind";

const TERMINAL_FONT_SCALE = 7 / 8;
type TerminalInstance = import("@xterm/xterm").Terminal;

const terminalMap = new Map<string, TerminalInstance>();

function isE2eMode(): boolean {
  return import.meta.env?.MODE === "e2e";
}

let e2eTerminalTextHookInstalled = false;

function e2eTerminalInstance(tabId?: string): TerminalInstance | null {
  const actualTabId = tabId ?? "";
  return terminalMap.get(actualTabId) ?? [...terminalMap.values()][0] ?? null;
}

/** Installs the e2e-only terminal buffer and geometry readers, once. */
function installE2eTerminalTextHook(): void {
  if (e2eTerminalTextHookInstalled) return;
  if (!isE2eMode()) return;
  e2eTerminalTextHookInstalled = true;
  (
    globalThis as {
      __BUZZ_E2E_TERMINAL_DIMS__?: (
        tabId?: string,
      ) => { cols: number; rows: number } | null;
    }
  ).__BUZZ_E2E_TERMINAL_DIMS__ = (tabId?: string) => {
    const instance = e2eTerminalInstance(tabId);
    return instance ? { cols: instance.cols, rows: instance.rows } : null;
  };
  (
    globalThis as { __BUZZ_E2E_TERMINAL_TEXT__?: (tabId?: string) => string }
  ).__BUZZ_E2E_TERMINAL_TEXT__ = (tabId?: string) => {
    const instance = e2eTerminalInstance(tabId);
    if (!instance) return "";
    const buffer = instance.buffer?.active ?? null;
    if (!buffer) return "";
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (line) {
        lines.push(line.translateToString(true));
      }
    }
    return lines.join("\n");
  };
}

export const terminalKindDefinition: TabKindDefinition = {
  kind: "terminal",
  label: "Terminal",
  createTitle: () => "Terminal",
  createPayload: () => ({ sessionKey: null }),
  canCreateFromNewTabPage: true,
  dispose: (tab) => disposeTerminalSession(tab.id),
};

/**
 * The explicit working directory a terminal tab was opened into.
 *
 * The Factory opens a terminal in an agent's own worktree; a tab restored from
 * localStorage may carry a payload this build never wrote, so anything that is
 * not a non-empty string reads as "no explicit cwd" and the project checkout
 * applies.
 */
export function readTerminalTabCwd(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const cwd = (payload as Record<string, unknown>).cwd;
  return typeof cwd === "string" && cwd.trim() ? cwd.trim() : null;
}

/** Open a terminal tab, optionally pinned to one directory. Returns its id. */
export function openTerminalTab(
  channelId: string,
  { cwd, title }: { cwd?: string | null; title?: string } = {},
): string {
  return openTab(channelId, {
    kind: terminalKindDefinition.kind,
    title: title ?? "Terminal",
    createdBy: "local",
    payload: { sessionKey: null, cwd: cwd ?? null },
  });
}

function chunkLength(chunk: TerminalChunk): number {
  return typeof chunk === "string" ? chunk.length : chunk.byteLength;
}

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
 */
export function buildTerminalStartRequest({
  channelId,
  project,
  projectsSettled,
  reposDir,
  cwd = null,
}: {
  channelId: string;
  project: Project | null | undefined;
  projectsSettled: boolean;
  reposDir: string | null;
  /** Explicit working directory (an agent's worktree), when one applies. */
  cwd?: string | null;
}): TerminalStartRequest | null {
  if (!projectsSettled) return null;
  const primaryRepository =
    project?.repositories.find(
      (candidate) => candidate.repoAddress === project.primaryRepositoryAddress,
    ) ?? project?.repositories[0];
  return {
    channelId,
    cwd,
    projectDtag: project?.dtag ?? null,
    cloneUrl: primaryRepository?.cloneUrls[0] ?? null,
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
  const syncSizeRef = React.useRef<(() => void) | null>(null);
  React.useEffect(() => {
    installE2eTerminalTextHook();
  }, []);
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
  const project = projects.data?.find(
    (candidate) => candidate.projectChannelId === channelId,
  );
  const explicitCwd = readTerminalTabCwd(tab.payload);
  const request = React.useMemo(
    () =>
      buildTerminalStartRequest({
        channelId,
        project,
        projectsSettled: projects.isFetched,
        reposDir: activeCommunity?.reposDir ?? null,
        cwd: explicitCwd,
      }),
    [
      activeCommunity?.reposDir,
      channelId,
      explicitCwd,
      project,
      projects.isFetched,
    ],
  );

  React.useEffect(() => {
    if (!request) return;
    void ensureTerminalSession(tab.id, request);
  }, [request, tab.id]);

  // Search state
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [searchTerm, setSearchTerm] = React.useState("");
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const searchAddonRef = React.useRef<
    import("@xterm/addon-search").SearchAddon | null
  >(null);

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let terminal: TerminalInstance | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let rootObserver: MutationObserver | null = null;
    let unsubscribeOutput: (() => void) | null = null;
    let unsubscribeResults: { dispose(): void } | null = null;
    let onData: { dispose(): void } | null = null;

    let lastCols: number | null = null;
    let lastRows: number | null = null;
    let resizeRafPending = false;

    const cleanup = () => {
      disposed = true;
      unsubscribeOutput?.();
      unsubscribeResults?.dispose();
      onData?.dispose();
      resizeObserver?.disconnect();
      rootObserver?.disconnect();
      terminal?.dispose();
      syncSizeRef.current = null;
      terminalRef.current = null;
      terminalMap.delete(tab.id);
    };

    void (async () => {
      const [
        { Terminal },
        { FitAddon },
        { Unicode11Addon },
        { WebLinksAddon },
        { ClipboardAddon },
        { SearchAddon },
        { WebglAddon },
      ] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-unicode11"),
        import("@xterm/addon-web-links"),
        import("@xterm/addon-clipboard"),
        import("@xterm/addon-search"),
        import("@xterm/addon-webgl"),
      ]);
      if (disposed) return;

      terminal = new Terminal({
        allowProposedApi: true,
        convertEol: true,
        cursorBlink: true,
        fontFamily:
          '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: computedTerminalFontSize(),
        scrollback: 10000,
        macOptionIsMeta: true,
        theme: {
          background: "#101217",
          foreground: "#e6e8ee",
        },
      });

      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(host);
      terminalRef.current = terminal;
      terminalMap.set(tab.id, terminal);

      // Addons loaded after open as per spec
      const unicodeAddon = new Unicode11Addon();
      terminal.loadAddon(unicodeAddon);
      if (terminal.unicode) {
        terminal.unicode.activeVersion = "11";
      }

      const linksAddon = new WebLinksAddon(
        (_event: MouseEvent, uri: string) => {
          void openUrl(uri);
        },
      );
      terminal.loadAddon(linksAddon);

      const clipboardAddon = new ClipboardAddon();
      terminal.loadAddon(clipboardAddon);

      const searchAddon = new SearchAddon();
      searchAddonRef.current = searchAddon;
      terminal.loadAddon(searchAddon);

      try {
        const webglAddon = new WebglAddon();
        terminal.loadAddon(webglAddon);
        webglAddon.onContextLoss(() => {
          webglAddon.dispose();
        });
      } catch {
        // Missing or lost WebGL context falls back silently.
      }

      const coalesceSync = () => {
        if (resizeRafPending) return;
        resizeRafPending = true;
        requestAnimationFrame(() => {
          resizeRafPending = false;
          if (disposed || !terminal) return;
          try {
            // Resize xterm to the host first; the PTY follows what xterm
            // actually adopted, not what the addon merely proposed.
            fit.fit();
          } catch {
            // A host detached mid-frame has no measurable size.
            return;
          }
          const cols = terminal.cols;
          const rows = terminal.rows;
          if (cols !== lastCols || rows !== lastRows) {
            lastCols = cols;
            lastRows = rows;
            void resizeTerminal(tab.id, cols, rows);
          }
        });
      };
      syncSizeRef.current = () => {
        lastCols = null;
        lastRows = null;
        coalesceSync();
      };

      resizeObserver = new ResizeObserver(coalesceSync);
      resizeObserver.observe(host);

      document.fonts.ready.then(() => {
        if (disposed) return;
        coalesceSync();
      });

      rootObserver = new MutationObserver(() => {
        const fontSize = computedTerminalFontSize();
        if (terminal) terminal.options.fontSize = fontSize;
        host.dataset.terminalFontSize = String(fontSize);
        host.dataset.terminalRootFontSize =
          document.documentElement.style.fontSize;
        coalesceSync();
      });
      rootObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["style", "class"],
      });

      terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
        const isMac = /mac|iphone|ipad|ipod/i.test(navigator.platform);
        const selection = terminal ? terminal.getSelection().length > 0 : false;
        const platform = isMac ? "mac" : "other";
        const action = resolveTerminalKey(
          {
            metaKey: event.metaKey ?? false,
            ctrlKey: event.ctrlKey ?? false,
            key: event.key ?? "",
            shiftKey: event.shiftKey ?? false,
          },
          { hasSelection: selection, platform },
        );
        if (action === "copy") {
          if (selection && terminal) {
            const text = terminal.getSelection();
            if (text.length > 0) {
              navigator.clipboard.writeText(text).catch(() => {});
            }
          }
          return false; // Custom handled; don't send to PTY
        }
        if (action === "paste") {
          navigator.clipboard
            .readText()
            .then((text) => {
              if (terminal) terminal.paste(text);
            })
            .catch(() => {});
          return false;
        }
        if (action === "search") {
          setSearchOpen(true);
          setTimeout(() => searchInputRef.current?.focus(), 0);
          return false;
        }
        if (action === "clear") {
          if (terminal) terminal.clear();
          return false;
        }
        return true; // Pass through to terminal / PTY
      });

      unsubscribeResults = searchAddon?.onDidChangeResults(
        (_event: { resultIndex: number; resultCount: number }) => {
          // We could use this to show match count; kept minimal.
        },
      );

      onData = terminal.onData((data) => {
        void writeTerminalInput(tab.id, data);
      });

      host.dataset.terminalRootFontSize = getComputedStyle(
        document.documentElement,
      ).fontSize;
      host.dataset.terminalFontSize = String(computedTerminalFontSize());

      // Initial sync after fonts ready
      document.fonts.ready.then(() => {
        if (!disposed) coalesceSync();
      });

      coalesceSync();
      terminal.focus();
      const sink = terminal;
      unsubscribeOutput = subscribeTerminalOutput(tab.id, (chunk) => {
        sink.write(chunk, () => {
          void ackTerminalOutput(tab.id, chunkLength(chunk));
        });
      });
    })();
    return cleanup;
  }, [tab.id]);

  // Restart handler for exited state
  const handleRestart = React.useCallback(async () => {
    await disposeTerminalSession(tab.id);
    if (request) {
      await ensureTerminalSession(tab.id, request);
      // Dispose forgot the pane size, so the restarted shell is re-fitted.
      syncSizeRef.current?.();
    }
  }, [tab.id, request]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background relative">
      <div
        className="xterm-host min-h-0 flex-1 overflow-hidden"
        aria-label="Workspace terminal"
        data-cwd={session.cwd ?? undefined}
        data-pid={session.pid?.toString() ?? undefined}
        data-status={session.status}
        data-testid="workspace-terminal-body"
        role="application"
        ref={hostRef}
      />
      {searchOpen && (
        <div
          className="absolute top-2 right-2 z-10 flex items-center gap-1 rounded-md border border-border bg-card/95 px-2 py-1 shadow-lg"
          data-testid="workspace-terminal-search-bar"
        >
          <Search className="h-3.5 w-3.5 text-muted-foreground" />
          <input
            ref={searchInputRef}
            className="h-6 w-32 rounded-sm border-0 bg-transparent px-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-0"
            value={searchTerm}
            onChange={(e) => {
              setSearchTerm(e.target.value);
              if (searchAddonRef.current) {
                searchAddonRef.current.findNext(e.target.value, {
                  incremental: true,
                });
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setSearchOpen(false);
                setSearchTerm("");
                if (searchAddonRef.current) {
                  searchAddonRef.current.clearDecorations();
                }
                e.preventDefault();
                return;
              }
              if (e.key === "Enter") {
                if (searchAddonRef.current && searchTerm) {
                  searchAddonRef.current.findNext(searchTerm, {
                    incremental: true,
                  });
                }
                e.preventDefault();
              }
              if (e.key === "Enter" && e.shiftKey) {
                if (searchAddonRef.current && searchTerm) {
                  searchAddonRef.current.findPrevious(searchTerm, {
                    incremental: true,
                  });
                }
                e.preventDefault();
              }
            }}
            placeholder="Find..."
            data-testid="workspace-terminal-search-input"
          />
          <button
            type="button"
            className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-xs text-muted-foreground hover:text-foreground hover:bg-muted"
            onClick={() => {
              if (searchAddonRef.current && searchTerm) {
                searchAddonRef.current.findNext(searchTerm, {
                  incremental: true,
                });
              }
            }}
            aria-label="Next match"
            data-testid="workspace-terminal-search-next"
          >
            <ArrowUp className="h-3 w-3 rotate-[-90deg]" />
          </button>
          <button
            type="button"
            className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-xs text-muted-foreground hover:text-foreground hover:bg-muted"
            onClick={() => {
              if (searchAddonRef.current && searchTerm) {
                searchAddonRef.current.findPrevious(searchTerm, {
                  incremental: true,
                });
              }
            }}
            aria-label="Previous match"
            data-testid="workspace-terminal-search-prev"
          >
            <ArrowDown className="h-3 w-3 rotate-[90deg]" />
          </button>
          <button
            type="button"
            className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-xs text-muted-foreground hover:text-foreground hover:bg-muted"
            onClick={() => {
              setSearchOpen(false);
              setSearchTerm("");
              if (searchAddonRef.current) {
                searchAddonRef.current.clearDecorations();
              }
            }}
            aria-label="Close search"
            data-testid="workspace-terminal-search-close"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
      {session.status === "error" ? (
        <div
          className="shrink-0 border-t border-destructive/30 px-3 py-1 text-xs text-destructive"
          data-testid="workspace-terminal-error"
        >
          {session.error ?? "Terminal failed to start."}
        </div>
      ) : session.status === "exited" ? (
        <div
          className="shrink-0 flex items-center justify-between border-t border-border px-3 py-1 text-xs text-muted-foreground"
          data-testid="workspace-terminal-exited"
        >
          <span>Shell exited</span>
          <button
            type="button"
            className="rounded-sm px-2 py-0.5 text-xs font-medium text-foreground hover:bg-muted"
            onClick={() => void handleRestart()}
            data-testid="workspace-terminal-restart"
          >
            Restart
          </button>
        </div>
      ) : null}
    </div>
  );
}
