import { createFileRoute } from "@tanstack/react-router";

import { useCommunities } from "@/features/communities/useCommunities";
import { useBlockCatalogQuery } from "@/features/blocks/blockCatalog";
import { NewMessageScreen } from "@/features/messages/ui/NewMessageScreen";
import {
  resolveVerifiedBlockHandoff,
  validateNewMessageSearch,
} from "./newMessageRouteSearch";

export const Route = createFileRoute("/messages/new")({
  validateSearch: validateNewMessageSearch,
  component: NewMessageRouteComponent,
});

function NewMessageRouteComponent() {
  const search = Route.useSearch();
  const { activeCommunity } = useCommunities();
  const hasBlockHandoff = Boolean(
    search.blockAddress && search.blockHandle && search.blockManifestId,
  );
  const catalogQuery = useBlockCatalogQuery(
    hasBlockHandoff && activeCommunity
      ? {
          channelIds: [],
          communityId: activeCommunity.id,
          recentUsageAvailable: false,
        }
      : null,
  );

  if (
    hasBlockHandoff &&
    activeCommunity &&
    (catalogQuery.isLoading || catalogQuery.isPending)
  ) {
    return (
      <div
        aria-busy="true"
        className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground"
        role="status"
      >
        Checking Block reference…
      </div>
    );
  }

  const initialBlockReference = resolveVerifiedBlockHandoff(
    search,
    catalogQuery.data ?? [],
  );
  const rejectedBlockHandoff =
    hasBlockHandoff &&
    (!activeCommunity || catalogQuery.isError || !initialBlockReference);

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {rejectedBlockHandoff ? (
        <div
          className="mx-4 mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-foreground sm:mx-6"
          role="alert"
        >
          This Block link is no longer the active published version. No
          reference was added.
        </div>
      ) : null}
      <NewMessageScreen
        initialBlockReference={initialBlockReference ?? undefined}
        initialContent={
          initialBlockReference
            ? `Work on @${initialBlockReference.displayName} `
            : undefined
        }
      />
    </div>
  );
}
