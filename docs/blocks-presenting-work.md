# Presenting work inside a conversation

Blocks are native, data-driven views inside channels and threads. Agents choose an active catalogue definition and fill its schema. Colony owns the layout, theme colors, interaction controls and validation. The Settings → Blocks catalogue shows the same primitive components as messages; the Examples tab provides real bundled media for inspection.

## Agent discovery

```sh
buzz blocks list
buzz blocks describe --handle question
```

`describe` resolves the active definition and returns its pinned manifest event ID, input schema, required and optional fields, examples, actions, permissions and invocation instructions. A caller may pin an explicit manifest. Use the returned schema rather than assuming every block accepts the same fields.

```sh
buzz blocks invoke --channel <channel-uuid> --handle question \
  --manifest <manifest-event-id> --data /path/to/question.json \
  --processor <agent-pubkey> --reply-to <current-message-event-id>
```

The data argument is a plain file path, without an `@` prefix. A signed interactive block needs a processor. Read-only blocks do not. The agent may change schema-exposed copy, options, rows, media descriptors and optional content. Instance data cannot create new buttons, remove required inputs, inject HTML/CSS/JavaScript or grant capabilities. Ordinary agents use the existing catalogue; creating or activating a custom definition is a separate human-authorized workflow.

## Choosing a view

| Need | View and behavior |
| --- | --- |
| One bounded decision | Question accepts single or multiple choices, descriptions and optional written input. The relay checks the answer against the posted instance. |
| Gather business context over several replies | Interview presents one question, its position and any already-known context. The owner replies in the thread or chooses “I don't know”; the agent records the answer and posts the next question. There is no automatic chat-to-form conversion. |
| Supporting facts | Details accepts a bounded list of labels and values. Empty optional facts are omitted. References can sit in a disclosure. |
| A company proposal | Company Blueprint groups proposed people, teams, costs, first work and gaps. Approval and change requests remain separate signed actions. |
| Several media files | Supply ordered `items` in Media. Image-only groups form a carousel; video, document and mixed groups show a selector and one active viewer. |
| A diagram | Use a fenced `mermaid` source block, or upload an `.mmd`/`.mermaid` source file and supply its returned descriptor to Media. |

Question and Interview have different lifecycles. A submitted choice is pending until its processor handles it and publishes a receipt. A button click is not proof that the requested business operation completed. A repeated Question inside a card list is unsupported; use separate instances so each signed response has one unambiguous target. External-data Questions cannot accept answers until their exact data can be verified by the relay; normal CLI invocations carry inline data.

## Files and diagrams

The viewing experience supports images and static SVG, audio, video, PDF, Excel and CSV. Users can expand, navigate and download originals. Editing, annotations and native maps are outside this release. Unsupported document types retain their existing workspace/download actions.

Media retains authored order, including repeated URLs and unavailable items. A collection remembers page, sheet, row and zoom state while switching documents, and pauses/releases the replaced player. It previews at most 24 attachments with a visible overflow notice. Plain Markdown attachments group only within a contiguous run in one paragraph; prose and spoiler boundaries are retained. Separate collections do not share a global playback coordinator.

Diagrams use the pinned Mermaid 11.17.2 library with fixed native colors and strict source validation. The current scope is flowcharts, sequences and entity relationships, up to 16 KiB of source, 200 lines and 150 edges. Source-provided styling/configuration, callbacks, links and embedded resources are unsupported. Oversized or invalid diagrams retain a readable source and download action. Expansion, Fit, zoom and SVG download use the same rendered content. Original SVG uploads continue through the existing static-artwork validator.

Definitions are immutable. The updated core catalogue adds new versions while retaining prior trusted digests for conversation history. New messages use the current catalogue head; older messages retain their pinned definition and content. Human-selected catalogue heads are not overwritten by an older bundled seed.

## Proof boundaries

The approved design reference is https://colony-block-design-review.ainativeventures.chatgpt.site. The native acceptance suite is `desktop/tests/e2e/approved-blocks-design.spec.ts`: it records every bundled manifest in light/dark channel/thread views and tests media and diagram navigation. Its signed events and native transport are mocked. GitHub CI, production promotion, packaged release, and authenticated runtime verification remain separate gates.
