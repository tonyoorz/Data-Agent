// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOntologyRegistry } from "../../../../server/ontology/registry.mjs";

describe("Ontology registry", () => {
  const temporaryRoots: string[] = [];
  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("loads the compiled catalog and enforces metric governance", () => {
    const registry = createOntologyRegistry();

    expect(registry.version).toBe("v1");
    expect(registry.getEntity("quality.defect").primaryKey).toBe("defect_id");
    expect(registry.getMetric("defect.count", { approvedOnly: true }).unit).toBe("count");
    expect(registry.getPolicy("actor.scope.mandatory").rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityId: "quality.defect", dimensionId: "org.problem_finder_team" }),
      expect.objectContaining({ entityId: "testing.test_run", dimensionId: "org.team" }),
    ]));
    expect(registry.getConstraint("query.max_limit").parameters.maximum).toBe(200);
    expect(registry.getConstraint("answer.claim_evidence_binding").parameters.coverage).toBe(1);
    expect(() => registry.getMetric("quality.defect_density", { approvedOnly: true })).toThrow("ONTOLOGY_METRIC_NOT_APPROVED");
    expect(() => registry.getPolicy("missing.policy")).toThrow("ONTOLOGY_POLICY_NOT_FOUND");
    expect(() => registry.getConstraint("missing.constraint")).toThrow("ONTOLOGY_CONSTRAINT_NOT_FOUND");
  });

  it("resolves Chinese business vocabulary without guessing a draft definition", () => {
    const registry = createOntologyRegistry();
    const terms = registry.matchTerms("今年 DTSV 的新增缺陷按 ECU 排名");

    expect(terms.map((term) => term.id)).toEqual(expect.arrayContaining([
      "time.current_year",
      "team.dtsv",
      "metric.created_defects",
      "dimension.ecu",
    ]));
    expect(registry.matchTerms("缺陷密度")[0].resolution.ambiguityCode).toBe("DEFECT_DENSITY_DENOMINATOR_REQUIRED");
  });

  it("requires ASCII vocabulary boundaries while allowing terms next to Chinese text", () => {
    const registry = createOntologyRegistry();

    expect(registry.matchTerms("execute shell").map((term) => term.id)).not.toContain("dimension.ecu");
    expect(registry.matchTerms("ECU模块统计").map((term) => term.id)).toContain("dimension.ecu");
  });

  it("lists approved planner warnings from the compiled business-rule catalog", () => {
    const registry = createOntologyRegistry();

    expect(registry.listBusinessRules({ status: "approved", kind: "plan_warning" })).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "business.defect_created_count.creation_time",
        effect: expect.objectContaining({ warningCode: "BUSINESS_RULE:business.defect_created_count.creation_time" }),
      }),
    ]));
  });

  it("finds governed relationship paths across reversible ontology edges", () => {
    const registry = createOntologyRegistry();

    expect(registry.findRelationshipPath("requirements.aida_node", "quality.defect").map((item) => item.id)).toEqual([
      "quality.defect.affects.aida_node",
    ]);
  });

  it("fails closed when the declared fingerprint does not match content", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ontology-registry-"));
    temporaryRoots.push(root);
    const compiledPath = path.join(root, "ontology.compiled.json");
    const fingerprintPath = path.join(root, "fingerprint.txt");
    fs.copyFileSync("ontology/generated/ontology.compiled.json", compiledPath);
    fs.writeFileSync(fingerprintPath, "0".repeat(64));

    expect(() => createOntologyRegistry({ compiledPath, fingerprintPath })).toThrow("ONTOLOGY_FINGERPRINT_MISMATCH");
  });
});
