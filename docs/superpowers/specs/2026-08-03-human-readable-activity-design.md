# Human-Readable Activity Feed

**Status:** Design source captured 2026-08-03. Not yet implemented.

## Problem

The Activity panel renders ACP transport detail at full weight, so a turn reads
as developer logs:

```
Ran  ls ~/.bun/bin/bun 2>&1; which -a bun n…        0.9s
Ran  export PATH="$HOME/.bun/bin:$PATH…             0.9s
Ran  5 tool calls
```

The panel already produces good prose in the same turn ("Site read. Now posting
the read-out.", the SalesTeams.ai read-out). The defect is ranking and
phrasing, not missing data: shell plumbing sits beside the agent's reasoning at
equal visual weight, so neither reads well.

## Source of the pattern

`ACTIVITY-DESIGN.html` in the Company-Agents-3 archive
(`~/Desktop/Billion/_company-agents-archive-2026-08-01/Company-Agents-3-all-branches.bundle`,
repository root). That design solved this problem for the same owner and is the
reference; it also benchmarks against Paperclip's Activity page.

Its two load-bearing ideas:

### 1. A live-work strip above the timeline

One card per agent currently working. Each card carries: the agent's face and
role, **the latest event phrased as a last action**, a live running clock, the
run cost, and the work unit. Status is an edge colour: green for active with a
pulsing "working", blue for done, red for failed or cancelled. A bounded recent
tail keeps what just finished and what broke visible.

Honest absence is specified: when the feed is empty or unavailable, the strip
degrades to a calm "No runs yet" and the timeline below still stands. Nothing
faked.

### 2. Timeline rows are sentences

Every row reads actor + verb + object:

- "Quinn moved CA-318 Rebuild STNB landing to in review"
- "Engine recorded a gate verdict on CA-312"
- "You approved CA-300"

with an actor avatar, a type chip, a relative timestamp, and day headers.

## What to build here

Colony already has most of the machinery:

| Piece | Where |
|---|---|
| Tool-to-verb mapping ("Read", "Write") | `desktop/src/features/agents/ui/agentSessionToolClassifier.ts` |
| Chain-of-thought rendering | `activityRenderClasses/ThoughtActivity.tsx` |
| Collapsible tool rows | `activityRenderClasses/ToolActivity.tsx`, `ActivityRow.tsx` |
| Turn grouping | `agentSessionTranscriptGrouping.ts` |

Three changes, in order:

1. **Phrase shell commands as intent.** Extend the classifier to parse a shell
   command's head verb and target: `ls ~/.bun/bin/bun` becomes "Looked for bun";
   `export PATH=…` and `which -a` are environment plumbing and fold into the
   existing "Ran N tool calls" collapse rather than earning their own rows.
2. **Rank by interest.** Agent prose and thoughts at full weight; each tool call
   one collapsed line; plumbing summarised. The raw command stays available
   behind the expander that already exists.
3. **Keep failures loud.** A failed tool keeps its raw output inline. The detail
   is exactly what is wanted at the moment something breaks.

## Acceptance gate

Rendered, not asserted. Capture the Activity panel mid-turn for a real agent run
and read it as a person would: every row is a sentence, no row is a raw shell
line unless it failed, and the agent's reasoning is the most prominent thing on
the panel. Screenshot before and after in the PR.
