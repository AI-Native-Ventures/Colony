import { Button, Textarea } from "buzz";

export function Default() {
  return (
    <Textarea
      className="max-w-sm"
      placeholder="Message #engineering"
    />
  );
}

export function WithLabel() {
  return (
    <div className="flex w-full max-w-sm flex-col gap-1.5">
      <label
        className="text-xs font-medium text-foreground"
        htmlFor="preview-channel-topic"
      >
        Channel topic
      </label>
      <Textarea
        defaultValue="Relay work, migrations, and desktop releases. Ping @scout for merge queue questions."
        id="preview-channel-topic"
      />
      <span className="text-xs text-muted-foreground">
        Shown to every member at the top of the channel.
      </span>
    </div>
  );
}

export function Composer() {
  return (
    <div className="flex w-full max-w-sm flex-col gap-2">
      <Textarea
        className="min-h-24"
        defaultValue={
          "The merge queue is stuck on PR #312 again. Looks like the merge_group trigger never fired, so nothing behind it can land."
        }
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          Replying in thread
        </span>
        <Button size="sm">Send</Button>
      </div>
    </div>
  );
}

export function Disabled() {
  return (
    <div className="flex w-full max-w-sm flex-col gap-1.5">
      <Textarea
        defaultValue="You need to be a member of #announcements to post here."
        disabled
      />
      <span className="text-xs text-muted-foreground">
        Posting is restricted to owners in this channel.
      </span>
    </div>
  );
}
