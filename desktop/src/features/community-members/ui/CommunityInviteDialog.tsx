import { Link2, UserPlus } from "lucide-react";
import * as React from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { DirectAddMemberForm } from "./AddMemberDialog";
import {
  DEFAULT_INVITE_TTL_SECS,
  InviteLinkSection,
} from "./InviteLinkSection";

export function CommunityInviteDialog({
  isOwner,
  onOpenChange,
  open,
}: {
  isOwner: boolean;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  // Email delivery is not available yet, so the modal only mints shareable
  // invite links through the relay's existing invite flow.
  const [ttlSecs, setTtlSecs] = React.useState(DEFAULT_INVITE_TTL_SECS);

  React.useEffect(() => {
    if (open) setTtlSecs(DEFAULT_INVITE_TTL_SECS);
  }, [open]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="max-h-[88vh] max-w-2xl overflow-hidden p-0"
        data-testid="community-invite-dialog"
      >
        <div className="flex max-h-[88vh] flex-col">
          <DialogHeader className="border-b border-border/60 px-6 py-5 pr-14">
            <DialogTitle>Invite to community</DialogTitle>
            <DialogDescription>
              Add someone now or create a link they can use to join.
            </DialogDescription>
          </DialogHeader>

          <div
            className="flex-1 space-y-4 overflow-y-auto bg-muted/15 px-6 py-5"
            data-testid="community-invite-dialog-body"
          >
            <section className="rounded-2xl border border-border/70 bg-background p-4 shadow-xs sm:p-5">
              <div className="mb-4 flex items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground">
                  <UserPlus aria-hidden="true" className="h-4 w-4" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold">Add directly</h3>
                  <p className="text-sm text-muted-foreground">
                    Add someone now using their Nostr public key.
                  </p>
                </div>
              </div>
              <DirectAddMemberForm
                isOwner={isOwner}
                submitLabel="Add to community"
              />
            </section>

            <section className="rounded-2xl border border-border/70 bg-background p-4 shadow-xs sm:p-5">
              <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground">
                  <Link2 aria-hidden="true" className="h-4 w-4" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold">
                    Share an invite link
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    Anyone with the link can join as a member.
                  </p>
                </div>
              </div>
              <InviteLinkSection
                onTtlSecsChange={setTtlSecs}
                ttlSecs={ttlSecs}
              />
            </section>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
