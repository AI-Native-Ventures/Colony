import dns from "node:dns";
import https from "node:https";
import net from "node:net";

import { isPrivateAddress } from "./address.mjs";
import { PreviewArtifactError } from "./errors.mjs";
import { validatePublicUrl } from "./manifest.mjs";

/** Per-request cap for one hop: DNS lookup, connect/TLS, and body streaming. */
export const DEFAULT_TIMEOUT_MS = 15_000;
/** Largest per-request cap a caller may set. */
export const MAX_TIMEOUT_MS = 60_000;
/** Total deadline for one preview load, covering every hop and body. */
export const DEFAULT_DEADLINE_MS = 120_000;
/** Largest total deadline a caller may set. */
export const MAX_DEADLINE_MS = 600_000;
/** Maximum redirect hops followed for one artifact. */
export const DEFAULT_MAX_REDIRECTS = 5;
/** Largest redirect bound a caller may set. */
export const MAX_MAX_REDIRECTS = 10;
/** Marks a transport error as a timeout rather than a generic network failure. */
export const TIMEOUT_CODE = "preview_timeout";
/** Marks a transport error as a caller abort rather than a network failure. */
export const ABORT_CODE = "preview_aborted";
const USER_AGENT = "colony-website-preview/1";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function stripBrackets(hostname) {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function headerValue(headers, name) {
  const value = headers?.[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === "string" ? value : null;
}

/** Validate a per-request timeout in milliseconds. */
export function validateTimeoutMs(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    throw new PreviewArtifactError(
      "invalid_timeout",
      `timeoutMs must be a positive safe integer no greater than ${MAX_TIMEOUT_MS}`,
      { timeoutMs: value, maxTimeoutMs: MAX_TIMEOUT_MS },
    );
  }
  return value;
}

/** Validate a finite total load deadline in milliseconds. */
export function validateDeadlineMs(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_DEADLINE_MS) {
    throw new PreviewArtifactError(
      "invalid_deadline",
      `deadlineMs must be a positive safe integer no greater than ${MAX_DEADLINE_MS}`,
      { deadlineMs: value, maxDeadlineMs: MAX_DEADLINE_MS },
    );
  }
  return value;
}

/** Validate a redirect hop bound. */
export function validateMaxRedirects(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_MAX_REDIRECTS) {
    throw new PreviewArtifactError(
      "invalid_redirects",
      `maxRedirects must be a safe integer between 0 and ${MAX_MAX_REDIRECTS}`,
      { maxRedirects: value, maxMaxRedirects: MAX_MAX_REDIRECTS },
    );
  }
  return value;
}

/** Validate an optional caller abort signal. */
export function validateAbortSignal(value) {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "object" ||
    typeof value.aborted !== "boolean" ||
    typeof value.addEventListener !== "function" ||
    typeof value.removeEventListener !== "function"
  ) {
    throw new PreviewArtifactError(
      "invalid_signal",
      "signal must be an AbortSignal",
    );
  }
  return value;
}

function abortedError() {
  return new PreviewArtifactError(
    "aborted",
    "preview load was aborted by the caller",
    { reason: "aborted" },
  );
}

function timeoutError(message, details) {
  return new PreviewArtifactError("timeout", message, details);
}

function normalizeAbortReason(reason) {
  if (reason instanceof PreviewArtifactError) return reason;
  if (reason?.code === TIMEOUT_CODE || reason?.name === "TimeoutError") {
    return timeoutError(reason?.message ?? "request timed out", {
      reason: "request_timeout",
    });
  }
  return abortedError();
}

/** Throw the typed abort reason when `signal` has already fired. */
export function throwIfAborted(signal) {
  if (signal?.aborted) throw normalizeAbortReason(signal.reason);
}

/**
 * Combine an optional caller signal with a finite total deadline.
 *
 * The returned signal aborts with a typed `PreviewArtifactError`: `timeout`
 * (reason `deadline`) when the deadline elapses, or `aborted` when the caller
 * signal fires. `dispose` clears the timer and the caller listener and must
 * run on every path.
 */
