import { Alert, AlertDescription, AlertTitle } from "buzz";

export function Default() {
  return (
    <Alert>
      <AlertTitle>Relay reconnected</AlertTitle>
      <AlertDescription>
        Messages sent while you were offline have been delivered. Nothing was
        lost.
      </AlertDescription>
    </Alert>
  );
}

export function Destructive() {
  return (
    <Alert variant="destructive">
      <AlertTitle>Signature verification failed</AlertTitle>
      <AlertDescription>
        Two events in this channel were signed by a key that is not in the
        member list. They have been hidden until an owner reviews them.
      </AlertDescription>
    </Alert>
  );
}

export function DescriptionOnly() {
  return (
    <Alert>
      <AlertDescription>
        This community is invite-only. Anyone with the link still needs an
        owner to approve them.
      </AlertDescription>
    </Alert>
  );
}
