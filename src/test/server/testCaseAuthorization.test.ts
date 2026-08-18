import { describe, expect, it, vi } from "vitest";

import {
  assertTestCaseDefectAuthorized,
  assertTestCaseOperationAuthorized,
  buildTestCaseDefectScope,
  TESTCASE_COMMIT_POLICY,
  TESTCASE_PROPOSAL_POLICY,
} from "../../../server/testCaseAuthorization.mjs";
import { prepareTestCaseProposal } from "../../../server/testCaseProposal.mjs";

function actor(overrides: Record<string, string[]> = {}) {
  return {
    actorId: "alice",
    scopeHash: "oidc-alice",
    scopes: {
      rowPolicyIds: [TESTCASE_PROPOSAL_POLICY, TESTCASE_COMMIT_POLICY],
      allowedObjectTypes: ["quality.defect", "testing.test_case"],
      workspaceIds: ["2001"],
      projectIds: ["SP25"],
      teamIds: ["DTSV_China"],
      ...overrides,
    },
  };
}

describe("testcase OIDC authorization", () => {
  it("keeps internal development compatible", () => {
    const internal = { scopeHash: "internal-local" };
    expect(assertTestCaseOperationAuthorized(internal, "proposal")).toBe(internal);
    expect(assertTestCaseOperationAuthorized(internal, "commit")).toBe(internal);
    expect(assertTestCaseDefectAuthorized(internal, {})).toEqual({});
  });

  it("requires separate operation policies, object types and commit workspace", () => {
    expect(assertTestCaseOperationAuthorized(actor(), "proposal")).toBeTruthy();
    expect(assertTestCaseOperationAuthorized(actor(), "commit", { VIZION_OCTANE_WORKSPACE_ID: "2001" })).toBeTruthy();
    expect(() => assertTestCaseOperationAuthorized(actor({ rowPolicyIds: [TESTCASE_PROPOSAL_POLICY] }), "commit")).toThrow(
      "TESTCASE_ACCESS_DENIED",
    );
    expect(() => assertTestCaseOperationAuthorized(actor({ allowedObjectTypes: ["quality.defect"] }), "commit")).toThrow(
      "TESTCASE_ACCESS_DENIED",
    );
    expect(() => assertTestCaseOperationAuthorized(actor({ workspaceIds: ["9999"] }), "commit")).toThrow(
      "TESTCASE_ACCESS_DENIED",
    );
  });

  it("fails closed when the defect is outside project/team scope or scope is absent", () => {
    const defect = { project: "SP25", problem_finder_team: "DTSV_China" };
    expect(assertTestCaseDefectAuthorized(actor(), defect)).toBe(defect);
    expect(buildTestCaseDefectScope(actor())).toEqual({ project_ids: ["SP25"], team_ids: ["DTSV_China"] });
    expect(() => assertTestCaseDefectAuthorized(actor({ projectIds: ["OTHER"] }), defect)).toThrow(
      "TESTCASE_DEFECT_SCOPE_DENIED",
    );
    expect(() => assertTestCaseDefectAuthorized(actor({ teamIds: ["OTHER"] }), defect)).toThrow(
      "TESTCASE_DEFECT_SCOPE_DENIED",
    );
    expect(() => assertTestCaseDefectAuthorized(actor({ projectIds: [], teamIds: [] }), defect)).toThrow(
      "TESTCASE_DEFECT_SCOPE_REQUIRED",
    );
  });

  it("authorizes the prepared defect before model generation", async () => {
    const authorizeDefect = vi.fn(() => { throw new Error("TESTCASE_DEFECT_SCOPE_DENIED"); });
    const generateContent = vi.fn();
    const runTestCaseBridge = vi.fn(async ({ action }) => {
      if (action === "prepare") {
        return { success: true, defect_info: { defect_id: "D-7", project: "OTHER" }, similar_cases: [] };
      }
      throw new Error("unexpected bridge action");
    });

    await expect(prepareTestCaseProposal({
      defectId: "D-7",
      runTestCaseBridge,
      authorizeDefect,
      generateContent,
    })).rejects.toThrow("TESTCASE_DEFECT_SCOPE_DENIED");
    expect(authorizeDefect).toHaveBeenCalledWith({ defect_id: "D-7", project: "OTHER" });
    expect(generateContent).not.toHaveBeenCalled();
  });
});