export function createBoundedSignal({
  deadlineMs = DEFAULT_DEADLINE_MS,
  signal,
} = {}) {
  const limit = validateDeadlineMs(deadlineMs);
  const caller = validateAbortSignal(signal);
  const controller = new AbortController();
  let timer = null;
  let removeCaller = null;
  let disposed = false;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (removeCaller !== null) removeCaller();
    removeCaller = null;
  };

  if (caller !== null) {
    const onCallerAbort = () => {
      controller.abort(normalizeAbortReason(caller.reason));
    };
    if (caller.aborted) {
      onCallerAbort();
    } else {
      caller.addEventListener("abort", onCallerAbort, { once: true });
      removeCaller = () => caller.removeEventListener("abort", onCallerAbort);
    }
  }

  if (!controller.signal.aborted) {
    timer = setTimeout(() => {
      controller.abort(
        timeoutError(`preview deadline of ${limit}ms expired`, {
          deadlineMs: limit,
          reason: "deadline",
        }),
      );
    }, limit);
  }

  return { signal: controller.signal, dispose };
}

function createHopSignal(parentSignal, timeoutMs) {
  const controller = new AbortController();
  let timer = null;
  let removeParent = null;
  let disposed = false;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (removeParent !== null) removeParent();
    removeParent = null;
  };

  if (parentSignal) {
    const onParentAbort = () => {
      controller.abort(normalizeAbortReason(parentSignal.reason));
    };
    if (parentSignal.aborted) {
      onParentAbort();
    } else {
      parentSignal.addEventListener("abort", onParentAbort, { once: true });
      removeParent = () =>
        parentSignal.removeEventListener("abort", onParentAbort);
    }
  }

  if (!controller.signal.aborted) {
    timer = setTimeout(() => {
      controller.abort(
        timeoutError(`request timed out after ${timeoutMs}ms`, {
          timeoutMs,
          reason: "request_timeout",
        }),
      );
    }, timeoutMs);
  }

  return { signal: controller.signal, dispose };
}

function destroyResponse(response) {
  try {
    if (response && typeof response.destroy === "function") {
      response.destroy();
    } else if (response?.body && typeof response.body.destroy === "function") {
      response.body.destroy();
    }
  } catch {
    // Cleanup failures must never mask the original error.
  }
}

/**
 * Await `promise`, but reject as soon as `signal` aborts.
 *
 * A result that arrives after the abort is never returned or acted on:
 * `onLateResolve` may clean it up (for example, destroy a late response), and
 * every rejection of `promise` is consumed so no unhandled rejection escapes.
 */
function awaitWithSignal(promise, signal, onLateResolve) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      settle(value);
    };
    const onAbort = () => finish(reject, normalizeAbortReason(signal.reason));
    promise.then(
      (value) => {
        if (signal.aborted) {
          try {
            onLateResolve?.(value);
          } catch {
            // Cleanup must not replace the typed abort error.
          }
          finish(reject, normalizeAbortReason(signal.reason));
        } else {
          finish(resolve, value);
        }
      },
      (error) => {
        if (signal.aborted) finish(reject, normalizeAbortReason(signal.reason));
        else finish(reject, error);
      },
    );
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Build the HTTPS request options for one pinned hop.
 *
 * The socket connects to the already-resolved `address`; SNI and the Host
 * header carry the original name so TLS verification stays meaningful. No
 * cookies, authorization, or proxy credentials are ever attached.
 */
export function buildHttpsRequestOptions({ url, hostname, address, family }) {
  const parsed = new URL(url);
  return {
    protocol: "https:",
    method: "GET",
    host: address,
    family,
    port: parsed.port === "" ? 443 : Number(parsed.port),
    path: `${parsed.pathname}${parsed.search}`,
    servername: net.isIP(hostname) === 0 ? hostname : undefined,
    headers: {
      host: parsed.host,
      accept: "*/*",
      "accept-encoding": "identity",
      "user-agent": USER_AGENT,
      connection: "close",
    },
    agent: false,
  };
}

function openHttps(request) {
  return new Promise((resolve, reject) => {
    const { signal } = request;
    const timeoutMs =
      Number.isSafeInteger(request.timeoutMs) && request.timeoutMs > 0
        ? request.timeoutMs
        : DEFAULT_TIMEOUT_MS;
    const clientRequest = https.request(buildHttpsRequestOptions(request));
    let settled = false;
    let removeAbort = null;

    // Permanent sink: a socket error that arrives after settlement must never
    // surface as an unhandled "error" event.
    clientRequest.on("error", () => {
      // Consumed by the sink; onError already rejected the open promise.
    });

    const settle = (settleWith, value) => {
      if (settled) return;
      settled = true;
      if (removeAbort !== null) removeAbort();
      removeAbort = null;
      clientRequest.setTimeout(0);
      settleWith(value);
    };
    const onError = (error) => settle(reject, error);
    const onResponse = (response) => {
      if (signal?.aborted) {
        destroyResponse(response);
        settle(reject, normalizeAbortReason(signal.reason));
        return;
      }
      settle(resolve, {
        statusCode: response.statusCode,
        headers: response.headers,
        body: response,
        destroy: () => destroyResponse(response),
      });
    };
    const onAbort = () => {
      clientRequest.destroy(normalizeAbortReason(signal.reason));
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbort = () => signal.removeEventListener("abort", onAbort);
      }
    }

    clientRequest.setTimeout(timeoutMs, () => {
      clientRequest.destroy(
        Object.assign(
          new Error(
            `request to ${request.url} timed out after ${timeoutMs}ms`,
          ),
          { code: TIMEOUT_CODE },
        ),
      );
    });
    clientRequest.once("error", onError);
    clientRequest.once("response", onResponse);
    clientRequest.end();
  });
}

