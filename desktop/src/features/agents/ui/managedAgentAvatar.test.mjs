import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveManagedAgentAvatarUrl,
  resolveRemoteManagedAgentAvatarUrl,
} from "./managedAgentAvatar.ts";

test("resolveManagedAgentAvatarUrl uploads data image URIs", async () => {
  const uploaded = await resolveManagedAgentAvatarUrl(
    "data:image/png;base64,aGVsbG8=",
    async (bytes) => {
      assert.deepEqual(bytes, [104, 101, 108, 108, 111]);
      return {
        url: "https://relay.example/avatar.png",
        sha256: "hash",
        size: bytes.length,
        type: "image/png",
        uploaded: 1,
      };
    },
  );

  assert.equal(uploaded, "https://relay.example/avatar.png");
});

test("resolveManagedAgentAvatarUrl passes emoji svg data URLs through", async () => {
  const emojiUrl =
    "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3C%2Fsvg%3E";
  const uploaded = await resolveManagedAgentAvatarUrl(emojiUrl, async () => {
    throw new Error("should not upload inline emoji svg data URLs");
  });

  assert.equal(uploaded, emojiUrl);
});

test("resolveManagedAgentAvatarUrl passes non-data URLs through", async () => {
  const uploaded = await resolveManagedAgentAvatarUrl(
    " https://relay.example/already-hosted.png ",
    async () => {
      throw new Error("should not upload hosted avatars");
    },
  );

  assert.equal(uploaded, "https://relay.example/already-hosted.png");
});

test("resolveManagedAgentAvatarUrl omits invalid data image URIs", async () => {
  const uploaded = await resolveManagedAgentAvatarUrl(
    "data:image/png;base64,",
    async () => {
      throw new Error("should not upload invalid data URIs");
    },
  );

  assert.equal(uploaded, undefined);
});

test("resolveManagedAgentAvatarUrl uses safe fallback when data image upload fails", async () => {
  const uploaded = await resolveManagedAgentAvatarUrl(
    "data:image/png;base64,YQ==",
    async () => {
      throw new Error("upload failed");
    },
    "app-avatar://goose",
  );

  assert.equal(uploaded, "app-avatar://goose");
});

test("resolveManagedAgentAvatarUrl ignores data URI fallbacks", async () => {
  const uploaded = await resolveManagedAgentAvatarUrl(
    "data:image/png;base64,YQ==",
    async () => {
      throw new Error("upload failed");
    },
    "data:image/png;base64,Yg==",
  );

  assert.equal(uploaded, undefined);
});

const EMOJI_SVG_URL =
  "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22512%22%20height%3D%22512%22%3E%3C%2Fsvg%3E";

test("resolveRemoteManagedAgentAvatarUrl rasterizes and uploads emoji svg data URLs", async () => {
  const uploaded = await resolveRemoteManagedAgentAvatarUrl(
    EMOJI_SVG_URL,
    async (bytes, filename) => {
      assert.deepEqual(bytes, [1, 2, 3]);
      assert.equal(filename, "avatar.png");
      return {
        url: "https://relay.example/emoji.png",
        sha256: "hash",
        size: bytes.length,
        type: "image/png",
        uploaded: 1,
      };
    },
    undefined,
    async (svgDataUrl) => {
      assert.equal(svgDataUrl, EMOJI_SVG_URL);
      return [1, 2, 3];
    },
  );

  assert.equal(uploaded, "https://relay.example/emoji.png");
});

test("resolveRemoteManagedAgentAvatarUrl omits the avatar when rasterization fails", async () => {
  const uploaded = await resolveRemoteManagedAgentAvatarUrl(
    EMOJI_SVG_URL,
    async () => {
      throw new Error("should not upload when rasterization failed");
    },
    "app-avatar://goose",
    async () => {
      throw new Error("rasterization failed");
    },
  );

  assert.equal(uploaded, undefined);
});

test("resolveRemoteManagedAgentAvatarUrl keeps https fallbacks when rasterization fails", async () => {
  const uploaded = await resolveRemoteManagedAgentAvatarUrl(
    EMOJI_SVG_URL,
    async () => {
      throw new Error("should not upload when rasterization failed");
    },
    "https://relay.example/runtime.png",
    async () => {
      throw new Error("rasterization failed");
    },
  );

  assert.equal(uploaded, "https://relay.example/runtime.png");
});

test("resolveRemoteManagedAgentAvatarUrl passes https URLs through untouched", async () => {
  const uploaded = await resolveRemoteManagedAgentAvatarUrl(
    "https://relay.example/hosted.png",
    async () => {
      throw new Error("should not upload hosted avatars");
    },
    undefined,
    async () => {
      throw new Error("should not rasterize hosted avatars");
    },
  );

  assert.equal(uploaded, "https://relay.example/hosted.png");
});

test("resolveRemoteManagedAgentAvatarUrl drops non-http schemes like app-avatar://", async () => {
  const uploaded = await resolveRemoteManagedAgentAvatarUrl(
    "app-avatar://goose",
    async () => {
      throw new Error("should not upload app avatars");
    },
    undefined,
    async () => {
      throw new Error("should not rasterize app avatars");
    },
  );

  assert.equal(uploaded, undefined);
});

test("resolveRemoteManagedAgentAvatarUrl uploads base64 data URIs via the base resolver", async () => {
  const uploads = [];
  const uploaded = await resolveRemoteManagedAgentAvatarUrl(
    "data:image/png;base64,aGVsbG8=",
    async (bytes, filename) => {
      uploads.push(filename);
      return {
        url: "https://relay.example/base64.png",
        sha256: "hash",
        size: bytes.length,
        type: "image/png",
        uploaded: 1,
      };
    },
    undefined,
    async () => {
      throw new Error("base64 uploads should not need rasterization");
    },
  );

  assert.equal(uploaded, "https://relay.example/base64.png");
  assert.equal(uploads.length, 1);
});
