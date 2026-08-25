# Website scrape — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Screen 7 reads the user's website and writes two to four sentences describing their business, instead of returning a fixed paragraph to everyone.

**Architecture:** An address guard sits in front of every fetch. A small crawler reads the landing page and up to four same-origin pages. A summariser calls the house model provider. A counter on the account bounds the spend to one run per user.

**Spec:** `docs/superpowers/specs/2026-08-23-website-scrape-design.md`

## Global Constraints

- **The address guard is the point of this feature.** Screen 7 makes the relay fetch a URL an untrusted stranger typed, from inside a private network with reachable Postgres, Redis and a cloud metadata endpoint. If any task tempts you to relax the guard to make a test pass, stop and say so.
- **Never fetch the live internet from a test.** Serve fixtures from a local test server.
- **Never call a real model from a test.** Fake at the trait boundary.
- **Never run `just ci`**, no full desktop or Playwright suites, one cargo invocation at a time, targeted with `-p` and `--lib`. Check `uptime` first; above roughly load 15, wait and say so. This machine is shared with someone working on it and has been taken to load 170 twice.
- **A suite reporting success while running zero tests is not evidence.** Several suites here are `#[ignore]`d; show the skip count.
- **Before adding a migration**, run `git ls-tree -r --name-only origin/develop migrations/ | tail -3` AND check this branch's own migrations. Both have collided before. A new table also needs `schema/schema.sql`, the write fence, deletion-catalog registration, and the count assertion in `migration.rs`.
- **`git commit -s`.** No em dashes anywhere. No `unsafe`, no new `unwrap()`/`expect()` outside tests.
- **No developer jargon in user-visible copy.** Never "your Mac"; say "your computer".

---

### Task 1: The address guard

Everything else depends on this, and it is the only part where a mistake exposes the network rather than annoying a user.

**Files:**
- Create: `crates/buzz-relay/src/safe_fetch.rs`
- Modify: `crates/buzz-relay/src/lib.rs`

**Produces:**
- `pub fn is_public_address(ip: IpAddr) -> bool`
- `pub fn validate_url(raw: &str) -> Result<Url, FetchRejection>`
- `pub async fn resolve_public(host: &str, port: u16) -> Result<SocketAddr, FetchRejection>`
- `pub enum FetchRejection { Scheme, Port, Host, PrivateAddress, TooManyRedirects, TooLarge, ContentType, Timeout }`

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::net::IpAddr;

    fn ip(s: &str) -> IpAddr { s.parse().expect("test address") }

    #[test]
    fn rejects_every_private_and_local_form() {
        // Each of these is a way into the relay's own network. 169.254.169.254
        // is the cloud metadata endpoint and is the one that leaks credentials.
        for addr in [
            "127.0.0.1", "127.1.2.3", "0.0.0.0",
            "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1",
            "169.254.169.254", "169.254.0.1",
            "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1",
            "::ffff:127.0.0.1", "::ffff:10.0.0.5", "::ffff:169.254.169.254",
        ] {
            assert!(!is_public_address(ip(addr)), "{addr} must be rejected");
        }
    }

    #[test]
    fn accepts_ordinary_public_addresses() {
        for addr in ["1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"] {
            assert!(is_public_address(ip(addr)), "{addr} must be accepted");
        }
    }

    #[test]
    fn rejects_schemes_that_are_not_http() {
        for raw in [
            "file:///etc/passwd",
            "ftp://example.com/",
            "gopher://example.com/",
            "data:text/html,hello",
            "jar:http://example.com!/",
        ] {
            assert_eq!(validate_url(raw).unwrap_err(), FetchRejection::Scheme);
        }
    }

    #[test]
    fn rejects_ports_other_than_80_and_443() {
        // Arbitrary ports make this a port scanner even with address checks.
        assert_eq!(validate_url("http://example.com:22/").unwrap_err(), FetchRejection::Port);
        assert_eq!(validate_url("http://example.com:6379/").unwrap_err(), FetchRejection::Port);
        assert!(validate_url("http://example.com:80/").is_ok());
        assert!(validate_url("https://example.com:443/").is_ok());
        assert!(validate_url("https://example.com/").is_ok());
    }

    #[test]
    fn rejects_a_literal_private_address_in_the_url() {
        assert_eq!(
            validate_url("http://169.254.169.254/latest/meta-data/").unwrap_err(),
            FetchRejection::PrivateAddress
        );
        assert_eq!(
            validate_url("http://[::1]/").unwrap_err(),
            FetchRejection::PrivateAddress
        );
    }

    #[test]
    fn every_rejection_is_indistinguishable_to_a_caller() {
        // The caller must not be able to tell a blocked address from an
        // unreachable site: a distinguishable answer turns this endpoint into
        // a network scanner with a readable oracle.
        for rejection in [
            FetchRejection::Scheme,
            FetchRejection::Port,
            FetchRejection::PrivateAddress,
            FetchRejection::Host,
        ] {
            assert_eq!(rejection.public_reason(), "unreachable");
        }
    }
}
```

- [ ] **Step 2: Run them, watch them fail**

```bash
. ./bin/activate-hermit && cargo test -p buzz-relay --lib safe_fetch
```

Expected: compile failure, module absent.

- [ ] **Step 3: Implement**

Requirements the tests pin, plus two they cannot:

- `is_public_address` must unwrap IPv4-mapped IPv6 before deciding. `::ffff:10.0.0.5` is a private address wearing a costume, and a naive IPv6 check calls it public.
- `resolve_public` resolves, checks **every** returned address, and returns the specific `SocketAddr` it validated. Callers connect to that address, not by hostname again. Resolving twice is the rebinding bug.
- `FetchRejection::public_reason()` collapses everything to `"unreachable"`. Keep the variants for logs and telemetry only.

- [ ] **Step 4: Run them, watch them pass.** Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add crates/buzz-relay/src/safe_fetch.rs crates/buzz-relay/src/lib.rs
git commit -s -m "feat(relay): add the address guard for user-supplied URLs

Resolves first, checks every returned address, and hands back the address
it validated so callers connect to that rather than resolving again.
Resolving twice is the DNS rebinding hole. IPv4-mapped IPv6 is unwrapped
before the decision, because ::ffff:10.0.0.5 is a private address wearing
a costume."
```

