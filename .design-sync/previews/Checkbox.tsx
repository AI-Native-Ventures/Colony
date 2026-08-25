import { Checkbox } from "buzz";

export function Default() {
  return (
    <div className="flex items-center gap-2">
      <Checkbox defaultChecked id="checkbox-default" />
      <label
        className="text-sm font-medium text-foreground"
        htmlFor="checkbox-default"
      >
        Notify me when an agent needs a decision
      </label>
    </div>
  );
}

export function States() {
  return (
    <div className="flex flex-col gap-3 w-[420px]">
      <div className="flex items-center gap-2">
        <Checkbox defaultChecked id="checkbox-state-checked" />
        <label className="text-sm" htmlFor="checkbox-state-checked">
          Checked, invite link expires in 7 days
        </label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="checkbox-state-unchecked" />
        <label className="text-sm" htmlFor="checkbox-state-unchecked">
          Unchecked, allow anyone with the link to join
        </label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox checked disabled id="checkbox-state-disabled-on" />
        <label
          className="text-sm text-muted-foreground"
          htmlFor="checkbox-state-disabled-on"
        >
          Disabled checked, owners always receive asks
        </label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox checked={false} disabled id="checkbox-state-disabled-off" />
        <label
          className="text-sm text-muted-foreground"
          htmlFor="checkbox-state-disabled-off"
        >
          Disabled unchecked, requires an owner-signed grant
        </label>
      </div>
    </div>
  );
}

export function WithDescription() {
  return (
    <div className="flex w-[420px] items-start gap-3 rounded-lg border border-border p-4">
      <Checkbox defaultChecked className="mt-0.5" id="checkbox-archive" />
      <div className="min-w-0">
        <label
          className="text-sm font-medium text-foreground"
          htmlFor="checkbox-archive"
        >
          Keep a local archive
        </label>
        <p className="text-sm text-muted-foreground">
          Messages from every channel you belong to are written to disk so
          search keeps working while the relay is unreachable.
        </p>
      </div>
    </div>
  );
}

export function ChannelSelection() {
  return (
    <div className="flex w-[420px] flex-col gap-1">
      <p className="pb-2 text-sm font-medium text-foreground">
        Channels to include in the digest
      </p>
      {[
        { checked: true, id: "general", members: 42, name: "general" },
        { checked: true, id: "engineering", members: 18, name: "engineering" },
        { checked: false, id: "design", members: 9, name: "design" },
        { checked: false, id: "watercooler", members: 31, name: "watercooler" },
      ].map((channel) => (
        <div
          className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted"
          key={channel.id}
        >
          <Checkbox
            defaultChecked={channel.checked}
            id={`checkbox-channel-${channel.id}`}
          />
          <label
            className="flex-1 text-sm text-foreground"
            htmlFor={`checkbox-channel-${channel.id}`}
          >
            #{channel.name}
          </label>
          <span className="text-xs text-muted-foreground">
            {channel.members} members
          </span>
        </div>
      ))}
    </div>
  );
}
