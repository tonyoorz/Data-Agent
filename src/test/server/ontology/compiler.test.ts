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
    expect(first.counts).toMatchObject({ entityCount: 19, relationshipCount: 15, dimensionCount: 22, metricCount: 22 });
  });

  it("rejects invalid relationship endpoints and metric references", () => {
    const bundle = JSON.parse(fs.readFileSync("ontology/generated/ontology.compiled.json", "utf8"));
    bundle.relationships[0].targetEntity = "missing.entity";
    expect(() => validateOntologyBundle(bundle)).toThrow("ONTOLOGY_RELATION_TARGET_NOT_FOUND");

    const second = JSON.parse(fs.readFileSync("ontology/generated/ontology.compiled.json", "utf8"));
    second.metrics[0].allowedDimensions.push("missing.dimension");
    expect(() => validateOntologyBundle(second)).toThrow("ONTOLOGY_METRIC_DIMENSION_NOT_FOUND");
  });

  it("rejects stale generated output", () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "ontology-stale-"));
    temporaryRoots.push(outputDir);
    compileOntology({ outputDir });
    fs.writeFileSync(path.join(outputDir, "fingerprint.txt"), "stale\n");

    expect(() => compileOntology({ outputDir, check: true })).toThrow("ONTOLOGY_GENERATED_OUTPUT_STALE");
  });
});
