// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createOntologyRegistry } from "../../../../server/ontology/registry.mjs";
import {
  createSemanticCandidateCatalog,
  createSemanticCandidateMessages,
  createSemanticCandidateSchema,
  parseSemanticCandidate,
} from "../../../../server/ontology/semanticCandidate.mjs";

const registry = createOntologyRegistry();

function catalogFromMessages(messages) {
  const marker = "Catalog: ";
  const content = messages[0].content;
  const index = content.indexOf(marker);
  if (index < 0) throw new Error("SEMANTIC_CANDIDATE_CATALOG_MISSING");
  return JSON.parse(content.slice(index + marker.length));
}

function legacyMetricRegistry() {
  const dimension = {
    id: "product.ecu",
    labels: { "zh-CN": "ECU" },
    entityId: "quality.defect",
  };
  const entity = {
    id: "quality.defect",
    labels: { "zh-CN": "缺陷" },
    aliases: [],
  };
  const term = {
    id: "dimension.ecu",
    phrases: ["ECU"],
    resolution: { dimensionId: "product.ecu" },
  };
  return {
    bundle: {
      metrics: [{ id: "defect.legacy", entityId: "quality.defect", labels: { "zh-CN": "遗留缺陷数" } }],
      dimensions: [dimension],
      entities: [entity],
      terms: [term],
    },
    matchTerms() {
      return [term];
    },
  };
}

describe("Ontology semantic candidate catalog", () => {
  it("prunes a matched metric query to its governed metric, dimensions, entities, and terms", () => {
    const catalog = createSemanticCandidateCatalog({
      registry,
      query: "最近一周 DTSV 新增缺陷按 ECU Top 5",
    });

    expect(catalog.selection).toMatchObject({ mode: "matched_terms" });
    expect(catalog.metrics.map((item) => item.id)).toEqual(["defect.created_count"]);
    expect(catalog.dimensions.map((item) => item.id)).toContain("product.ecu");
    expect(catalog.entities.map((item) => item.id)).toEqual(expect.arrayContaining(["quality.defect", "product.ecu"]));
    expect(catalog.entities.map((item) => item.id)).not.toContain("testing.test_run");
    expect(catalog.vocabulary.map((item) => item.id)).toEqual(expect.arrayContaining([
      "metric.created_defects",
      "dimension.ecu",
      "team.dtsv",
    ]));
  });

  it("does not crash when a legacy metric omits allowed dimensions", () => {
    expect(() => createSemanticCandidateCatalog({
      registry: legacyMetricRegistry(),
      query: "ECU",
    })).not.toThrow();
  });

  it("infers compatible metrics from a matched dimension without a metric term", () => {
    const catalog = createSemanticCandidateCatalog({ registry, query: "按 ECU 统计" });

    expect(catalog.selection.mode).toBe("matched_terms");
    expect(catalog.metrics.map((item) => item.id)).toEqual(expect.arrayContaining([
      "defect.count",
      "defect.created_count",
    ]));
    expect(catalog.metrics.map((item) => item.id)).not.toContain("testing.run_count");
  });

  it("retains the full catalog for a matched time term without structural IDs", () => {
    const catalog = createSemanticCandidateCatalog({ registry, query: "最近一周" });

    expect(catalog.selection).toEqual({ mode: "full_catalog", matchedTermIds: ["time.last_7_days"] });
    expect(catalog.metrics).toHaveLength(registry.bundle.metrics.length);
  });

  it("rejects candidate IDs outside a pruned catalog", () => {
    const catalog = createSemanticCandidateCatalog({
      registry,
      query: "最近一周 DTSV 新增缺陷按 ECU Top 5",
    });
    const schema = createSemanticCandidateSchema(registry, catalog);

    expect(() => parseSemanticCandidate(JSON.stringify({
      intent: "aggregate",
      metricIds: ["testing.run_count"],
      dimensionIds: [],
      entityIds: ["testing.test_run"],
    }), schema)).toThrow("SEMANTIC_CANDIDATE_INVALID");
  });

  it("uses the explicit compact catalog in the candidate prompt", () => {
    const selectedCatalog = createSemanticCandidateCatalog({
      registry,
      query: "最近一周 DTSV 新增缺陷按 ECU Top 5",
    });
    const messages = createSemanticCandidateMessages({
      registry,
      query: "最近一周 DTSV 新增缺陷按 ECU Top 5",
      catalog: selectedCatalog,
    });
    const catalog = catalogFromMessages(messages);

    expect(catalog.selection.mode).toBe("matched_terms");
    expect(catalog.metrics.map((item) => item.id)).toEqual(["defect.created_count"]);
    expect(catalog.entities.map((item) => item.id)).not.toContain("testing.test_run");
  });

  it("keeps the default candidate prompt catalog aligned with the default schema catalog", () => {
    const catalog = catalogFromMessages(createSemanticCandidateMessages({
      registry,
      query: "最近一周 DTSV 新增缺陷按 ECU Top 5",
    }));

    expect(catalog.selection.mode).toBe("full_catalog");
    expect(catalog.metrics.map((item) => item.id)).toEqual(registry.bundle.metrics.map((item) => item.id));
  });

  it("retains the full catalog when no governed terms match", () => {
    const catalog = createSemanticCandidateCatalog({ registry, query: "各楼层工位利用率" });

    expect(catalog.selection).toEqual({ mode: "full_catalog", matchedTermIds: [] });
    expect(catalog.metrics).toHaveLength(registry.bundle.metrics.length);
    expect(catalog.dimensions).toHaveLength(registry.bundle.dimensions.length);
    expect(catalog.entities).toHaveLength(registry.bundle.entities.length);
  });
});