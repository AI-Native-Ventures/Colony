# Security Policy

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

If you discover a security vulnerability in Buzz, please report it by emailing
**buzz@block.xyz**. Include as much detail as possible:

- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof-of-concept (if available)
- The affected version(s) or commit range
- Any suggested mitigations you've identified

You will receive an acknowledgment within **48 hours**. We aim to provide a
full response — including a timeline for a fix — within **7 days** of initial
contact. We'll keep you informed as we work toward a resolution.

We ask that you:

- Give us reasonable time to address the issue before any public disclosure
- Avoid accessing or modifying data that does not belong to you
- Not perform denial-of-service attacks or disrupt production systems

We will credit reporters in release notes unless you prefer to remain anonymous.

---

## Supported Versions

| Version | Supported |
|---------|-----------|
| `main` (latest) | ✅ Active |
| Previous releases | ⚠️ Best-effort; upgrade recommended |

Buzz is pre-1.0. We do not maintain long-term support branches at this stage.
All security fixes land on `main` first.

---

## Security Design Principles

### Authentication — NIP-42

Every connection to the relay must authenticate via
[NIP-42](https://github.com/nostr-protocol/nips/blob/master/42.md)
challenge/response before writing events. The relay sends a random challenge;
the client signs a `kind:22242` event containing the challenge and the relay
URL, proving possession of the private key.

REST endpoints authenticate via
[NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md) HTTP Auth —
the client signs a `kind:27235` event containing the request URL and method.
The relay verifies the Schnorr signature and extracts the pubkey.

### Authorization — Channel Membership as the Gate

Channel membership is the **only** access control mechanism. There are no
separate ACL lists or capability taxonomies. If a principal (human or agent)
is a member of a channel, they can read and write to it. If they are not a
member, the relay rejects their requests — even if they are authenticated.

Private channels are invisible to non-members: they do not appear in channel
listings, and subscription filters for private channel events return nothing
unless the subscriber is a member.

### Append-Only Audit Log

All events are written to a tamper-evident audit log (`buzz-audit`). Each
log entry is chained to the previous one via a SHA-256 hash chain. Because the
chain is keyless, it is tamper-evident but not tamper-resistant: it detects
accidental corruption or single-row edits, but an attacker with database write
access can recompute the entire chain after editing. The audit log is designed
for SOX-grade compliance and eDiscovery.

### Desktop Secret Storage — OS Keyring

The Buzz desktop app stores nsec private keys in the operating system keyring
rather than in plaintext files: macOS Keychain, Windows Credential Manager, or
the Linux Secret Service (`gnome-keyring` / `kwallet` via D-Bus). This covers
both the human identity key and every managed-agent key.

On first launch after upgrading, existing plaintext keys are migrated into the
keyring: the key is imported, read back to verify the round-trip, and only then
is the plaintext deleted. Migration runs only when the keyring is reachable —
if the backend is unavailable that session, the app keeps reading from the
plaintext file and does **not** migrate, so a transient outage cannot resurrect
a rotated key from a leftover file.

When no keyring backend is available (headless Linux with no Secret Service, for
example), keys fall back to a `0o600` owner-only file. The `BUZZ_PRIVATE_KEY`
environment variable, when set, always takes precedence over both stores — this
is how harnessed agents and CI receive their identity.

### Relay-Held Employee Keys

A company employee is a workspace-owned agent identity: one role, one keypair,
reachable by every member (`docs/design/company-employees.html`). Its key is
minted by the relay and never leaves it, which is what lets any member's
machine produce work as that one colleague without a private key being copied
between laptops or rotated when somebody leaves the company.

This makes the `employees` table the only place the relay stores private key
material, so it is sealed rather than stored:

- **AES-256-GCM** under a key-encryption key supplied as `BUZZ_EMPLOYEE_KEK`
  (64 hex characters), held only in the process environment.
- The **community id and the employee's own pubkey are bound in as associated
  data**, so a sealed key lifted from one row cannot be replayed into another
  employee's row or another tenant's: the authentication tag will not verify.
- **No plaintext fallback.** With no KEK configured, hiring refuses; the relay
  never writes an unsealed key.
- The sealer's `Debug` rendering is redacted, so an accidental `{:?}` of
  application state cannot put the KEK in a log line.

The honest bound: this is confidentiality at rest. An attacker holding both a
database dump and the running process's environment has the employee keys.
What it buys is that **losing a backup is not the same as losing the company**.

Two further properties limit the blast radius. Employee keys are Nostr identity
keys scoped to this deployment; they are not credentials to any AI vendor, and
no member's subscription token is ever stored server-side. And an employee head
(kind `30190`) is refused at ingest unless its author is a registered employee
of that community, so minting a keypair and claiming employment does not work.
The job head (kind `30191`) carries the same gate for the same reason: a worker
reads the head to decide whether it still holds its lease, so a forged one is a
way to stop somebody else's work or to report a result nobody produced.

### The Job Queue

Members supply the execution an employee needs, and the relay arbitrates who is
executing what (`docs/design/company-employees.html`). Three rules there are
security properties rather than conveniences:

- **A worker may claim only its own human's jobs.** Each member's worker runs
  on that member's machine under that member's AI-vendor account. Letting one
  seat pick up another member's work would be account sharing in effect, and
  can get a subscription banned. The relay checks the claimant against the
  job's originator; a job whose human is offline waits rather than being
  rerouted. There is deliberately no setting that relaxes this.
- **A delegated job keeps the human it started with.** When an employee files
  a job it must name the job it is delegating from, and the relay reads the
  originator off that parent row rather than believing the event. Naming
  somebody else's job does not borrow their name: the parent must be a job
  that same employee owes.
- **Only the current lease holder may finish a job.** A pubkey does not
  identify a worker, because one person's laptop and desktop share an
  identity. Every lease carries an attempt number that rises on each claim,
  and heartbeats and outcomes must name it, so a worker that hung and was
  replaced cannot overwrite the live worker's result with a stale one.

### Input Validation

- All UUIDs (channel IDs, workflow IDs) are validated at API boundaries before
  use in database queries.
- Workflow `call_webhook` actions are SSRF-protected: the target URL is
  resolved and checked against a blocklist of private/loopback address ranges
  before the request is made.
- Workflow response bodies are size-limited to prevent memory exhaustion.
- `evalexpr` condition evaluation is sandboxed and timeout-bounded.
- Query parameters passed to external URLs are percent-encoded to prevent
  injection.

### Transport Security

All production deployments should terminate TLS at the relay or a reverse
proxy in front of it. The relay itself does not enforce TLS — this is
intentional to allow flexible deployment behind load balancers and ingress
controllers.

### Dependency Management

We use `cargo audit` in CI to scan for known vulnerabilities in dependencies.
`#![deny(unsafe_code)]` is enforced across all crates — no unsafe Rust.

---

## Disclosure Policy

We follow [coordinated disclosure](https://en.wikipedia.org/wiki/Coordinated_vulnerability_disclosure).
Once a fix is ready and released, we will publish a security advisory on
GitHub describing the vulnerability, its impact, and the fix. Reporters will
be credited unless they request anonymity.
