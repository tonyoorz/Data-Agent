// @vitest-environment node
import { describe, expect, it } from "vitest";
import { validateOntologyBundle } from "../../../../server/ontology/validator.mjs";
import { createOntologyRegistry } from "../../../../server/ontology/registry.mjs";
import { canonicalize } from "../../../../server/ontology/fingerprint.mjs";

function baseBundleFromRegistry() {
  const registry = createOntologyRegistry();
  const bundle = JSON.parse(JSON.stringify(registry.bundle));
  // strip generated-only fields; validateOntologyBundle expects the core arrays
  return bundle;
}

describe("Action Type schema and compiler validation (P1-C1)", () => {
  const registry = createOntologyRegistry();
  const actions = registry.bundle.actions;

  it("registers the three governed writeback actions", () => {
    const ids = actions.map((a) => a.id);
    expect(ids).toContain("quality.defect.update_status");
    expect(ids).toContain("quality.defect.link_duplicate");
    expect(ids).toContain("testing.testcase.propose");
    for (const id of ids) {
      const action = actions.find((a) => a.id === id);
      if (action.execution?.mode === "enabled") {
        expect(action.mutation?.writeback?.transactional, id).toBe(true);
        expect(action.submissionCriteria?.some((c) => c.kind === "approval"), id).toBe(true);
      }
    }
  });

  it("rejects a mutation field that the target entity does not own", () => {
    const bundle = baseBundleFromRegistry();
    const action = bundle.actions.find((a) => a.id === "quality.defect.update_status");
    action.mutation.fields = ["nonexistent_field"];
    expect(() => validateOntologyBundle(bundle)).toThrow("ONTOLOGY_ACTION_MUTATION_FIELD_NOT_FOUND");
  });

  it("rejects a writeback dataset that is not a declared source", () => {
    const bundle = baseBundleFromRegistry();
    const action = bundle.actions.find((a) => a.id === "quality.defect.update_status");
    action.mutation.writeback.dataset = "analytics.not_declared";
    expect(() => validateOntologyBundle(bundle)).toThrow("ONTOLOGY_ACTION_WRITEBACK_SOURCE_NOT_FOUND");
  });

  it("rejects a non-transactional writeback", () => {
    const bundle = baseBundleFromRegistry();
    const action = bundle.actions.find((a) => a.id === "quality.defect.update_status");
    action.mutation.writeback.transactional = false;
    expect(() => validateOntologyBundle(bundle)).toThrow("ONTOLOGY_ACTION_WRITEBACK_MUST_BE_TRANSACTIONAL");
  });

  it("rejects an unknown user group in submission criteria", () => {
    const bundle = baseBundleFromRegistry();
    const action = bundle.actions.find((a) => a.id === "quality.defect.update_status");
    action.submissionCriteria[0].userGroup = "strangers";
    expect(() => validateOntologyBundle(bundle)).toThrow("ONTOLOGY_ACTION_USER_GROUP_UNKNOWN");
  });

  it("rejects an enabled action without an approval criterion", () => {
    const bundle = baseBundleFromRegistry();
    const action = bundle.actions.find((a) => a.id === "quality.defect.update_status");
    action.submissionCriteria = action.submissionCriteria.filter((c) => c.kind !== "approval");
    expect(() => validateOntologyBundle(bundle)).toThrow("ONTOLOGY_ACTION_ENABLED_NEEDS_APPROVAL_CRITERION");
  });

  it("keeps canonicalize stable so the compiled artifact round-trips", () => {
    const bundle = baseBundleFromRegistry();
    const canonicalOnce = JSON.parse(JSON.stringify(canonicalize(bundle)));
    const canonicalTwice = canonicalize(JSON.parse(JSON.stringify(canonicalOnce)));
    expect(canonicalTwice).toEqual(canonicalOnce);
  });
});
