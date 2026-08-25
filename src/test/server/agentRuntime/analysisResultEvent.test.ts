import { describe, expect, it } from "vitest";

import { buildAnalysisResultEvent } from "../../../../server/agentRuntime/langGraphChatRuntime.mjs";
import { createGovernedAnalysisPlanner } from "../../../../server/ontology/analysisPlanner.mjs";
import { createQueryPlanner } from "../../../../server/ontology/queryPlanner.mjs";
import { createOntologyRegistry } from "../../../../server/ontology/registry.mjs";
import { createSemanticResolver } from "../../../../server/ontology/resolver.mjs";

// buildAnalysisResultEvent (task 29) projects a governed semantic tool payload
// into a structured analysis-result event so the front end can render a chart
// matched to analysisPlanner.visualization. These tests pin the projection:
// derived visualization when no plan is present, plan-visualization priority,
// row capping at the plan budget, tool filtering (semantic only), and graceful
// handling of malformed tool messages.

const registry = createOntologyRegistry();
const NOW = "2026-08-10T08:00:00.000Z";
const actor = {
  actorId: "alice",
  scopeHash: "scope-a",
  scopes: { workspaceIds: ["DTSV"], teamIds: ["DTSV"] },
};

function semanticToolMessage(result: Record<string, unknown>) {
  return {
    role: "tool",
    content: JSON.stringify({ ok: true, tool: "query_semantic_metrics", result }),
  };
}

function governedPlanFor(query = "缺陷总数") {
  const resolver = createSemanticResolver({ registry, now: () => NOW });
  const frame = resolver.resolve({ query, actor, requestAnchorAt: NOW });
  const queryPlan = createQueryPlanner({ registry }).createPlan({ frame, actor, query });
  return createGovernedAnalysisPlanner({ registry }).createPlan({ frame, queryPlan });
}

describe("buildAnalysisResultEvent", () => {
  it("derives a table visualization from multi-row payload and projects columns + metrics", () => {
    const ctx = {
      toolMessages: [
        semanticToolMessage({
          ontologyVersion: "v1",
          schemaFingerprint: "f".repeat(64),
          analysisRef: "analysis-abc",
          sourceRevision: { revisionId: "snap-1" },
          data: [
            { "product.ecu": "HU", "defect.count": 3 },
            { "product.ecu": "ADAS", "defect.count": 5 },
          ],
          summary: { metrics: { "defect.count": 8 } },
        }),
      ],
    };
    const event = buildAnalysisResultEvent(ctx, null);
    expect(event).not.toBeNull();
    expect(event?.type).toBe("analysis-result");
    expect(event?.visualization).toBe("table");
    expect(event?.rows).toHaveLength(2);
    expect(event?.columns.map((c) => c.id)).toEqual(["product.ecu", "defect.count"]);
    expect(event?.metrics).toEqual({ "defect.count": 8 });
    expect(event?.analysisRef).toBe("analysis-abc");
    expect(event?.sourceRevisionId).toBe("snap-1");
  });

  it("falls back to kpi when only summary metrics are present", () => {
    const ctx = {
      toolMessages: [
        semanticToolMessage({ ontologyVersion: "v1", data: [], summary: { metrics: { "defect.count": 42 } } }),
      ],
    };
    const event = buildAnalysisResultEvent(ctx, null);
    expect(event?.visualization).toBe("kpi");
    expect(event?.metrics).toEqual({ "defect.count": 42 });
    expect(event?.rows).toEqual([]);
  });

  it("returns null when the governed semantic tool produced neither rows nor metrics", () => {
    const ctx = {
      toolMessages: [semanticToolMessage({ ontologyVersion: "v1", data: [], summary: {} })],
    };
    expect(buildAnalysisResultEvent(ctx, null)).toBeNull();
  });

  it("ignores non-semantic tool payloads", () => {
    const ctx = {
      toolMessages: [
        {
          role: "tool",
          content: JSON.stringify({ ok: true, tool: "query_analytics", result: { data: [{ x: 1 }] } }),
        },
      ],
    };
    expect(buildAnalysisResultEvent(ctx, null)).toBeNull();
  });

  it("prefers the governed plan visualization over the derived one and echoes the plan id", () => {
    const plan = governedPlanFor();
    const analyticsContext = { analysisPlan: plan };
    const ctx = {
      toolMessages: [
        semanticToolMessage({
          ontologyVersion: plan.ontologyVersion,
          schemaFingerprint: plan.schemaFingerprint,
          data: [{ "product.ecu": "HU", "defect.count": 3 }],
          summary: { metrics: { "defect.count": 3 } },
        }),
      ],
    };
    const event = buildAnalysisResultEvent(ctx, analyticsContext);
    expect(event).not.toBeNull();
    expect(event?.visualization).toBe(plan.visualization);
    expect(event?.analysisPlanId).toBe(plan.analysisPlanId);
  });

  it("caps rows at the plan maxRows budget", () => {
    const plan = governedPlanFor();
    const analyticsContext = { analysisPlan: plan };
    const many = Array.from({ length: 500 }, (_, i) => ({ "product.ecu": `E${i}`, "defect.count": i }));
    const ctx = {
      toolMessages: [
        semanticToolMessage({ ontologyVersion: plan.ontologyVersion, data: many, summary: { metrics: {} } }),
      ],
    };
    const event = buildAnalysisResultEvent(ctx, analyticsContext);
    expect(event?.rows.length).toBeLessThanOrEqual(plan.maxRows);
  });

  it("skips malformed tool message content and still projects the next valid semantic payload", () => {
    const ctx = {
      toolMessages: [
        { role: "tool", content: "not-json" },
        semanticToolMessage({
          ontologyVersion: "v1",
          data: [{ "product.ecu": "HU", "defect.count": 3 }],
          summary: { metrics: { "defect.count": 3 } },
        }),
      ],
    };
    const event = buildAnalysisResultEvent(ctx, null);
    expect(event).not.toBeNull();
    expect(event?.rows).toHaveLength(1);
  });
});
