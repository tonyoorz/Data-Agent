// @vitest-environment node
import { describe, expect, it } from "vitest";

import { routeMainAgentIntent } from "../../../server/mainAgentIntentRouter.mjs";

describe("main agent intent router", () => {
  it("routes Chinese defect ID display requests to governed record retrieval", () => {
    expect(routeMainAgentIntent([
      { role: "user", content: "最近7天一些严重的defect，带着id展示" },
    ])).toMatchObject({
      intent: "record_query",
      policyHints: ["semantic_records_first"],
    });
  });
});