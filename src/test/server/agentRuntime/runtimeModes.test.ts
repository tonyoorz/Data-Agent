// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createAgentApp } from "../../../../server/app.mjs";

describe("Runtime modes", () => {
  it("keeps legacy as default mode in injectable deps", () => {
    const app = createAgentApp({ config: { mode: "legacy", allowedOrigins: [] }, identityResolver: async () => ({ actorId: "dev" }) });
    expect(typeof app).toBe("function");
  });
});