---

### Task 2: The fetcher

**Files:**
- Modify: `crates/buzz-relay/src/safe_fetch.rs`

**Consumes:** Task 1. **Produces:** `pub async fn fetch_page(url: &Url) -> Result<String, FetchRejection>` and `pub async fn fetch_site(root: &Url) -> Result<Vec<(Url, String)>, FetchRejection>`.

- [ ] **Step 1: Write the failing tests**, served from a local test server, never the internet:
  - a redirect to a private address is rejected **at the hop**, not followed
  - more than 3 hops is rejected
  - a 10 MB body is truncated at 2 MB rather than consumed
  - a non-HTML content type is rejected
  - a page taking longer than 10 seconds is abandoned
  - `fetch_site` follows at most 4 same-origin links and never a cross-origin one

- [ ] **Step 2: Run, watch fail. Step 3: Implement.**

The redirect policy must be **`redirect::Policy::none()`** with hops followed manually, each one re-validated. Handing the policy to the HTTP client is the bug: it will happily follow a public URL to `169.254.169.254`.

Strip script, style, nav and footer before returning text. Feeding raw markup to a model wastes tokens and produces worse prose.

- [ ] **Step 4: Run, watch pass. Step 5: Commit.**

---

### Task 3: The summariser and the counter

**Files:**
- Create: `crates/buzz-relay/src/business_summary.rs`
- Migration adding `scrape_runs` to the account row (resolve the number as per Global Constraints)
- Modify: `crates/buzz-db/src/email_accounts.rs`, `deletion.rs` if needed, `schema/schema.sql`, `migration.rs`

**Produces:** a `Summariser` trait so tests fake it, plus `pub async fn describe_business(pages: &[(Url, String)]) -> Result<String, SummaryError>`.

Requirements:

- The model is **not hardcoded**. It resolves through the house provider path with `LLM_PROVIDER` selecting it, per repo convention.
- **The prompt asks for original prose**, never quotation. Screen 8 presents this as the user's own account of their business, and a lifted marketing sentence reads wrong in a founder's voice. Forbid marketing register explicitly in the prompt.
- **The counter increments after a successful model call, in the same transaction that stores the description.** A run that never reached the model does not count. A crash between the call and the write costs Colony a fraction of a cent, which is better than charging a user for something they never saw.
- One retry on model failure, then give up.

- [ ] Steps: failing tests (counter permits exactly one run, a second returns the stored description without spending, a failed fetch does not increment), run, implement, run, commit.

---

### Task 4: The route

**Files:**
- Create: `crates/buzz-relay/src/api/scrape.rs`
- Modify: `crates/buzz-relay/src/api/mod.rs`, `router.rs`

`POST /api/scrape/describe`, NIP-98 signed, pubkey from the signature. Whole step capped at 30 seconds regardless of how the page budget was spent.

Returns the contract the desktop already consumes:

```jsonc
{ "ok": true, "description": "...", "sourcePages": ["/", "/about"] }
{ "ok": false, "reason": "unreachable" }
```

**Every rejection returns `unreachable`.** The four typed reasons in the contract exist for telemetry; the screen shows one sentence for all of them.

- [ ] Steps: failing tests, run, implement, run, commit.

---

### Task 5: Desktop service

**Files:**
- Create: `desktop/src/features/onboarding/scrapeService.ts` + test
- Modify: `contracts.fake.ts` only if the shape changed

Follow `authService.ts` and `paymentsService.ts` exactly: injected dependencies, typed failures, no HTTP status reaching a screen.

Copy rule: never explain why a fetch failed. "We couldn't reach that site" for everything, per the onboarding spec. Explaining bot protection to a non-technical founder is the leak this redesign exists to remove.

- [ ] Steps: failing tests, run, implement, `pnpm check` and `pnpm typecheck`, commit, open a PR against develop and arm auto-merge.

---

## Self-Review

**Spec coverage:** the guard (Task 1), fetching and its caps (Task 2), the model and the counter (Task 3), the route and its uniform failure (Task 4), the client (Task 5).

**The one thing worth re-reading before starting:** Task 1's `every_rejection_is_indistinguishable_to_a_caller`. It is the test most likely to be quietly weakened by someone debugging, because distinguishing failures is exactly what you want while developing and exactly what must not ship.
