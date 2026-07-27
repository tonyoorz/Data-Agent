// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createOntologyRegistry } from "../../../../server/ontology/registry.mjs";
import { buildApprovedMetricsCatalog } from "../../../../server/ontology/catalog.mjs";

const registry = createOntologyRegistry();

describe("Ontology approved-metrics catalog", () => {
  it("projects only approved metrics into a consumer-friendly shape", () => {
    const catalog = buildApprovedMetricsCatalog(registry);

    expect(catalog.count).toBe(catalog.metrics.length);
    expect(catalog.count).toBe(registry.listMetrics({ status: "approved" }).length);
    // No draft metrics leak into the catalog.
    expect(catalog.metrics.every((metric) => !metric.id.includes("draft"))).toBe(true);
    const ids = catalog.metrics.map((metric) => metric.id);
    expect(ids).toContain("defect.created_count");
    expect(ids).toContain("testing.run_count");
    // Draft metrics must be excluded.
    expect(ids).not.toContain("defect.open_count");
    expect(ids).not.toContain("testing.pass_rate");
  });

  it("includes the governance header and stable projection fields", () => {
    const catalog = buildApprovedMetricsCatalog(registry);
    const created = catalog.metrics.find((metric) => metric.id === "defect.created_count");

    expect(catalog.ontologyVersion).toBe(registry.version);
    expect(catalog.ontologyFingerprint).toBe(registry.fingerprint);
    expect(catalog.locale).toBe("zh-CN");
    expect(created).toMatchObject({
      id: "defect.created_count",
      label: "新建缺陷数",
      entity: "quality.defect",
      unit: "count",
      defaultTimeDimension: "time.defect_creation_date",
      owner: "Quality Analytics",
    });
    expect(created?.allowedDimensions).toContain("product.ecu");
    expect(created?.capabilities).toMatchObject({ trend: true, ranking: true });
  });

  it("honors the locale query for label selection", () => {
    const catalog = buildApprovedMetricsCatalog(registry, { locale: "en-US" });
    const created = catalog.metrics.find((metric) => metric.id === "defect.created_count");

    expect(catalog.locale).toBe("en-US");
    expect(created?.label).toBe("Created Defect Count");
  });
});
