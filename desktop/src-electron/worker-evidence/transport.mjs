/**
 * Host-owned HTTPS transport for worker evidence sessions.
 *
 * Chromium still owns parsing, layout, JavaScript, and interaction. Its
 * session's HTTPS protocol is handled here, so every navigation and
 * subresource is fetched through the pinned Node transport rather than merely
 * passing a DNS preflight and then letting Chromium resolve the name again.
 * The session is ephemeral and carries no application cookies or credentials.
 */

import {
  createDefaultDependencies,
  fetchBoundBytes,
  TIMEOUT_CODE,
} from "../website-preview/network.mjs";
import {
  evidenceResponseHeaders,
  isAllowedEvidenceRequest,
  MAX_EVIDENCE_BYTES,
  MAX_EVIDENCE_REQUESTS,
  MAX_EVIDENCE_RESOURCE_BYTES,
  requireEvidenceReadMethod,
  validateEvidenceUrl,
} from "./policy.mjs";

function response(status, message) {
  const headers = evidenceResponseHeaders("text/plain; charset=utf-8");
  headers.set("content-length", String(Buffer.byteLength(message)));
  return new Response(message, { status, headers });
}

function hasUploadData(value) {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) {
    return value.some((part) => {
      if (part === null || typeof part !== "object") return true;
      const bytes = part.bytes;
      return typeof bytes === "string" ? bytes.length > 0 : true;
    });
  }
  return true;
}

function errorStatus(error) {
  return error?.code === TIMEOUT_CODE || error?.code === "timeout" ? 504 : 502;
}

/**
 * One ephemeral session's bounded, pinned HTTPS protocol.
 *
 * A transport instance owns all request accounting for its session. The
 * reservation uses the per-resource maximum before starting a fetch, so
 * concurrent Chromium subresources cannot exceed the total byte budget even
 * when their Content-Length headers are absent or dishonest.
 */
