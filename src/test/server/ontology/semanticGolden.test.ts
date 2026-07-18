// @vitest-environment node
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { createOntologyRegistry } from "../../../../server/ontology/registry.mjs";
import { createSemanticResolver } from "../../../../server/ontology/resolver.mjs";

const actor = { actorId: "golden", scopeHash: "golden-scope", scopes: { workspaceIds: ["DTSV"], teamIds: ["DTSV"] } };
const registry = createOntologyRegistry();
const resolver = createSemanticResolver({ registry });

describe("Semantic golden suite", () => {
  it("repeats 113 governed semantic resolutions exactly", () => {
    const cases = fs.readFileSync("evals/main-agent/target/semantic-golden.jsonl", "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(cases).toHaveLength(113);

    for (const item of cases) {
      const frame = resolver.resolve({ query: item.query, actor, requestAnchorAt: item.anchorAt });
      expect(frame.intent, item.caseId).toBe(item.expected.intent);
      expect(frame.metricIds, item.caseId).toEqual(item.expected.metricIds);
      expect(frame.dimensionIds, item.caseId).toEqual(expect.arrayContaining(item.expected.dimensionIds));
      if (item.expected.timeFieldId) expect(frame.timeScopes[0]?.fieldId, item.caseId).toBe(item.expected.timeFieldId);
      if (item.expected.timeStart) expect(frame.timeScopes[0]?.start, item.caseId).toBe(item.expected.timeStart);
      if (item.expected.comparisonGroups) expect(frame.comparison?.groups, item.caseId).toEqual(item.expected.comparisonGroups);
      if (item.expected.filters) expect(frame.filters, item.caseId).toEqual(expect.arrayContaining(item.expected.filters));
      if (item.expected.limit) expect(frame.limit, item.caseId).toBe(item.expected.limit);
      if (item.expected.ambiguityCode) {
        expect(frame.ambiguities, item.caseId).toContainEqual(expect.objectContaining({ code: item.expected.ambiguityCode }));
      } else {
        expect(frame.ambiguities, item.caseId).toEqual([]);
      }
    }
  });
});
