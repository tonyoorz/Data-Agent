import { describe, expect, it, vi } from "vitest";

import {
  buildCatalogBackedAnalyticsRetry,
  buildGovernedSemanticPlanRetry,
  classifyToolFailure,
  executeToolWithRecovery,
} from "../../../server/mainAgentToolRecovery.mjs";

const toolCall = {
  id: "recovery-call-1",
  type: "function",
  function: { name: "query_analytics", arguments: "{}" },
};

const successfulResult = {
  toolMessage: {
    role: "tool",
    tool_call_id: "recovery-call-1",
    name: "query_analytics",
    content: JSON.stringify({ ok: true, tool: "query_analytics", result: { rows: [{ defect_count: 3 }] } }),
  },
  contextText: "# Main agent tool result\nTool: query_analytics\nAggregate rows: 1",
};

describe("main agent tool recovery", () => {
  it("classifies transient, policy, empty, and schema failures without broadening authority", () => {
    expect(classifyToolFailure({ toolName: "query_semantic_metrics", statusCode: 429 })).toEqual({
      action: "retry",
      retryable: true,
      maxAttempts: 2,
      reason: "transient_read_failure",
    });
    expect(classifyToolFailure({ toolName: "query_semantic_metrics", code: "SEMANTIC_SCOPE_FILTER_DENIED", statusCode: 403 })).toEqual({
      action: "deny",
      retryable: false,
      maxAttempts: 1,
      reason: "policy_or_scope_denied",
    });
    expect(classifyToolFailure({ toolName: "query_analytics", code: "EMPTY_RESULT" })).toEqual({
      action: "diagnose",
      retryable: false,
      maxAttempts: 1,
      reason: "empty_analytics_result",
    });
    expect(classifyToolFailure({ toolName: "query_semantic_metrics", code: "SEMANTIC_DIMENSION_NOT_ALLOWED", statusCode: 400 })).toEqual({
      action: "catalog",
      retryable: false,
      maxAttempts: 1,
      reason: "schema_or_value_mismatch",
    });
    expect(classifyToolFailure({ toolName: "query_semantic_metrics", code: "ONTOLOGY_METRIC_NOT_APPROVED", statusCode: 400 })).toEqual({
      action: "catalog",
      retryable: false,
      maxAttempts: 1,
      reason: "schema_or_value_mismatch",
    });
  });

  it("retries one transient read failure and records a recovered outcome", async () => {
    const executeToolCall = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("upstream unavailable"), { statusCode: 503, retryable: true }))
      .mockResolvedValueOnce(successfulResult);
    const waitForRetry = vi.fn().mockResolvedValue(undefined);

    const execution = await executeToolWithRecovery({
      toolCall,
      executeToolCall,
      toolDependencies: { marker: "dependency" },
      waitForRetry,
      random: () => 0,
    });

    expect(executeToolCall).toHaveBeenCalledTimes(2);
    expect(executeToolCall).toHaveBeenNthCalledWith(1, toolCall, { marker: "dependency" });
    expect(waitForRetry).toHaveBeenCalledWith(50);
    expect(execution.result).toBe(successfulResult);
    expect(execution.recovery).toEqual(expect.objectContaining({
      action: "retry",
      retryable: true,
      maxAttempts: 2,
      reason: "transient_read_failure",
      attempts: 2,
      outcome: "recovered",
      queryFingerprint: expect.stringMatching(/^[a-f0-9]{24}$/),
    }));
  });

  it("does not retry a backend scope denial or expose the raw failure", async () => {
    const executeToolCall = vi.fn().mockRejectedValue(
      Object.assign(new Error("ACTOR_CAPABILITY_SCOPE_DENIED"), { code: "ACTOR_CAPABILITY_SCOPE_DENIED", statusCode: 403 }),
    );
    const waitForRetry = vi.fn();

    const execution = await executeToolWithRecovery({
      toolCall,
      executeToolCall,
      waitForRetry,
    });

    expect(executeToolCall).toHaveBeenCalledTimes(1);
    expect(waitForRetry).not.toHaveBeenCalled();
    expect(execution.recovery).toEqual(expect.objectContaining({
      action: "deny",
      attempts: 1,
      outcome: "denied",
    }));
    expect(execution.result.toolMessage.content).toContain("TOOL_ACCESS_DENIED");
    expect(execution.result.contextText).not.toContain("ACTOR_CAPABILITY_SCOPE_DENIED");
  });

  it("does not retry text-only access denials or unclassified future action tools", () => {
    expect(classifyToolFailure({
      toolName: "query_analytics",
      statusCode: 503,
      retryable: true,
      message: "ACTOR_CAPABILITY_SCOPE_DENIED HTTP 503",
    })).toEqual({
      action: "deny",
      retryable: false,
      maxAttempts: 1,
      reason: "policy_or_scope_denied",
    });
    expect(classifyToolFailure({
      toolName: "approve_change",
      statusCode: 503,
      retryable: true,
    })).toEqual({
      action: "stop",
      retryable: false,
      maxAttempts: 1,
      reason: "non_retryable_failure",
    });
  });

  it("retries a structured HTTP failure result from legacy tool adapters", async () => {
    const executeToolCall = vi
      .fn()
      .mockResolvedValueOnce({
        toolMessage: {
          role: "tool",
          tool_call_id: "recovery-call-1",
          name: "query_analytics",
          content: JSON.stringify({ ok: false, tool: "query_analytics", failure: { statusCode: 503 } }),
        },
        contextText: "# Main agent tool result\nResult: unavailable",
      })
      .mockResolvedValueOnce(successfulResult);

    const execution = await executeToolWithRecovery({
      toolCall,
      executeToolCall,
      waitForRetry: vi.fn().mockResolvedValue(undefined),
    });

    expect(executeToolCall).toHaveBeenCalledTimes(2);
    expect(execution.recovery).toEqual(expect.objectContaining({ action: "retry", outcome: "recovered" }));
  });

  it("classifies a real adapter failure envelope as one catalog recovery stop", async () => {
    const execution = await executeToolWithRecovery({
      toolCall,
      executeToolCall: vi.fn().mockResolvedValue({
        toolMessage: {
          role: "tool",
          tool_call_id: "recovery-call-1",
          name: "query_analytics",
          content: JSON.stringify({
            ok: false,
            tool: "query_analytics",
            failure: { code: "AGENT_ANALYTICS_SCHEMA_INVALID", statusCode: 400 },
          }),
        },
        contextText: "# Main agent tool result\nResult: unavailable",
      }),
    });

    expect(execution.recovery).toEqual(expect.objectContaining({
      action: "catalog",
      retryable: false,
      maxAttempts: 1,
      reason: "schema_or_value_mismatch",
      attempts: 1,
      outcome: "stopped",
      queryFingerprint: expect.stringMatching(/^[a-f0-9]{24}$/),
    }));
  });

  it("builds one corrected analytics retry only from a verified detected-by alias diagnosis", () => {
    const originalToolCall = {
      id: "alias-source",
      type: "function",
      function: {
        name: "query_analytics",
        arguments: JSON.stringify({
          dataset: "defects",
          intent: "aggregate",
          metrics: ["defect_count"],
          dimensions: [],
          filters: { years: ["2026"], detected_by: ["Size Li"], problem_finder_teams: ["DTSV_China"] },
          time: { field: "creation_time", current: ["2026-01-01", "2026-12-31"], timezone: "Asia/Shanghai" },
          limit: 20,
        }),
      },
    };
    const diagnosisToolCall = { id: "alias-diagnosis", type: "function", function: { name: "diagnose_analytics_empty", arguments: "{}" } };
    const diagnosisResult = {
      toolMessage: {
        role: "tool",
        tool_call_id: "alias-diagnosis",
        name: "diagnose_analytics_empty",
        content: JSON.stringify({
          ok: true,
          tool: "diagnose_analytics_empty",
          result: {
            causeCode: "FILTER_VALUE_ALIAS",
            retryQuery: {
              dataset: "defects",
              intent: "aggregate",
              metrics: ["defect_count"],
              dimensions: [],
              filters: { years: ["2026"], detected_by: ["Li Size"], problem_finder_teams: ["DTSV_China"] },
              time: { field: "creation_time", current: ["2026-01-01", "2026-12-31"], timezone: "Asia/Shanghai" },
              limit: 20,
            },
            candidateValues: [{ field: "detected_by", value: "Li Size", count: 12 }],
          },
        }),
      },
    };

    const correction = buildCatalogBackedAnalyticsRetry({ originalToolCall, diagnosisToolCall, diagnosisResult });

    expect(correction).toEqual(expect.objectContaining({
      toolCall: expect.objectContaining({
        id: "alias-source-catalog-retry",
        function: expect.objectContaining({ name: "query_analytics" }),
      }),
      recovery: expect.objectContaining({
        action: "catalog",
        reason: "filter_value_alias",
        sourceToolCallId: "alias-source",
        diagnosisToolCallId: "alias-diagnosis",
        originalQueryFingerprint: expect.stringMatching(/^[a-f0-9]{24}$/),
        revisedQueryFingerprint: expect.stringMatching(/^[a-f0-9]{24}$/),
      }),
    }));
    expect(JSON.parse(correction.toolCall.function.arguments)).toEqual(expect.objectContaining({
      filters: { years: ["2026"], detected_by: ["Li Size"], problem_finder_teams: ["DTSV_China"] },
    }));
  });

  it("refuses catalog recovery when the diagnosis would relax a filter", () => {
    const originalToolCall = {
      id: "relaxed-source",
      type: "function",
      function: { name: "query_analytics", arguments: JSON.stringify({ dataset: "defects", filters: { years: ["2026"], detected_by: ["Size Li"] } }) },
    };
    const diagnosisToolCall = { id: "relaxed-diagnosis", type: "function", function: { name: "diagnose_analytics_empty", arguments: "{}" } };
    const diagnosisResult = {
      toolMessage: {
        role: "tool",
        tool_call_id: "relaxed-diagnosis",
        name: "diagnose_analytics_empty",
        content: JSON.stringify({
          ok: true,
          tool: "diagnose_analytics_empty",
          result: {
            causeCode: "FILTER_TOO_RESTRICTIVE",
            retryQuery: { dataset: "defects", filters: { years: ["2026"] } },
            candidateValues: [],
          },
        }),
      },
    };

    expect(buildCatalogBackedAnalyticsRetry({ originalToolCall, diagnosisToolCall, diagnosisResult })).toBeNull();
  });

  it("builds one semantic retry from a unique scope-bound canonical plan step", () => {
    const originalToolCall = {
      id: "semantic-source",
      type: "function",
      function: {
        name: "query_semantic_metrics",
        arguments: JSON.stringify({ query: { schemaVersion: "1.0", intent: "aggregate", dimensionIds: ["unknown.dimension"] } }),
      },
    };
    const queryPlan = {
      status: "valid",
      actorScopeHash: "scope-a",
      steps: [{
        toolName: "query_semantic_metrics",
        canonicalArgs: {
          query: {
            schemaVersion: "1.0",
            ontologyVersion: "v1",
            schemaFingerprint: "a".repeat(64),
            intent: "aggregate",
            entityIds: ["quality.defect"],
            metricIds: ["defect.count"],
            dimensionIds: [],
            filters: [{ dimensionId: "org.problem_finder_team", operator: "in", values: ["DTSV_China"], source: "policy" }],
            timeScopes: [],
            comparison: null,
            sort: [],
            limit: 20,
          },
        },
      }],
    };

    const correction = buildGovernedSemanticPlanRetry({
      originalToolCall,
      recovery: { action: "catalog" },
      queryPlan,
      actorScopeHash: "scope-a",
    });

    expect(correction).toEqual(expect.objectContaining({
      toolCall: expect.objectContaining({
        id: "semantic-source-governed-plan-retry",
        function: expect.objectContaining({ name: "query_semantic_metrics" }),
      }),
      recovery: expect.objectContaining({
        action: "catalog",
        reason: "governed_query_plan",
        sourceToolCallId: "semantic-source",
        originalQueryFingerprint: expect.stringMatching(/^[a-f0-9]{24}$/),
        revisedQueryFingerprint: expect.stringMatching(/^[a-f0-9]{24}$/),
      }),
    }));
    expect(JSON.parse(correction.toolCall.function.arguments)).toEqual(queryPlan.steps[0].canonicalArgs);
  });

  it("refuses semantic plan recovery for a mismatched scope or ambiguous step set", () => {
    const originalToolCall = { id: "semantic-source", type: "function", function: { name: "query_semantic_metrics", arguments: "{}" } };
    const step = { toolName: "query_semantic_metrics", canonicalArgs: { query: { intent: "aggregate" } } };

    expect(buildGovernedSemanticPlanRetry({
      originalToolCall,
      recovery: { action: "catalog" },
      queryPlan: { status: "valid", actorScopeHash: "scope-b", steps: [step] },
      actorScopeHash: "scope-a",
    })).toBeNull();
    expect(buildGovernedSemanticPlanRetry({
      originalToolCall,
      recovery: { action: "catalog" },
      queryPlan: { status: "valid", actorScopeHash: "scope-a", steps: [step, step] },
      actorScopeHash: "scope-a",
    })).toBeNull();
  });
});