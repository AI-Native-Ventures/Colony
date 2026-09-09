import { useEffect, useRef, useState } from "react";
import { getIdentity } from "@/shared/api/tauriIdentity";
import { useCommunityOnboarding } from "@/features/onboarding/communityOnboarding";
import { getStorageItem } from "@/shared/lib/safeStorage";
import { electronDesktop } from "@/shared/api/electronNativeBridge";
import { useCommunities } from "@/features/communities/useCommunities";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/shared/ui/dialog";
import {
  describeBrowserImport,
  filterImportSites,
  importSelectedSites,
  selectImportSites,
  type BrowserImportResult,
} from "./browserImportModel";

type Profile = {
  id: string;
  browserName: string;
  profileName: string;
  supported: boolean;
};

function ImportForm({ business }: { business: string }) {
  const api = electronDesktop();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileId, setProfileId] = useState("");
  const [sites, setSites] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BrowserImportResult | null>(null);
  const [progress, setProgress] = useState("");
  const mounted = useRef(false);
  const resultElement = useRef<HTMLDivElement>(null);
  const visibleSites = filterImportSites(sites, filter);
  const allVisibleSelected = visibleSites.every((site) =>
    selected.includes(site),
  );
  const outcome = result ? describeBrowserImport(result) : null;
  useEffect(() => {
    if (result) resultElement.current?.scrollIntoView({ block: "nearest" });
  }, [result]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let current = true;
    setBusy(true);
    void api
      ?.request<{ profiles: Profile[] }>("import:discover")
      .then((value) => {
        if (current) setProfiles(value.profiles);
      })
      .catch(() => {
        if (current)
          setError(
            "Could not detect browsers. You can sign in directly in a Colony browser tab.",
          );
      })
      .finally(() => {
        if (current) setBusy(false);
      });
    return () => {
      current = false;
    };
  }, [api]);
  return (
    <div className="space-y-4" data-testid="browser-import" aria-busy={busy}>
      <p className="text-sm text-muted-foreground">
        Bring signed-in accounts from a browser on this computer into this
        business. Choose the sites to copy. Existing Colony sign-ins are
        preserved unless you choose to replace them below. Some sites will ask
        you to sign in again.
      </p>
      {result && outcome && (
        <div
          ref={resultElement}
          role="status"
          aria-live="polite"
          className="space-y-2 rounded-xl border bg-muted/40 p-4 text-sm"
          data-testid="browser-import-result"
        >
          <p className="font-semibold">{outcome.title}</p>
          <p>{outcome.detail}</p>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 py-1">
            {[
              ["Cookies copied", result.imported],
              ["Existing cookies kept", result.preserved],
              ["Expired or unsupported", result.skipped],
              ["Could not be copied", result.failed],
            ].map(([label, count]) => (
              <div key={label}>
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="font-semibold tabular-nums">{count}</dd>
              </div>
            ))}
          </dl>
          <p>{outcome.nextStep}</p>
        </div>
      )}
      <label className="block space-y-2 text-sm">
        Browser profile
        <select
          aria-label="Browser profile"
          className="block w-full rounded border bg-background p-2"
          value={profileId}
          disabled={busy}
          onChange={(event) => {
            const id = event.target.value;
            setProfileId(id);
            setSites([]);
            setSelected([]);
            setFilter("");
            setReplaceExisting(false);
            setResult(null);
            setError(null);
            if (!id) return;
            setBusy(true);
            void api
              ?.request<string[]>("import:sites", { profileId: id })
              .then(setSites)
              .catch((reason) => setError(String(reason)))
              .finally(() => setBusy(false));
          }}
        >
          <option value="">Choose a browser profile</option>
          {profiles.map((profile) => (
            <option
              key={profile.id}
              value={profile.id}
              disabled={!profile.supported}
            >
              {profile.browserName} · {profile.profileName}
              {profile.supported ? "" : " — sign in directly"}
            </option>
          ))}
        </select>
      </label>
      {!busy && profiles.length === 0 && (
        <p className="text-sm">
          No supported browser profiles found. Open your website in a Colony
          browser tab and sign in.
        </p>
      )}
      {sites.length > 0 && (
        <>
          <input
            aria-label="Filter sites"
            placeholder="Find a site, e.g. instagram"
            value={filter}
            disabled={busy}
            onChange={(event) => setFilter(event.target.value)}
            className="w-full rounded border bg-background p-2 text-sm"
          />
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span aria-live="polite">
              {selected.length} of {sites.length} sites selected
              {filter.trim() && ` · ${visibleSites.length} matches`}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={
                  busy || visibleSites.length === 0 || allVisibleSelected
                }
                onClick={() =>
                  setSelected((previous) =>
                    selectImportSites(previous, visibleSites),
                  )
                }
              >
                {filter.trim() ? "Select matches" : "Select all"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy || selected.length === 0}
                onClick={() => setSelected([])}
              >
                Clear selection
              </Button>
            </div>
          </div>
          <div className="max-h-56 space-y-2 overflow-auto rounded border p-3">
            {visibleSites.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No sites match your search.
              </p>
            )}
            {visibleSites.map((site) => (
              <label key={site} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={selected.includes(site)}
                  onChange={(event) =>
                    setSelected((previous) =>
                      event.target.checked
                        ? selectImportSites(previous, [site])
                        : previous.filter((value) => value !== site),
                    )
                  }
                />
                {site}
              </label>
            ))}
          </div>
        </>
      )}
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          disabled={busy}
          checked={replaceExisting}
          onChange={(event) => setReplaceExisting(event.target.checked)}
        />
        Replace existing sign-ins for the selected sites with accounts from this
        browser.
      </label>
      <p className="text-xs text-muted-foreground">
        Import runs locally. Saved passwords are not imported. macOS may ask for
        Keychain access. Browser profiles are detected; account access is
        verified by opening each site afterward.
      </p>
      <Button
        disabled={busy || selected.length === 0}
        onClick={() => {
          setBusy(true);
          setError(null);
          setResult(null);
          setProgress(`Importing ${selected.length} sites…`);
          void importSelectedSites({
            hosts: selected,
            isCurrent: () => mounted.current,
            onProgress: (completed, total) => {
              if (mounted.current)
                setProgress(
                  `Processed ${completed} of ${total} selected sites…`,
                );
            },
            run: (hosts) => {
              if (!api)
                return Promise.reject(
                  new Error(
                    "The browser connection is unavailable. Try opening Colony again.",
                  ),
                );
              return api.request<BrowserImportResult>("import:run", {
                business,
                profileId,
                hosts,
                confirmed: true,
                replaceExisting,
              });
            },
          })
            .then((value) => {
              if (mounted.current) setResult(value);
            })
            .catch((reason) => {
              if (mounted.current) setError(String(reason));
            })
            .finally(() => {
              if (mounted.current) {
                setBusy(false);
                setProgress("");
              }
            });
        }}
      >
        {busy
          ? progress || "Working…"
          : `Import sign-ins${selected.length ? ` (${selected.length} ${selected.length === 1 ? "site" : "sites"})` : ""}`}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
