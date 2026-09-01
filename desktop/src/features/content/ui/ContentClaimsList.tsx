import { Badge } from "@/shared/ui/badge";

import type { ClaimVerdict } from "../claimVerifier";
import type { ClaimSource, ContentClaim } from "../contracts";

/**
 * Every assertion the card makes, what stands behind it, and whether that
 * still holds.
 *
 * This is the part of the screen with the most customer value and the least
 * visual interest. An owner's real risk is not an off-brand colour; it is
 * publishing "fully insured" or a price under their own name when it is not
 * true. So the verification state is the badge: verified says when it was
 * checked, stale says the ground moved, unverified says nothing has checked
 * it, manual says a person is the evidence, owner-signed says the owner's own
 * signature is.
 */

function sourceLabel(source: ClaimSource): string {
  switch (source.type) {
    case "page":
      return source.selector
        ? `${source.url} (${source.selector})`
        : source.url;
    case "repo":
      return [source.repo, source.path, source.line ? `:${source.line}` : ""]
        .filter(Boolean)
        .join(" ")
        .trim();
    case "owner":
      return `You said so, in event ${source.event.slice(0, 12)}…`;
  }
}

function checkedAtLabel(checkedAt: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - checkedAt) / 60_000));
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return new Date(checkedAt).toLocaleDateString();
}

function verdictBadge(verdict: ClaimVerdict | undefined) {
  if (!verdict) {
    return <Badge variant="outline">Checking…</Badge>;
  }
  switch (verdict.state) {
    case "verified":
      return (
        <Badge
          title={`Checked ${checkedAtLabel(verdict.checkedAt)}`}
          variant="success"
        >
          Verified {checkedAtLabel(verdict.checkedAt)}
        </Badge>
      );
    case "stale":
      return (
        <Badge title={verdict.reason} variant="warning">
          Stale
        </Badge>
      );
    case "unverified":
      return (
        <Badge title={verdict.reason} variant="destructive">
          Unverified
        </Badge>
      );
    case "manual":
      return (
        <Badge title={verdict.reason} variant="secondary">
          Manual
        </Badge>
      );
    case "owner-signed":
      return (
        <Badge
          title="The workspace owner signed this assertion."
          variant="warning"
        >
          Owner signed
        </Badge>
      );
  }
}

export function ContentClaimsList({
  claims,
  verdicts = {},
}: {
  claims: ContentClaim[];
  verdicts?: Record<string, ClaimVerdict>;
}) {
  if (claims.length === 0) {
    return (
      <section>
        <h4 className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
          No claims registered
        </h4>
        <p className="mt-1.5 text-xs text-muted-foreground">
          Nothing on this card has been traced to a source. That is not the same
          as the card saying nothing.
        </p>
      </section>
    );
  }

  return (
    <section>
      <h4 className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
        What this card claims
      </h4>
      <ul className="mt-1.5 space-y-2">
        {claims.map((claim) => {
          const verdict = verdicts[claim.id];
          return (
            <li
              className="border-b border-border/40 pb-2 last:border-b-0 last:pb-0"
              key={claim.id}
            >
              <div className="flex items-start justify-between gap-3">
                <p className="min-w-0 text-sm">{claim.asserts}</p>
                {claim.source ? (
                  verdictBadge(verdict)
                ) : (
                  <Badge variant="destructive">No source</Badge>
                )}
              </div>
              <p className="mt-1 break-all text-xs text-muted-foreground">
                {claim.source
                  ? sourceLabel(claim.source)
                  : "Nothing backs this. Do not publish it until something does."}
              </p>
              {verdict &&
              (verdict.state === "stale" || verdict.state === "unverified") ? (
                <p className="mt-1 text-xs text-destructive">
                  {verdict.reason}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
