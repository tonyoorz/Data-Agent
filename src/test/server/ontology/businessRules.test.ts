// @vitest-environment node
import fs from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

function readJson(filePath: string) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

describe("typed business rule schema", () => {
  it("accepts an approved deny rule with a stable denial code", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    ajv.addSchema(readJson("ontology/schema/common.schema.json"));
    const validate = ajv.compile(readJson("ontology/schema/business_rules.schema.json"));
    const valid = validate({
      schemaVersion: "1.0",
      ontologyVersion: "v1",
      businessRules: [{
        id: "business.test.no_created_count",
        version: "1.0.0",
        kind: "deny",
        appliesTo: { metricIds: ["defect.created_count"], intents: ["rank"] },
        effect: {
          denialCode: "BUSINESS_RULE_DENY:business.test.no_created_count",
          message: "Created defect ranking is blocked for this policy test.",
        },
        governance: { status: "approved", owner: "Agent Security" },
      }],
    });

    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it("accepts an approved require rule for a governed event-time field", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    ajv.addSchema(readJson("ontology/schema/common.schema.json"));
    const validate = ajv.compile(readJson("ontology/schema/business_rules.schema.json"));
    const valid = validate({
      schemaVersion: "1.0",
      ontologyVersion: "v1",
      businessRules: [{
        id: "business.test.created_count.creation_time",
        version: "1.0.0",
        kind: "require",
        appliesTo: { metricIds: ["defect.created_count"] },
        effect: {
          requiredTimeField: "time.defect_creation_date",
          message: "Created defect queries must use creation time.",
        },
        governance: { status: "approved", owner: "Quality Analytics" },
      }],
    });

    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it("accepts an approved derive rule with a static policy filter", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    ajv.addSchema(readJson("ontology/schema/common.schema.json"));
    const validate = ajv.compile(readJson("ontology/schema/business_rules.schema.json"));
    const valid = validate({
      schemaVersion: "1.0",
      ontologyVersion: "v1",
      businessRules: [{
        id: "business.test.project_scope",
        version: "1.0.0",
        kind: "derive",
        appliesTo: { metricIds: ["defect.created_count"], intents: ["rank"] },
        effect: {
          derivedFilter: { dimensionId: "product.project", operator: "in", values: ["SP25"] },
          message: "This policy test is scoped to SP25.",
        },
        governance: { status: "approved", owner: "Quality Analytics" },
      }],
    });

    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });
});