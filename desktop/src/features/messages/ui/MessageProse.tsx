import * as React from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

import { Markdown } from "@/shared/ui/markdown";
import type { MarkdownProps } from "@/shared/ui/markdown/types";
import { messageExcerpt } from "../lib/messageExcerpt";

// Presentation state only, bounded and in memory. Each pane remembers its own
// reading choice across virtualized row unmounts and opening/closing a thread.
const expandedMessages = new Set<string>();
const MAX_REMEMBERED_EXPANSIONS = 256;

type MessageProseProps = MarkdownProps & { scopeKey: string };

/** The original message, with an optional accessible long-prose disclosure. */
export function MessageProse(props: MessageProseProps) {
  // The thread pane reuses its head row when another root is selected. Reset
  // local state at that boundary while retaining each scope's remembered choice.
  return <ScopedMessageProse key={props.scopeKey} {...props} />;
}

function ScopedMessageProse({ scopeKey, ...props }: MessageProseProps) {
  const id = React.useId();
  const [expanded, setExpanded] = React.useState(() =>
    expandedMessages.has(scopeKey),
  );
  const excerpt = React.useMemo(
    () =>
      props.searchQuery || props.imetaByUrl?.size
        ? null
        : messageExcerpt(props.content),
    [props.content, props.imetaByUrl, props.searchQuery],
  );
  if (!excerpt) return <Markdown {...props} />;

  function toggleExpanded() {
    const next = !expanded;
    setExpanded(next);
    if (next) {
      expandedMessages.add(scopeKey);
      if (expandedMessages.size > MAX_REMEMBERED_EXPANSIONS) {
        const oldest = expandedMessages.values().next().value;
        if (oldest !== undefined) expandedMessages.delete(oldest);
      }
    } else {
      expandedMessages.delete(scopeKey);
    }
  }

  return (
    <div className="colony-message-prose">
      <div id={id}>
        <Markdown {...props} content={expanded ? props.content : excerpt} />
      </div>
      <button
        aria-controls={id}
        aria-expanded={expanded}
        className="colony-message-expand"
        onClick={toggleExpanded}
        type="button"
      >
        {expanded ? "Show less" : "Read full message"}
        {expanded ? (
          <ChevronUp aria-hidden className="size-3.5" />
        ) : (
          <ChevronDown aria-hidden className="size-3.5" />
        )}
      </button>
    </div>
  );
}
