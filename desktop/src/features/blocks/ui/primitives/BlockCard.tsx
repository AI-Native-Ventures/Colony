import type { ReactNode } from "react";

import { cn } from "@/shared/lib/cn";
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentTitle,
} from "@/shared/ui/attachment";

import { resolveCard } from "./resolvers";
import type { BlockCardNode } from "./types";

export function BlockCard({
  children,
  className,
  data,
  node,
  rootData,
}: {
  children?: ReactNode;
  className?: string;
  data: unknown;
  node: BlockCardNode;
  rootData?: unknown;
}) {
  const card = resolveCard(node, data, rootData);
  return (
    <Attachment
      className={cn(
        "w-full min-w-0 border-border bg-card text-card-foreground shadow-none",
        className,
      )}
      data-block-primitive="card"
      orientation="vertical"
    >
      {(card.title || card.description) && (
        <AttachmentContent className="w-full">
          {card.title ? (
            <AttachmentTitle className="whitespace-normal break-words">
              {card.title}
            </AttachmentTitle>
          ) : null}
          {card.description ? (
            <AttachmentDescription className="whitespace-pre-wrap break-words text-muted-foreground">
              {card.description}
            </AttachmentDescription>
          ) : null}
        </AttachmentContent>
      )}
      {children ? <div className="w-full space-y-3">{children}</div> : null}
    </Attachment>
  );
}
