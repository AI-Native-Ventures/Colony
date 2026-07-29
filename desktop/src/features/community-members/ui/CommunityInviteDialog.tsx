import * as React from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Separator } from "@/shared/ui/separator";
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
        className="max-h-[85vh] max-w-xl overflow-y-auto"
        data-testid="community-invite-dialog"
      >
        <DialogHeader>
          <DialogTitle>Invite to community</DialogTitle>
          <DialogDescription>
            Add someone directly or share a link they can use to join.
          </DialogDescription>
        </DialogHeader>

        <section className="space-y-3">
          <div>
            <h3 className="text-sm font-medium">Add directly</h3>
            <p className="text-sm text-muted-foreground">
              Enter a person’s public key and choose their community role.
            </p>
          </div>
          <DirectAddMemberForm isOwner={isOwner} submitLabel="Add directly" />
        </section>

        <Separator className="bg-border/60" />

        <section className="space-y-3">
          <div>
            <h3 className="text-sm font-medium">Or share a link</h3>
            <p className="text-sm text-muted-foreground">
              Anyone with the link can join as a member.
            </p>
          </div>
          <InviteLinkSection onTtlSecsChange={setTtlSecs} ttlSecs={ttlSecs} />
        </section>
      </DialogContent>
    </Dialog>
  );
}
