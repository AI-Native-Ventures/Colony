/**
 * Adapter from the generic evidence host to Colony's verified artifact
 * renderer. The website preview host remains the single implementation of
 * manifest verification, wrapper isolation, fixed iframe geometry, and
 * preview teardown; this module only gives EvidenceBrowserHost the entry it
 * needs to run its generic page-tools protocol.
 */

import { createWebsitePreviewHost } from "../website-preview/host.mjs";
import { evidenceViewportSize, validateEvidenceUrl } from "./policy.mjs";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function requireElectronConstructors({ BrowserWindow, WebContentsView, View, session }) {
  if (
    typeof BrowserWindow !== "function" ||
    typeof WebContentsView !== "function" ||
    typeof View !== "function" ||
    session === null ||
    typeof session?.fromPartition !== "function"
  ) {
    throw new Error("Verified artifact rendering requires Electron view constructors");
  }
}

/** Return the positive signed Website content revision required by artifacts. */
export function requireWebsiteRevision(binding) {
  if (
    !Number.isSafeInteger(binding?.websiteRevision) ||
    binding.websiteRevision < 1
  ) {
    throw new Error(
      "Verified artifact rendering requires the signed Website content revision",
    );
  }
  return binding.websiteRevision;
}

/** Require the caller's manifest to be the one in the signed current revision. */
export function requireWebsiteManifest(binding, manifest) {
  let expectedUrl;
  try {
    expectedUrl = validateEvidenceUrl(binding?.websiteManifestUrl).href;
  } catch {
    throw new Error(
      "Verified artifact rendering requires the signed current Website manifest",
    );
  }
  const expectedHash = binding?.websiteManifestSha256;
  if (typeof expectedHash !== "string" || !SHA256_PATTERN.test(expectedHash)) {
    throw new Error(
      "Verified artifact rendering requires the signed current Website manifest",
    );
  }
  let manifestUrl;
  try {
    manifestUrl = validateEvidenceUrl(manifest?.url).href;
  } catch {
    throw new Error("The artifact manifest does not match the signed Website revision");
  }
  if (manifestUrl !== expectedUrl || manifest?.sha256 !== expectedHash) {
    throw new Error("The artifact manifest does not match the signed Website revision");
  }
  return Object.freeze({ url: manifestUrl, sha256: expectedHash });
}

/**
 * Create an EvidenceBrowserHost artifact callback backed by the verified
 * WebsitePreviewHost. `loadPreview` must already capture the current owner and
 * business generation before reading any manifest bytes.
 */
export function createVerifiedArtifactRenderer({
  BrowserWindow,
  WebContentsView,
  View,
  session,
  loadPreview,
} = {}) {
  requireElectronConstructors({ BrowserWindow, WebContentsView, View, session });
  if (typeof loadPreview !== "function")
    throw new Error("Verified artifact rendering requires a verified loader");

  const previewHost = createWebsitePreviewHost({
    WebContentsView,
    View,
    session,
    loadPreview,
    // The wrapper is required for the separate-origin artifact child even when
    // the visible bounds equal the fixed viewport. Production native clipping
    // remains independently gated by the WebsitePreviewHost proof.
    clipStrategy: "clip",
  });

  const render = async ({ binding, source, viewport } = {}) => {
    if (source?.kind !== "verified-artifact")
      throw new Error("Local build evidence requires a host-registered renderer");
    const websiteRevision = requireWebsiteRevision(binding);
    const manifest = requireWebsiteManifest(binding, source.manifest);
    const size = evidenceViewportSize(viewport);
    const window = new BrowserWindow({
      width: size.width,
      height: size.height,
      useContentSize: true,
      show: false,
      skipTaskbar: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: false,
      },
    });
    let state;
    try {
      state = await previewHost.open({
        window,
        communityId: binding.communityId,
        jobId: binding.jobId,
        threadRoot: binding.threadRoot,
        // `websiteGeneration` is the signed Website-head lifecycle stamp;
        // preview identity must use the actual content revision instead of a
        // fallback or a row generation that may advance for other head data.
        revision: websiteRevision,
        manifest,
        viewport,
        pixelWidth: size.width,
        pixelHeight: size.height,
        bounds: { x: 0, y: 0, width: size.width, height: size.height },
        visible: true,
        zoom: 1,
      });
      const entry = previewHost.byHandle.get(state.handle);
      if (!entry?.view?.webContents)
        throw new Error("The verified artifact did not produce an isolated page");
      return {
        window,
        view: entry.view,
        webContents: entry.webContents,
        tab: {
          id: `evidence-artifact-${state.handle}`,
          view: entry.view,
          observation: null,
        },
        close: async () => {
          await previewHost.close({ window, handle: state.handle });
          try {
            window.close();
          } catch {}
        },
      };
    } catch (error) {
      if (state?.handle) {
        await previewHost.close({ window, handle: state.handle }).catch(() => {});
      } else {
        await previewHost.closeAllForWindow(window).catch(() => {});
      }
      try {
        window.close();
      } catch {}
      throw error;
    }
  };

  render.close = () => previewHost.closeAll();
  return render;
}
