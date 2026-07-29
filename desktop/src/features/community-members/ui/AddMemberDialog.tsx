import { Shield, UserRound } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import {
  useAddRelayMemberMutation,
  useRelayMembersQuery,
} from "@/features/community-members/hooks";
import type { RelayMemberRole } from "@/shared/api/types";
import { cn } from "@/shared/lib/cn";
import { parsePubkeyInput } from "@/shared/lib/nostrUtils";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";

const ROLE_OPTIONS: Array<{
  value: RelayMemberRole;
  label: string;
  description: string;
  icon: typeof UserRound;
}> = [
  {
    value: "member",
    label: "Member",
    description: "Can join and participate",
    icon: UserRound,
  },
  {
    value: "admin",
    label: "Admin",
    description: "Can manage members and invites",
    icon: Shield,
  },
];

export function DirectAddMemberForm({
  isOwner,
  onAdded,
  submitLabel = "Add member",
}: {
  isOwner: boolean;
  onAdded?: () => void;
  submitLabel?: string;
}) {
  const addMutation = useAddRelayMemberMutation();
  const membersQuery = useRelayMembersQuery();
  const [pubkey, setPubkey] = React.useState("");
  const [role, setRole] = React.useState<RelayMemberRole>("member");

  const normalizedPubkey = parsePubkeyInput(pubkey);
  const isValidPubkey = normalizedPubkey !== null;
  const isAlreadyMember =
    isValidPubkey &&
    !addMutation.isPending &&
    (membersQuery.data ?? []).some(
      (m) => m.pubkey.toLowerCase() === normalizedPubkey,
    );
  const canAdd = isValidPubkey && !isAlreadyMember && !addMutation.isPending;

  function reset() {
    setPubkey("");
    setRole("member");
    addMutation.reset();
  }

  function handleAdd() {
    if (!canAdd || normalizedPubkey === null) return;
    addMutation.mutate(
      { pubkey: normalizedPubkey, role },
      {
        onSuccess: () => {
          toast.success(role === "admin" ? "Admin added" : "Member added");
          reset();
          onAdded?.();
        },
      },
    );
  }

  return (
    <form
      className="space-y-4"
      data-testid="direct-add-member-form"
      onSubmit={(event) => {
        event.preventDefault();
        handleAdd();
      }}
    >
      <div className="space-y-1.5">
        <label className="text-sm font-medium" htmlFor="member-pubkey">
          Public key
        </label>
        <Input
          autoCapitalize="none"
          autoCorrect="off"
          data-testid="member-pubkey-input"
          id="member-pubkey"
          onChange={(event) => setPubkey(event.target.value)}
          placeholder="npub1… or 64-character hex pubkey"
          spellCheck={false}
          value={pubkey}
        />
        {pubkey.trim().length > 0 && !isValidPubkey ? (
          <p className="text-xs text-destructive">
            Must be an npub1… key or 64 hex characters.
          </p>
        ) : null}
        {isAlreadyMember ? (
          <p className="text-xs text-destructive">
            This pubkey is already a community member.
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">Role</p>
        <div
          className={cn(
            "grid gap-2",
            isOwner ? "sm:grid-cols-2" : "grid-cols-1",
          )}
        >
          {ROLE_OPTIONS.filter(
            (option) => isOwner || option.value === "member",
          ).map((option) => {
            const Icon = option.icon;
            const selected = role === option.value;
            return (
              <button
                aria-pressed={selected}
                className={cn(
                  "flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring",
                  selected
                    ? "border-foreground/25 bg-muted/70 text-foreground shadow-xs"
                    : "border-border/60 bg-background text-muted-foreground hover:border-border hover:bg-muted/35",
                )}
                data-testid={`member-role-${option.value}`}
                key={option.value}
                onClick={() => setRole(option.value)}
                type="button"
              >
                <span
                  className={cn(
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                    selected
                      ? "bg-foreground text-background"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  <Icon aria-hidden="true" className="h-4 w-4" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-foreground">
                    {option.label}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {option.description}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {addMutation.error instanceof Error ? (
        <p className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {addMutation.error.message}
        </p>
      ) : null}

      <div className="flex justify-end">
        <Button
          data-testid="confirm-add-member"
          disabled={!canAdd}
          size="sm"
          type="submit"
        >
          {addMutation.isPending ? "Adding…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}

export function AddMemberDialog({
  isOwner,
  open,
  onOpenChange,
}: {
  isOwner: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="max-w-md overflow-hidden p-0"
        data-testid="add-relay-member-dialog"
      >
        <div className="flex max-h-[85vh] flex-col">
          <DialogHeader className="border-b border-border/60 px-6 py-5 pr-14">
            <DialogTitle>Add member</DialogTitle>
            <DialogDescription>
              Add a person to this community by their public key.
            </DialogDescription>
          </DialogHeader>
          <div className="px-6 py-4">
            <DirectAddMemberForm
              isOwner={isOwner}
              onAdded={() => onOpenChange(false)}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
