import * as React from "react";

import { useCommunities } from "@/features/communities/useCommunities";
import { KIND_CONTENT_POST } from "@/shared/constants/kinds";
import { rewriteRelayUrl } from "@/shared/lib/mediaUrl";
import { cn } from "@/shared/lib/cn";
import { PageHeader } from "@/shared/ui/PageHeader";
import {
  AuxiliaryPanel,
  AuxiliaryPanelHeader,
  AuxiliaryPanelHeaderGroup,
  AuxiliaryPanelTitle,
} from "@/shared/layout/AuxiliaryPanel";
import { useThreadPanelWidth } from "@/shared/hooks/useThreadPanelWidth";

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
import { ContentBrandPanel } from "./ContentBrandPanel";
import { ContentDayDetail } from "./ContentDayDetail";

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

/**
 * Status rendered as a small tinted dot plus a word, not a boxed badge: the
 * calendar is a wall of the agent's cards, and forty badge boxes under forty
 * images turned the gallery back into the admin table this redesign removed.
 */
const TONE_DOT = {
  bad: "bg-destructive",
  good: "bg-emerald-500",
  neutral: "bg-muted-foreground/40",
  warn: "bg-amber-500",
} as const;

const TONE_TEXT = {
  bad: "text-destructive",
  good: "text-emerald-600 dark:text-emerald-400",
  neutral: "text-muted-foreground",
  warn: "text-amber-600 dark:text-amber-400",
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
      className="group w-48 shrink-0 text-left"
      data-testid={`content-day-${post.slug}`}
      onClick={() => onSelect(post)}
      type="button"
    >
      <div
        className={cn(
          "overflow-hidden rounded-xl transition-shadow",
          selected
            ? "shadow-md ring-2 ring-primary"
            : "ring-1 ring-border/50 group-hover:shadow-md group-hover:ring-border",
        )}
      >
        {post.images.length > 0 ? (
          <img
            alt=""
            className="aspect-[4/5] w-full object-cover transition-transform duration-200 ease-out group-hover:scale-[1.02]"
            src={rewriteRelayUrl(post.images[0].url)}
          />
        ) : (
          // An undrawn card shows its own words rather than a grey box saying
          // it has none. A week of unrendered posts was five identical
          // placeholders, which made a planned week look like an empty one and
          // gave the eye nothing to pick a day by.
          <div className="flex aspect-[4/5] w-full flex-col justify-between bg-muted/40 p-3">
            <p className="line-clamp-5 text-sm font-medium leading-snug">
              {post.headline ?? post.slug}
            </p>
            <p className="text-2xs uppercase tracking-wider text-muted-foreground">
              Not drawn yet
            </p>
          </div>
        )}
      </div>
      {/* A gallery caption, not a card footer: date on the left, status as a
          dot and a word on the right, the job as a whisper beneath. */}
      <div className="mt-2 flex items-baseline justify-between gap-2 px-0.5">
        <p className="truncate text-xs font-medium">
          {dayLabel(post.scheduledFor)}
        </p>
        <span
          className="flex shrink-0 items-center gap-1.5"
          title={chip.detail}
        >
          <span
            aria-hidden
            className={cn("h-1.5 w-1.5 rounded-full", TONE_DOT[chip.tone])}
          />
          <span className={cn("text-2xs", TONE_TEXT[chip.tone])}>
            {chip.label}
          </span>
        </span>
      </div>
      {post.job ? (
        <p className="truncate px-0.5 text-2xs uppercase tracking-wide text-muted-foreground/70">
          {post.job}
        </p>
      ) : null}
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
  // The campaign's own label when it has one; the label already carries the
  // week number, so printing "Week 1" beside "Week 1 - first contact" said it
  // twice.
  const label =
    campaign.weeks.find((entry) => entry.index === week)?.label ??
    `Week ${week}`;

  return (
    <section className="mt-10 first:mt-6">
      {/* An editorial rule, not a bare heading: the label sits on a hairline
          that runs the row's width, so the eye reads weeks as chapters. */}
      <div className="flex items-center gap-3">
        <h3 className="shrink-0 text-sm font-semibold tracking-tight">
          {label}
        </h3>
        <div aria-hidden className="h-px flex-1 bg-border/60" />
        {posts.length > 0 ? (
          <p className="shrink-0 text-2xs text-muted-foreground">
            {posts.length} {posts.length === 1 ? "card" : "cards"}
          </p>
        ) : null}
      </div>
      {posts.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Nothing planned for this week yet.
        </p>
      ) : (
        // Wraps rather than scrolling sideways: a five-day week clipped its
        // last card off the right edge of a normal window, and a horizontal
        // scrollbar under one row is not a thing anyone finds.
        <div className="mt-4 flex flex-wrap gap-x-4 gap-y-6 pb-2">
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
  // The same panel width every other right-hand pane in the app uses, so the
  // day detail drags, resets and remembers exactly like a thread does. It was
  // pinned at 26rem, which on a narrow window clipped the approve controls off
  // the right edge with no way to widen it.
  const panelWidth = useThreadPanelWidth();

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

  // What the calendar owes the owner in three seconds: how many cards are
  // sitting on their call. Computed from what is already on screen, so the
  // count can never disagree with the dots under the cards.
  const waitingCount = React.useMemo(
    () =>
      posts.filter((post) => {
        const own = decisionsForPost(post, decisions, KIND_CONTENT_POST);
        return postChip(post, own).label === "Ready for you";
      }).length,
    [decisions, posts],
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-row overflow-hidden">
      <nav className="flex w-56 shrink-0 flex-col overflow-y-auto border-r border-border/60 p-3">
        <p className="px-2 pb-2 text-2xs uppercase tracking-wider text-muted-foreground">
          Campaigns
        </p>
        <div className="flex flex-col gap-0.5">
          {campaigns.map((campaign) => (
            <button
              className={cn(
                "rounded-lg px-2.5 py-2 text-left text-sm transition",
                !showStyle && campaign.id === activeCampaign?.id
                  ? "bg-muted font-medium"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
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
        </div>
        {/* Brand sits apart at the foot of the rail: it is the standing
            identity, not another campaign in the list. */}
        <div className="mt-auto border-t border-border/60 pt-2">
          <button
            className={cn(
              "w-full rounded-lg px-2.5 py-2 text-left text-sm transition",
              showStyle
                ? "bg-muted font-medium"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
            data-testid="content-open-style"
            onClick={() => setShowStyle(true)}
            type="button"
          >
            Brand
          </button>
        </div>
      </nav>

      {showStyle ? (
        <ContentBrandPanel
          communityId={communityId}
          sampleImageUrl={
            posts.find((post) => post.images.length > 0)?.images[0]?.url ?? null
          }
          style={styleQuery.data ?? null}
        />
      ) : (
        <>
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-6 py-4">
            <PageHeader
              description="Made and measured by your agent. Nothing goes out without your approval."
              title="Content"
            />

            {waitingCount > 0 ? (
              // The three-second answer, said once and quietly: a violet dot
              // and one sentence, above everything else on the screen.
              <p className="mt-3 flex items-center gap-2 text-sm">
                <span
                  aria-hidden
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                />
                <span className="font-medium">
                  {waitingCount === 1
                    ? "1 card is waiting for your call."
                    : `${waitingCount} cards are waiting for your call.`}
                </span>
              </p>
            ) : null}

            {campaignsQuery.isLoading ? (
              <p className="mt-4 text-sm text-muted-foreground">Loading.</p>
            ) : !activeCampaign ? (
              // The empty calendar reassures instead of echoing: a ghost week
              // sketches what will be here, and the words say who is filling
              // it. Static tiles, no pulse: an infinite animation would hang
              // the screenshot harness's animation settle.
              <div className="mt-10 flex flex-col items-center">
                <div aria-hidden className="flex gap-4">
                  {[0, 1, 2].map((ghost) => (
                    <div
                      className="aspect-[4/5] w-32 rounded-xl bg-muted/40"
                      key={ghost}
                    />
                  ))}
                </div>
                <p className="mt-6 max-w-sm text-center text-sm text-muted-foreground">
                  No campaign yet. Ask your content agent for a week and it will
                  appear here, with every check it measured, waiting on you.
                </p>
              </div>
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
            <AuxiliaryPanel
              canResetWidth={panelWidth.canReset}
              header={
                <AuxiliaryPanelHeader bordered>
                  <AuxiliaryPanelHeaderGroup>
                    <AuxiliaryPanelTitle>
                      {selectedPost.headline ?? selectedPost.slug}
                    </AuxiliaryPanelTitle>
                  </AuxiliaryPanelHeaderGroup>
                </AuxiliaryPanelHeader>
              }
              key={selectedPost.address}
              onClose={() => setSelectedAddress(null)}
              onResetWidth={panelWidth.onResetWidth}
              onResizeStart={panelWidth.onResizeStart}
              resizeHandleAriaLabel="Resize the day detail"
              resizeHandleTestId="content-day-detail-resize"
              testId="content-day-detail-panel"
              widthPx={panelWidth.widthPx}
            >
              <ContentDayDetail
                communityId={communityId}
                decisions={decisions}
                onSubmit={handleSubmit}
                post={selectedPost}
                styleVersion={styleQuery.data?.version ?? null}
                submitting={submitDecision.isPending}
              />
            </AuxiliaryPanel>
          ) : null}
        </>
      )}
    </div>
  );
}
