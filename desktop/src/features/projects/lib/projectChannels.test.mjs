import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  countChannelEmployees,
  formatEmployeeCount,
  partitionProjectChannels,
  primaryRepository,
  projectBranchLabel,
  projectForChannel,
  projectHeaderMeta,
  repositorySlug,
} from "./projectChannels.ts";

function channel(id, name = id) {
  return { id, name, channelType: "stream" };
}

function project(id, projectChannelId, overrides = {}) {
  return {
    id,
    dtag: id,
    name: id,
    projectChannelId,
    primaryRepositoryAddress: null,
    repositories: [],
    ...overrides,
  };
}

function repository(overrides = {}) {
  return {
    dtag: "colony",
    name: "colony",
    cloneUrls: [],
    defaultBranch: "main",
    repoAddress: "30617:owner:colony",
    ...overrides,
  };
}

describe("partitionProjectChannels", () => {
  it("splits channels a project claims from the rest", () => {
    const owned = channel("chan-1", "colony");
    const plain = channel("chan-2", "general");
    const { projectChannels, rest } = partitionProjectChannels(
      [owned, plain],
      [project("p1", "chan-1")],
    );

    assert.equal(projectChannels.length, 1);
    assert.equal(projectChannels[0].channel, owned);
    assert.equal(projectChannels[0].project.id, "p1");
    assert.deepEqual(rest, [plain]);
  });

  it("keeps every channel when no project claims one", () => {
    const { projectChannels, rest } = partitionProjectChannels(
      [channel("chan-1"), channel("chan-2")],
      [project("p1", null)],
    );

    assert.deepEqual(projectChannels, []);
    assert.equal(rest.length, 2);
  });

  it("tolerates missing channels and projects", () => {
    assert.deepEqual(partitionProjectChannels(undefined, undefined), {
      projectChannels: [],
      rest: [],
    });
  });

  it("gives a channel claimed twice to the first project", () => {
    const { projectChannels } = partitionProjectChannels(
      [channel("chan-1")],
      [project("first", "chan-1"), project("second", "chan-1")],
    );

    assert.equal(projectChannels[0].project.id, "first");
  });
});

describe("projectForChannel", () => {
  it("finds the owning project", () => {
    const found = projectForChannel(
      [project("p1", "chan-9"), project("p2", "chan-1")],
      "chan-1",
    );
    assert.equal(found?.id, "p2");
  });

  it("returns null for an unclaimed or missing channel id", () => {
    assert.equal(projectForChannel([project("p1", "chan-1")], "chan-2"), null);
    assert.equal(projectForChannel([project("p1", "chan-1")], null), null);
  });
});

describe("primaryRepository", () => {
  it("prefers the project's primary repository address", () => {
    const primary = repository({ repoAddress: "addr-b", dtag: "b" });
    const found = primaryRepository({ primaryRepositoryAddress: "addr-b" }, [
      repository({ repoAddress: "addr-a", dtag: "a" }),
      primary,
    ]);
    assert.equal(found, primary);
  });

  it("falls back to the first repository", () => {
    const first = repository({ repoAddress: "addr-a" });
    assert.equal(
      primaryRepository({ primaryRepositoryAddress: "missing" }, [first]),
      first,
    );
  });

  it("returns null without repositories", () => {
    assert.equal(
      primaryRepository({ primaryRepositoryAddress: null }, []),
      null,
    );
  });
});

describe("repositorySlug", () => {
  it("reads owner/repo from an https clone url", () => {
    assert.equal(
      repositorySlug(
        repository({
          cloneUrls: ["https://github.com/AI-Native-Ventures/Colony.git"],
        }),
      ),
      "AI-Native-Ventures/Colony",
    );
  });

  it("reads owner/repo from an scp-style ssh clone url", () => {
    assert.equal(
      repositorySlug(
        repository({ cloneUrls: ["git@github.com:block/buzz.git"] }),
      ),
      "block/buzz",
    );
  });

  it("falls back to the repository name for a relay-hosted repo", () => {
    assert.equal(
      repositorySlug(
        repository({
          name: "colony",
          cloneUrls: [`http://localhost:3000/git/${"a".repeat(64)}/colony`],
        }),
      ),
      "colony",
    );
  });

  it("falls back to the repository name without a clone url", () => {
    assert.equal(repositorySlug(repository({ name: "colony" })), "colony");
  });

  it("returns null without a repository", () => {
    assert.equal(repositorySlug(null), null);
  });
});

describe("formatEmployeeCount", () => {
  it("uses the singular for one employee", () => {
    assert.equal(formatEmployeeCount(1), "1 employee");
  });

  it("uses the plural for zero and many", () => {
    assert.equal(formatEmployeeCount(0), "0 employees");
    assert.equal(formatEmployeeCount(3), "3 employees");
  });
});

describe("projectHeaderMeta", () => {
  it("joins repo, branch and employees", () => {
    assert.equal(
      projectHeaderMeta(
        { primaryRepositoryAddress: "addr-a" },
        [
          repository({
            repoAddress: "addr-a",
            cloneUrls: ["https://github.com/AI-Native-Ventures/Colony.git"],
            defaultBranch: "develop",
          }),
        ],
        3,
      ),
      "AI-Native-Ventures/Colony · develop · 3 employees",
    );
  });

  it("defaults an empty branch to main", () => {
    assert.equal(
      projectHeaderMeta(
        { primaryRepositoryAddress: null },
        [repository({ name: "colony", defaultBranch: "" })],
        1,
      ),
      "colony · main · 1 employee",
    );
  });

  it("drops repo and branch when the project has no repository", () => {
    assert.equal(
      projectHeaderMeta({ primaryRepositoryAddress: null }, [], 0),
      "0 employees",
    );
  });
});

describe("projectBranchLabel", () => {
  it("returns the primary repository's default branch", () => {
    assert.equal(
      projectBranchLabel({ primaryRepositoryAddress: null }, [
        repository({ defaultBranch: "develop" }),
      ]),
      "develop",
    );
  });

  it("returns null without a repository", () => {
    assert.equal(
      projectBranchLabel({ primaryRepositoryAddress: null }, []),
      null,
    );
  });
});

describe("countChannelEmployees", () => {
  const known = new Set(["aa", "bb"]);

  it("counts members in the known agent baseline", () => {
    assert.equal(
      countChannelEmployees([{ pubkey: "AA" }, { pubkey: "cc" }], known),
      1,
    );
  });

  it("counts a member flagged as an agent outside the baseline", () => {
    assert.equal(
      countChannelEmployees([{ pubkey: "cc", isAgent: true }], known),
      1,
    );
  });

  it("counts nothing without members", () => {
    assert.equal(countChannelEmployees(undefined, known), 0);
    assert.equal(countChannelEmployees([{ pubkey: "cc" }], null), 0);
  });
});
