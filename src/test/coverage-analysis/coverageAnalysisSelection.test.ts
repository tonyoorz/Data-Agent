import { describe, expect, it } from "vitest";

import {
  applyAidaPointSelection,
  applyFvPointSelection,
} from "@/components/dashboard/coverage-analysis/coverageAnalysisSelection";

describe("coverageAnalysisSelection", () => {
  it("replaces the fv selection from chart 1 clicks", () => {
    expect(applyFvPointSelection(["Media"], "Speech")).toEqual(["Speech"]);
  });

  it("clears the fv selection when the clicked value is blank", () => {
    expect(applyFvPointSelection(["Media"], "")).toEqual([]);
  });

  it("replaces the aida selection from chart 2 clicks", () => {
    expect(applyAidaPointSelection(["AIDA-OLD"], "AIDA-NEW")).toEqual([
      "AIDA-NEW",
    ]);
  });

  it("clears the aida selection when the clicked value is blank", () => {
    expect(applyAidaPointSelection(["AIDA-OLD"], "")).toEqual([]);
  });
});