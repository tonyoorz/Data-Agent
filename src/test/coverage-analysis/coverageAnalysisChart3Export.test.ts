import { describe, expect, it } from "vitest";

import { buildChart3ExportModel } from "@/components/dashboard/coverage-analysis/coverageAnalysisChart3Export";

describe("buildChart3ExportModel", () => {
  it("creates TPMDashboard-style Pivot and Stats sheet models", () => {
    const model = buildChart3ExportModel([
      {
        test_id: "T-1",
        test_name: "Wake test",
        test_week: "2026-CW20",
        status: "Passed",
        top_aida: "AIDA-1",
        project: "IDCEVO",
        pu: "PU1",
        fvp: "Voice Experience",
        fv: "Speech",
        tester: "Tester A",
        count: 1,
      },
      {
        test_id: "T-1",
        test_name: "Wake test",
        test_week: "2026-CW21",
        status: "Failed",
        top_aida: "AIDA-1",
        project: "IDCEVO",
        pu: "PU1",
        fvp: "Voice Experience",
        fv: "Speech",
        tester: "Tester A",
        count: 1,
      },
      {
        test_id: "T-2",
        test_name: "Media test",
        test_week: "2026-CW21",
        status: "Passed",
        top_aida: "AIDA-2",
        project: "ICAS3",
        pu: "PU2",
        fvp: "Entertainment",
        fv: "Media",
        tester: "Tester B",
        count: 1,
      },
    ]);

    expect(model.weekHeaders).toEqual(["CW20", "CW21"]);
    expect(model.pivotHeaders).toContain("Testcase Name");
    expect(model.pivotHeaders).toContain("CW20");
    expect(model.pivotHeaders).toContain("Pass Rate");
    expect(model.pivotRows).toEqual([
      {
        "Testcase ID": "T-1",
        "Testcase Name": "Wake test",
        "Top AIDA": "AIDA-1",
        FVP: "Voice Experience",
        FV: "Speech",
        Project: "IDCEVO",
        PU: "PU1",
        Tester: "Tester A",
        CW20: "Passed",
        CW21: "Failed",
        "Test Frequency": 1,
        "Pass Rate": 0.5,
      },
      {
        "Testcase ID": "T-2",
        "Testcase Name": "Media test",
        "Top AIDA": "AIDA-2",
        FVP: "Entertainment",
        FV: "Media",
        Project: "ICAS3",
        PU: "PU2",
        Tester: "Tester B",
        CW20: "",
        CW21: "Passed",
        "Test Frequency": 0.5,
        "Pass Rate": 1,
      },
    ]);
    expect(model.statsHeaders).toContain("Weeks With Result");
    expect(model.statsRows[0]).toMatchObject({
      "Weeks With Result": 2,
      "Weeks Passed": 1,
      "Test Frequency": 1,
      "Pass Rate": 0.5,
    });
  });
});