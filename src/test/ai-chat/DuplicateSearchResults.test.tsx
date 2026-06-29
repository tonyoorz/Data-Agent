import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import DuplicateSearchResults from "@/components/dashboard/chat/DuplicateSearchResults";

describe("DuplicateSearchResults", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders candidate ticket IDs as Octane hyperlinks", () => {
    render(
      <DuplicateSearchResults
        allowFeedback={false}
        result={{
          searchId: "search-link-1",
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
          ],
        }}
      />,
    );

    const ticketLink = screen.getByRole("link", { name: "DTV-1024" });

    expect(ticketLink).toHaveAttribute(
      "href",
      "https://octane-prod.bmwgroup.net/ui/entity-navigation?p=1002/2001&entityType=work_item&id=DTV-1024",
    );
    expect(ticketLink).toHaveAttribute("target", "_blank");
    expect(ticketLink).toHaveAttribute("rel", "noreferrer");
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

  it("records a weak click signal when opening an Octane ticket", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        result: { feedback_count: 4 },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <DuplicateSearchResults
        result={{
          searchId: "search-click-1",
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

    fireEvent.click(screen.getByRole("link", { name: "DTV-1024" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/duplicate-feedback",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            queryText: "导航黑屏",
            ticketId: "DTV-1024",
            signal: "click",
            baseScore: 0.92,
            rankPos: 1,
          }),
        }),
      );
    });

    expect(screen.queryByText("已标记命中")).not.toBeInTheDocument();
    expect(screen.queryByText("已标记不相关")).not.toBeInTheDocument();
  });

  it("renders compact dense and sparse ranking signals", () => {
    render(
      <DuplicateSearchResults
        allowFeedback={false}
        result={{
          searchId: "search-signals-1",
          queryText: "reconnectPhone=false BT timeout",
          modelPhase: "click_boost",
          feedbackCount: 0,
          candidates: [
            {
              ticketId: "DTV-1024",
              name: "BT reconnect timeout",
              score1to10: 8,
              similarity: 0.87,
              project: "IDC",
              pu: "26-07",
              statusPhase: "04-In Progress",
              snippet: "Logs show reconnectPhone=false after ACP disconnect.",
              rankingSignals: {
                denseRank: 2,
                denseScore: 0.72,
                sparseRank: 1,
                sparseScore: 0.87,
                denseWeight: 0.75,
                sparseWeight: 2,
              },
            },
          ],
        }}
      />,
    );

    expect(screen.getByText("Dense #2")).toBeInTheDocument();
    expect(screen.getByText("Sparse #1")).toBeInTheDocument();
    expect(screen.getByText("Sparse x2")).toBeInTheDocument();
  });
});