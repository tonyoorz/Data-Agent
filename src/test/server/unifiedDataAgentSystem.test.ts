import { mkdtempSync, copyFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createUnifiedDataAgentSystem,
  SEMANTIC_QUERY_ENDPOINT_PATH,
  UNIFIED_SEMANTIC_TOOL_NAMES,
  UNIFIED_SYSTEM_NAME,
} from "../../../server/unifiedDataAgentSystem.mjs";

const REPO_ROOT = path.resolve(__dirname, "../../..");

const AGENT_ACTOR = Object.freeze({
  actorId: "alice",
  scopeHash: "scope-alice-dtsv",
  scopes: {
    allowedObjectTypes: ["quality.defect"],
    teamIds: ["DTSV_China"],
    projectIds: ["IDCEVO"],
  },
});

function semanticToolArguments() {
  return JSON.stringify({
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
  });
}

function semanticApiResponse() {
  return {
    ok: true,
    json: async () => ({
      ontologyVersion: "v1",
      schemaFingerprint: "a".repeat(64),
      sourceRevision: { revisionId: "snap-1" },
      data: [],
      summary: { metrics: { "defect.count": 2 }, rowCount: 2 },
      quality: { completeness: "complete" },
    }),
  };
}

const tempRoots: string[] = [];

function tamperedOntologyRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "unified-system-tampered-"));
  tempRoots.push(root);
  const generatedDir = path.join(root, "ontology", "generated");
  mkdirSync(generatedDir, { recursive: true });
  copyFileSync(
    path.join(REPO_ROOT, "ontology/generated/ontology.compiled.json"),
    path.join(generatedDir, "ontology.compiled.json"),
  );
  writeFileSync(path.join(generatedDir, "fingerprint.txt"), `${"0".repeat(64)}\n`);
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("unified data agent system snapshot", () => {
  it("exposes the three integrated layers with green contracts", async () => {
    const system = await createUnifiedDataAgentSystem({ root: REPO_ROOT });
    const snapshot = system.snapshot();

    expect(snapshot.system).toMatchObject({
      name: UNIFIED_SYSTEM_NAME,
      integration: "codex-harness × pi-semantic-kernel × data-plane",
    });
    expect(snapshot.layers.harness).toMatchObject({
      layer: "codex.harness",
      orchestratorEntry: "runMainAgentToolTurn",
      runtime: "langgraph",
    });
    expect(snapshot.layers.harness.semanticToolsPresent).toEqual(UNIFIED_SEMANTIC_TOOL_NAMES);
    expect(snapshot.layers.semanticKernel).toMatchObject({
      layer: "pi.semantic-kernel",
      ontologyVersion: "v1",
    });
    expect(snapshot.layers.semanticKernel.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.layers.semanticKernel.adapterIds).toEqual([
      "python.semantic.defects",
      "python.semantic.test_runs",
      "python.semantic.testcases",
    ]);
    expect(snapshot.layers.dataPlane).toMatchObject({
      layer: "data-plane",
      semanticEndpointPath: SEMANTIC_QUERY_ENDPOINT_PATH,
    });

    expect(snapshot.contracts.map((contract) => contract.id)).toEqual([
      "HARNESS_TOOL_SOURCE_OF_TRUTH",
      "HARNESS_INTENT_WIRING",
      "SEMANTIC_KERNEL_FAIL_CLOSED",
      "RUNTIME_PUBLICATION_CONSISTENT",
      "READY_METRICS_GOVERNED",
      "ORCHESTRATOR_INJECTABLE_BOUNDARY",
    ]);
    expect(snapshot.ok).toBe(true);
  });

  it("fails closed when the ontology fingerprint is tampered", async () => {
    const system = await createUnifiedDataAgentSystem({ root: tamperedOntologyRoot() });
    const snapshot = system.snapshot();

    const kernelContract = snapshot.contracts.find(
      (contract) => contract.id === "SEMANTIC_KERNEL_FAIL_CLOSED",
    );
    expect(kernelContract?.ok).toBe(false);
    expect(kernelContract?.detail).toContain("UNIFIED_SEMANTIC_KERNEL_UNAVAILABLE");
    expect(snapshot.layers.semanticKernel).toMatchObject({
      layer: "pi.semantic-kernel",
      ok: false,
      code: "UNIFIED_SEMANTIC_KERNEL_UNAVAILABLE",
    });
    expect(snapshot.ok).toBe(false);
    expect(system.layers.semanticKernel).toBeNull();
  });
});

