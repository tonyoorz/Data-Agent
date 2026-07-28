import { describe, expect, it } from "vitest";

import { MAIN_AGENT_TOOLS } from "../../../server/mainAgentTools.mjs";
import {
  createMainAgentToolRegistry,
  selectMainAgentToolset,
  shouldPlanMainAgentTools,
} from "../../../server/mainAgentToolRegistry.mjs";

describe("main agent tool registry", () => {
  it("derives compact toolsets from tool metadata", () => {
    const registry = createMainAgentToolRegistry(MAIN_AGENT_TOOLS);
    const selected = registry.selectToolset([{ role: "user", content: "Octane defect 字段能不能更新？能不能删除缺陷单？" }]);

    expect(selected.intent).toBe("action_capability");
    expect(selected.toolNames).toEqual(["get_ontology_catalog", "search_octane_fields", "ask_clarification"]);
    expect(selected.tools.map((tool) => tool.function.name)).toEqual(selected.toolNames);
    expect(registry.validateToolCall({ function: { name: "query_analytics" } }, selected)).toEqual(
      expect.objectContaining({ allowed: false, reason: expect.stringContaining("not allowed") }),
    );
  });

  it("uses one routing source for planning trigger and selected intent", () => {
    const messages = [{ role: "user", content: "DTSV 当前风险怎么看？" }];

    expect(shouldPlanMainAgentTools(messages)).toBe(true);
    expect(selectMainAgentToolset(messages).intent).toBe("general");
  });
});
