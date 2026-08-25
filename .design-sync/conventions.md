## How to build with Colony

Colony is the design system behind a Nostr-based team communication app:
channels, threads, messages, members, relays, and AI agents that work alongside
people. Compositions should read like that product.

### Wrap everything in ColonyProvider

`ColonyProvider` must wrap any tree that uses these components. `Dialog` and
`Sheet` read the theme from its context and throw without it, and it also
installs the native-shell stub the components expect outside the desktop app.
Without it you get a blank page, not an error message.

```jsx
const { ColonyProvider, Button, Card, CardHeader, CardTitle } = window.ColonyDS;

ReactDOM.createRoot(document.getElementById("ds-root")).render(
  <ColonyProvider>
    <div className="bg-background text-foreground p-8">
      <Card className="max-w-md">
        <CardHeader>
          <CardTitle>#engineering</CardTitle>
        </CardHeader>
        <div className="px-6 pb-6">
          <p className="text-sm text-muted-foreground">
            14 members, 3 agents. Last message 6 minutes ago.
          </p>
          <Button className="mt-4">Open channel</Button>
        </div>
      </Card>
    </div>
  </ColonyProvider>,
);
```

### Important: the stylesheet is a fixed compiled set

`styles.css` is Tailwind output compiled from the Colony app's own source, not
a live Tailwind runtime. Only utilities the app already uses exist. Common ones
are all present (`flex`, `grid`, `gap-2`, `p-4`, `px-6`, `mt-4`, `w-full`,
`max-w-md`, `items-center`, `justify-between`, `rounded-2xl`, `text-lg`,
`font-semibold`), but off-the-beaten-path values are not: `min-h-screen`,
`space-y-4`, `gap-11` and `p-7` all resolve to nothing, silently. Stick to
ordinary values, and when you need something unusual use an inline `style`
rather than inventing a class that will not exist.

### The styling idiom: utilities on semantic tokens

Always reach for the semantic color token rather than a raw palette value
(`bg-muted`, never `bg-gray-100`). Tokens flip correctly between light and dark;
raw palette values do not.

| Family | Classes | Use for |
|---|---|---|
| Surfaces | `bg-background`, `bg-card`, `bg-popover`, `bg-muted`, `bg-sidebar` | Page, cards, floating surfaces, recessed areas, the left rail |
| Text | `text-foreground`, `text-muted-foreground`, `text-card-foreground`, `text-primary` | Body copy, secondary/meta copy, text on cards, emphasis |
| Accent | `bg-primary` + `text-primary-foreground`, `bg-secondary`, `bg-accent` | Primary actions, secondary actions, hover surfaces |
| Danger | `bg-destructive`, `text-destructive-foreground` | Destructive actions and error surfaces |
| Status | `text-warning`, `bg-warning-bg`, `text-status-added`, `text-status-deleted` | Warnings and diff/change indicators |
| Lines | `border-border`, `border-input`, `border-sidebar-border` | Dividers, field outlines, rail edges |

Radius follows `rounded-lg` / `rounded-md` / `rounded-sm`, all derived from a
single `--radius`. Both fonts ship: `font-sans` is Inter Variable, `font-mono`
is JetBrains Mono (use it for keys, ids, relay URLs, code).

### Text sizing: rem only, never px

The app scales type by changing the root font size, so hardcoded px text is
frozen against zoom. Use the stock rem scale (`text-base`, `text-sm`,
`text-xs`), plus these Colony additions for meta text: `text-2xs` (11px, the
workhorse for timestamps and count badges), `text-3xs` (8px glyphs),
`text-badge` (10px status badges) and `text-title` (40px page titles). Never
write `text-[13px]` or `text-[0.9rem]`.

### Component API vocabulary

The generated `.d.ts` files carry no variant information, so use this list.
Every value below is real.

- `Button` variant: `default`, `secondary`, `outline`, `ghost`, `link`,
  `destructive`. size: `default`, `sm`, `xs`, `lg`, `icon`, `icon-xs`.
- `Badge` variant: `default`, `secondary`, `outline`, `destructive`, `warning`,
  `success`, `info`. Badges are uppercase and letter-spaced by design, so keep
  labels to one or two words.
- `Alert` variant: `default`, `destructive`. Compose with `AlertTitle` and
  `AlertDescription`.
- `Toggle` variant: `default`, `outline`, on the same size scale as Button.
- `SheetContent` takes `side`: `top`, `right`, `bottom`, `left`.
- Compound components follow Radix naming: `Dialog` + `DialogTrigger` /
  `DialogContent` / `DialogHeader` / `DialogTitle` / `DialogDescription` /
  `DialogFooter`, and the same shape for `AlertDialog`, `DropdownMenu`,
  `ContextMenu`, `Popover`, `Tooltip`, `Tabs`, `Card`, `Avatar`, `Carousel`.
- `Tooltip` needs a `TooltipProvider` ancestor.
- `Avatar` needs `AvatarFallback` for initials; `AvatarImage` alone renders
  nothing if the src fails.

### Where the truth lives

Read these before styling anything unusual: `styles.css` and the files it
imports hold every token definition and the complete set of available
utilities, and each component's `.prompt.md` sits next to its `.d.ts` under
`components/general/<Name>/`. The stylesheet is authoritative; this file is a
summary of it.
