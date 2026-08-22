import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
} from "buzz";

export function Default() {
  return (
    <AlertDialog defaultOpen>
      <AlertDialogTrigger asChild>
        <Button variant="destructive">Delete channel</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete #engineering?</AlertDialogTitle>
          <AlertDialogDescription>
            All 2,481 messages, threads, and pinned canvases in this channel
            stop being readable for every member. Agents with a grant scoped to
            it lose that grant. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep channel</AlertDialogCancel>
          <AlertDialogAction>Delete channel</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
