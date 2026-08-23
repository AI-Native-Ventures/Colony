import * as React from "react";

import { useCommunities } from "@/features/communities/useCommunities";
import { KIND_CONTENT_POST } from "@/shared/constants/kinds";
import { rewriteRelayUrl } from "@/shared/lib/mediaUrl";
import { cn } from "@/shared/lib/cn";
import { Badge } from "@/shared/ui/badge";
import { PageHeader } from "@/shared/ui/PageHeader";

import type {
  ContentCampaign,
  ContentDecision,
  ContentPost,
} from "../contracts";
import { decisionsForPost, postChip } from "../contentStatus";
import {
  useContentCampaigns,
  useContentDecisions,
  useContentPosts,
  useContentStyle,
  useSubmitContentDecision,
} from "../hooks";
import { ContentDayDetail } from "./ContentDayDetail";
import { ContentStylePanel } from "./ContentStylePanel";

/**
 * The content calendar.
 *
 * Campaigns in the rail, weeks as rows, days as cards. The one thing this
 * layout exists to show that a grid of independent posts cannot is the running
 * order: each card wears its job in the week's sequence, because the largest
 * correction in the campaign this was built from was structural rather than
 * visual, and that correction is invisible in a plain grid.
 *
 * The app renders nothing here. Every image was produced and measured by the
 * agent on its own machine, and what this screen holds is the record and the
 * approval.
 */

const TONE_VARIANT = {
  bad: "destructive",
  good: "success",
  neutral: "outline",
  warn: "warning",
} as const;

function dayLabel(isoDate: string): string {
  const parsed = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return isoDate;
  }
  return parsed.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    weekday: "short",
  });
}

function DayCard({
  decisions,
  onSelect,
  post,
  selected,
}: {
  decisions: ContentDecision[];
  onSelect: (post: ContentPost) => void;
  post: ContentPost;
  selected: boolean;
}) {
  const own = decisionsForPost(post, decisions, KIND_CONTENT_POST);
  const chip = postChip(post, own);

  return (
    <button
      className={cn(
        "flex w-40 shrink-0 flex-col gap-2 rounded-lg border p-2 text-left transition",
        selected
          ? "border-primary bg-primary/5"
          : "border-border/60 hover:bg-muted/40",
      )}
      data-testid={`content-day-${post.slug}`}
      onClick={() => onSelect(post)}
      type="button"
    >
      {post.images.length > 0 ? (
        <img
          alt=""
          className="aspect-[4/5] w-full rounded-md border border-border/40 object-cover"
          src={rewriteRelayUrl(post.images[0].url)}
        />
      ) : (
        <div className="flex aspect-[4/5] w-full items-center justify-center rounded-md border border-dashed border-border/50 text-xs text-muted-foreground">
          Not rendered
        </div>
      )}
      <div className="min-w-0">
        <p className="truncate text-xs font-medium">
          {dayLabel(post.scheduledFor)}
        </p>
        {post.job ? (
          <p className="truncate text-2xs uppercase tracking-wide text-muted-foreground">
            {post.job}
          </p>
        ) : null}
      </div>
      <Badge title={chip.detail} variant={TONE_VARIANT[chip.tone]}>
        {chip.label}
      </Badge>
    </button>
  );
}

