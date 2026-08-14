import { describe, expect, it, vi } from "vitest";

import {
  createTestCaseProposalRegistry,
  TestCaseProposalCapabilityError,
} from "../../../server/testCaseProposalRegistry.mjs";

const env = { VIZION_TESTCASE_PROPOSAL_SECRET: "test-secret-with-at-least-16-bytes" };
const actor = { scopeHash: "internal-user-a" };
const proposal = {
  proposalDigest: "proposal-digest-1",
  defectId: "D-7",
  name: "Server stored name",
  descriptionHtml: "<p>Server stored description</p>",
  stepsText: "- action\n- ? expected",
};

function createRegistry(nowRef = { value: 1_000 }) {
  return createTestCaseProposalRegistry({
    env,
    now: () => nowRef.value,
    ttlMs: 5_000,
    randomBytesImpl: () => Buffer.alloc(18, 7),
  });
}

async function expectCapabilityError(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject<TestCaseProposalCapabilityError>({ code });
}

describe("test case proposal capability registry", () => {
  it("commits only the server-stored proposal and caches an identical replay", async () => {
    const registry = createRegistry();
    const { capability } = registry.issue({ actor, proposal });
    const commitProposal = vi.fn(async (input) => ({ success: true, id: "T-42", input }));

    const first = await registry.commit({
      capability,
      actor,
      featureId: "F-2",
      ownerId: "U-3",
      commitProposal,
    });
    const replay = await registry.commit({
      capability,
      actor,
      featureId: "F-2",
      ownerId: "U-3",
      commitProposal,
    });

    expect(commitProposal).toHaveBeenCalledTimes(1);
    expect(commitProposal).toHaveBeenCalledWith({
      proposal,
      featureId: "F-2",
      ownerId: "U-3",
    });
    expect(first).toMatchObject({ success: true, id: "T-42", idempotentReplay: false });
    expect(replay).toMatchObject({ success: true, id: "T-42", idempotentReplay: true });
  });

  it("rejects a tampered capability", async () => {
    const registry = createRegistry();
    const { capability } = registry.issue({ actor, proposal });
    const tampered = `${capability.slice(0, -1)}${capability.endsWith("A") ? "B" : "A"}`;

    await expectCapabilityError(
      registry.commit({ capability: tampered, actor, commitProposal: vi.fn() }),
      "TESTCASE_PROPOSAL_CAPABILITY_INVALID",
    );
  });

  it("rejects use by a different actor", async () => {
    const registry = createRegistry();
    const { capability } = registry.issue({ actor, proposal });

    await expectCapabilityError(
      registry.commit({
        capability,
        actor: { scopeHash: "internal-user-b" },
        commitProposal: vi.fn(),
      }),
      "TESTCASE_PROPOSAL_ACTOR_MISMATCH",
    );
  });

  it("rejects expired capabilities", async () => {
    const nowRef = { value: 1_000 };
    const registry = createRegistry(nowRef);
    const { capability } = registry.issue({ actor, proposal });
    nowRef.value = 6_001;

    await expectCapabilityError(
      registry.commit({ capability, actor, commitProposal: vi.fn() }),
      "TESTCASE_PROPOSAL_CAPABILITY_EXPIRED",
    );
  });

  it("rejects replay with changed human-approved fields", async () => {
    const registry = createRegistry();
    const { capability } = registry.issue({ actor, proposal });
    await registry.commit({
      capability,
      actor,
      featureId: "F-1",
      ownerId: "U-1",
      commitProposal: async () => ({ success: true }),
    });

    await expectCapabilityError(
      registry.commit({
        capability,
        actor,
        featureId: "F-9",
        ownerId: "U-1",
        commitProposal: vi.fn(),
      }),
      "TESTCASE_PROPOSAL_CAPABILITY_ALREADY_USED",
    );
  });

  it("blocks concurrent commits and allows retry after bridge failure", async () => {
    const registry = createRegistry();
    const { capability } = registry.issue({ actor, proposal });
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const firstCommit = registry.commit({
      capability,
      actor,
      commitProposal: async () => {
        await waiting;
        throw new Error("bridge failed");
      },
    });

    await expectCapabilityError(
      registry.commit({ capability, actor, commitProposal: vi.fn() }),
      "TESTCASE_PROPOSAL_COMMIT_IN_PROGRESS",
    );
    release();
    await expect(firstCommit).rejects.toThrow("bridge failed");

    await expect(registry.commit({
      capability,
      actor,
      commitProposal: async () => ({ success: true, id: "T-retry" }),
    })).resolves.toMatchObject({ success: true, id: "T-retry" });
  });
});
