import {
  Button,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "buzz";

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 border-b border-border/60 py-3 last:border-0">
      <dt className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="break-words text-sm text-foreground">{value}</dd>
    </div>
  );
}

export function Default() {
  return (
    <Sheet defaultOpen>
      <SheetTrigger asChild>
        <Button variant="outline">Open task</Button>
      </SheetTrigger>
      <SheetContent
        className="w-full overflow-y-auto sm:max-w-md"
        onOpenAutoFocus={(event) => event.preventDefault()}
        side="right"
      >
        <SheetHeader>
          <SheetTitle>Ship the invite-link expiry banner</SheetTitle>
          <SheetDescription>
            Durable task context for this canonical thread.
          </SheetDescription>
        </SheetHeader>
        <dl className="mt-5">
          <DetailRow label="Accountable owner" value="tyler" />
          <DetailRow label="QA owner" value="agent:reviewer" />
          <DetailRow label="Task state" value="In review" />
          <DetailRow label="Channel" value="#engineering" />
          <DetailRow
            label="Expected deliverable"
            value="Banner appears 48h before an invite link expires."
          />
        </dl>
        <SheetFooter className="mt-6">
          <Button variant="outline">Reassign</Button>
          <Button>Mark done</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
