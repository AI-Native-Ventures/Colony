import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { BlockCatalogCard } from "./BlockCatalogCard.tsx";

function catalogItem() {
  return {
    blockAddress: `30178:${"a".repeat(64)}:lead-card`,
    catalogEventId: "b".repeat(64),
    handle: "lead-card",
    manifestId: "c".repeat(64),
    name: "Lead Card",
    origin: "core",
    permissions: [
      { capability: "lead.read", constraints: { workspace: true } },
    ],
    preview: {
      name: "Tennant Group",
      summary: "A strong premium website prospect.",
    },
    publisherPubkey: "d".repeat(64),
    recentUsage: {
      complete: true,
      count: 4,
      lastUsedAt: 1_700_000_000,
    },
    status: "active",
    summary: "A company opportunity summary.",
    workshop: null,
    manifestRecord: {
      event: {
        id: "c".repeat(64),
        pubkey: "d".repeat(64),
        created_at: 1_700_000_000,
        kind: 40012,
        tags: [],
        content: "",
        sig: "e".repeat(128),
      },
      digest: "f".repeat(64),
      trust: "core",
      manifest: {
        schema: "ai-native-office.block-manifest/1",
        handle: "lead-card",
        version: "1.0.0",
        name: "Lead Card",
        description: "A company opportunity summary.",
        origin: "core",
        created_at: 1_700_000_000,
        input_schema: {},
        tree: {
          type: "card",
          title: "{{name}}",
          description: "{{summary}}",
          children: [
            {
              type: "actions",
              controls: [
                {
                  label: "Review evidence",
                  interaction: {
                    type: "signed",
                    action_id: "lead.review",
                    resolves_attention: false,
                  },
                },
              ],
            },
          ],
        },
        actions: [
          {
            id: "lead.review",
            label: "Review evidence",
            interaction: {
              type: "signed",
              action_id: "lead.review",
              resolves_attention: false,
            },
            permissions: [],
          },
        ],
        permissions: [
          { capability: "lead.read", constraints: { workspace: true } },
        ],
        fallback_template: "{{name}}",
        supported_clients: ["desktop"],
        primitive_versions: { card: 1, actions: 1 },
        examples: [],
        validation: { state: "tested", requires_attention: false },
      },
    },
  };
}

test("catalog card presents governance metadata without operational controls", () => {
  const html = renderToStaticMarkup(
    React.createElement(BlockCatalogCard, {
      item: catalogItem(),
      onSelect() {},
    }),
  );

  assert.match(html, /Lead Card/);
  assert.match(html, /@lead-card/);
  assert.match(html, /AI Native Office/);
  assert.match(html, /v1\.0\.0/);
  assert.match(html, /lead\.read/);
  assert.match(html, /desktop/);
  assert.match(html, /Review evidence/);
  assert.equal(html.match(/<button/g)?.length, 1);
  assert.doesNotMatch(html, />Create</);
  assert.doesNotMatch(html, />Edit</);
});

test("catalog card labels incomplete and unavailable usage honestly", () => {
  const partialHtml = renderToStaticMarkup(
    React.createElement(BlockCatalogCard, {
      item: {
        ...catalogItem(),
        recentUsage: {
          complete: false,
          count: 500,
          lastUsedAt: 1_700_000_000,
        },
      },
      onSelect() {},
    }),
  );
  assert.match(partialHtml, /At least 500 in recent sample/);
  assert.doesNotMatch(partialHtml, /500 in 30 days/);

  const unavailableHtml = renderToStaticMarkup(
    React.createElement(BlockCatalogCard, {
      item: {
        ...catalogItem(),
        recentUsage: {
          complete: false,
          count: null,
          lastUsedAt: null,
        },
      },
      onSelect() {},
    }),
  );
  assert.match(unavailableHtml, /Usage unavailable/);
});
