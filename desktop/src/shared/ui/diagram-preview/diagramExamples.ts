/** Illustrative processes, rendered by the same viewer as message diagrams. */
export const DIAGRAM_EXAMPLES = [
  {
    id: "flow",
    title: "From brief to published campaign",
    subtitle: "Parallel work, decisions, revisions and recovery",
    source:
      "flowchart TB\n    subgraph PLAN[Plan the campaign]\n      A([Client brief]) --> B[Confirm audience and goal]\n      B --> C{Brief complete?}\n      C -->|Missing facts| D[Ask owner in thread]\n      D --> B\n    end\n    subgraph CREATE[Create in parallel]\n      C -->|Yes| E[Write captions]\n      C -->|Yes| F[Design carousel]\n      C -->|Yes| G[Prepare video cut]\n      E --> H[Assemble review package]\n      F --> H\n      G --> H\n    end\n    subgraph REVIEW[Review with the owner]\n      H --> I{Owner decision}\n      I -->|Changes requested| J[Revise affected assets]\n      J --> H\n      I -->|Approved| K[Schedule approved version]\n    end\n    subgraph DELIVERY[Publish and report]\n      K --> L{Platform response}\n      L -->|Published| M[Save post URL and receipt]\n      L -->|Temporary failure| N[Retry within agreed policy]\n      N --> L\n      L -->|Needs attention| O[Ask owner to reconnect]\n      O --> K\n      M --> P([Report results in thread])\n    end",
    footer:
      "An example campaign process. Publishing integrations and retry policies shown here are illustrative.",
  },
  {
    id: "sequence",
    title: "A decision, from request to receipt",
    subtitle: "Who does what, and what happens when changes are requested",
    source:
      "sequenceDiagram\n    autonumber\n    actor Owner\n    participant Scout\n    participant Designer\n    participant Thread\n    Owner->>Scout: Prepare a campaign for review\n    Scout->>Designer: Create the carousel assets\n    Designer-->>Scout: Draft assets and notes\n    Scout->>Thread: Post draft and review choices\n    Thread-->>Owner: Show the draft inline\n    alt Changes requested\n      Owner->>Thread: Choose changes and add feedback\n      Thread->>Scout: Deliver the signed response\n      Scout->>Designer: Revise the selected assets\n      Designer-->>Scout: Return the next version\n      Scout->>Thread: Post revised draft with history\n    else Approved\n      Owner->>Thread: Approve this version\n      Thread->>Scout: Deliver the signed approval\n      Scout->>Thread: Record the confirmed outcome\n      Thread-->>Owner: Show the receipt\n    end",
    footer:
      "A sequence shows exchanges over time. A button click and a confirmed result are separate steps.",
  },
  {
    id: "er",
    title: "How a client delivery fits together",
    subtitle: "Relationships and quantities, beyond a simple flowchart",
    source:
      "erDiagram\n    CLIENT ||--o{ PROJECT : commissions\n    PROJECT ||--o{ THREAD : discusses\n    PROJECT ||--o{ DELIVERABLE : contains\n    DELIVERABLE ||--|{ VERSION : has\n    VERSION ||--o{ ASSET : includes\n    VERSION ||--o{ DECISION : receives\n    DECISION ||--o| RECEIPT : records\n    CLIENT {\n      string name\n      string contact\n    }\n    DELIVERABLE {\n      string title\n      string status\n    }\n    VERSION {\n      int number\n      string summary\n    }\n    ASSET {\n      string filename\n      string format\n    }\n    DECISION {\n      string outcome\n      string reviewer\n    }",
    footer:
      "Illustrative delivery model, not a claim about Colony’s database schema.",
  },
] as const;
