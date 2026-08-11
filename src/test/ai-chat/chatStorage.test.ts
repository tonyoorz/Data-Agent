import { describe, expect, it } from "vitest";

import { actorScopedChatStorageKey } from "@/components/dashboard/chat/chatStorage";

describe("actor-scoped AI Chat storage", () => {
  it("fails closed when there is no authenticated actor", async () => {
    await expect(actorScopedChatStorageKey(null)).resolves.toBeNull();
    await expect(actorScopedChatStorageKey({ user: {} })).resolves.toBeNull();
  });

  it("derives a deterministic non-reversible namespace without token material", async () => {
    const first = await actorScopedChatStorageKey({
      user: { id: "actor-123" },
      access_token: "secret-token-one",
    });
    const repeated = await actorScopedChatStorageKey({
      user: { id: "actor-123" },
      access_token: "secret-token-two",
    });
    const other = await actorScopedChatStorageKey({ user: { id: "actor-456" } });

    expect(first).toBe(repeated);
    expect(first).not.toBe(other);
    expect(first).toMatch(/^dtsv\.chat\.v3\.[a-f0-9]{64}$/);
    expect(first).not.toContain("actor-123");
    expect(first).not.toContain("secret-token");
  });
});
