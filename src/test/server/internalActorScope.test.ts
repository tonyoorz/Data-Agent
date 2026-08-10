// @vitest-environment node
import { describe, expect, it } from "vitest";

import { withInternalActorScope } from "../../../server/internalActorScope.mjs";

describe("internal analytics actor scope", () => {
  it("adds one server-owned principal for the internal deployment", () => {
    const body = withInternalActorScope(
      { messages: [{ role: "user", content: "按 ECU 看缺陷" }] },
      {},
    );

    expect(body.actor).toMatchObject({
      actorId: "vizion-internal",
      scopeHash: expect.stringMatching(/^internal-[a-f0-9]{16}$/),
      scopes: {
        allowedObjectTypes: [
          "quality.defect",
          "testing.test_case",
          "testing.test_run",
          "requirements.aida_node",
        ],
      },
    });
  });

  it("uses environment scope settings without trusting browser overrides", () => {
    const body = withInternalActorScope(
      {
        actor: { actorId: "browser-user", scopeHash: "browser-scope", scopes: { allowedObjectTypes: ["*"] } },
      },
      {
        VIZION_INTERNAL_ACTOR_ID: "lan-agent",
        VIZION_INTERNAL_WORKSPACE_IDS: "workspace-a, workspace-b",
        VIZION_INTERNAL_TEAM_IDS: "team-a",
        VIZION_INTERNAL_ALLOWED_OBJECT_TYPES: "quality.defect,testing.test_run",
      },
    );

    expect(body.actor).toMatchObject({
      actorId: "lan-agent",
      scopes: {
        workspaceIds: ["workspace-a", "workspace-b"],
        teamIds: ["team-a"],
        allowedObjectTypes: ["quality.defect", "testing.test_run"],
      },
    });
    expect(body.actor.scopeHash).not.toBe("browser-scope");
  });
});
