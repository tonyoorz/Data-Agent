// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { verifyActorCapabilityHeader } from "../../../server/agentActorCapability.mjs";
import {
  buildSemanticContinuationContext,
  buildToolEvidence,
  evaluateSemanticEvidence,
} from "../../../server/mainAgentEvidence.mjs";
import { executeMainAgentToolCall } from "../../../server/mainAgentTools.mjs";

const fingerprint = "f".repeat(64);
const capabilitySecret = "semantic-e2e-capability-secret";
const capabilityNow = 1_700_000_000;
const actor = {
  actorId: "alice",
  scopeHash: "scope-a",
  scopes: { workspaceIds: ["DTSV"], teamIds: ["DTSV"], allowedObjectTypes: ["quality.defect"] },
};
const aggregateQuery = {
  schemaVersion: "1.0",
  ontologyVersion: "v1",
  schemaFingerprint: fingerprint,
  intent: "rank",
  entityIds: ["quality.defect"],
  metricIds: ["defect.count"],
  dimensionIds: ["product.ecu"],
  filters: [{ dimensionId: "org.problem_finder_team", operator: "in", values: ["DTSV_China"], source: "policy" }],
  timeScopes: [],
  comparison: null,
  sort: [{ fieldId: "defect.count", direction: "desc" }],
  limit: 5,
};
const traceQuery = {
  schemaVersion: "1.0",
  ontologyVersion: "v1",
  schemaFingerprint: fingerprint,
  intent: "trace",
  entityIds: ["requirements.aida_node", "testing.test_case", "testing.test_run", "quality.defect"],
  metricIds: [],
  dimensionIds: [],
  filters: [{ dimensionId: "org.team", operator: "in", values: ["DTSV_China"], source: "policy" }],
  timeScopes: [],
  comparison: null,
  sort: [],
  limit: 20,
};