/** Production DNS + HTTPS dependencies. Tests must inject fakes instead. */
export function createDefaultDependencies() {
  return Object.freeze({
    lookup: (hostname) =>
      dns.promises.lookup(hostname, { all: true, verbatim: true }),
    open: (request) => openHttps(request),
  });
}

/**
 * Resolve the transport to use. `undefined` selects the real network; anything
 * else must explicitly provide both `lookup` and `open`, so tests can never
 * fall through to production network access by accident.
 */
export function resolveDependencies(value) {
  if (value === undefined) return createDefaultDependencies();
  if (
    value === null ||
    typeof value.lookup !== "function" ||
    typeof value.open !== "function"
  ) {
    throw new PreviewArtifactError(
      "invalid_dependencies",
      "dependencies must be undefined or provide lookup and open functions",
    );
  }
  return value;
}

async function readBounded(response, maxBytes, label, signal) {
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of response.body) {
      throwIfAborted(signal);
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total > maxBytes) {
        throw new PreviewArtifactError(
          "body_too_large",
          `body for ${label} exceeds the ${maxBytes} byte budget`,
          { label, limit: maxBytes },
        );
      }
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof PreviewArtifactError) throw error;
    throwIfAborted(signal);
    throw new PreviewArtifactError(
      "body_read_failed",
      `reading ${label} failed: ${error?.message ?? error}`,
      { label },
    );
  }
  throwIfAborted(signal);
  return Buffer.concat(chunks, total);
}

/**
 * Fetch bounded bytes over HTTPS from a public, already-validated URL.
 *
 * Every hop re-validates the URL, resolves DNS through the injected transport,
 * rejects any blocked address, and connects to the resolved address itself.
 * Redirects never carry headers across and bodies are bounded even without
 * `Content-Length`. Each hop (DNS, connect/TLS, and body) must finish inside
 * `timeoutMs`, and the whole call inside `deadlineMs`; `signal` cancels the
 * transfer. Timers, listeners, sockets, and bodies are released before
 * settling, and no bytes are returned after a timeout or abort.
 */
