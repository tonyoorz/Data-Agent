import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import TestCasePreviewCard from "@/components/dashboard/chat/TestCasePreviewCard";
import type { TestCaseResult } from "@/components/dashboard/chat/testCaseTypes";

const result: TestCaseResult = {
  defectId: "D-7",
  defectName: "Defect name",
  defectSeverity: "High",
  name: "Generated case",
  descriptionHtml: '<p>Safe text</p><img src=x onerror="window.__pwned=1"><script>bad()</script>',
  stepsText: "- action\n- ? expected",
  verification: { passed: true, criteria: [], feedback: "" },
  similarCases: [],
  generatedAt: "2026-08-18T08:00:00.000Z",
  proposalDigest: "digest-1",
  proposalCapability: "v1.signed.capability",
  proposalExpiresAt: "2026-08-18T08:05:00.000Z",
  proposalOnly: true,
  committed: false,
};

describe("TestCasePreviewCard", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders generated HTML as inert text and commits only the signed capability", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, octane_url: "https://example.test/T-42" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<TestCasePreviewCard result={result} />);

    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText(/Safe text/)).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Owner workspace_user ID"), {
      target: { value: "U-3" },
    });
    fireEvent.change(screen.getByPlaceholderText("Feature ID（可选，link 到 feature）"), {
      target: { value: "F-2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认创建" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, request] = fetchMock.mock.calls[0];
    const submitted = JSON.parse(String(request.body));
    expect(submitted).toEqual({
      proposal_capability: "v1.signed.capability",
      feature_id: "F-2",
      owner_workspace_user_id: "U-3",
    });
    expect(submitted).not.toHaveProperty("test_case_data");
    expect(JSON.stringify(submitted)).not.toContain("Generated case");
    expect(JSON.stringify(submitted)).not.toContain("descriptionHtml");
  });
});
