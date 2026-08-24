import { Tabs, TabsContent, TabsList, TabsTrigger } from "buzz";

export function Default() {
  return (
    <Tabs defaultValue="messages" className="w-[420px]">
      <TabsList>
        <TabsTrigger value="messages">Messages</TabsTrigger>
        <TabsTrigger value="files">Files</TabsTrigger>
        <TabsTrigger value="members">Members</TabsTrigger>
      </TabsList>
      <TabsContent value="messages">
        <p className="text-sm text-muted-foreground">
          Everything posted in #engineering, newest last.
        </p>
      </TabsContent>
      <TabsContent value="files">
        <p className="text-sm text-muted-foreground">
          Attachments shared in this channel.
        </p>
      </TabsContent>
      <TabsContent value="members">
        <p className="text-sm text-muted-foreground">
          14 people and 3 agents can read this channel.
        </p>
      </TabsContent>
    </Tabs>
  );
}

export function WithDisabledTab() {
  return (
    <Tabs defaultValue="overview" className="w-[420px]">
      <TabsList>
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="activity">Activity</TabsTrigger>
        <TabsTrigger value="billing" disabled>
          Billing
        </TabsTrigger>
      </TabsList>
      <TabsContent value="overview">
        <p className="text-sm text-muted-foreground">
          Billing is disabled for self-hosted relays.
        </p>
      </TabsContent>
    </Tabs>
  );
}
