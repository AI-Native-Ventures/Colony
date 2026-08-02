import * as React from "react";
import { Mail, MessageCircle, Send } from "lucide-react";

import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { Input } from "@/shared/ui/input";
import type { DiscoveryDataSource } from "../data/DiscoveryDataSource";
import type { CampaignDetail, ConversationThread } from "../types";

export function CampaignConversationsTab({
  campaign,
  dataSource,
}: {
  campaign: CampaignDetail;
  dataSource: DiscoveryDataSource;
}) {
  const [items, setItems] = React.useState<ConversationThread[]>([]);
  const [selectedId, setSelectedId] = React.useState("");
  const [reply, setReply] = React.useState("");

  React.useEffect(() => {
    let cancelled = false;
    void dataSource.getConversations(campaign.id).then((conversations) => {
      if (cancelled) return;
      setItems(conversations);
      setSelectedId((current) => current || conversations[0]?.id || "");
    });
    return () => {
      cancelled = true;
    };
  }, [campaign.id, dataSource]);

  const selected = items.find((item) => item.id === selectedId) ?? items[0];

  async function select(id: string) {
    setSelectedId(id);
    const updated = await dataSource.markConversationRead(campaign.id, id);
    setItems((current) =>
      current.map((item) => (item.id === id ? updated : item)),
    );
  }

  async function send() {
    if (!reply.trim() || !selected) return;
    const updated = await dataSource.sendConversationReply(
      campaign.id,
      selected.id,
      reply,
    );
    setItems((current) =>
      current.map((item) => (item.id === selected.id ? updated : item)),
    );
    setReply("");
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Conversations</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Replies from {campaign.name}, ready for a human or agent handoff.
        </p>
      </div>
      <Card className="grid min-h-[32rem] overflow-hidden border-border/60 bg-card/70 p-0 shadow-none md:grid-cols-[18rem_1fr]">
        <aside className="border-r border-border/60">
          <div className="border-b border-border/60 px-4 py-3 text-sm font-semibold">
            Inbox{" "}
            <Badge className="ml-2" variant="secondary">
              {items.filter((item) => item.unread).length}
            </Badge>
          </div>
          {items.map((item) => (
            <button
              className={`w-full border-b border-border/50 px-4 py-4 text-left ${selected?.id === item.id ? "bg-primary/5" : "hover:bg-muted/30"}`}
              key={item.id}
              onClick={() => void select(item.id)}
              type="button"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-semibold">
                  {item.name}
                </span>
                {item.unread ? (
                  <span className="h-2 w-2 rounded-full bg-primary" />
                ) : null}
              </div>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {item.company}
              </p>
              <p className="mt-2 truncate text-xs text-muted-foreground">
                {item.messages.at(-1)?.body}
              </p>
            </button>
          ))}
        </aside>
        {selected ? (
          <section className="flex min-w-0 flex-col">
            <header className="flex items-center justify-between border-b border-border/60 px-5 py-4">
              <div>
                <h3 className="font-semibold">{selected.name}</h3>
                <p className="text-xs text-muted-foreground">
                  {selected.company}
                </p>
              </div>
              <Badge variant="outline">
                {selected.channel === "Email" ? (
                  <Mail className="mr-1 h-3 w-3" />
                ) : (
                  <MessageCircle className="mr-1 h-3 w-3" />
                )}
                {selected.channel}
              </Badge>
            </header>
            <div className="flex-1 space-y-3 overflow-y-auto p-5">
              {selected.messages.map((message) => (
                <div
                  className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm ${message.direction === "outbound" ? "ml-auto bg-primary text-primary-foreground" : "bg-muted text-foreground"}`}
                  key={message.id}
                >
                  {message.body}
                </div>
              ))}
            </div>
            <div className="flex gap-2 border-t border-border/60 p-4">
              <Input
                aria-label="Reply"
                onChange={(event) => setReply(event.target.value)}
                onKeyDown={(event) =>
                  event.key === "Enter" ? void send() : undefined
                }
                placeholder="Write a reply…"
                value={reply}
              />
              <Button
                aria-label="Send reply"
                onClick={() => void send()}
                size="icon"
              >
                <Send />
              </Button>
            </div>
          </section>
        ) : (
          <div className="grid place-items-center text-sm text-muted-foreground">
            No conversations yet
          </div>
        )}
      </Card>
    </div>
  );
}