describe("unified data agent turn", () => {
  it("runs an end-to-end 智能问数 turn through orchestrator, semantic tool, and semantic API", async () => {
    const analyticsFetch = vi.fn().mockResolvedValue(semanticApiResponse());
    const system = await createUnifiedDataAgentSystem({
      root: REPO_ROOT,
      analyticsFetch,
      analyticsApiBase: "http://127.0.0.1:3003",
      actor: AGENT_ACTOR,
      actorCapabilitySecret: "unified-system-capability-secret",
      actorCapabilityNow: 1_700_000_000,
      actorCapabilityNonce: "unified-system-capability-nonce",
    });

    const requestToolCompletion = vi.fn()
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [{
          id: "unified-semantic-1",
          type: "function",
          function: {
            name: "query_semantic_metrics",
            arguments: semanticToolArguments(),
          },
        }],
      })
      .mockResolvedValueOnce({ content: "DTSV_China 当前缺陷计数为 2。", toolCalls: [] });

    const turn = await system.runDataAgentTurn({
      messages: [{ role: "user", content: "DTSV_China 现在有多少缺陷？" }],
      requestToolCompletion,
      runId: "unified-run-1",
      threadId: "unified-thread-1",
    });

    expect(turn.events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "agent.turn.started",
      "agent.tool.started",
      "agent.tool.completed",
      "agent.turn.completed",
    ]));
    expect(turn.uiToolEvents.map((event) => event.type)).toEqual([
      "tool-input-available",
      "tool-output-available",
    ]);

    expect(analyticsFetch).toHaveBeenCalledTimes(1);
    const [url, init] = analyticsFetch.mock.calls[0];
    expect(url).toBe(`http://127.0.0.1:3003${SEMANTIC_QUERY_ENDPOINT_PATH}`);
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.query.metricIds).toEqual(["defect.count"]);
    expect(body.query.filters[0]).toMatchObject({
      dimensionId: "org.problem_finder_team",
      values: ["DTSV_China"],
    });

    expect(turn.contextText).toContain("Tool: query_semantic_metrics");
    expect(turn.contextText).toContain("defect.count: 2");
    expect(turn.system).toMatchObject({
      name: UNIFIED_SYSTEM_NAME,
      ontologyFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("honors an injected executor for offline harness-level tests", async () => {
    const system = await createUnifiedDataAgentSystem({ root: REPO_ROOT });
    const requestToolCompletion = vi.fn()
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [{
          id: "unified-injected-1",
          type: "function",
          function: { name: "query_semantic_records", arguments: semanticToolArguments() },
        }],
      })
      .mockResolvedValueOnce({ content: "done", toolCalls: [] });
    const executeToolCall = vi.fn().mockResolvedValue({
      toolMessage: { role: "tool", tool_call_id: "unified-injected-1", name: "query_semantic_records", content: "{}" },
      contextText: "# Main agent tool result\nTool: query_semantic_records\nResult: injected",
    });

    const turn = await system.runDataAgentTurn({
      messages: [{ role: "user", content: "列出最近的缺陷记录" }],
      requestToolCompletion,
      executeToolCall,
      runId: "unified-run-2",
    });

    expect(executeToolCall).toHaveBeenCalledTimes(1);
    expect(turn.contextText).toContain("Result: injected");
    expect(turn.events.at(-1)).toMatchObject({ type: "agent.turn.completed" });
  });
});