describe("semantic analysis closure", () => {
  it("closes aggregate to same-snapshot records with a passing evidence gate", async () => {
    const analyticsFetch = vi.fn(async (url: string, init: { body?: string; headers?: Record<string, string> }) => {
      const body = JSON.parse(String(init.body || "{}"));
      expect(body).not.toHaveProperty("actorScope");
      expect(verifyActorCapabilityHeader(init.headers || {}, {
        secret: capabilitySecret,
        now: capabilityNow,
      })).toMatchObject({ actorId: "alice", scopeHash: "scope-a" });
      if (url.endsWith("/api/semantic/query")) {
        expect(body.query).toEqual(aggregateQuery);
        return {
          ok: true,
          json: async () => ({
            ontologyVersion: "v1",
            schemaFingerprint: fingerprint,
            analysisRef: "analysis-e2e-1",
            sourceRevision: { sourceId: "analytics.full_picture_defects", revisionId: "snap-e2e-1", status: "pinned" },
            scope: { actorScopeHash: "scope-a", filters: aggregateQuery.filters, timeScopes: [], grain: ["quality.defect"] },
            data: [
              { "product.ecu": "HU", "defect.count": 3 },
              { "product.ecu": "ADAS", "defect.count": 1 },
            ],
            summary: { metrics: { "defect.count": 4 }, rowCount: 4 },
            quality: { completeness: "complete", warnings: [], truncated: false },
            evidence: {
              kind: "semantic_metric_result",
              analysisRef: "analysis-e2e-1",
              sourceRevisionId: "snap-e2e-1",
              rowCount: 4,
              metricValues: { "defect.count": 4 },
              groupRows: [{ "product.ecu": "HU", "defect.count": 3 }, { "product.ecu": "ADAS", "defect.count": 1 }],
            },
          }),
        };
      }
      expect(url).toMatch(/\/api\/semantic\/records$/);
      expect(body).toMatchObject({
        analysisRef: "analysis-e2e-1",
        selections: [{ dimensionId: "product.ecu", operator: "in", values: ["HU"] }],
      });
      return {
        ok: true,
        json: async () => ({
          ontologyVersion: "v1",
          schemaFingerprint: fingerprint,
          analysisRef: "analysis-e2e-1",
          sourceRevision: { sourceId: "analytics.full_picture_defects", revisionId: "snap-e2e-1", status: "pinned" },
          scope: { actorScopeHash: "scope-a", entityId: "quality.defect" },
          data: [{ defect_id: "D-1", name: "Audio issue", assigned_ecu: "HU", status: "Open" }],
          pagination: { page: 1, pageSize: 20, totalRows: 3, totalPages: 1 },
          quality: { completeness: "complete", warnings: [], truncated: false },
          evidence: {
            kind: "semantic_record_set",
            analysisRef: "analysis-e2e-1",
            sourceRevisionId: "snap-e2e-1",
            rowCount: 1,
            totalRows: 3,
            fieldIds: ["defect_id", "name", "assigned_ecu", "status"],
          },
        }),
      };
    });
    const metricToolCall = {
      id: "metric-e2e-1",
      type: "function",
      function: { name: "query_semantic_metrics", arguments: JSON.stringify({ query: aggregateQuery }) },
    };
    const metricResult = await executeMainAgentToolCall(metricToolCall, {
      analyticsFetch,
      analyticsApiBase: "http://127.0.0.1:3003",
      actor,
      actorCapabilitySecret: capabilitySecret,
      actorCapabilityNow: capabilityNow,
      actorCapabilityNonce: "semantic-e2e-capability-nonce",
    });
    const recordsToolCall = {
      id: "records-e2e-1",
      type: "function",
      function: {
        name: "query_semantic_records",
        arguments: JSON.stringify({
          ontology_version: "v1",
          schema_fingerprint: fingerprint,
          query: null,
          analysis_ref: "analysis-e2e-1",
          selections: [{ dimensionId: "product.ecu", operator: "in", values: ["HU"] }],
          fields: ["defect_id", "name", "assigned_ecu", "status"],
          page: 1,
          page_size: 20,
        }),
      },
    };
    const recordsResult = await executeMainAgentToolCall(recordsToolCall, {
      analyticsFetch,
      analyticsApiBase: "http://127.0.0.1:3003",
      actor,
      actorCapabilitySecret: capabilitySecret,
      actorCapabilityNow: capabilityNow,
      actorCapabilityNonce: "semantic-e2e-capability-nonce",
    });
    const evidence = [
      buildToolEvidence({ toolCall: metricToolCall, result: metricResult, intent: "metric_query" }),
      buildToolEvidence({ toolCall: recordsToolCall, result: recordsResult, intent: "record_list" }),
    ];

    expect(analyticsFetch).toHaveBeenCalledTimes(2);
    expect(recordsResult.contextText).toContain('"defect_id":"D-1"');
    expect(evidence.map((item) => item.analysisRef)).toEqual(["analysis-e2e-1", "analysis-e2e-1"]);
    expect(evidence.map((item) => item.sourceRevision.revisionId)).toEqual(["snap-e2e-1", "snap-e2e-1"]);
    expect(evaluateSemanticEvidence(evidence)).toMatchObject({
      status: "pass",
      analysisRefs: ["analysis-e2e-1"],
      sourceRevisionIds: ["snap-e2e-1"],
    });
  });

  it("accepts the Python trace response shape as lineage evidence without exposing a records continuation", async () => {
    const relationshipIds = [
      "testing.test_case.validates.aida_node",
      "testing.test_run.executes.test_case",
      "quality.defect.detected_in.test_run",
    ];
    const analyticsFetch = vi.fn(async (url: string, init: { body?: string; headers?: Record<string, string> }) => {
      const body = JSON.parse(String(init.body || "{}"));
      expect(url).toMatch(/\/api\/semantic\/query$/);
      expect(body).not.toHaveProperty("actorScope");
      expect(body.query).toEqual(traceQuery);
      expect(verifyActorCapabilityHeader(init.headers || {}, {
        secret: capabilitySecret,
        now: capabilityNow,
      })).toMatchObject({ actorId: "alice", scopeHash: "scope-a" });
      return {
        ok: true,
        json: async () => ({
          schemaVersion: "1.0",
          queryId: "trace-e2e-1",
          ontologyVersion: "v1",
          schemaFingerprint: fingerprint,
          analysisRef: "analysis-trace-e2e-1",
          sourceRevision: { sourceId: "analytics.traceability", revisionId: "snap-trace-e2e-1", status: "unpinned" },
          scope: { actorScopeHash: "scope-a", filters: traceQuery.filters, timeScopes: [], grain: [] },
          data: [{ run_id: "MR-1", scope_team: "DTSV_China" }],
          summary: { total_runs: 1, rowCount: 1 },
          quality: { completeness: "complete", missingness: "not_applicable", truncated: false, warnings: [], redactionStatus: "not_required" },
          businessRules: { applied: [] },
          evidence: {
            kind: "semantic_lineage_result",
            analysisRef: "analysis-trace-e2e-1",
            sourceRevisionId: "snap-trace-e2e-1",
            rowCount: 1,
            relationshipIds,
          },
          lineage: {
            path: [],
            sourceRevision: { sourceId: "analytics.traceability", revisionId: "snap-trace-e2e-1", status: "unpinned" },
            evidence: { rowCount: 1, rowIndexes: [0], relationshipIds },
          },
        }),
      };
    });
    const toolCall = {
      id: "trace-e2e-1",
      type: "function",
      function: { name: "query_traceability", arguments: JSON.stringify({ query: traceQuery }) },
    };

    const result = await executeMainAgentToolCall(toolCall, {
      analyticsFetch,
      analyticsApiBase: "http://127.0.0.1:3003",
      actor,
      actorCapabilitySecret: capabilitySecret,
      actorCapabilityNow: capabilityNow,
      actorCapabilityNonce: "semantic-trace-e2e-capability-nonce",
    });
    const evidence = buildToolEvidence({ toolCall, result, intent: "traceability" });

    expect(evidence.evidence).toMatchObject({ kind: "semantic_lineage_result", relationshipIds });
    expect(evaluateSemanticEvidence([evidence], { expectedActorScopeHash: "scope-a" })).toMatchObject({
      status: "pass",
      analysisRefs: ["analysis-trace-e2e-1"],
      sourceRevisionIds: ["snap-trace-e2e-1"],
    });
    expect(buildSemanticContinuationContext([evidence], actor)).toBe("");
  });
});
