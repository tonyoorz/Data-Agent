// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileOntology } from "../../../../scripts/compileOntology.mjs";
import { validateOntologyBundle } from "../../../../server/ontology/validator.mjs";

describe("Ontology compiler", () => {
  const temporaryRoots: string[] = [];
  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("compiles deterministic validated output and verifies it in check mode", () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "ontology-output-"));
    temporaryRoots.push(outputDir);
    const first = compileOntology({ outputDir });
    const second = compileOntology({ outputDir, check: true });

    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(first.counts).toMatchObject({
      entityCount: 28,
      relationshipCount: 27,
      dimensionCount: 51,
      metricCount: 31,
      businessRuleCount: 3,
      actionCount: 3,
    });
    expect(first.bundle.businessRules).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "business.defect_created_count.creation_time",
        kind: "require",
        effect: expect.objectContaining({ requiredTimeField: "time.defect_creation_date" }),
      }),
    ]));
  });

  it("rejects invalid relationship endpoints and metric references", () => {
    const bundle = JSON.parse(fs.readFileSync("ontology/generated/ontology.compiled.json", "utf8"));
    bundle.relationships[0].targetEntity = "missing.entity";
    expect(() => validateOntologyBundle(bundle)).toThrow("ONTOLOGY_RELATION_TARGET_NOT_FOUND");

    const second = JSON.parse(fs.readFileSync("ontology/generated/ontology.compiled.json", "utf8"));
    second.metrics[0].allowedDimensions.push("missing.dimension");
    expect(() => validateOntologyBundle(second)).toThrow("ONTOLOGY_METRIC_DIMENSION_NOT_FOUND");
  });

  it("emits a Mermaid entity graph when emitGraph is true", () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "ontology-graph-"));
    temporaryRoots.push(outputDir);
    const graphPath = path.join(outputDir, "graph.md");
    const result = compileOntology({ outputDir, emitGraph: true, graphPath });

    expect(result.graphOutputPath).toBe(graphPath);
    const graphText = fs.readFileSync(graphPath, "utf8");
    expect(graphText).toContain("# Ontology Entity Relationship Graph");
    expect(graphText).toContain("flowchart LR");
    expect(graphText).toContain("quality_defect");
    expect(graphText).toContain(' -->|"executes"| ');
    expect(graphText).toContain("-.->"); // at least one draft relationship
  });

  it("rejects stale generated output", () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "ontology-stale-"));
    temporaryRoots.push(outputDir);
    compileOntology({ outputDir });
    fs.writeFileSync(path.join(outputDir, "fingerprint.txt"), "stale\n");

    expect(() => compileOntology({ outputDir, check: true })).toThrow("ONTOLOGY_GENERATED_OUTPUT_STALE");
  });
});