export class EvidenceTransport {
  constructor({
    previewSession,
    dependencies = createDefaultDependencies(),
    maxRequests = MAX_EVIDENCE_REQUESTS,
    maxBytes = MAX_EVIDENCE_BYTES,
    maxResourceBytes = MAX_EVIDENCE_RESOURCE_BYTES,
    requestTimeoutMs = 15_000,
    requestDeadlineMs = 120_000,
    maxRedirects = 5,
  } = {}) {
    if (
      previewSession === null ||
      typeof previewSession !== "object" ||
      typeof previewSession.protocol?.handle !== "function"
    ) {
      throw new Error("Evidence transport requires a session protocol");
    }
    if (
      dependencies === null ||
      typeof dependencies.lookup !== "function" ||
      typeof dependencies.open !== "function"
    ) {
      throw new Error(
        "Evidence transport requires pinned network dependencies",
      );
    }
    for (const [label, value] of [
      ["maxRequests", maxRequests],
      ["maxBytes", maxBytes],
      ["maxResourceBytes", maxResourceBytes],
    ]) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${label} must be a positive safe integer`);
      }
    }
    if (maxResourceBytes > maxBytes) {
      throw new Error("maxResourceBytes cannot exceed maxBytes");
    }
    this.session = previewSession;
    this.dependencies = dependencies;
    this.maxRequests = maxRequests;
    this.maxBytes = maxBytes;
    this.maxResourceBytes = maxResourceBytes;
    this.maxConcurrent = Math.max(
      1,
      Math.min(8, Math.floor(maxBytes / maxResourceBytes)),
    );
    this.requestTimeoutMs = requestTimeoutMs;
    this.requestDeadlineMs = requestDeadlineMs;
    this.maxRedirects = maxRedirects;
    this.requests = 0;
    this.bytes = 0;
    this.reserved = 0;
    this.active = 0;
    this.waiters = [];
    this.closed = false;
    this.protocolHandled = false;
    this.clearWebRequest = null;
    this.abortController = new AbortController();
  }

  /** Install the HTTPS handler and the method/scheme policy guard. */
  async start() {
    if (this.closed) throw new Error("Evidence transport is closed");
    const handler = (request) => this.handle(request);
    await this.session.protocol.handle("https", handler);
    this.protocolHandled = true;

    const onBeforeRequest = (details, callback) => {
      const allowed =
        isAllowedEvidenceRequest({
          url: details?.url,
          method: details?.method,
          resourceType: details?.resourceType,
        }) && !hasUploadData(details?.uploadData);
      callback({ cancel: !allowed });
    };
    this.session.webRequest?.onBeforeRequest?.(
      { urls: ["<all_urls>"] },
      onBeforeRequest,
    );
    this.clearWebRequest = () => {
      try {
        this.session.webRequest?.onBeforeRequest?.(null);
      } catch {
        // The ephemeral session may already be torn down.
      }
    };

    this.session.setPermissionRequestHandler?.((_wc, _permission, callback) =>
      callback(false),
    );
    this.session.setPermissionCheckHandler?.(() => false);
    const onDownload = (event, item) => {
      event.preventDefault();
      try {
        item?.cancel?.();
      } catch {
        // A late download event must not interrupt session teardown.
      }
    };
    this.session.on?.("will-download", onDownload);
    this.removeDownloadListener = () => {
      try {
        this.session.removeListener?.("will-download", onDownload);
      } catch {
        // Best-effort cleanup for a destroyed session.
      }
    };
  }

  drainWaiters() {
    while (this.waiters.length > 0) {
      if (this.closed) {
        const pending = this.waiters.splice(0);
        for (const waiter of pending) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error("Evidence transport is closed"));
        }
        return;
      }
      if (this.requests >= this.maxRequests) {
        const pending = this.waiters.splice(0);
        for (const waiter of pending) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error("Evidence request budget exhausted"));
        }
        return;
      }
      if (this.active >= this.maxConcurrent) return;
      if (this.bytes + this.reserved + this.maxResourceBytes > this.maxBytes) {
        // Active requests may still release their reservations. Once none are
        // active, the remaining waiters cannot ever fit in the total budget.
        if (this.active === 0) {
          const pending = this.waiters.splice(0);
          for (const waiter of pending) {
            clearTimeout(waiter.timer);
            waiter.reject(new Error("Evidence byte budget exhausted"));
          }
        }
        return;
      }
      const waiter = this.waiters.shift();
      clearTimeout(waiter.timer);
      this.requests += 1;
      this.active += 1;
      this.reserved += this.maxResourceBytes;
      let released = false;
      waiter.resolve((actualBytes) => {
        if (released) return;
        released = true;
        this.active -= 1;
        this.reserved -= this.maxResourceBytes;
        this.bytes += Math.max(0, actualBytes);
        this.drainWaiters();
      });
    }
  }

  acquireRequest() {
    if (this.closed)
      return Promise.reject(new Error("Evidence transport is closed"));
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error("Evidence request queue timed out"));
        }, this.requestTimeoutMs),
      };
      this.waiters.push(waiter);
      this.drainWaiters();
    });
  }

  /** Handle one Chromium request through the pinned, bounded Node transport. */
  async handle(request) {
    if (this.closed) return response(410, "Evidence session closed");
    let url;
    try {
      requireEvidenceReadMethod(request?.method);
      url = validateEvidenceUrl(request?.url).href;
    } catch {
      return response(403, "Evidence request refused");
    }
    let release;
    try {
      release = await this.acquireRequest();
    } catch {
      return response(429, "Evidence request budget exhausted or busy");
    }
    try {
      const fetched = await fetchBoundBytes(url, {
        dependencies: this.dependencies,
        maxBytes: this.maxResourceBytes,
        label: "worker evidence resource",
        timeoutMs: this.requestTimeoutMs,
        deadlineMs: this.requestDeadlineMs,
        maxRedirects: this.maxRedirects,
        signal: this.abortController.signal,
      });
      if (this.closed) {
        release(0);
        return response(410, "Evidence session closed");
      }
      release(fetched.bytes.byteLength);
      if (fetched.finalUrl && fetched.finalUrl !== url) {
        const headers = evidenceResponseHeaders("text/plain; charset=utf-8");
        headers.set("location", fetched.finalUrl);
        headers.set("content-length", "0");
        return new Response(null, { status: 302, headers });
      }
      const headers = evidenceResponseHeaders(fetched.contentType);
      headers.set("content-length", String(fetched.bytes.byteLength));
      return new Response(fetched.bytes, { status: 200, headers });
    } catch (error) {
      release(0);
      return response(errorStatus(error), "Evidence resource fetch failed");
    }
  }

  /** Stop handlers and abort in-flight pinned requests. */
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.abortController.abort(new Error("Evidence session closed"));
    this.drainWaiters();
    this.clearWebRequest?.();
    this.removeDownloadListener?.();
    if (this.protocolHandled) {
      try {
        await this.session.protocol.unhandle?.("https");
      } catch {
        // The ephemeral session is being destroyed; no handler can escape it.
      }
    }
    this.protocolHandled = false;
  }

  /** Bounded counters suitable for a worker-facing status response. */
  stats() {
    return Object.freeze({
      requests: this.requests,
      bytes: this.bytes,
      maxRequests: this.maxRequests,
      maxBytes: this.maxBytes,
      active: this.active,
      queued: this.waiters.length,
    });
  }
}

export function createEvidenceTransport(options) {
  return new EvidenceTransport(options);
}
