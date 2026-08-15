// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileOntology, validateRelationshipKinds } from "../../../../scripts/compileOntology.mjs";
import { validateOntologyBundle } from "../../../../server/ontology/validator.mjs";
import { createOntologyRegistry } from "../../../../server/ontology/registry.mjs";

const DERIVED_ID = "quality.defect.same_root_cause_cluster.quality.defect";
const EVENT_ID = "quality.qgate.gate_passed.product.project";
const TIME_VARYING_ID = "organization.tester.member_of_history.organization.team";

function temporaryDirectory(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return dir;
}

function cloneOntologySources() {
  // Copies ontology/v1 + ontology/schema into a temp tree so tests can mutate
  // relationships.json without touching the real sources.
  const root = path.resolve(__dirname, "../../../..");
  const sourceDir = path.join(temporaryDirectory("ontology-kinds-src-"), "v1");
  const schemaDir = path.join(temporaryDirectory("ontology-kinds-schema-"), "schema");
  fs.cpSync(path.join(root, "ontology/v1"), sourceDir, { recursive: true });
  fs.cpSync(path.join(root, "ontology/schema"), schemaDir, { recursive: true });
  return { root, sourceDir, schemaDir };
}

function readRelationship(sourceDir: string) {
  const filePath = path.join(sourceDir, "relationships.json");
  const document = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return { filePath, document };
}

