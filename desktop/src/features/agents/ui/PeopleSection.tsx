import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { UserPlus } from "lucide-react";

import { AgentRankBadge } from "@/features/agents/ui/AgentRankBadge";
import {
  rankLabel,
  useEmployeeHeadsQuery,
} from "@/features/agents/employeeHeads";
import {
  activeGrantsFromEvents,
  delegationGrantsQueryKey,
  fetchDelegationGrantEvents,
  type DelegationGrant,
} from "@/features/agents/delegationGrants";
import { useCommunityOwnersQuery } from "@/features/agents/communityOwners";
import {
  buildOrgTree,
  type OrgMember,
  type OrgTreeNode,
} from "@/features/agents/orgTree";
import {
  type OrgChartMember,
  useOrgMembers,
} from "@/features/agents/orgMembers";
import {
  dismissLandedPendingHires,
  usePendingHires,
} from "@/features/agents/pendingHires";
import type { RoleDialogMember } from "@/features/agents/ui/EmployeeRoleDialog";
import { DelegatedAuthoritySection } from "@/features/agents/ui/DelegatedAuthoritySection";
import { EmployeeRoleDialog } from "@/features/agents/ui/EmployeeRoleDialog";
import { HireEmployeeDialog } from "@/features/agents/ui/HireEmployeeDialog";
import { useAgentWorking } from "@/features/agents/agentWorkingSignal";
import { useUsersBatchQuery } from "@/features/profile/hooks";
import type { UserProfileLookup } from "@/features/profile/lib/identity";
import { normalizePubkey } from "@/shared/lib/pubkey";
import { ProfileAvatar } from "@/features/profile/ui/ProfileAvatar";
import { useCommunities } from "@/features/communities/useCommunities";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { SectionHeader } from "@/shared/ui/PageHeader";

/**
 * The People and Roles screen: the community's org chart of agents, an
 * Unassigned tray for lines that do not resolve, hiring, and role editing.
 *
 * Humans are never drawn: the owner sits above the entire structure and can
 * address any agent directly, so placing them in the tree would misrepresent
 * both facts.
 */

const EMPTY_OWNERS: Set<string> = new Set();

