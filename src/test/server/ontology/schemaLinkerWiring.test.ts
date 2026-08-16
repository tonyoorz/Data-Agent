// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createOntologyRegistry } from "../../../../server/ontology/registry.mjs";
import { createSemanticResolver } from "../../../../server/ontology/resolver.mjs";
import { createSchemaLinker } from "../../../../server/ontology/schemaLinker.mjs";
import { loadGoldenDataset } from "../evals/loader.mjs";

const { ontology } = loadGoldenDataset();
const NOW = "2026-08-16T02:00:00.000Z";
const actor = { actorId: "w", scopeHash: "w", scopes: { workspaceIds: ["DTSV"], teamIds: ["DTSV"] } };

function buildResolver({ withLinker }) {
  const registry = createOntologyRegistry();
  return createSemanticResolver({
    registry,
    now: () => NOW,
    schemaLinker: withLinker ? createSchemaLinker({ ontology }) : undefined,
  });
}

describe("resolver + schemaLinker fallback wiring", () => {
  it("no governed term hit → frame carries ranked schemaLinkSuggestions", () => {
    const resolver = buildResolver({ withLinker: true });
    // "坏单子" is real user slang with ZERO governed term hits (verified via probe)
    const frame = resolver.resolve({ query: "坏单子按电子控制单元看看", actor, requestAnchorAt: NOW });
    expect(Array.isArray(frame.schemaLinkSuggestions?.dims)).toBe(true);
    expect(frame.schemaLinkSuggestions.dims.length).toBeGreaterThan(0);
    expect(frame.schemaLinkSuggestions.entities.map((e) => e.id)).toContain("quality.defect");
  });

  it("clean governed hit → no suggestions attached (priority unchanged)", () => {
    const resolver = buildResolver({ withLinker: true });
    const frame = resolver.resolve({ query: "上个月 BCM 停演缺陷趋势", actor, requestAnchorAt: NOW });
    expect(frame.metricIds).toEqual(["defect.showstopper_count"]); // existing resolution NOT altered
    expect(frame.schemaLinkSuggestions).toBeUndefined();
  });

  it("without schemaLinker injected → resolver behaves exactly as before", () => {
    const resolver = buildResolver({ withLinker: false });
    const frame = resolver.resolve({ query: "问题单按 ECU 分布", actor, requestAnchorAt: NOW });
    expect(frame.schemaLinkSuggestions).toBeUndefined();
    expect(Array.isArray(frame.metricIds)).toBe(true);
  });
});