function WeekRow({
  campaign,
  decisions,
  onSelect,
  posts,
  selectedAddress,
  week,
}: {
  campaign: ContentCampaign;
  decisions: ContentDecision[];
  onSelect: (post: ContentPost) => void;
  posts: ContentPost[];
  selectedAddress: string | null;
  week: number;
}) {
  const label =
    campaign.weeks.find((entry) => entry.index === week)?.label ??
    `Week ${week}`;

  return (
    <section className="mt-4">
      <h3 className="text-sm font-medium">
        Week {week}
        <span className="ml-2 font-normal text-muted-foreground">{label}</span>
      </h3>
      {posts.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Nothing planned for this week yet.
        </p>
      ) : (
        <div className="mt-2 flex gap-3 overflow-x-auto pb-2">
          {posts.map((post) => (
            <DayCard
              decisions={decisions}
              key={post.address}
              onSelect={onSelect}
              post={post}
              selected={post.address === selectedAddress}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export function ContentScreen() {
  const { activeCommunity } = useCommunities();
  const communityId = activeCommunity?.id ?? "";

  const [selectedCampaignId, setSelectedCampaignId] = React.useState<
    string | null
  >(null);
  const [selectedAddress, setSelectedAddress] = React.useState<string | null>(
    null,
  );
  const [showStyle, setShowStyle] = React.useState(false);

  const campaignsQuery = useContentCampaigns(communityId);
  const campaigns = React.useMemo(
    () => campaignsQuery.data ?? [],
    [campaignsQuery.data],
  );
  const activeCampaign =
    campaigns.find((campaign) => campaign.id === selectedCampaignId) ??
    campaigns[0] ??
    null;

  const postsQuery = useContentPosts(communityId, activeCampaign?.id ?? "");
  const posts = React.useMemo(() => postsQuery.data ?? [], [postsQuery.data]);
  const decisionsQuery = useContentDecisions(communityId);
  const decisions = React.useMemo(
    () => decisionsQuery.data ?? [],
    [decisionsQuery.data],
  );
  const styleQuery = useContentStyle(communityId);
  const submitDecision = useSubmitContentDecision(communityId);

  const selectedPost =
    posts.find((post) => post.address === selectedAddress) ?? null;

  const weeks = React.useMemo(() => {
    const declared = (activeCampaign?.weeks ?? []).map((week) => week.index);
    const present = posts.map((post) => post.week);
    return [...new Set([...declared, ...present])].sort((a, b) => a - b);
  }, [activeCampaign, posts]);

  const handleSubmit = React.useCallback(
    (input: Parameters<typeof submitDecision.mutateAsync>[0]) =>
      submitDecision.mutateAsync(input),
    [submitDecision.mutateAsync],
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-row overflow-hidden">
      <nav className="flex w-56 shrink-0 flex-col gap-1 overflow-y-auto border-r border-border/60 p-3">
        <p className="px-2 pb-1 text-2xs uppercase tracking-wide text-muted-foreground">
          Campaigns
        </p>
        {campaigns.map((campaign) => (
          <button
            className={cn(
              "rounded-md px-2 py-1.5 text-left text-sm transition",
              !showStyle && campaign.id === activeCampaign?.id
                ? "bg-muted font-medium"
                : "hover:bg-muted/60",
            )}
            key={campaign.id}
            onClick={() => {
              setShowStyle(false);
              setSelectedCampaignId(campaign.id);
              setSelectedAddress(null);
            }}
            type="button"
          >
            <span className="block truncate">{campaign.name}</span>
            <span className="block text-2xs text-muted-foreground">
              {campaign.weeks.length} week
              {campaign.weeks.length === 1 ? "" : "s"}
              {campaign.status === "archived" ? " · archived" : ""}
            </span>
          </button>
        ))}
        <button
          className={cn(
            "mt-2 rounded-md px-2 py-1.5 text-left text-sm transition",
            showStyle ? "bg-muted font-medium" : "hover:bg-muted/60",
          )}
          data-testid="content-open-style"
          onClick={() => setShowStyle(true)}
          type="button"
        >
          Style
        </button>
      </nav>

      {showStyle ? (
        <ContentStylePanel style={styleQuery.data ?? null} />
      ) : (
        <>
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4">
            <PageHeader
              description="Made and measured by your agent. Nothing goes out without your approval."
              title="Content"
            />

            {campaignsQuery.isLoading ? (
              <p className="mt-4 text-sm text-muted-foreground">Loading.</p>
            ) : !activeCampaign ? (
              <p className="mt-4 max-w-prose text-sm text-muted-foreground">
                No campaign yet. Ask your content agent for a week and it will
                appear here, with every check it measured, waiting on you.
              </p>
            ) : (
              weeks.map((week) => (
                <WeekRow
                  campaign={activeCampaign}
                  decisions={decisions}
                  key={week}
                  onSelect={(post) => setSelectedAddress(post.address)}
                  posts={posts.filter((post) => post.week === week)}
                  selectedAddress={selectedAddress}
                  week={week}
                />
              ))
            )}
          </div>

          {selectedPost ? (
            <aside className="flex w-[26rem] shrink-0 flex-col border-l border-border/60">
              <ContentDayDetail
                communityId={communityId}
                decisions={decisions}
                key={selectedPost.address}
                onSubmit={handleSubmit}
                post={selectedPost}
                submitting={submitDecision.isPending}
              />
            </aside>
          ) : null}
        </>
      )}
    </div>
  );
}
