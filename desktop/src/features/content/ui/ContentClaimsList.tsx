import { Badge } from "@/shared/ui/badge";

import type { ContentClaim, ClaimSource } from "../contracts";

/**
 * Every assertion the card makes, and what stands behind it.
 *
 * This is the part of the screen with the most customer value and the least
 * visual interest. An owner's real risk is not an off-brand colour; it is
 * publishing "fully insured" or a price under their own name when it is not
 * true. So a claim with no source is shown as a problem rather than omitted,
 * and an owner-asserted claim says plainly that the owner is the only thing
 * backing it.
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
      return "You said so";
  }
}

function sourceBadge(source: ClaimSource | null) {
  if (!source) {
    return <Badge variant="destructive">No source</Badge>;
  }
  if (source.type === "owner") {
    return <Badge variant="warning">Your word</Badge>;
  }
  return <Badge variant="secondary">{source.type}</Badge>;
}

export function ContentClaimsList({ claims }: { claims: ContentClaim[] }) {
  if (claims.length === 0) {
    return (
      <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
        <p className="text-sm font-medium">No claims registered</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Nothing on this card has been traced to a source. That is not the same
          as the card saying nothing.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border/60 bg-muted/10 p-3">
      <p className="text-sm font-medium">What this card claims</p>
      <ul className="mt-2 space-y-2">
        {claims.map((claim) => (
          <li
            className="border-b border-border/40 pb-2 last:border-b-0 last:pb-0"
            key={claim.id}
          >
            <div className="flex items-start justify-between gap-3">
              <p className="min-w-0 text-sm">{claim.asserts}</p>
              {sourceBadge(claim.source)}
            </div>
            <p className="mt-1 break-all text-xs text-muted-foreground">
              {claim.source
                ? sourceLabel(claim.source)
                : "Nothing backs this. Do not publish it until something does."}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
