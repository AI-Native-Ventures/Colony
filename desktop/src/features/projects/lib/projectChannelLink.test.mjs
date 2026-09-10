import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { linkableProjects, withProjectChannel } from "./projectChannelLink.ts";

const CHANNEL_A = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const CHANNEL_B = "5b1e7c22-9d44-4a17-8b0e-1f2a3c4d5e6f";

describe("withProjectChannel", () => {
  it("appends the channel tag when the head has none", () => {
    assert.deepEqual(
      withProjectChannel(
        [
          ["d", "colony"],
          ["name", "Colony"],
        ],
        CHANNEL_A,
      ),
      [
        ["d", "colony"],
        ["name", "Colony"],
        ["buzz-channel", CHANNEL_A],
      ],
    );
  });

  it("replaces an existing channel tag in place", () => {
    assert.deepEqual(
      withProjectChannel(
        [
          ["d", "colony"],
          ["buzz-channel", CHANNEL_A],
          ["a", "30617:aa:colony"],
        ],
        CHANNEL_B,
      ),
      [
        ["d", "colony"],
        ["buzz-channel", CHANNEL_B],
        ["a", "30617:aa:colony"],
      ],
    );
  });

  it("removes the channel tag when unlinking", () => {
    assert.deepEqual(
      withProjectChannel(
        [
          ["d", "colony"],
          ["buzz-channel", CHANNEL_A],
          ["name", "Colony"],
        ],
        null,
      ),
      [
        ["d", "colony"],
        ["name", "Colony"],
      ],
    );
  });

  it("preserves unknown tags, relay hints and order", () => {
    const tags = [
      ["d", "colony"],
      ["future-tag", "keep", "me"],
      ["a", "30617:aa:colony", "wss://relay.example"],
      ["buzz-visibility", "unlisted"],
    ];
    assert.deepEqual(withProjectChannel(tags, CHANNEL_A), [
      ...tags,
      ["buzz-channel", CHANNEL_A],
    ]);
  });

  it("does not mutate the tags it is given", () => {
    const tags = [["buzz-channel", CHANNEL_A]];
    withProjectChannel(tags, CHANNEL_B);
    assert.deepEqual(tags, [["buzz-channel", CHANNEL_A]]);
  });

  it("collapses duplicate channel tags to one", () => {
    assert.deepEqual(
      withProjectChannel(
        [
          ["buzz-channel", CHANNEL_A],
          ["buzz-channel", CHANNEL_B],
        ],
        CHANNEL_B,
      ),
      [["buzz-channel", CHANNEL_B]],
    );
  });

  it("trims a padded channel id", () => {
    assert.deepEqual(withProjectChannel([], ` ${CHANNEL_A} `), [
      ["buzz-channel", CHANNEL_A],
    ]);
  });

  it("refuses an invalid channel id", () => {
    assert.throws(
      () => withProjectChannel([["d", "colony"]], "not-a-uuid"),
      /invalid/i,
    );
  });
});

describe("linkableProjects", () => {
  const owner = "AA".repeat(32);
  const other = "bb".repeat(32);

  function project(overrides) {
    return { owner, projectChannelId: null, ...overrides };
  }

  it("offers the user's projects that have no channel", () => {
    const free = project({ id: "free" });
    assert.deepEqual(linkableProjects([free], CHANNEL_A, owner.toLowerCase()), [
      free,
    ]);
  });

  it("offers a project already linked to this channel", () => {
    const linked = project({ id: "linked", projectChannelId: CHANNEL_A });
    assert.deepEqual(linkableProjects([linked], CHANNEL_A, owner), [linked]);
  });

  it("hides a project linked to another channel", () => {
    assert.deepEqual(
      linkableProjects(
        [project({ projectChannelId: CHANNEL_B })],
        CHANNEL_A,
        owner,
      ),
      [],
    );
  });

  it("hides projects owned by someone else", () => {
    assert.deepEqual(
      linkableProjects([project({ owner: other })], CHANNEL_A, owner),
      [],
    );
  });

  it("returns nothing without an identity or projects", () => {
    assert.deepEqual(linkableProjects([project({})], CHANNEL_A, null), []);
    assert.deepEqual(linkableProjects(undefined, CHANNEL_A, owner), []);
  });
});