export async function fetchBoundBytes(rawUrl, options) {
  const {
    dependencies,
    maxBytes,
    label = "artifact",
    timeoutMs = DEFAULT_TIMEOUT_MS,
    deadlineMs = DEFAULT_DEADLINE_MS,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    signal,
  } = options ?? {};
  if (
    !dependencies ||
    typeof dependencies.lookup !== "function" ||
    typeof dependencies.open !== "function"
  ) {
    throw new PreviewArtifactError(
      "invalid_dependencies",
      "fetchBoundBytes requires explicit lookup and open dependencies",
    );
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new PreviewArtifactError(
      "invalid_budget",
      "maxBytes must be a non-negative safe integer",
    );
  }
  const requestTimeoutMs = validateTimeoutMs(timeoutMs);
  const redirectLimit = validateMaxRedirects(maxRedirects);
  const scope = createBoundedSignal({ deadlineMs, signal });

  try {
    throwIfAborted(scope.signal);
    let url = validatePublicUrl(rawUrl);
    let redirects = 0;

    for (;;) {
      const hostname = stripBrackets(url.hostname);
      const hop = createHopSignal(scope.signal, requestTimeoutMs);
      try {
        throwIfAborted(hop.signal);

        let records;
        try {
          records = await awaitWithSignal(
            Promise.resolve(
              dependencies.lookup(hostname, { signal: hop.signal }),
            ),
            hop.signal,
          );
        } catch (error) {
          if (error instanceof PreviewArtifactError) throw error;
          if (error?.code === TIMEOUT_CODE || error?.name === "TimeoutError") {
            throw timeoutError(
              `DNS lookup for ${hostname} timed out after ${requestTimeoutMs}ms`,
              {
                hostname,
                timeoutMs: requestTimeoutMs,
                reason: "request_timeout",
              },
            );
          }
          if (error?.code === ABORT_CODE || error?.name === "AbortError") {
            throw abortedError();
          }
          throw new PreviewArtifactError(
            "dns_failed",
            `DNS lookup failed for ${hostname}: ${error?.message ?? error}`,
            { hostname },
          );
        }

        const addresses = Array.isArray(records) ? records : [records];
        if (addresses.length === 0) {
          throw new PreviewArtifactError(
            "dns_empty",
            `DNS returned no addresses for ${hostname}`,
            { hostname },
          );
        }
        for (const record of addresses) {
          const address = typeof record === "string" ? record : record?.address;
          if (typeof address !== "string" || net.isIP(address) === 0) {
            throw new PreviewArtifactError(
              "dns_invalid_address",
              `DNS for ${hostname} returned a non-IP address`,
              { hostname },
            );
          }
          if (isPrivateAddress(address)) {
            throw new PreviewArtifactError(
              "dns_blocked",
              `DNS for ${hostname} resolved to blocked address ${address}`,
              { hostname, address },
            );
          }
        }
        const chosen = addresses[0];
        const address = typeof chosen === "string" ? chosen : chosen.address;

        throwIfAborted(hop.signal);

        let response;
        try {
          response = await awaitWithSignal(
            Promise.resolve(
              dependencies.open({
                url: url.href,
                hostname,
                address,
                family: net.isIP(address),
                timeoutMs: requestTimeoutMs,
                signal: hop.signal,
              }),
            ),
            hop.signal,
            (late) => destroyResponse(late),
          );
        } catch (error) {
          if (error instanceof PreviewArtifactError) throw error;
          if (error?.code === TIMEOUT_CODE || error?.name === "TimeoutError") {
            throw timeoutError(
              `request to ${url.href} timed out after ${requestTimeoutMs}ms`,
              {
                url: url.href,
                timeoutMs: requestTimeoutMs,
                reason: "request_timeout",
              },
            );
          }
          if (error?.code === ABORT_CODE || error?.name === "AbortError") {
            throw abortedError();
          }
          throw new PreviewArtifactError(
            "request_failed",
            `request to ${url.href} failed: ${error?.message ?? error}`,
            { url: url.href },
          );
        }

        if (hop.signal.aborted) {
          destroyResponse(response);
          throwIfAborted(hop.signal);
        }
        if (!response || typeof response.statusCode !== "number") {
          destroyResponse(response);
          throw new PreviewArtifactError(
            "request_failed",
            `transport returned no response for ${url.href}`,
            { url: url.href },
          );
        }

        if (REDIRECT_STATUSES.has(response.statusCode)) {
          const location = headerValue(response.headers, "location");
          destroyResponse(response);
          if (location === null) {
            throw new PreviewArtifactError(
              "http_status",
              `redirect from ${url.href} has no location`,
              { url: url.href, status: response.statusCode },
            );
          }
          if (redirects >= redirectLimit) {
            throw new PreviewArtifactError(
              "redirect_limit",
              `more than ${redirectLimit} redirects while fetching ${rawUrl}`,
              { url: url.href, maxRedirects: redirectLimit },
            );
          }
          redirects += 1;
          let next;
          try {
            next = new URL(location, url);
          } catch {
            throw new PreviewArtifactError(
              "redirect_invalid",
              `redirect from ${url.href} has an invalid location`,
              { url: url.href },
            );
          }
          url = validatePublicUrl(next.href);
          continue;
        }

        if (response.statusCode < 200 || response.statusCode > 299) {
          destroyResponse(response);
          throw new PreviewArtifactError(
            "http_status",
            `fetching ${url.href} returned status ${response.statusCode}`,
            { url: url.href, status: response.statusCode },
          );
        }

        let bytes;
        try {
          bytes = await awaitWithSignal(
            readBounded(response, maxBytes, label, hop.signal),
            hop.signal,
            () => destroyResponse(response),
          );
        } catch (error) {
          destroyResponse(response);
          if (error instanceof PreviewArtifactError) throw error;
          throw new PreviewArtifactError(
            "body_read_failed",
            `reading ${label} failed: ${error?.message ?? error}`,
            { label },
          );
        }

        return {
          bytes,
          contentType: headerValue(response.headers, "content-type"),
          finalUrl: url.href,
          redirects,
        };
      } finally {
        hop.dispose();
      }
    }
  } finally {
    scope.dispose();
  }
}
