import { Switch } from "buzz";

export function Default() {
  return (
    <div className="flex w-[420px] items-center justify-between gap-4">
      <label
        className="text-sm font-medium text-foreground"
        htmlFor="switch-default"
      >
        Desktop alerts
      </label>
      <Switch defaultChecked id="switch-default" />
    </div>
  );
}

export function States() {
  return (
    <div className="flex flex-col gap-4 w-[420px]">
      <div className="flex items-center justify-between gap-4">
        <label className="text-sm" htmlFor="switch-on">
          On
        </label>
        <Switch checked id="switch-on" />
      </div>
      <div className="flex items-center justify-between gap-4">
        <label className="text-sm" htmlFor="switch-off">
          Off
        </label>
        <Switch checked={false} id="switch-off" />
      </div>
      <div className="flex items-center justify-between gap-4">
        <label className="text-sm text-muted-foreground" htmlFor="switch-do">
          Disabled on
        </label>
        <Switch checked disabled id="switch-do" />
      </div>
      <div className="flex items-center justify-between gap-4">
        <label className="text-sm text-muted-foreground" htmlFor="switch-df">
          Disabled off
        </label>
        <Switch checked={false} disabled id="switch-df" />
      </div>
    </div>
  );
}

export function NotificationSettings() {
  return (
    <div className="flex w-[460px] flex-col divide-y divide-border rounded-lg border border-border">
      {[
        {
          checked: true,
          copy: "Native desktop alerts for mentions and needs-action items.",
          disabled: false,
          id: "desktop",
          title: "Desktop alerts",
        },
        {
          checked: true,
          copy: "Also alert for direct messages in the conversation you have open.",
          disabled: false,
          id: "while-viewing",
          title: "Notify while viewing",
        },
        {
          checked: false,
          copy: "Play a sound when an agent raises an ask that needs an owner.",
          disabled: false,
          id: "sound",
          title: "Ask sounds",
        },
        {
          checked: false,
          copy: "Requires desktop alerts to be enabled first.",
          disabled: true,
          id: "digest",
          title: "Daily digest",
        },
      ].map((row) => (
        <div
          className="flex items-center justify-between gap-6 px-4 py-3"
          key={row.id}
        >
          <div className="min-w-0">
            <label
              className="text-sm font-medium text-foreground"
              htmlFor={`switch-notif-${row.id}`}
            >
              {row.title}
            </label>
            <p className="text-sm text-muted-foreground">{row.copy}</p>
          </div>
          <Switch
            checked={row.checked}
            disabled={row.disabled}
            id={`switch-notif-${row.id}`}
          />
        </div>
      ))}
    </div>
  );
}

export function InlineWithStatus() {
  return (
    <div className="flex w-[420px] items-center gap-3 rounded-lg border border-border bg-muted px-4 py-3">
      <Switch defaultChecked id="switch-agent-autoreply" />
      <div className="min-w-0">
        <label
          className="text-sm font-medium text-foreground"
          htmlFor="switch-agent-autoreply"
        >
          Auto-reply in #engineering
        </label>
        <p className="text-xs text-muted-foreground">
          Enabled, the agent answers when it is mentioned.
        </p>
      </div>
    </div>
  );
}