export function PeopleSection() {
  const { activeCommunity } = useCommunities();
  const communityId = activeCommunity?.id ?? "";
  const queryClient = useQueryClient();
  const { members, unrankedAgents, isLoading, error } =
    useOrgMembers(communityId);
  const ownersQuery = useCommunityOwnersQuery(communityId);
  const grantEventsQuery = useQuery({
    queryKey: delegationGrantsQueryKey(communityId),
    queryFn: fetchDelegationGrantEvents,
    enabled: communityId !== "",
    staleTime: 30_000,
  });
  const pendingHires = usePendingHires(communityId);

  const [isHireOpen, setIsHireOpen] = React.useState(false);
  const [editingMember, setEditingMember] =
    React.useState<RoleDialogMember | null>(null);

  // While a hire is pending, poll for its head; it lands asynchronously once
  // the relay mints the identity.
  React.useEffect(() => {
    if (pendingHires.length === 0 || communityId === "") return;
    const interval = window.setInterval(() => {
      void queryClient.invalidateQueries({
        queryKey: ["colony-employee-heads"],
      });
    }, 5_000);
    return () => window.clearInterval(interval);
  }, [pendingHires.length, communityId, queryClient]);

  // A pending hire whose role now has a head has landed.
  const headsQuery = useEmployeeHeadsQuery(communityId);
  React.useEffect(() => {
    if (pendingHires.length === 0) return;
    const heads = headsQuery.data;
    if (!heads) return;
    const filledRoles = new Set<string>();
    for (const head of heads.values()) filledRoles.add(head.role);
    dismissLandedPendingHires(communityId, filledRoles);
  }, [headsQuery.data, pendingHires.length, communityId]);

  const activeGrants: DelegationGrant[] = React.useMemo(
    () =>
      activeGrantsFromEvents(
        grantEventsQuery.data ?? [],
        ownersQuery.data ?? EMPTY_OWNERS,
      ),
    [grantEventsQuery.data, ownersQuery.data],
  );

  const tree = React.useMemo(() => buildOrgTree(members), [members]);

  // The tree builder types its nodes as plain OrgMember, but every member it
  // was given is an OrgChartMember carrying the payroll flag; restore it so
  // the dialog knows which publish path this agent edits through.
  const openEditor = React.useCallback((member: OrgMember) => {
    const chartMember = member as OrgChartMember;
    setEditingMember({
      pubkey: chartMember.pubkey,
      name: chartMember.name,
      role: chartMember.role,
      rank: chartMember.rank,
      manager: chartMember.manager,
      isPersonalAgent: chartMember.isPersonalAgent === true,
    });
  }, []);
  // Real avatars, batched in one query for every agent on the chart. Nodes
  // rendered initials-only before this, which made the org read as a debug
  // view rather than the company.
  const memberPubkeys = React.useMemo(
    () => members.map((member) => member.pubkey),
    [members],
  );
  const profilesQuery = useUsersBatchQuery(memberPubkeys, {
    enabled: memberPubkeys.length > 0,
  });
  const profiles = profilesQuery.data?.profiles;
  // An agent present but unranked is an action waiting, not an empty page:
  // the empty state may only claim "no one" when nothing at all renders.
  const isEmpty =
    !isLoading && members.length === 0 && unrankedAgents.length === 0;

  return (
    <section className="relative space-y-4" data-testid="people-roles-section">
      <SectionHeader
        action={
          <Button
            data-testid="hire-employee-button"
            disabled={communityId === ""}
            onClick={() => setIsHireOpen(true)}
            size="sm"
          >
            <UserPlus />
            Hire employee
          </Button>
        }
        description="Who reports to whom, who is working, and what everyone may decide."
        title="People and roles"
      />

      {error ? (
        <p className="rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error.message}
        </p>
      ) : null}

      {isLoading ? (
        <div
          className="h-24 animate-pulse rounded-2xl border border-border/60 bg-muted/40"
          data-testid="people-roles-loading"
        />
      ) : isEmpty ? (
        <div
          className="rounded-2xl border border-dashed border-border px-6 py-10 text-center"
          data-testid="people-roles-empty"
        >
          <p className="text-sm font-medium text-foreground">
            No one is employed here yet.
          </p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Hire your first employee to build out your org. Hired staff appear
            here with their reporting line, rank badge, and live status.
          </p>
          <Button
            className="mt-4"
            data-testid="people-roles-empty-hire"
            onClick={() => setIsHireOpen(true)}
            size="sm"
            variant="outline"
          >
            <UserPlus />
            Hire an employee
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          {tree.roots.length > 0 ? (
            <div
              className="flex flex-wrap items-start gap-x-8 gap-y-4 rounded-2xl border border-border/60 bg-muted/20 p-4"
              data-testid="org-tree"
            >
              {tree.roots.map((root) => (
                <OrgNodeCard
                  profiles={profiles}
                  key={root.member.pubkey}
                  node={root}
                  onEdit={openEditor}
                />
              ))}
            </div>
          ) : null}

          {unrankedAgents.length > 0 ? (
            <div
              className="rounded-2xl border border-dashed border-border p-4"
              data-testid="unranked-agents"
            >
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Unranked
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                These agents have no rank yet, so they cannot sit on the chart.
                Give one a rank to place it in the org.
              </p>
              <div className="mt-3 flex flex-col gap-2">
                {unrankedAgents.map((agent) => (
                  <div
                    className="flex items-center gap-2.5"
                    data-testid={`unranked-agent-${agent.pubkey}`}
                    key={agent.pubkey}
                  >
                    <ProfileAvatar
                      avatarUrl={null}
                      className="h-7 w-7 text-xs"
                      label={agent.name}
                    />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium tracking-tight text-foreground">
                        {agent.name}
                      </p>
                      {agent.role ? (
                        <p className="truncate font-mono text-3xs text-muted-foreground">
                          {agent.role}
                        </p>
                      ) : null}
                    </div>
                    <Button
                      className="ml-auto shrink-0"
                      data-testid={`unranked-agent-rank-${agent.pubkey}`}
                      onClick={() =>
                        setEditingMember({
                          ...agent,
                          rank: null,
                          manager: null,
                          isPersonalAgent: true,
                        })
                      }
                      size="sm"
                      variant="outline"
                    >
                      Set rank
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {tree.unassigned.length > 0 ? (
            <div
              className="rounded-2xl border border-dashed border-border p-4"
              data-testid="unassigned-tray"
            >
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Unassigned
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                No reporting line yet. Assign a manager from each agent's Edit
                dialog to place them on the chart.
              </p>
              <div className="mt-3 flex flex-col gap-2">
                {tree.unassigned.map((node) => (
                  <OrgNodeCard
                    profiles={profiles}
                    key={node.member.pubkey}
                    node={node}
                    onEdit={openEditor}
                    variant="tray"
                  />
                ))}
              </div>
            </div>
          ) : null}

          {pendingHires.map((hire) => (
            <div
              className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-muted/30 px-4 py-3"
              data-testid={`pending-hire-${hire.role}`}
              key={hire.id}
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">
                  Hiring {hire.name} as{" "}
                  <span className="font-mono text-xs">{hire.role}</span>
                </p>
                <p
                  className="text-xs text-muted-foreground"
                  data-testid="pending-hire-explanation"
                >
                  Waiting for the workspace to mint an identity. This row clears
                  as soon as the hire's head lands.
                </p>
              </div>
              <Badge variant="secondary">{rankLabel(hire.rank)}</Badge>
            </div>
          ))}
        </div>
      )}

      {/* Community-level record: delegated authority renders whether or not
          the org chart has anyone on it yet. */}
      <DelegatedAuthoritySection communityId={communityId} />

      <HireEmployeeDialog
        communityId={communityId}
        members={members}
        onOpenChange={setIsHireOpen}
        open={isHireOpen}
      />

      {editingMember ? (
        <EmployeeRoleDialog
          communityId={communityId}
          grants={activeGrants}
          isGrantsLoading={ownersQuery.isLoading || grantEventsQuery.isLoading}
          member={editingMember}
          members={members}
          onOpenChange={(open) => {
            if (!open) setEditingMember(null);
          }}
          open={editingMember !== null}
          ownerPubkeys={ownersQuery.data ?? EMPTY_OWNERS}
        />
      ) : null}
    </section>
  );
}

function OrgNodeLiveness({ pubkey }: { pubkey: string }) {
  // Liveness comes from the shared working signal (observer turns primary,
  // bot typing fallback) -- never a separate source.
  const working = useAgentWorking(pubkey).working;
  return (
    <Badge
      data-testid="org-node-liveness"
      variant={working ? "success" : "outline"}
    >
      {working ? "Working" : "Idle"}
    </Badge>
  );
}

/**
 * Span of control, and the two shapes worth flagging.
 *
 * A chart that only draws structure hides the thing the owner actually needs
 * to see: whether the work is spread evenly. A lead carrying eleven reports
 * and a lead carrying none look identical in a tree of boxes.
 *
 * Deliberately advisory, never enforcement. The relay permits any number of
 * reports, and this only makes the shape legible.
 */
const CROWDED_DIRECT_REPORTS = 8;

function OrgNodeLoad({ node }: { node: OrgTreeNode }) {
  const { directReports, totalReports } = node.counts;
  const managerRank =
    node.member.rank === "leader" || node.member.rank === "executive";

  if (directReports === 0) {
    // Only a manager-rank agent with nobody under it is worth flagging: a
    // worker having no reports is the normal case, not a gap.
    return managerRank ? (
      <span
        className="text-2xs text-muted-foreground"
        data-testid={`org-node-load-${node.member.pubkey}`}
        title="No one reports to this agent yet"
      >
        no reports
      </span>
    ) : null;
  }

  const crowded = directReports >= CROWDED_DIRECT_REPORTS;
  return (
    <span
      className={
        crowded
          ? "text-2xs font-medium text-warning"
          : "text-2xs text-muted-foreground"
      }
      data-testid={`org-node-load-${node.member.pubkey}`}
      title={
        totalReports === directReports
          ? undefined
          : `${totalReports} in total underneath`
      }
    >
      {directReports} direct
      {totalReports > directReports ? ` / ${totalReports} total` : ""}
    </span>
  );
}

function OrgNodeCard({
  node,
  onEdit,
  profiles,
  variant = "tree",
}: {
  node: OrgTreeNode;
  onEdit: (member: OrgMember) => void;
  profiles?: UserProfileLookup;
  variant?: "tree" | "tray";
}) {
  const profile = profiles?.[normalizePubkey(node.member.pubkey)];
  return (
    <div data-testid={`org-node-${node.member.pubkey}`}>
      <div className="flex min-w-0 items-center gap-2.5">
        <ProfileAvatar
          avatarUrl={profile?.avatarUrl ?? null}
          className={variant === "tray" ? "h-7 w-7 text-xs" : "h-9 w-9 text-sm"}
          label={node.member.name}
        />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-medium tracking-tight text-foreground">
              {node.member.name}
            </span>
            <AgentRankBadge rank={node.member.rank} />
            <OrgNodeLiveness pubkey={node.member.pubkey} />
            <OrgNodeLoad node={node} />
          </div>
          {node.member.role ? (
            <p className="truncate font-mono text-3xs text-muted-foreground">
              {node.member.role}
            </p>
          ) : null}
        </div>
        <Button
          aria-label={`Edit role for ${node.member.name}`}
          className="ml-auto shrink-0"
          data-testid={`org-node-edit-${node.member.pubkey}`}
          onClick={() => onEdit(node.member)}
          size="sm"
          variant="ghost"
        >
          Edit
        </Button>
      </div>
      {node.reports.length > 0 ? (
        <div
          className={`mt-2 space-y-2 border-l pl-4 ${variant === "tray" ? "border-border/60" : "ml-4 border-border/80"}`}
          data-testid={`org-reports-${node.member.pubkey}`}
        >
          {node.reports.map((report) => (
            <OrgNodeCard
              profiles={profiles}
              key={report.member.pubkey}
              node={report}
              onEdit={onEdit}
              variant={variant}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
