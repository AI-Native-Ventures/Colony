import { useEffect, useState } from "react";
import { electronDesktop } from "@/shared/api/electronNativeBridge";

type Teammate = { pubkey: string; name: string };

/** Owner controls for sharing a signed-in browser tab with one local teammate. */
export function BrowserTeammateControls({
  tabId,
  business,
}: {
  tabId: string;
  business?: string;
}) {
  const api = electronDesktop();
  const [open, setOpen] = useState(false);
  const [workers, setWorkers] = useState<Teammate[]>([]);
  const [selected, setSelected] = useState("");
  const [mode, setMode] = useState("read");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!api || !open || !business) return;
    let alive = true;
    setLoaded(false);
    const refresh = async () => {
      try {
        const rows = await api.request<Teammate[]>("browser:workers");
        if (!alive) return;
        setWorkers(rows);
        setSelected((current) =>
          rows.some((row) => row.pubkey === current)
            ? current
            : (rows[0]?.pubkey ?? ""),
        );
        setLoaded(true);
      } catch (reason) {
        if (alive) {
          setWorkers([]);
          setSelected("");
          setError(String(reason));
          setLoaded(true);
        }
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [api, open, business]);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer">Share with a teammate</summary>
      <div className="flex flex-wrap items-center gap-2 py-2">
        {!loaded ? (
          <span>Finding running teammates…</span>
        ) : workers.length === 0 ? (
          <span>
            Start a local teammate set to respond only to you, then return here.
          </span>
        ) : (
          <>
            <label>
              Teammate{" "}
              <select
                aria-label="Browser teammate"
                className="rounded border bg-background p-1"
                value={selected}
                onChange={(event) => setSelected(event.target.value)}
              >
                {workers.map((worker) => (
                  <option key={worker.pubkey} value={worker.pubkey}>
                    {worker.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Access{" "}
              <select
                aria-label="Browser access"
                className="rounded border bg-background p-1"
                value={mode}
                onChange={(event) => setMode(event.target.value)}
              >
                <option value="read">Read only</option>
                <option value="interact">Read and interact</option>
              </select>
            </label>
            <button
              type="button"
              disabled={busy || !selected}
              className="rounded border px-2 py-1 disabled:opacity-50"
              onClick={() => {
                setError(null);
                setBusy(true);
                void api
                  ?.request("browser:share", {
                    id: tabId,
                    pubkey: selected,
                    mode,
                  })
                  .catch((reason) => setError(String(reason)))
                  .finally(() => setBusy(false));
              }}
            >
              {busy ? "Sharing…" : "Share this tab"}
            </button>
          </>
        )}
      </div>
      <p className="pb-2">
        Access stays on this website. Use Take control to end it.
      </p>
      {error && (
        <p role="alert" className="pb-2 text-destructive">
          {error}
        </p>
      )}
    </details>
  );
}
