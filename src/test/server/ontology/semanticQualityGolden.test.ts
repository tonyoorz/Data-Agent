// @vitest-environment node
import fs from "node:fs";
import { describe, expect, it } from "vitest";

import { validateAnswerTextCitations } from "../../../../server/answerValidator.mjs";
import { createOntologyRegistry } from "../../../../server/ontology/registry.mjs";
import { createQueryPlanner } from "../../../../server/ontology/queryPlanner.mjs";
import { createSemanticResolver } from "../../../../server/ontology/resolver.mjs";

const actor = { actorId: "quality-golden", scopeHash: "quality-golden-scope", scopes: { workspaceIds: ["DTSV"], teamIds: ["DTSV"] } };
const registry = createOntologyRegistry();
const resolver = createSemanticResolver({ registry, now: () => "2026-07-15T04:00:00.000Z" });

function readCases() {
  return fs.readFileSync("evals/main-agent/target/semantic-quality-golden.jsonl", "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

function registryForFixture(fixture: string) {
  if (fixture === "missing-run-testcase-link") {
    return {
      ...registry,
      getRelationship(relationshipId: string) {
        if (relationshipId === "testing.test_run.executes.test_case") throw new Error("relationship unavailable");
        return registry.getRelationship(relationshipId);
      },
    };
  }
  if (fixture === "unbounded-testcase-requirement-link") {
    return {
      ...registry,
      getRelationship(relationshipId: string) {
        const relationship = registry.getRelationship(relationshipId);
        return relationship.id === "testing.test_case.validates.aida_node"
          ? { ...relationship, explosionPolicy: undefined }
          : relationship;
      },
    };
  }
  return registry;
}

describe("P1 semantic quality golden suite", () => {
  it("repeats deterministic ambiguity, trace-path, cardinality, and causal-claim gates", () => {
    const allCases = readCases();
    expect(allCases).toHaveLength(5);
    const cases = allCases.filter((item) => item.surface !== "semantic-api");
    expect(cases).toHaveLength(4);

    for (const item of cases) {
      if (item.surface === "resolver") {
        const frame = resolver.resolve({ query: item.query, actor });
        const plan = createQueryPlanner({ registry }).createPlan({ frame, actor, query: item.query });
        expect(plan.status, item.caseId).toBe(item.expected.status);
        expect(plan.violations, item.caseId).toContain(item.expected.violation);
        continue;
      }
      if (item.surface === "planner") {
        const frame = resolver.resolve({ query: item.query, actor });
        expect(() => createQueryPlanner({ registry: registryForFixture(item.fixture) })
          .createPlan({ frame, actor, query: item.query }), item.caseId).toThrow(item.expected.error);
        continue;
      }
      if (item.surface === "answer") {
        const validation = validateAnswerTextCitations({
          text: item.text,
          evidence: [{ toolCallId: "call-1", tool: "query_semantic_metrics", ontologyVersion: "v1", schemaFingerprint: registry.fingerprint }],
          registry,
        });
        expect(validation.valid, item.caseId).toBe(false);
        expect(validation.violations, item.caseId).toContain(item.expected.violation);
      }
    }
  });
});