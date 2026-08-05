// @vitest-environment node
import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { createActorCapability, verifyActorCapability } from "../../../server/agentActorCapability.mjs";
import { createOntologyRegistry } from "../../../server/ontology/registry.mjs";
import { executeMainAgentToolCall } from "../../../server/mainAgentTools.mjs";
import { runMainAgentToolTurn } from "../../../server/mainAgentToolOrchestrator.mjs";
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

function readCases() {
  return fs.readFileSync("evals/main-agent/target/policy-golden.jsonl", "utf8")
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

describe("Main agent policy golden suite", () => {
  const registry = createOntologyRegistry();

  it("repeats deterministic capability and policy-denial scenarios", async () => {
    const cases = readCases();
    expect(cases.length).toBeGreaterThanOrEqual(6);

    for (const item of cases) {
      const actor = ACTORS[item.actor as keyof typeof ACTORS];
      if (item.kind === "altered_capability") {
        const token = createActorCapability(actor, {
          secret: EVAL_SECRET,
          now: EVAL_NOW,
          nonce: `eval-${item.caseId}-nonce`,
        });
        const altered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
        expect(() => verifyActorCapability(altered, { secret: EVAL_SECRET, now: EVAL_NOW }), item.caseId)
          .toThrow(item.expected.errorCode);
        continue;
      }

      const plannedBatches = item.plans.map((batch: Array<{ id: string; name: string; arguments: unknown }>) => batch.map(toolCall));
      const requests: Array<{ path: string; init: RequestInit }> = [];
      const requestBodies: unknown[] = [];
      const fakeResponses = [...(item.fakeResponses || [])];
      const analyticsFetch = vi.fn(async (url: string, init: RequestInit) => {
        const next = fakeResponses.shift();
        if (!next) throw new Error(`Unexpected request for ${item.caseId}: ${url}`);
        const parsedUrl = new URL(url);
        requests.push({ path: parsedUrl.pathname, init });
        const requestBody = JSON.parse(String(init.body || "{}"));
        requestBodies.push(requestBody);
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
        return response(next.status, next.body);
      });
      const blockedExecutor = vi.fn();
      const executeToolCall = item.kind === "toolset_block" ? blockedExecutor : executeMainAgentToolCall;
      const result = await runMainAgentToolTurn({
        messages: [{ role: "user", content: item.query }],
        requestToolCompletion: vi.fn().mockImplementation(async () => ({ content: "", toolCalls: plannedBatches.shift() || [] })),
        executeToolCall,
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

      expect(result.stoppedReason, item.caseId).toBe(item.expected.stoppedReason);
      if (item.expected.toolSequence) {
        expect(result.toolCalls.map((call) => call.function.name), item.caseId).toEqual(item.expected.toolSequence);
        expect(requests.map((request) => request.path), item.caseId).toEqual(item.expected.endpointSequence);
        expect(requests, item.caseId).toHaveLength(item.expected.requestCount);
        if (item.expected.requestBody) {
          expect(requestBodies[0], item.caseId).toMatchObject(item.expected.requestBody);
        }
        expect(result.toolEvents, item.caseId).toContainEqual(expect.objectContaining({
          type: "tool-recovery",
          recovery: expect.objectContaining({ action: item.expected.recoveryAction }),
        }));
      }
      if (item.expected.blockedTool) {
        expect(blockedExecutor, item.caseId).not.toHaveBeenCalled();
        expect(result.toolEvents, item.caseId).toContainEqual(expect.objectContaining({
          type: "tool-blocked",
          toolName: item.expected.blockedTool,
        }));
        if (item.expected.actionId) {
          const action = registry.bundle.actions.find((entry) => entry.id === item.expected.actionId);
          expect(action, item.caseId).toEqual(expect.objectContaining({
            capabilityState: item.expected.executionMode,
            execution: expect.objectContaining({ requiresHumanApproval: item.expected.requiresHumanApproval }),
          }));
        }
      }
      expect(fakeResponses, item.caseId).toHaveLength(0);
    }
  });
});