describe("Ontology relationship kinds", () => {
  const temporaryPaths: string[] = [];
  afterEach(() => {
    for (const dir of temporaryPaths.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("backfills kind=foreign_key on every legacy relation and keeps compile deterministic", () => {
    const outputDir = temporaryDirectory("ontology-kinds-out-");
    temporaryPaths.push(outputDir);
    const first = compileOntology({ outputDir });
    const second = compileOntology({ outputDir, check: true });

    expect(first.counts.relationshipCount).toBe(30);
    expect(second.check).toBe(true);
    const kinds = first.bundle.relationships.map((relationship) => relationship.kind);
    expect(kinds.filter((kind) => kind === "foreign_key")).toHaveLength(27);
    expect(first.bundle.relationships.every((relationship) => relationship.kind !== undefined)).toBe(true);
  });

  it("preserves derived/event/time_varying relations and their fields in the compiled output", () => {
    const outputDir = temporaryDirectory("ontology-kinds-preserve-");
    temporaryPaths.push(outputDir);
    const { bundle } = compileOntology({ outputDir });
    const onDisk = JSON.parse(fs.readFileSync(path.join(outputDir, "ontology.compiled.json"), "utf8"));
    for (const source of [bundle, onDisk]) {
      const byId = new Map(source.relationships.map((relationship) => [relationship.id, relationship]));
      expect(byId.get(DERIVED_ID)).toMatchObject({ kind: "derived", derivedBy: "duplicate_search" });
      expect(byId.get(EVENT_ID)).toMatchObject({ kind: "event", happensAtField: "passed_at" });
      expect(byId.get(TIME_VARYING_ID)).toMatchObject({
        kind: "time_varying",
        validFrom: "valid_from",
        validTo: "valid_to",
      });
    }
  });

  it("keeps the derived relation free of sourceFields and allowedJoinPaths (not SQL joinable)", () => {
    const { bundle } = compileOntology({ outputDir: temporaryDirectory("ontology-kinds-derived-") });
    const derived = bundle.relationships.find((relationship) => relationship.id === DERIVED_ID);
    expect(derived).toBeDefined();
    expect(derived?.sourceFields).toBeUndefined();
    expect(derived?.allowedJoinPaths).toBeUndefined();
    expect(derived?.note).toMatch(/duplicate_search|similarity/i);
  });

  it("marks the event relation draft with pendingColumns because quality.qgate has no time attribute", () => {
    const { bundle } = compileOntology({ outputDir: temporaryDirectory("ontology-kinds-event-") });
    const event = bundle.relationships.find((relationship) => relationship.id === EVENT_ID);
    expect(event).toMatchObject({
      kind: "event",
      happensAtField: "passed_at",
      governance: expect.objectContaining({ status: "draft" }),
    });
    expect(event?.pendingColumns).toEqual(expect.arrayContaining(["passed_at", "project_id"]));

    const qgate = bundle.entities.find((entity) => entity.id === "quality.qgate");
    expect(qgate?.properties.some((property) => property.id === event?.happensAtField)).toBe(false);
  });

  it("passes time_varying interval fields through and keeps the current-snapshot join", () => {
    const { bundle } = compileOntology({ outputDir: temporaryDirectory("ontology-kinds-tv-") });
    const timeVarying = bundle.relationships.find((relationship) => relationship.id === TIME_VARYING_ID);
    expect(timeVarying).toMatchObject({
      kind: "time_varying",
      validFrom: "valid_from",
      validTo: "valid_to",
      sourceFields: { source: "team_id", target: "team_id" },
      allowedJoinPaths: [["organization.tester", "organization.team"]],
      governance: expect.objectContaining({ status: "draft" }),
    });
    expect(timeVarying?.pendingColumns).toEqual(["valid_from", "valid_to"]);
  });

  it("validateRelationshipKinds defaults a missing kind to foreign_key without throwing", () => {
    expect(() =>
      validateRelationshipKinds([{ id: "a.b.c.d", predicate: "c", sourceEntity: "a.b", targetEntity: "c.d" }]),
    ).not.toThrow();
  });

  it("validateRelationshipKinds rejects an unknown kind", () => {
    expect(() => validateRelationshipKinds([{ id: "a.b.c.d", kind: "hybrid" }])).toThrow(
      "ONTOLOGY_RELATIONSHIP_KIND_INVALID:a.b.c.d:hybrid",
    );
  });

  it("validateRelationshipKinds rejects sourceFields on a derived relation", () => {
    expect(() =>
      validateRelationshipKinds([{ id: "a.b.c.d", kind: "derived", derivedBy: "x", sourceFields: { source: "s", target: "t" } }]),
    ).toThrow("ONTOLOGY_DERIVED_RELATION_SOURCE_FIELDS_FORBIDDEN:a.b.c.d");
  });

  it("validateRelationshipKinds rejects allowedJoinPaths on a derived relation", () => {
    expect(() =>
      validateRelationshipKinds([{ id: "a.b.c.d", kind: "derived", derivedBy: "x", allowedJoinPaths: [["a.b", "c.d"]] }]),
    ).toThrow("ONTOLOGY_DERIVED_RELATION_JOIN_PATHS_FORBIDDEN:a.b.c.d");
  });

  it("schema rejects an invalid kind end-to-end through compileOntology", () => {
    const clone = cloneOntologySources();
    temporaryPaths.push(path.dirname(clone.sourceDir), path.dirname(clone.schemaDir));
    const { filePath, document } = readRelationship(clone.sourceDir);
    document.relationships[0].kind = "hybrid";
    fs.writeFileSync(filePath, `${JSON.stringify(document, null, 2)}\n`);

    const outputDir = temporaryDirectory("ontology-kinds-invalid-");
    temporaryPaths.push(outputDir);
    expect(() => compileOntology({ sourceDir: clone.sourceDir, schemaDir: clone.schemaDir, outputDir })).toThrow(
      /ONTOLOGY_SCHEMA_INVALID:relationships\.json/,
    );
  });

  it("schema rejects a derived relation that still declares sourceFields end-to-end", () => {
    const clone = cloneOntologySources();
    temporaryPaths.push(path.dirname(clone.sourceDir), path.dirname(clone.schemaDir));
    const { filePath, document } = readRelationship(clone.sourceDir);
    const derived = document.relationships.find((relationship) => relationship.id === DERIVED_ID);
    derived.sourceFields = { source: "defect_id", target: "defect_id" };
    fs.writeFileSync(filePath, `${JSON.stringify(document, null, 2)}\n`);

    const outputDir = temporaryDirectory("ontology-kinds-derived-fk-");
    temporaryPaths.push(outputDir);
    expect(() => compileOntology({ sourceDir: clone.sourceDir, schemaDir: clone.schemaDir, outputDir })).toThrow(
      /ONTOLOGY_SCHEMA_INVALID:relationships\.json/,
    );
  });

  it("schema rejects a foreign_key relation that drops sourceFields end-to-end", () => {
    const clone = cloneOntologySources();
    temporaryPaths.push(path.dirname(clone.sourceDir), path.dirname(clone.schemaDir));
    const { filePath, document } = readRelationship(clone.sourceDir);
    const legacy = document.relationships.find((relationship) => relationship.kind === "foreign_key");
    delete legacy.sourceFields;
    fs.writeFileSync(filePath, `${JSON.stringify(document, null, 2)}\n`);

    const outputDir = temporaryDirectory("ontology-kinds-missing-fk-");
    temporaryPaths.push(outputDir);
    expect(() => compileOntology({ sourceDir: clone.sourceDir, schemaDir: clone.schemaDir, outputDir })).toThrow(
      /ONTOLOGY_SCHEMA_INVALID:relationships\.json/,
    );
  });

  it("bundle validation tolerates relations without allowedJoinPaths or sourceFields", () => {
    const bundle = JSON.parse(fs.readFileSync("ontology/generated/ontology.compiled.json", "utf8"));
    expect(bundle.relationships.some((relationship) => relationship.allowedJoinPaths === undefined)).toBe(true);
    expect(bundle.relationships.some((relationship) => relationship.sourceFields === undefined)).toBe(true);
    const counts = validateOntologyBundle(bundle);
    expect(counts.relationshipCount).toBe(30);
  });

  it("registry serves the new-kind relations and keeps them out of approved-only pathfinding", () => {
    const registry = createOntologyRegistry();

    expect(registry.getRelationship(DERIVED_ID).derivedBy).toBe("duplicate_search");
    expect(registry.getRelationship(EVENT_ID).happensAtField).toBe("passed_at");
    expect(registry.getRelationship(TIME_VARYING_ID).validFrom).toBe("valid_from");

    // Default (approvedOnly) pathfinding must not route SQL joins over draft
    // non-FK relations; opting in surfaces the direct event edge.
    const approvedPath = registry.findRelationshipPath("quality.qgate", "product.project");
    expect(approvedPath.some((relationship) => relationship.id === EVENT_ID)).toBe(false);
    const anyPath = registry.findRelationshipPath("quality.qgate", "product.project", { approvedOnly: false });
    expect(anyPath.map((relationship) => relationship.id)).toContain(EVENT_ID);
  });

  it("mermaid graph emission (vault sync path) renders the new-kind edges without crashing", () => {
    const outputDir = temporaryDirectory("ontology-kinds-graph-");
    temporaryPaths.push(outputDir);
    const graphPath = path.join(outputDir, "graph.md");
    const result = compileOntology({ outputDir, emitGraph: true, graphPath });

    expect(result.graphOutputPath).toBe(graphPath);
    const graphText = fs.readFileSync(graphPath, "utf8");
    expect(graphText).toContain('"same_root_cause_cluster"');
    expect(graphText).toContain('"gate_passed"');
    expect(graphText).toContain('"member_of_history"');
    expect(graphText).toMatch(/quality_qgate -\.->\|"gate_passed"\| product_project/);
  });
});
