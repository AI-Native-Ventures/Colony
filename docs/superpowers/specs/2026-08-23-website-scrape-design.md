# Reading a user's website to describe their business

**Status:** draft
**Implements:** the `scrape.*` contract left open by
[the onboarding redesign spec](2026-08-21-onboarding-redesign-design.md).
Screen 7 currently returns a fixed paragraph about a Johannesburg workshop to
everyone.

## What this is

The user types their website on screen 6. Screen 7 fetches it, reads a few
pages, and writes two to four sentences describing their business. Screen 8
shows that text for them to edit.

It is the first moment Colony does work on the user's behalf, and it is the
only step that spends Colony's money before the user has spent any.

## The central risk: this is a server-side request forgery surface

**The relay will fetch a URL an untrusted stranger typed.** The relay sits
inside a private network with reachable Postgres, Redis, and on Fly a metadata
endpoint holding credentials. A naive fetch turns onboarding into a proxy for
scanning and reading that network, from an unauthenticated signup form.

Nothing in this codebase currently guards against that, so the guard is the
first thing built and the thing most worth reviewing.

### Rules, all mandatory

1. **Scheme allowlist.** `http` and `https` only. No `file:`, `ftp:`,
   `gopher:`, `data:`, or anything else.
2. **Resolve first, then check the address, then connect to that address.**
   Checking the hostname is not enough: `internal.example.com` can resolve to
   `10.0.0.5`.
3. **Reject non-public addresses** after resolution: loopback, private ranges
   (10/8, 172.16/12, 192.168/16), link-local including `169.254.169.254`
   (cloud metadata), unique-local and link-local IPv6, `::1`, IPv4-mapped IPv6
   forms of all the above, and the unspecified address.
4. **Re-validate on every redirect hop.** A public URL may redirect to
   `http://169.254.169.254/`. Follow at most 3 hops, checking each. Never hand
   the redirect policy to the HTTP client.
5. **Pin the connection to the address you validated.** Between resolving and
   connecting, DNS can change its answer (rebinding). Connect to the checked
   IP, carrying the original `Host`.
6. **Cap the response**: 2 MB per page, `text/html` or `text/plain` only.
   A user who points this at a large file must not be able to exhaust relay
   memory.
7. **No credentials, ever.** No cookies, no auth headers, no client
   certificates on these requests.

A rejected URL is not an error the user sees. It lands on screen 8 with the
same wording as an unreachable site. **Never tell the caller why**: a message
distinguishing "private address" from "connection refused" turns this into a
working network scanner with a readable oracle.

### Ports

Only 80 and 443. A business website does not live on 22, and allowing arbitrary
ports makes port scanning trivial even with address checks in place.

## Cost, and the counter that bounds it

The summary runs on Colony's inference spend, so an unbounded endpoint is an
unbounded bill.

- **One per account**, enforced by a counter column on the account row, not by
  client state and not by a cache. The client cannot be trusted, and a cache
  expires.
- **The cost is recorded against the account** and recouped from the user's
  first credit purchase, so it is a float rather than a giveaway.
- The exposure per abandoned signup is a fraction of a cent, and a user who
  never buys credits never uses the workspace.

The model is not hardcoded. It goes through the house provider path with
`LLM_PROVIDER` selecting it, per the repo convention that models stay dynamic
rather than pinned in source.

## Fetching

- The landing page, plus **up to 4 same-origin linked pages** whose paths look
  informative: about, product, pricing, services, what-we-do. Same origin
  strictly: a link to another domain is not followed.
- **10 seconds per page, 30 seconds for the whole step.** These come from the
  onboarding spec and are what the screen's copy promises.
- Strip script, style, nav and footer before summarising. Feeding raw markup
  wastes tokens and produces worse text.

## The contract

Unchanged from what the desktop already consumes:

```
scrape.describeBusiness(url) -> { ok: true, description, sourcePages }
                              | { ok: false, reason }
reason = "unreachable" | "blocked" | "empty" | "timeout"
```

**Those four reasons are for telemetry, not for the screen.** The onboarding
spec is explicit that every failure shows the same words: "We couldn't reach
that site." A user who typed their own address does not care whether a bot wall
or a DNS failure stopped us, and explaining Cloudflare to a non-technical
founder is exactly the leak this redesign exists to remove.

## Failures

Every one lands on screen 8 with an empty description and the user writing
their own. That is a working path, not a degraded one: screen 8 exists to be
edited regardless.

The model call gets **one retry**, then gives up. Everything else fails
immediately.

## Testing

**Never fetch the live internet from a test.** Serve fixtures from a local
test server.

The SSRF suite is the one that matters, and each case must be proven to fail
before the guard exists:

- every private, loopback and link-local form is rejected, IPv4 and IPv6
- a hostname resolving to a private address is rejected
- a public URL redirecting to a private address is rejected at the hop
- a non-80/443 port is rejected
- a non-http scheme is rejected
- a 10 MB response is truncated rather than consumed
- every rejection returns the same typed reason as an unreachable site, with
  nothing distinguishing them to the caller

Plus: the per-account counter permits exactly one run; a second returns the
cached description rather than spending again; and the whole step honours its
30 second ceiling.

## Out of scope

- Rendering JavaScript. A JS-only site reads as empty and the user writes their
  own description.
- Re-running the scrape later from settings.
- Storing page content beyond the generated description.
- Any crawl beyond 5 pages of one origin.

## Open questions

1. **Whether the summary should quote the site.** Cheap and factual, but a
   scraped sentence can read oddly in the user's own voice. Assumed no: write
   original prose from what was read.
2. **What the counter does on a failed run.** Charging an account for a fetch
   that returned nothing is unfair; not charging invites a retry loop against
   Colony's spend. Assumed: a run that never reached the model does not count,
   a run that reached the model does.
