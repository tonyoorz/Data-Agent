import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import DuplicateSearchResults from "@/components/dashboard/chat/DuplicateSearchResults";

describe("DuplicateSearchResults", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders candidates as one compact list instead of separate article cards", () => {
    const { container } = render(
      <DuplicateSearchResults
        allowFeedback={false}
        result={{
          searchId: "search-1",
          queryText: "导航黑屏",
          modelPhase: "click_boost",
          feedbackCount: 0,
          candidates: [
            {
              ticketId: "DTV-1024",
              name: "IDCEVO 26/07 导航黑屏",
              score1to10: 9,
              similarity: 0.92,
              project: "IDCEVO",
              pu: "26-07",
              statusPhase: "03-In Analysis",
              snippet: "车辆冷启动后中控导航黑屏，需要重启恢复。",
            },
            {
              ticketId: "DTV-2048",
              name: "导航地图偶发白屏",
              score1to10: 7,
              similarity: 0.76,
              project: "ICAS3",
              pu: "25-11",
              statusPhase: "04-In Implementation",
              snippet: "地图初始化阶段偶发白屏，重试后恢复。",
            },
          ],
        }}
      />,
    );

    expect(screen.getByRole("list", { name: "候选缺陷列表" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("Phase 03-In Analysis")).toBeInTheDocument();
    expect(container.querySelectorAll("article")).toHaveLength(0);
  });

  it("updates the visible feedback total after a successful feedback submission", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          result: { feedback_count: 4 },
        }),
      }),
    );

    render(
      <DuplicateSearchResults
        result={{
          searchId: "search-2",
          queryText: "导航黑屏",
          modelPhase: "click_boost",
          feedbackCount: 3,
          candidates: [
            {
              ticketId: "DTV-1024",
              name: "IDCEVO 26/07 导航黑屏",
              score1to10: 9,
              similarity: 0.92,
              project: "IDCEVO",
              pu: "26-07",
              statusPhase: "03-In Analysis",
              snippet: "车辆冷启动后中控导航黑屏，需要重启恢复。",
            },
          ],
        }}
      />, 
    );

    fireEvent.click(screen.getByRole("button", { name: "DTV-1024 命中" }));

    await waitFor(() => {
      expect(screen.getByText("共 1 条 · 阶段 click_boost · 反馈 4")).toBeInTheDocument();
    });

    expect(screen.getByText("已记录反馈，累计 4 条")).toBeInTheDocument();
  });
});