export function BrowserSettings() {
  const { activeCommunity } = useCommunities();
  if (!electronDesktop())
    return <p>Browser sign-in import is available in the Electron desktop.</p>;
  return (
    <section className="space-y-5">
      <h2 className="text-xl font-semibold">Browser</h2>
      {activeCommunity ? (
        <>
          <p className="text-sm">Import sign-ins for {activeCommunity.name}.</p>
          <ImportForm key={activeCommunity.id} business={activeCommunity.id} />
        </>
      ) : (
        <p>Choose a business to import its sign-ins.</p>
      )}
    </section>
  );
}
export function BrowserImportWelcome() {
  const { transaction } = useCommunityOnboarding();
  const [completionVersion, setCompletionVersion] = useState(0);
  useEffect(() => {
    const refresh = () => setCompletionVersion((value) => value + 1);
    window.addEventListener("colony:onboarding-complete", refresh);
    return () =>
      window.removeEventListener("colony:onboarding-complete", refresh);
  }, []);
  const { activeCommunity } = useCommunities();
  const business = activeCommunity?.id;
  const [open, setOpen] = useState(false);
  // The first-use prompt mounts outside QueryClientProvider. Read the native
  // identity only after Electron/business eligibility, and discard stale reads.
  // biome-ignore lint/correctness/useExhaustiveDependencies: completionVersion invalidates the persisted completion marker.
  useEffect(() => {
    let cancelled = false;
    setOpen(false);
    if (
      electronDesktop() &&
      business &&
      !transaction &&
      activeCommunity?.relayUrl &&
      !getStorageItem("colony-browser-import-offered")
    ) {
      const relay = activeCommunity.relayUrl;
      void getIdentity()
        .then((identity) => {
          if (
            !cancelled &&
            getStorageItem(
              `buzz-community-onboarding-complete.v1:${encodeURIComponent(relay)}:${identity.pubkey}`,
            ) === "true"
          )
            setOpen(true);
        })
        .catch(() => {
          /* Optional import remains available in Settings. */
        });
    }
    return () => {
      cancelled = true;
    };
  }, [business, activeCommunity?.relayUrl, transaction, completionVersion]);
  if (!business || !electronDesktop()) return null;
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (!value) localStorage.setItem("colony-browser-import-offered", "1");
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-auto">
        <DialogHeader>
          <DialogTitle>Bring your signed-in accounts</DialogTitle>
          <DialogDescription>
            Connect the websites you already use to {activeCommunity?.name}. You
            can also do this later in Settings → Browser.
          </DialogDescription>
        </DialogHeader>
        <ImportForm key={business} business={business} />
        <Button
          variant="outline"
          onClick={() => {
            localStorage.setItem("colony-browser-import-offered", "1");
            setOpen(false);
          }}
        >
          Done / do this later
        </Button>
      </DialogContent>
    </Dialog>
  );
}
