// @vitest-environment node
import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { createOntologyRegistry } from "../../../server/ontology/registry.mjs";
import { validateAnswerTextCitations } from "../../../server/answerValidator.mjs";
import { evaluateSemanticEvidence } from "../../../server/mainAgentEvidence.mjs";
import { executeMainAgentToolCall } from "../../../server/mainAgentTools.mjs";
import { runMainAgentToolTurn } from "../../../server/mainAgentToolOrchestrator.mjs";
import { primitiveForLegacyTool } from "../../../server/mainAgentPrimitives.mjs";
import { verifyActorCapabilityHeader } from "../../../server/agentActorCapability.mjs";

const EVAL_NOW = 1_700_000_000;
const EVAL_SECRET = "main-agent-evaluation-capability-secret";
const UNSAFE_REQUEST_TEXT = /\bselect\b[\s\S]*\bfrom\b|\binsert\s+into\b|\bupdate\s+\S+\s+set\b|\bdelete\s+from\b|\bdrop\s+(?:table|database|schema)\b|\balter\s+(?:table|database)\b|\bpragma\s+\w+|\battach\s+database\b|\bdetach\s+database\b|\bexec(?:ute)?\s+(?:\S|@)|```|<script\b|\b(?:import|require)\s*(?:\(|[\w{])|\bfunction\s*\(|=>\s*|\b(?:eval|spawn|exec)\s*\(/i;
const ACTORS = Object.freeze({
  "dtsv-reader": {
    actorId: "eval-dtsv-reader",
    scopeHash: "scope-eval-dtsv",
    scopes: {
      allowedObjectTypes: ["quality.defect"],
      teamIds: ["DTSV_China"],
      projectIds: ["IDCEVO"],
    },
  },
});

function readCases(fileName: string) {
  return fs.readFileSync(`evals/main-agent/target/${fileName}`, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

function toolCall(item: { id: string; name: string; arguments: unknown }) {
  return {
    id: item.id,
    type: "function",
    function: { name: item.name, arguments: JSON.stringify(item.arguments) },
  };
}

function response(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function assertSafeRequest(value: unknown, caseId: string) {
  if (typeof value === "string") {
    expect(value, caseId).not.toMatch(UNSAFE_REQUEST_TEXT);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => assertSafeRequest(entry, caseId));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    expect(["sql", "python", "javascript", "shell", "command", "code"], caseId).not.toContain(key.toLowerCase());
    assertSafeRequest(entry, caseId);
  }
}

describe("Main agent execution golden suite", () => {
  const registry = createOntologyRegistry();

  it("rejects raw SQL and executable-code strings from governed requests", () => {
    expect(() => assertSafeRequest({ query: "SELECT * FROM octane_defects" }, "unsafe-sql")).toThrow();
    expect(() => assertSafeRequest({ query: "<script>alert(1)</script>" }, "unsafe-code")).toThrow();
    expect(() => assertSafeRequest({ queryId: "exec-semantic" }, "benign-tool-id")).not.toThrow();
  });

  it("repeats deterministic execution scenarios with governed requests", async () => {
    const cases = readCases("execution-golden.jsonl");
    expect(cases.length).toBeGreaterThanOrEqual(3);

    for (const item of cases) {
      const actor = ACTORS[item.actor as keyof typeof ACTORS];
      expect(actor, item.caseId).toBeDefined();
      const plannedBatches = item.plans.map((batch: Array<{ id: string; name: string; arguments: unknown }>) => batch.map(toolCall));
      const requests: Array<{ path: string; init: RequestInit }> = [];
      const fakeResponses = [...item.fakeResponses];
      let requestAssertionError = "";
      const analyticsFetch = vi.fn(async (url: string, init: RequestInit) => {
        const next = fakeResponses.shift();
        if (!next) throw new Error(`Unexpected request for ${item.caseId}: ${url}`);
        const parsedUrl = new URL(url);
        requests.push({ path: parsedUrl.pathname, init });
        try {
          const requestBody = JSON.parse(String(init.body || "{}"));
          assertSafeRequest(requestBody, item.caseId);
          if (init.headers && parsedUrl.pathname.startsWith("/api/agent/")) {
            expect(verifyActorCapabilityHeader(init.headers as Record<string, string>, {
              secret: EVAL_SECRET,
              now: EVAL_NOW,
            }), item.caseId).toMatchObject({ scopeHash: item.expected.actorScopeHash });
          }
          if (parsedUrl.pathname.startsWith("/api/semantic/")) {
            expect(requestBody.actorScope?.scopeHash, item.caseId).toBe(item.expected.actorScopeHash);
          }
        } catch (error) {
          requestAssertionError = error instanceof Error ? error.message : String(error);
          throw error;
        }
        return response(next.status, next.body);
      });
      const requestToolCompletion = vi.fn().mockImplementation(async () => ({
        content: "",
        toolCalls: plannedBatches.shift() || [],
      }));

      const result = await runMainAgentToolTurn({
        messages: [{ role: "user", content: item.query }],
        requestToolCompletion,
        executeToolCall: executeMainAgentToolCall,
        toolDependencies: {
          analyticsFetch,
          analyticsApiBase: "http://agent-eval.local",
          actor,
          actorCapabilitySecret: EVAL_SECRET,
          actorCapabilityNow: EVAL_NOW,
          actorCapabilityNonce: `eval-${item.caseId}-nonce`,
          toolRecoveryWait: vi.fn().mockResolvedValue(undefined),
          toolRecoveryRandom: () => 0,
        },
        maxSteps: 4,
        now: new Date("2026-08-04T08:00:00.000Z"),
      });

      const normalizedToolSequence = result.toolCalls.map((call) => call.function.name === "diagnose_analytics_empty"
        ? call.function.name
        : primitiveForLegacyTool(call.function.name) || call.function.name);
      const expectedToolSequence = item.expected.toolSequence.map((name: string) => name === "diagnose_analytics_empty"
        ? name
        : primitiveForLegacyTool(name) || name);
      expect(normalizedToolSequence, item.caseId).toEqual(expectedToolSequence);
      expect(requests.map((request) => request.path), item.caseId).toEqual(item.expected.endpointSequence);
      const evidenceGate = evaluateSemanticEvidence(result.evidence);
      expect(evidenceGate.status, `${item.caseId}: ${JSON.stringify({ evidenceGate, evidence: result.evidence, toolMessages: result.toolMessages, requestAssertionError })}`).toBe(item.expected.evidenceStatus);
      if (item.expected.recovery) {
        expect(result.toolEvents, item.caseId).toContainEqual(expect.objectContaining({
          type: "tool-recovery",
          recovery: expect.objectContaining(item.expected.recovery),
        }));
      }
      if (item.expected.citation) {
        expect(validateAnswerTextCitations({
          text: item.expected.citation,
          evidence: result.evidence,
          registry,
        }), item.caseId).toEqual({ valid: true, violations: [] });
      }
      expect(fakeResponses, item.caseId).toHaveLength(0);
    }
  });
});
